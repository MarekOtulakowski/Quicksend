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
// route messages between them. currentFile is the one narrow exception
// (see recordChunkBytes): it reads a chunk frame's outer header —
// never its ciphertext — to enforce QUICKSEND_MAX_FILE_SIZE_BYTES.
type Session struct {
	ID           string
	CreatedAt    time.Time
	mu           sync.Mutex
	lastActivity time.Time
	peers        [2]*peer
	currentFile  currentFileState
}

// currentFileState tracks the size of whichever file is currently
// being relayed in a session, so a single file can be capped at
// QUICKSEND_MAX_FILE_SIZE_BYTES. Only one file is ever in flight at a
// time (see docs/PROTOCOL.md), so one tracker per session suffices
// regardless of which peer is currently sending (transfer role can
// swap — see the role swap decision).
type currentFileState struct {
	fileID     [16]byte
	active     bool
	blocked    bool // already told both peers to stop; further chunks for this fileID are dropped
	bytesSoFar int64
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

// chunkFrameHeaderLen and chunkFrameTypeFile mirror transfer.js's
// binary chunk-frame format (docs/PROTOCOL.md): byte 0 is the frame
// type, byte 1's low bit is the last-chunk flag, bytes 2-17 are the
// 16-byte fileId, bytes 18-25 are the chunk index. recordChunkBytes
// only ever reads this fixed-size header, never the ciphertext that
// follows it.
const (
	chunkFrameHeaderLen = 26
	chunkFrameTypeFile  = 0x01
)

// recordChunkBytes updates the running byte count for whichever file
// is currently being relayed in this session — using only a chunk
// frame's outer header (frame type, fileId, last-chunk flag), never
// its ciphertext — so QUICKSEND_MAX_FILE_SIZE_BYTES can be enforced
// without the relay ever needing to decrypt or understand file
// content, size, or name. See docs/DECISIONS.md.
//
// It reports the fileId a frame belongs to (zero value if frame isn't
// a recognized chunk frame, in which case it's never tracked), and:
//   - drop: true if this frame belongs to a file already over the
//     limit and must not be relayed further.
//   - sendAbort: true exactly once, for the frame that just pushed
//     the running total past maxSize — the caller should still relay
//     this one frame, then tell both peers to stop.
func (s *Session) recordChunkBytes(frame []byte, maxSize int64) (fileID [16]byte, drop, sendAbort bool) {
	if len(frame) < chunkFrameHeaderLen || frame[0] != chunkFrameTypeFile {
		return fileID, false, false
	}
	copy(fileID[:], frame[2:18])
	isLast := frame[1]&1 == 1

	s.mu.Lock()
	defer s.mu.Unlock()

	if !s.currentFile.active || s.currentFile.fileID != fileID {
		s.currentFile = currentFileState{fileID: fileID, active: true}
	}
	if s.currentFile.blocked {
		return fileID, true, false
	}

	s.currentFile.bytesSoFar += int64(len(frame))
	if s.currentFile.bytesSoFar > maxSize {
		s.currentFile.blocked = true
		return fileID, false, true
	}
	if isLast {
		s.currentFile = currentFileState{}
	}
	return fileID, false, false
}
