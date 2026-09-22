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

	"github.com/coder/websocket"

	"github.com/MarekOtulakowski/Quicksend/server/internal/proto"
	"github.com/MarekOtulakowski/Quicksend/server/internal/session"
)

// maxMessageSize must comfortably exceed a file chunk (see
// transfer.js's CHUNK_SIZE, 256KiB) plus its framing overhead and
// AES-GCM tag, with headroom to spare.
const maxMessageSize = 1 << 20 // 1MiB

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

	endedExplicitly := false
	defer func() {
		if !endedExplicitly {
			h.hub.HandleDisconnect(context.Background(), sess, role)
		}
	}()

	for {
		typ, data, err := raw.Read(ctx)
		if err != nil {
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
