package session

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"sync"
	"time"

	"github.com/MarekOtulakowski/Quicksend/server/internal/config"
	"github.com/MarekOtulakowski/Quicksend/server/internal/proto"
)

var (
	// ErrTooManySessions means the client IP is already at its
	// concurrent-session limit.
	ErrTooManySessions = errors.New("too many concurrent sessions for this client")
	// ErrSessionNotFound means the referenced session ID doesn't exist
	// (never existed, already ended, expired, or its host is no longer
	// connected to receive a pairing).
	ErrSessionNotFound = errors.New("session not found")
	// ErrSessionFull means the session's guest slot is already occupied
	// by a connected peer.
	ErrSessionFull = errors.New("session already has two peers")
	// ErrInvalidCode means the pairing code doesn't match any active
	// code session (wrong code, already used, or expired).
	ErrInvalidCode = errors.New("invalid or expired pairing code")
	// ErrTooManyAttempts means ip has made too many wrong join_by_code
	// guesses recently and is temporarily blocked from trying more.
	ErrTooManyAttempts = errors.New("too many wrong pairing code attempts")
	// ErrInvalidReconnectToken means a reconnect attempt's sessionId/role
	// combination doesn't exist, isn't currently disconnected, or its
	// token doesn't match the one registered at pairing time.
	ErrInvalidReconnectToken = errors.New("invalid reconnect token, or nothing to reconnect to")
)

// codeEntry maps a short human-readable pairing code to the session
// it was generated for. Removed on first successful lookup (single
// use) or once expired.
type codeEntry struct {
	sessionID string
	expiresAt time.Time
}

// guessBudget tracks wrong join_by_code guesses from one IP within a
// rolling window, so brute-forcing the code space is rate-limited
// independently of any specific target session.
type guessBudget struct {
	count       int
	windowStart time.Time
}

// Hub owns every live session and enforces the relay's resource limits
// (concurrent sessions per IP, session inactivity, reconnect grace
// period). It never inspects relayed message content — see the proto
// package doc comment for why — but it does construct and send the
// small set of session-lifecycle control messages itself, since it's
// the only thing that knows the full picture of a session's state.
type Hub struct {
	cfg config.Config
	now func() time.Time

	mu       sync.Mutex
	sessions map[string]*Session
	ipCounts map[string]int
	codes    map[string]*codeEntry
	guesses  map[string]*guessBudget
}

// NewHub builds a Hub enforcing the given config's limits.
func NewHub(cfg config.Config) *Hub {
	return &Hub{
		cfg:      cfg,
		now:      time.Now,
		sessions: make(map[string]*Session),
		ipCounts: make(map[string]int),
		codes:    make(map[string]*codeEntry),
		guesses:  make(map[string]*guessBudget),
	}
}

// CreateSession starts a new session with ip's connection occupying the
// host slot, and sends it a session_created message carrying the new
// session ID.
func (h *Hub) CreateSession(ctx context.Context, ip string, conn Conn) (*Session, Role, error) {
	h.mu.Lock()
	if h.ipCounts[ip] >= h.cfg.MaxSessionsPerIP {
		h.mu.Unlock()
		return nil, 0, ErrTooManySessions
	}
	id, err := newSessionID()
	if err != nil {
		h.mu.Unlock()
		return nil, 0, fmt.Errorf("generate session id: %w", err)
	}
	now := h.now()
	s := newSession(id, now)
	s.attach(RoleHost, conn, ip, now)
	h.sessions[id] = s
	h.ipCounts[ip]++
	h.mu.Unlock()

	sendEnvelope(ctx, conn, proto.TypeSessionCreated, proto.SessionCreatedPayload{SessionID: id})
	return s, RoleHost, nil
}

// JoinSession attaches ip's connection to an existing session's guest
// slot and, on success, notifies both peers with a paired message.
func (h *Hub) JoinSession(ctx context.Context, id, ip string, conn Conn) (*Session, Role, error) {
	h.mu.Lock()
	s, ok := h.sessions[id]
	if !ok {
		h.mu.Unlock()
		return nil, 0, ErrSessionNotFound
	}
	if h.ipCounts[ip] >= h.cfg.MaxSessionsPerIP {
		h.mu.Unlock()
		return nil, 0, ErrTooManySessions
	}
	h.mu.Unlock()

	return h.attachGuest(ctx, s, ip, conn)
}

// CreateCodeSession starts a new session exactly like CreateSession,
// but instead of exposing the sessionId directly (for a QR/link), it
// generates a short one-time human-readable code and sends that. The
// code is both the routing key a remote peer uses to find this
// session (join_by_code) and, client-side, the PAKE password — the
// relay treats it as an opaque lookup key and never learns anything
// about the PAKE exchange itself.
func (h *Hub) CreateCodeSession(ctx context.Context, ip string, conn Conn) (*Session, Role, error) {
	h.mu.Lock()
	if h.ipCounts[ip] >= h.cfg.MaxSessionsPerIP {
		h.mu.Unlock()
		return nil, 0, ErrTooManySessions
	}
	id, err := newSessionID()
	if err != nil {
		h.mu.Unlock()
		return nil, 0, fmt.Errorf("generate session id: %w", err)
	}
	code, err := h.newUniqueCodeLocked()
	if err != nil {
		h.mu.Unlock()
		return nil, 0, fmt.Errorf("generate pairing code: %w", err)
	}
	now := h.now()
	expiresAt := now.Add(h.cfg.PairingCodeTTL)
	s := newSession(id, now)
	s.attach(RoleHost, conn, ip, now)
	h.sessions[id] = s
	h.codes[code] = &codeEntry{sessionID: id, expiresAt: expiresAt}
	h.ipCounts[ip]++
	h.mu.Unlock()

	sendEnvelope(ctx, conn, proto.TypeCodeSessionCreated, proto.CodeSessionCreatedPayload{Code: code, ExpiresAt: expiresAt})
	return s, RoleHost, nil
}

// JoinByCode looks up code (rate-limited per ip to defend against
// online brute-force guessing) and, if it matches a live, unexpired
// code session, attaches ip's connection as its guest — otherwise
// identical to JoinSession. The code is consumed (single-use) as soon
// as it's successfully matched, regardless of what happens afterward.
func (h *Hub) JoinByCode(ctx context.Context, code, ip string, conn Conn) (*Session, Role, error) {
	now := h.now()

	h.mu.Lock()
	if !h.checkAndRecordGuessLocked(ip, now) {
		h.mu.Unlock()
		return nil, 0, ErrTooManyAttempts
	}

	entry, ok := h.codes[code]
	if !ok || now.After(entry.expiresAt) {
		delete(h.codes, code) // clean up if merely expired
		h.mu.Unlock()
		return nil, 0, ErrInvalidCode
	}
	delete(h.codes, code) // single-use: consumed by this match attempt

	if h.ipCounts[ip] >= h.cfg.MaxSessionsPerIP {
		h.mu.Unlock()
		return nil, 0, ErrTooManySessions
	}
	s, ok := h.sessions[entry.sessionID]
	h.mu.Unlock()
	if !ok {
		return nil, 0, ErrSessionNotFound
	}

	return h.attachGuest(ctx, s, ip, conn)
}

// attachGuest is the shared "attach as guest, notify both sides"
// logic behind both JoinSession and JoinByCode.
func (h *Hub) attachGuest(ctx context.Context, s *Session, ip string, conn Conn) (*Session, Role, error) {
	hostConn := s.connOf(RoleHost)
	if hostConn == nil {
		// The host that created this session is no longer connected
		// (e.g. its tab closed right after showing the QR code); from
		// the joiner's perspective this session isn't reachable.
		return nil, 0, ErrSessionNotFound
	}

	now := h.now()
	if !s.attach(RoleGuest, conn, ip, now) {
		return nil, 0, ErrSessionFull
	}

	h.mu.Lock()
	h.ipCounts[ip]++
	h.mu.Unlock()

	paired := proto.PairedPayload{SessionID: s.ID}
	sendEnvelope(ctx, hostConn, proto.TypePaired, paired)
	sendEnvelope(ctx, conn, proto.TypePaired, paired)
	return s, RoleGuest, nil
}

// RegisterReconnectToken records the bearer token role's peer on s
// must present to resume this session after a future disconnect. It's
// called once by each peer right over the connection they just paired
// on; the relay stores the token opaquely (it's an HMAC output it
// can't compute or forge itself — see cryptoutil.DeriveReconnectToken)
// and never relays it to the other peer.
func (h *Hub) RegisterReconnectToken(s *Session, role Role, token []byte) {
	s.setReconnectToken(role, token)
}

// Reconnect attaches ip's new connection to role's slot in the session
// identified by sessionID, resuming it after a dropped connection,
// provided token matches the one registered for that role at pairing
// time. On success it notifies the other peer (if connected) with
// peer_reconnected, so both sides can advance their local epoch
// counter in lockstep (see cryptoutil.DeriveEpochKey) — the relay
// itself never tracks or sees the epoch number.
func (h *Hub) Reconnect(ctx context.Context, sessionID string, role Role, token []byte, ip string, conn Conn) (*Session, Role, error) {
	h.mu.Lock()
	s, ok := h.sessions[sessionID]
	if !ok {
		h.mu.Unlock()
		return nil, 0, ErrInvalidReconnectToken
	}
	if h.ipCounts[ip] >= h.cfg.MaxSessionsPerIP {
		h.mu.Unlock()
		return nil, 0, ErrTooManySessions
	}
	h.mu.Unlock()

	if !s.reattach(role, token, conn, ip, h.now()) {
		return nil, 0, ErrInvalidReconnectToken
	}

	h.mu.Lock()
	h.ipCounts[ip]++
	h.mu.Unlock()

	if other := s.connOf(role.other()); other != nil {
		sendEnvelope(ctx, other, proto.TypePeerReconnected, nil)
	}
	sendEnvelope(ctx, conn, proto.TypeReconnected, nil)
	return s, role, nil
}

// newUniqueCodeLocked generates a 6-digit code not currently in use.
// Callers must hold h.mu.
func (h *Hub) newUniqueCodeLocked() (string, error) {
	for attempt := 0; attempt < 20; attempt++ {
		n, err := rand.Int(rand.Reader, big.NewInt(1_000_000))
		if err != nil {
			return "", err
		}
		code := fmt.Sprintf("%06d", n.Int64())
		if _, taken := h.codes[code]; !taken {
			return code, nil
		}
	}
	return "", errors.New("could not find an unused pairing code")
}

// checkAndRecordGuessLocked reports whether ip is still under its
// wrong-guess budget for the current window, recording this attempt
// regardless of whether the code it's about to be checked against
// turns out to be valid. The window length matches the pairing code
// TTL: after it elapses, the budget resets rather than accumulating
// forever. Callers must hold h.mu.
func (h *Hub) checkAndRecordGuessLocked(ip string, now time.Time) bool {
	b, ok := h.guesses[ip]
	if !ok || now.Sub(b.windowStart) >= h.cfg.PairingCodeTTL {
		b = &guessBudget{windowStart: now}
		h.guesses[ip] = b
	}
	if b.count >= h.cfg.MaxPairingAttempts {
		return false
	}
	b.count++
	return true
}

// Relay forwards data from role's peer to the other peer in the same
// session, if currently connected. It reports whether there was a live
// peer to deliver to. The relay never parses data; see the proto
// package doc comment.
func (h *Hub) Relay(ctx context.Context, s *Session, role Role, binary bool, data []byte) bool {
	s.touch(h.now())

	if binary {
		fileID, drop, sendAbort := s.recordChunkBytes(data, h.cfg.MaxFileSize)
		if drop {
			return true
		}
		if sendAbort {
			defer h.abortOversizedFile(ctx, s, fileID)
		}
	}

	other := s.connOf(role.other())
	if other == nil {
		return false
	}
	_ = other.Send(ctx, binary, data)
	return true
}

// abortOversizedFile tells both peers to stop a file that just
// exceeded QUICKSEND_MAX_FILE_SIZE_BYTES, reusing the same file_abort
// message clients already handle for a user-initiated cancel (see
// docs/PROTOCOL.md) — the relay is simply the one sending it this
// time, instead of relaying it from one peer to the other. It's a
// best-effort notification, like every other control message the hub
// sends; a peer that's currently disconnected just won't get it (and
// will find the file gone if it later reconnects and receives more
// chunks that recordChunkBytes silently drops).
func (h *Hub) abortOversizedFile(ctx context.Context, s *Session, fileID [16]byte) {
	payload := proto.FileAbortPayload{
		FileID: hex.EncodeToString(fileID[:]),
		Reason: proto.FileAbortReasonSizeLimit,
	}
	if host := s.connOf(RoleHost); host != nil {
		sendEnvelope(ctx, host, proto.TypeFileAbort, payload)
	}
	if guest := s.connOf(RoleGuest); guest != nil {
		sendEnvelope(ctx, guest, proto.TypeFileAbort, payload)
	}
}

// EndSession tears the session down immediately by explicit request
// from byRole, notifying and closing the other peer's connection.
func (h *Hub) EndSession(ctx context.Context, s *Session, byRole Role) {
	otherConn, otherIP := s.connAndIP(byRole.other())
	if otherConn != nil {
		sendEnvelope(ctx, otherConn, proto.TypeSessionEnded, proto.SessionEndedPayload{Reason: proto.ReasonEndedByPeer})
		h.closeAndRelease(otherConn, otherIP, proto.ReasonEndedByPeer)
	}
	h.removeByID(s.ID)
}

// HandleDisconnect records that role's connection to s has dropped and
// notifies the other peer (if connected) with peer_disconnected. The
// session itself is kept alive for the configured reconnect grace
// period; Run's background reaper finishes tearing it down if nobody
// reconnects in time.
func (h *Hub) HandleDisconnect(ctx context.Context, s *Session, role Role) {
	now := h.now()
	other, ip := s.markDisconnected(role, now)

	h.mu.Lock()
	if h.ipCounts[ip] > 0 {
		h.ipCounts[ip]--
	}
	h.mu.Unlock()

	if other != nil {
		sendEnvelope(ctx, other, proto.TypePeerDisconnected, nil)
	}
}

// Run periodically reaps expired sessions until ctx is cancelled.
func (h *Hub) Run(ctx context.Context, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			h.ReapOnce()
		}
	}
}

// ReapOnce scans every session and closes the ones that have been idle
// too long, or whose disconnected peer never reconnected within the
// grace period. It also expires unused pairing codes and stale
// per-IP guess-attempt tracking. Exported so tests can drive it
// deterministically; production code should call Run instead.
func (h *Hub) ReapOnce() {
	now := h.now()

	h.mu.Lock()
	ids := make([]string, 0, len(h.sessions))
	for id := range h.sessions {
		ids = append(ids, id)
	}
	for code, entry := range h.codes {
		if now.After(entry.expiresAt) {
			delete(h.codes, code)
		}
	}
	for ip, b := range h.guesses {
		if now.Sub(b.windowStart) >= h.cfg.PairingCodeTTL {
			delete(h.guesses, ip)
		}
	}
	h.mu.Unlock()

	for _, id := range ids {
		h.mu.Lock()
		s, ok := h.sessions[id]
		h.mu.Unlock()
		if ok {
			h.reapSession(s, now)
		}
	}
}

func (h *Hub) reapSession(s *Session, now time.Time) {
	snap := s.snapshot(now)
	ctx := context.Background()

	notifyAndClose := func(reason string) {
		if snap.hostConn != nil {
			sendEnvelope(ctx, snap.hostConn, proto.TypeSessionEnded, proto.SessionEndedPayload{Reason: reason})
			h.closeAndRelease(snap.hostConn, snap.hostIP, reason)
		}
		if snap.guestConn != nil {
			sendEnvelope(ctx, snap.guestConn, proto.TypeSessionEnded, proto.SessionEndedPayload{Reason: reason})
			h.closeAndRelease(snap.guestConn, snap.guestIP, reason)
		}
		h.removeByID(s.ID)
	}

	if snap.idle >= h.cfg.SessionInactivityTimeout {
		notifyAndClose(proto.ReasonInactivityTimeout)
		return
	}

	graceExpired := func(disconnected bool, since time.Time) bool {
		return disconnected && now.Sub(since) >= h.cfg.ReconnectGracePeriod
	}
	if graceExpired(snap.hostDisconnected, snap.hostSince) || graceExpired(snap.guestDisconnected, snap.guestSince) {
		notifyAndClose(proto.ReasonPeerTimeout)
	}
}

// closeAndRelease closes a still-connected peer's connection and
// releases the concurrent-session slot it held against its IP.
func (h *Hub) closeAndRelease(conn Conn, ip, reason string) {
	_ = conn.Close(reason)
	h.mu.Lock()
	if h.ipCounts[ip] > 0 {
		h.ipCounts[ip]--
	}
	h.mu.Unlock()
}

func (h *Hub) removeByID(id string) {
	h.mu.Lock()
	delete(h.sessions, id)
	h.mu.Unlock()
}

func sendEnvelope(ctx context.Context, c Conn, msgType string, payload any) {
	var raw json.RawMessage
	if payload != nil {
		b, err := json.Marshal(payload)
		if err != nil {
			return
		}
		raw = b
	}
	b, err := json.Marshal(proto.Envelope{Type: msgType, Payload: raw})
	if err != nil {
		return
	}
	_ = c.Send(ctx, false, b)
}

func newSessionID() (string, error) {
	buf := make([]byte, 16) // 128 bits: a routing identifier, not a secret guessed over the network.
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}
