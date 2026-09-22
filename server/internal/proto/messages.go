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

import (
	"encoding/json"
	"time"
)

// Envelope is the wrapper for every control-plane message.
type Envelope struct {
	Type    string          `json:"type"`
	Payload json.RawMessage `json:"payload,omitempty"`
}

// Message types the relay itself acts on.
const (
	TypeCreateSession      = "create_session"
	TypeSessionCreated     = "session_created"
	TypeJoin               = "join"
	TypeCreateCodeSession  = "create_code_session"
	TypeCodeSessionCreated = "code_session_created"
	TypeJoinByCode         = "join_by_code"
	TypePaired             = "paired"
	TypeEndSession         = "end_session"
	TypeSessionEnded       = "session_ended"
	TypePeerDisconnected   = "peer_disconnected"
	TypeReconnectToken     = "reconnect_token"
	TypeReconnect          = "reconnect"
	TypeReconnected        = "reconnected"
	TypePeerReconnected    = "peer_reconnected"
	TypeError              = "error"
)

// Message types the two paired clients exchange directly, relayed
// opaquely (see the package doc comment). Defined here purely for
// documentation/discoverability and any Go-side test that needs to
// construct one — the relay itself never switches on these.
const (
	TypePakeMsg          = "pake_msg"
	TypePakeConfirm      = "pake_confirm"
	TypeRoleSwapRequest  = "role_swap_request"
	TypeRoleSwapResponse = "role_swap_response"
	TypeFileAbort        = "file_abort"
)

// RoleSwapResponsePayload answers a role_swap_request: Accepted is
// false if the responding peer currently has a transfer in progress
// (mid-transfer role changes aren't supported — see docs/DECISIONS.md)
// or already has a swap of its own in flight. The relay never parses
// this; it's opaque like pake_msg above.
type RoleSwapResponsePayload struct {
	Accepted bool `json:"accepted"`
}

// FileAbortPayload cancels one in-progress file transfer without
// ending the session. Sent by either side — the sender giving up, or
// the receiver declining to keep receiving — to whichever side didn't
// initiate the cancel, so both stop for the same file. Normally
// opaque to the relay, like pake_msg above — the one exception is
// FileAbortReasonSizeLimit, which the relay itself sends (see
// docs/DECISIONS.md): it can enforce QUICKSEND_MAX_FILE_SIZE_BYTES
// using only the chunk frame's outer header (fileId, the last-chunk
// flag), never its ciphertext, so this doesn't require seeing
// plaintext file content or size.
type FileAbortPayload struct {
	FileID string `json:"fileId"`
	Reason string `json:"reason,omitempty"`
}

// FileAbortReasonSizeLimit is the only reason the relay itself ever
// sends (rather than merely relaying); see FileAbortPayload.
const FileAbortReasonSizeLimit = "size_limit_exceeded"

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

// CodeSessionCreatedPayload is sent to the peer who called
// create_code_session, carrying the short human-readable pairing code
// the other side must type in (never the sessionId itself — the code
// is looked up server-side). This code is also the PAKE password the
// two clients use to derive sessionKey themselves; the relay only
// ever sees it as an opaque routing key.
type CodeSessionCreatedPayload struct {
	Code      string    `json:"code"`
	ExpiresAt time.Time `json:"expiresAt"`
}

// JoinByCodePayload is sent by the second peer to attach to a session
// found by its human-readable pairing code.
type JoinByCodePayload struct {
	Code string `json:"code"`
}

// PakeMsgPayload carries one leg of the SPAKE2 exchange (the JSON
// produced by schollz/pake's Pake.Bytes()) between the two clients.
// The relay never parses this.
type PakeMsgPayload struct {
	Message string `json:"message"`
}

// PakeConfirmPayload carries the HMAC key-confirmation tag (see
// docs/DECISIONS.md) each client sends after deriving its session key,
// so both sides can detect a wrong pairing code instead of only
// finding out from a later failed decryption. The relay never parses
// this.
type PakeConfirmPayload struct {
	TagHex string `json:"tagHex"`
}

// PairedPayload is sent to both peers once they're attached to the
// same session. SessionID lets each client compute and register its
// reconnect token (see ReconnectTokenPayload) — this is the only way
// a code+PAKE client learns its session ID, since create_code_session/
// join_by_code deliberately never expose it (the human-facing pairing
// code is the only identifier those flows hand a user).
type PairedPayload struct {
	SessionID string `json:"sessionId"`
}

// ReconnectTokenPayload registers the bearer credential (see
// cryptoutil.DeriveReconnectToken) the sending peer must present to
// resume this session after a dropped connection. Sent once by each
// peer right after pairing completes. The relay stores it opaquely
// and never relays it to the other peer.
type ReconnectTokenPayload struct {
	TokenHex string `json:"tokenHex"`
}

// ReconnectPayload is sent as the first message on a new connection to
// resume an existing session after a drop, in place of create_session
// or join. Role is "host" or "guest", matching whichever slot this
// client occupied before disconnecting.
type ReconnectPayload struct {
	SessionID string `json:"sessionId"`
	Role      string `json:"role"`
	TokenHex  string `json:"tokenHex"`
}

// Role values used in ReconnectPayload.
const (
	RoleHostWire  = "host"
	RoleGuestWire = "guest"
)

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
	ErrCodeSessionNotFound       = "session_not_found"
	ErrCodeSessionFull           = "session_full"
	ErrCodeTooManySessions       = "too_many_sessions"
	ErrCodeInvalidMessage        = "invalid_message"
	ErrCodeAlreadyPaired         = "already_in_session"
	ErrCodeInvalidCode           = "invalid_code"
	ErrCodeTooManyAttempts       = "too_many_attempts"
	ErrCodeInvalidReconnectToken = "invalid_reconnect_token"
)
