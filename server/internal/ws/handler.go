// Package ws wires HTTP WebSocket connections into the session hub. It
// owns WebSocket-specific mechanics only (accept, read loop, framing);
// all session-lifecycle and relay semantics live in the session package.
package ws

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/coder/websocket"

	"github.com/MarekOtulakowski/Quicksend/server/internal/proto"
	"github.com/MarekOtulakowski/Quicksend/server/internal/session"
)

// maxMessageSize must comfortably exceed a file chunk (see
// transfer.js's CHUNK_SIZE, 256KiB) plus its framing overhead and
// AES-GCM tag, with headroom to spare.
const maxMessageSize = 1 << 20 // 1MiB

// pingInterval/pingTimeout control the keepalive ping loop (see
// pingLoop) that runs for the lifetime of a paired connection. Vars,
// not consts, so tests can shorten them instead of waiting out the
// real 20s/10s.
var (
	pingInterval = 20 * time.Second
	pingTimeout  = 10 * time.Second
)

type handler struct {
	hub *session.Hub
}

// NewHandler returns the HTTP handler that upgrades requests to
// WebSocket connections and dispatches them into hub.
func NewHandler(hub *session.Hub) http.Handler {
	return &handler{hub: hub}
}

func (h *handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	raw, err := websocket.Accept(w, r, nil)
	if err != nil {
		slog.Warn("websocket accept failed", "error", err)
		return
	}
	// coder/websocket defaults to a 32KiB max message size, far below
	// a 256KiB file chunk plus its framing overhead; without raising
	// this, the first real chunk sent trips the limit and the relay
	// silently closes the connection.
	raw.SetReadLimit(maxMessageSize)

	ip := clientIP(r)
	c := newConn(raw)
	defer c.Close("connection closed")

	ctx := context.Background()

	typ, data, err := raw.Read(ctx)
	if err != nil {
		return
	}
	if typ != websocket.MessageText {
		sendError(ctx, c, proto.ErrCodeInvalidMessage, "first message must be text")
		return
	}

	var env proto.Envelope
	if err := json.Unmarshal(data, &env); err != nil {
		sendError(ctx, c, proto.ErrCodeInvalidMessage, "malformed json")
		return
	}

	sess, role, err := h.beginSession(ctx, env, ip, c)
	if err != nil {
		sendError(ctx, c, errCode(err), err.Error())
		return
	}

	pingCtx, cancelPing := context.WithCancel(context.Background())
	defer cancelPing()
	go pingLoop(pingCtx, c, sess.ID, role)

	endedExplicitly := false
	defer func() {
		if !endedExplicitly {
			h.hub.HandleDisconnect(context.Background(), sess, role)
		}
	}()

	for {
		typ, data, err := raw.Read(ctx)
		if err != nil {
			logReadError(sess.ID, role, err)
			return
		}

		binary := typ == websocket.MessageBinary
		if !binary {
			switch controlType(data) {
			case proto.TypeEndSession:
				h.hub.EndSession(ctx, sess, role)
				endedExplicitly = true
				return
			case proto.TypeReconnectToken:
				h.handleReconnectToken(sess, role, data)
				continue
			}
		}

		h.hub.Relay(ctx, sess, role, binary, data)
	}
}

// pingLoop periodically pings the peer for the lifetime of ctx, to
// keep the underlying connection alive across NATs/middleboxes that
// silently drop a TCP connection that looks idle — a mobile carrier's
// NAT in particular, which a long quiet stretch (e.g. the sender
// reading a large cloud-backed photo, or either side just sitting
// paired with nothing to send) can trip well before either endpoint
// would otherwise notice anything wrong. See docs/DECISIONS.md.
//
// It also gives the relay a bounded way to detect a truly dead
// connection: raw.Read in ServeHTTP's main loop is called with
// context.Background(), so with no ping it could block forever on a
// connection a NAT has silently dropped with neither a FIN nor an
// RST. A ping that never gets its pong closes the connection, which
// unblocks that Read with an error and runs the normal disconnect
// path (HandleDisconnect -> notifies the other peer via
// peer_disconnected).
func pingLoop(ctx context.Context, c *conn, sessionID string, role session.Role) {
	ticker := time.NewTicker(pingInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			pingCtx, cancel := context.WithTimeout(ctx, pingTimeout)
			err := c.Ping(pingCtx)
			cancel()
			if err != nil {
				slog.Warn("ws ping timed out, closing connection", "session", sessionID, "role", role, "error", err)
				_ = c.Close("ping timeout")
				return
			}
		}
	}
}

// logReadError classifies why a paired connection's read loop ended.
// Previously this error was discarded entirely (the loop just
// returned), leaving real-world disconnects — which mobile networks
// in particular produce for all sorts of different reasons — totally
// invisible in the logs. A normal/expected close (the client going
// away cleanly, e.g. via end_session or the tab closing) logs at Info;
// anything else — an abnormal close code, or no close frame at all
// (a read timeout, a reset, the ping loop's own forced close) — logs
// at Warn so it stands out when correlating a user's bug report
// against the timestamp in these logs. See docs/DECISIONS.md.
func logReadError(sessionID string, role session.Role, err error) {
	if status := websocket.CloseStatus(err); status != -1 {
		if status == websocket.StatusNormalClosure || status == websocket.StatusGoingAway {
			slog.Info("ws closed", "session", sessionID, "role", role, "close_status", status)
			return
		}
		slog.Warn("ws closed abnormally", "session", sessionID, "role", role, "close_status", status, "error", err)
		return
	}
	slog.Warn("ws read error", "session", sessionID, "role", role, "error", err)
}

// handleReconnectToken registers the bearer token role's peer just
// generated for resuming this session later (see
// session.Hub.RegisterReconnectToken). Malformed payloads are
// silently ignored rather than closing the connection: a client that
// never successfully registers a token simply can't reconnect later,
// which is no worse than not having reconnect support at all.
func (h *handler) handleReconnectToken(sess *session.Session, role session.Role, data []byte) {
	var env proto.Envelope
	if err := json.Unmarshal(data, &env); err != nil {
		return
	}
	var payload proto.ReconnectTokenPayload
	if err := json.Unmarshal(env.Payload, &payload); err != nil {
		return
	}
	token, err := hex.DecodeString(payload.TokenHex)
	if err != nil {
		return
	}
	h.hub.RegisterReconnectToken(sess, role, token)
}

func (h *handler) beginSession(ctx context.Context, env proto.Envelope, ip string, c *conn) (*session.Session, session.Role, error) {
	switch env.Type {
	case proto.TypeCreateSession:
		return h.hub.CreateSession(ctx, ip, c)
	case proto.TypeJoin:
		var payload proto.JoinPayload
		if err := json.Unmarshal(env.Payload, &payload); err != nil {
			return nil, 0, errInvalidMessage
		}
		return h.hub.JoinSession(ctx, payload.SessionID, ip, c)
	case proto.TypeCreateCodeSession:
		return h.hub.CreateCodeSession(ctx, ip, c)
	case proto.TypeJoinByCode:
		var payload proto.JoinByCodePayload
		if err := json.Unmarshal(env.Payload, &payload); err != nil {
			return nil, 0, errInvalidMessage
		}
		return h.hub.JoinByCode(ctx, payload.Code, ip, c)
	case proto.TypeReconnect:
		var payload proto.ReconnectPayload
		if err := json.Unmarshal(env.Payload, &payload); err != nil {
			return nil, 0, errInvalidMessage
		}
		role, ok := parseRole(payload.Role)
		if !ok {
			return nil, 0, errInvalidMessage
		}
		token, err := hex.DecodeString(payload.TokenHex)
		if err != nil {
			return nil, 0, errInvalidMessage
		}
		return h.hub.Reconnect(ctx, payload.SessionID, role, token, ip, c)
	default:
		return nil, 0, errInvalidMessage
	}
}

var errInvalidMessage = errors.New("first message must be create_session, join, create_code_session, join_by_code, or reconnect")

func parseRole(wire string) (session.Role, bool) {
	switch wire {
	case proto.RoleHostWire:
		return session.RoleHost, true
	case proto.RoleGuestWire:
		return session.RoleGuest, true
	default:
		return 0, false
	}
}

// controlType returns the envelope type of a text control message
// without otherwise interpreting it, or "" if data isn't a valid
// envelope. Used to pick out the handful of types the relay itself
// must act on (end_session, reconnect_token); every other known
// control type — pake_msg, file_meta, chunk_ack, ... — is relayed
// opaquely and never reaches this switch.
func controlType(data []byte) string {
	var env proto.Envelope
	if err := json.Unmarshal(data, &env); err != nil {
		return ""
	}
	return env.Type
}

func sendError(ctx context.Context, c *conn, code, message string) {
	payload, err := json.Marshal(proto.ErrorPayload{Code: code, Message: message})
	if err != nil {
		return
	}
	b, err := json.Marshal(proto.Envelope{Type: proto.TypeError, Payload: payload})
	if err != nil {
		return
	}
	_ = c.Send(ctx, false, b)
}

func errCode(err error) string {
	switch {
	case errors.Is(err, session.ErrTooManySessions):
		return proto.ErrCodeTooManySessions
	case errors.Is(err, session.ErrSessionNotFound):
		return proto.ErrCodeSessionNotFound
	case errors.Is(err, session.ErrSessionFull):
		return proto.ErrCodeSessionFull
	case errors.Is(err, session.ErrInvalidCode):
		return proto.ErrCodeInvalidCode
	case errors.Is(err, session.ErrTooManyAttempts):
		return proto.ErrCodeTooManyAttempts
	case errors.Is(err, session.ErrInvalidReconnectToken):
		return proto.ErrCodeInvalidReconnectToken
	default:
		return proto.ErrCodeInvalidMessage
	}
}

// clientIP returns the address the relay should count against
// per-IP session limits.
//
// Quicksend is designed to run with TLS terminated by a reverse proxy
// in front of the container (see README), so we trust X-Forwarded-For
// / X-Real-IP here. This is only safe because the container is not
// meant to be reachable directly from untrusted networks — if it is,
// these headers are trivially spoofable and the per-IP limit becomes
// meaningless. docker-compose.yml's example wiring keeps the relay
// off any publicly reachable port other than through the proxy.
func clientIP(r *http.Request) string {
	if fwd := r.Header.Get("X-Forwarded-For"); fwd != "" {
		if first, _, ok := strings.Cut(fwd, ","); ok {
			return strings.TrimSpace(first)
		}
		return strings.TrimSpace(fwd)
	}
	if rip := r.Header.Get("X-Real-IP"); rip != "" {
		return rip
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}
