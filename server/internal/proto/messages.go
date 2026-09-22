// Package proto defines the JSON control-plane wire format exchanged
// between clients and the relay over the WebSocket text channel.
//
// The relay only ever inspects a small allowlist of message types it must
// act on (session lifecycle: create_session, join, end_session, reconnect).
// Every other message — including the ones the two paired clients use for
// pairing (pake_msg), transfer (file_meta, chunk_ack, file_abort, ...) and
// role swap — is relayed byte-for-byte between the two peers without the
// relay parsing or understanding it, so it never needs to see plaintext.
package proto

import "encoding/json"

// Envelope is the wrapper for every control-plane message.
type Envelope struct {
	Type    string          `json:"type"`
	Payload json.RawMessage `json:"payload,omitempty"`
}

// Message types the relay itself acts on.
const (
	TypeCreateSession    = "create_session"
	TypeSessionCreated   = "session_created"
	TypeJoin             = "join"
	TypePaired           = "paired"
	TypeEndSession       = "end_session"
	TypeSessionEnded     = "session_ended"
	TypePeerDisconnected = "peer_disconnected"
	TypePeerReconnected  = "peer_reconnected"
	TypeError            = "error"
)

// SessionCreatedPayload is sent to the peer who called create_session,
// carrying the session ID the other side needs to join (via QR or, later,
// a paired code).
type SessionCreatedPayload struct {
	SessionID string `json:"sessionId"`
}

// JoinPayload is sent by the second peer to attach to an existing session.
type JoinPayload struct {
	SessionID string `json:"sessionId"`
}

// SessionEndedPayload explains why a session was torn down.
type SessionEndedPayload struct {
	Reason string `json:"reason"`
}

// Reasons a session can end.
const (
	ReasonEndedByPeer       = "ended_by_peer"
	ReasonPeerTimeout       = "peer_timeout"
	ReasonInactivityTimeout = "inactivity_timeout"
)

// ErrorPayload carries a machine-readable code plus a human-readable
// message for protocol-level errors (bad session ID, session full, etc).
type ErrorPayload struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// Error codes the relay can send.
const (
	ErrCodeSessionNotFound = "session_not_found"
	ErrCodeSessionFull     = "session_full"
	ErrCodeTooManySessions = "too_many_sessions"
	ErrCodeInvalidMessage  = "invalid_message"
	ErrCodeAlreadyPaired   = "already_in_session"
)
