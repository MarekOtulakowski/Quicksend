package session

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
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
)

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
}

// NewHub builds a Hub enforcing the given config's limits.
func NewHub(cfg config.Config) *Hub {
	return &Hub{
		cfg:      cfg,
		now:      time.Now,
		sessions: make(map[string]*Session),
		ipCounts: make(map[string]int),
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

	sendEnvelope(ctx, hostConn, proto.TypePaired, nil)
	sendEnvelope(ctx, conn, proto.TypePaired, nil)
	return s, RoleGuest, nil
}

// Relay forwards data from role's peer to the other peer in the same
// session, if currently connected. It reports whether there was a live
// peer to deliver to. The relay never parses data; see the proto
// package doc comment.
func (h *Hub) Relay(ctx context.Context, s *Session, role Role, binary bool, data []byte) bool {
	s.touch(h.now())
	other := s.connOf(role.other())
	if other == nil {
		return false
	}
	_ = other.Send(ctx, binary, data)
	return true
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
// grace period. Exported so tests can drive it deterministically;
// production code should call Run instead.
func (h *Hub) ReapOnce() {
	now := h.now()

	h.mu.Lock()
	ids := make([]string, 0, len(h.sessions))
	for id := range h.sessions {
		ids = append(ids, id)
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
