package session

import (
	"context"
	"crypto/hmac"
	"sync"
	"time"
)

// Role identifies which of the two slots in a session a peer occupies.
// It has nothing to do with sender/receiver file-transfer roles (those
// can be swapped later); it only identifies "the peer who created the
// session" vs. "the peer who joined it", which is what the relay needs
// to know who to forward a message to.
type Role int

const (
	RoleHost Role = iota
	RoleGuest
)

func (r Role) other() Role {
	if r == RoleHost {
		return RoleGuest
	}
	return RoleHost
}

// Conn is the minimal interface the session package needs from a live
// connection. It exists so the hub's session/limit/timeout logic can be
// unit-tested without a real WebSocket; the ws package provides the real
// implementation backed by coder/websocket.
type Conn interface {
	// Send writes one message. binary distinguishes a raw file-chunk
	// frame from a JSON control-plane text frame.
	Send(ctx context.Context, binary bool, data []byte) error
	// Close closes the underlying connection with a human-readable reason.
	Close(reason string) error
}

type peer struct {
	conn           Conn
	ip             string
	disconnectedAt time.Time // zero value means "connected"
	reconnectToken []byte    // set once, right after pairing; see setReconnectToken
}

func (p *peer) connected() bool {
	return p != nil && p.disconnectedAt.IsZero()
}

// Session is a two-party pairing session. The relay never inspects the
// content of relayed messages; it only tracks which of the two slots is
// occupied, by whom, and since when, so it can enforce timeouts and
// route messages between them.
type Session struct {
	ID           string
	CreatedAt    time.Time
	mu           sync.Mutex
	lastActivity time.Time
	peers        [2]*peer
}

func newSession(id string, now time.Time) *Session {
	return &Session{
		ID:           id,
		CreatedAt:    now,
		lastActivity: now,
	}
}

func (s *Session) touch(now time.Time) {
	s.mu.Lock()
	s.lastActivity = now
	s.mu.Unlock()
}

// attach occupies a role's slot with a freshly connected peer. It fails
// if the slot is already occupied by a still-connected peer.
func (s *Session) attach(role Role, conn Conn, ip string, now time.Time) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.peers[role].connected() {
		return false
	}
	s.peers[role] = &peer{conn: conn, ip: ip}
	s.lastActivity = now
	return true
}

// connOf returns role's live connection, if currently connected.
func (s *Session) connOf(role Role) Conn {
	s.mu.Lock()
	defer s.mu.Unlock()
	p := s.peers[role]
	if !p.connected() {
		return nil
	}
	return p.conn
}

// connAndIP returns role's live connection and the IP it connected
// from, if currently connected.
func (s *Session) connAndIP(role Role) (Conn, string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	p := s.peers[role]
	if !p.connected() {
		return nil, ""
	}
	return p.conn, p.ip
}

// markDisconnected records that role's peer has dropped its connection,
// starting the reconnect grace period. It returns the other peer's live
// connection (if any) so the caller can notify it outside the lock.
func (s *Session) markDisconnected(role Role, now time.Time) (other Conn, ip string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if p := s.peers[role]; p != nil {
		p.disconnectedAt = now
		ip = p.ip
	}
	if op := s.peers[role.other()]; op.connected() {
		other = op.conn
	}
	return other, ip
}

// setReconnectToken records the bearer token role's peer must present
// to resume this session after a future disconnect. A no-op if role's
// slot isn't currently occupied (shouldn't happen: clients register
// their token over the same connection right after pairing).
func (s *Session) setReconnectToken(role Role, token []byte) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if p := s.peers[role]; p != nil {
		p.reconnectToken = token
	}
}

// reattach resumes role's peer slot with a new connection after a
// drop, provided role was previously attached, is currently
// disconnected (not already resumed by someone else), and token
// matches the one registered via setReconnectToken. It preserves the
// existing peer struct (and its reconnectToken) rather than replacing
// it, unlike attach, so the token survives across multiple reconnects
// of the same peer.
func (s *Session) reattach(role Role, token []byte, conn Conn, ip string, now time.Time) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	p := s.peers[role]
	if p == nil || p.connected() {
		return false
	}
	if len(p.reconnectToken) == 0 || !hmac.Equal(p.reconnectToken, token) {
		return false
	}
	p.conn = conn
	p.ip = ip
	p.disconnectedAt = time.Time{}
	s.lastActivity = now
	return true
}

// snapshot describes a session's current state for reaper decisions.
type snapshot struct {
	idle time.Duration

	hostConn         Conn
	hostIP           string
	hostDisconnected bool
	hostSince        time.Time

	guestConn         Conn
	guestIP           string
	guestDisconnected bool
	guestSince        time.Time
}

func (s *Session) snapshot(now time.Time) snapshot {
	s.mu.Lock()
	defer s.mu.Unlock()
	snap := snapshot{idle: now.Sub(s.lastActivity)}
	if h := s.peers[RoleHost]; h != nil {
		snap.hostIP = h.ip
		if h.connected() {
			snap.hostConn = h.conn
		} else {
			snap.hostDisconnected = true
			snap.hostSince = h.disconnectedAt
		}
	}
	if g := s.peers[RoleGuest]; g != nil {
		snap.guestIP = g.ip
		if g.connected() {
			snap.guestConn = g.conn
		} else {
			snap.guestDisconnected = true
			snap.guestSince = g.disconnectedAt
		}
	}
	return snap
}
