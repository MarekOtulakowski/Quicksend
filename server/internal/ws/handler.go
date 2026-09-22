// Package ws wires HTTP WebSocket connections into the session hub. It
// owns WebSocket-specific mechanics only (accept, read loop, framing);
// all session-lifecycle and relay semantics live in the session package.
package ws

import (
	"context"
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
		if !binary && isEndSession(data) {
			h.hub.EndSession(ctx, sess, role)
			endedExplicitly = true
			return
		}

		h.hub.Relay(ctx, sess, role, binary, data)
	}
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
	default:
		return nil, 0, errInvalidMessage
	}
}

var errInvalidMessage = errors.New("first message must be create_session, join, create_code_session, or join_by_code")

// isEndSession reports whether data is a text control message with
// type "end_session", without otherwise interpreting it. Everything
// else — including other known control types like pake_msg or
// file_meta — is relayed opaquely; the relay only needs to act on
// end_session itself.
func isEndSession(data []byte) bool {
	var env proto.Envelope
	if err := json.Unmarshal(data, &env); err != nil {
		return false
	}
	return env.Type == proto.TypeEndSession
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
