package session

import (
	"context"
	"encoding/json"
	"sync"
	"testing"
	"time"

	"github.com/MarekOtulakowski/Quicksend/server/internal/config"
	"github.com/MarekOtulakowski/Quicksend/server/internal/proto"
)

// fakeConn is an in-memory Conn used to test hub logic without a real
// WebSocket.
type fakeConn struct {
	mu       sync.Mutex
	sent     []proto.Envelope
	closed   bool
	closeMsg string
}

func (f *fakeConn) Send(_ context.Context, _ bool, data []byte) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	var env proto.Envelope
	if err := json.Unmarshal(data, &env); err != nil {
		panic("test: sent non-envelope data: " + err.Error())
	}
	f.sent = append(f.sent, env)
	return nil
}

func (f *fakeConn) Close(reason string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.closed = true
	f.closeMsg = reason
	return nil
}

func (f *fakeConn) types() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]string, len(f.sent))
	for i, e := range f.sent {
		out[i] = e.Type
	}
	return out
}

func (f *fakeConn) isClosed() bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.closed
}

func testConfig() config.Config {
	return config.Config{
		MaxSessionsPerIP:         2,
		SessionInactivityTimeout: time.Minute,
		ReconnectGracePeriod:     30 * time.Second,
	}
}

// newTestHub returns a Hub whose clock is controlled by the returned
// function, so timeout/reap tests don't need real sleeps.
func newTestHub(cfg config.Config) (*Hub, *time.Time) {
	h := NewHub(cfg)
	now := time.Now()
	h.now = func() time.Time { return now }
	return h, &now
}

func TestCreateSessionSendsSessionCreated(t *testing.T) {
	h, _ := newTestHub(testConfig())
	host := &fakeConn{}

	s, role, err := h.CreateSession(context.Background(), "1.1.1.1", host)
	if err != nil {
		t.Fatalf("CreateSession error = %v", err)
	}
	if role != RoleHost {
		t.Errorf("role = %v, want RoleHost", role)
	}
	if s.ID == "" {
		t.Error("expected non-empty session ID")
	}
	if got := host.types(); len(got) != 1 || got[0] != proto.TypeSessionCreated {
		t.Errorf("host received %v, want [session_created]", got)
	}
}

func TestJoinSessionPairsBothPeers(t *testing.T) {
	h, _ := newTestHub(testConfig())
	host := &fakeConn{}
	guest := &fakeConn{}

	s, _, err := h.CreateSession(context.Background(), "1.1.1.1", host)
	if err != nil {
		t.Fatalf("CreateSession error = %v", err)
	}

	_, role, err := h.JoinSession(context.Background(), s.ID, "2.2.2.2", guest)
	if err != nil {
		t.Fatalf("JoinSession error = %v", err)
	}
	if role != RoleGuest {
		t.Errorf("role = %v, want RoleGuest", role)
	}

	if got := host.types(); len(got) != 2 || got[1] != proto.TypePaired {
		t.Errorf("host messages = %v, want [session_created paired]", got)
	}
	if got := guest.types(); len(got) != 1 || got[0] != proto.TypePaired {
		t.Errorf("guest messages = %v, want [paired]", got)
	}
}

func TestJoinUnknownSessionFails(t *testing.T) {
	h, _ := newTestHub(testConfig())
	_, _, err := h.JoinSession(context.Background(), "does-not-exist", "2.2.2.2", &fakeConn{})
	if err != ErrSessionNotFound {
		t.Errorf("err = %v, want ErrSessionNotFound", err)
	}
}

func TestJoinFullSessionFails(t *testing.T) {
	h, _ := newTestHub(testConfig())
	host := &fakeConn{}
	s, _, _ := h.CreateSession(context.Background(), "1.1.1.1", host)
	if _, _, err := h.JoinSession(context.Background(), s.ID, "2.2.2.2", &fakeConn{}); err != nil {
		t.Fatalf("first join failed: %v", err)
	}
	if _, _, err := h.JoinSession(context.Background(), s.ID, "3.3.3.3", &fakeConn{}); err != ErrSessionFull {
		t.Errorf("err = %v, want ErrSessionFull", err)
	}
}

func TestPerIPSessionLimit(t *testing.T) {
	cfg := testConfig()
	cfg.MaxSessionsPerIP = 1
	h, _ := newTestHub(cfg)

	if _, _, err := h.CreateSession(context.Background(), "1.1.1.1", &fakeConn{}); err != nil {
		t.Fatalf("first CreateSession failed: %v", err)
	}
	if _, _, err := h.CreateSession(context.Background(), "1.1.1.1", &fakeConn{}); err != ErrTooManySessions {
		t.Errorf("err = %v, want ErrTooManySessions", err)
	}

	// A different IP is unaffected.
	if _, _, err := h.CreateSession(context.Background(), "9.9.9.9", &fakeConn{}); err != nil {
		t.Errorf("CreateSession for different IP failed: %v", err)
	}
}

func TestRelayRawBytesPassThroughUnparsed(t *testing.T) {
	h, _ := newTestHub(testConfig())
	host := &fakeConn{}
	raw := &rawCaptureConn{}
	s, _, _ := h.CreateSession(context.Background(), "1.1.1.1", host)
	s.attach(RoleGuest, raw, "2.2.2.2", h.now())

	payload := []byte{0x01, 0x02, 0xFF, 0x00}
	if !h.Relay(context.Background(), s, RoleHost, true, payload) {
		t.Fatal("expected delivery")
	}
	if string(raw.last) != string(payload) {
		t.Errorf("relayed bytes = %v, want %v (byte-for-byte, unparsed)", raw.last, payload)
	}
	if !raw.lastBinary {
		t.Error("expected binary flag to be preserved")
	}
}

type rawCaptureConn struct {
	last       []byte
	lastBinary bool
}

func (r *rawCaptureConn) Send(_ context.Context, binary bool, data []byte) error {
	r.last = data
	r.lastBinary = binary
	return nil
}
func (r *rawCaptureConn) Close(string) error { return nil }

func TestEndSessionNotifiesAndClosesOtherPeer(t *testing.T) {
	h, _ := newTestHub(testConfig())
	host := &fakeConn{}
	guest := &fakeConn{}
	s, _, _ := h.CreateSession(context.Background(), "1.1.1.1", host)
	h.JoinSession(context.Background(), s.ID, "2.2.2.2", guest)

	h.EndSession(context.Background(), s, RoleHost)

	if !guest.isClosed() {
		t.Error("expected guest connection to be closed")
	}
	last := guest.sent[len(guest.sent)-1]
	if last.Type != proto.TypeSessionEnded {
		t.Errorf("last message to guest = %s, want session_ended", last.Type)
	}
	var payload proto.SessionEndedPayload
	json.Unmarshal(last.Payload, &payload)
	if payload.Reason != proto.ReasonEndedByPeer {
		t.Errorf("reason = %s, want %s", payload.Reason, proto.ReasonEndedByPeer)
	}

	// Session should be gone: joining it again fails.
	if _, _, err := h.JoinSession(context.Background(), s.ID, "3.3.3.3", &fakeConn{}); err != ErrSessionNotFound {
		t.Errorf("err = %v, want ErrSessionNotFound after EndSession", err)
	}
}

func TestDisconnectNotifiesOtherPeerAndReleasesIPSlot(t *testing.T) {
	cfg := testConfig()
	cfg.MaxSessionsPerIP = 1
	h, _ := newTestHub(cfg)
	host := &fakeConn{}
	guest := &fakeConn{}
	s, _, _ := h.CreateSession(context.Background(), "1.1.1.1", host)
	h.JoinSession(context.Background(), s.ID, "2.2.2.2", guest)

	h.HandleDisconnect(context.Background(), s, RoleHost)

	last := guest.types()
	if len(last) == 0 || last[len(last)-1] != proto.TypePeerDisconnected {
		t.Errorf("guest messages = %v, want last to be peer_disconnected", last)
	}

	// Host's IP slot should be released, so a *new* session from that IP
	// succeeds even though MaxSessionsPerIP is 1 and the old session
	// object still exists (pending reconnect grace period).
	if _, _, err := h.CreateSession(context.Background(), "1.1.1.1", &fakeConn{}); err != nil {
		t.Errorf("CreateSession after disconnect should succeed, got %v", err)
	}
}

func TestReapClosesSessionAfterInactivityTimeout(t *testing.T) {
	cfg := testConfig()
	cfg.SessionInactivityTimeout = time.Minute
	h, now := newTestHub(cfg)
	host := &fakeConn{}
	guest := &fakeConn{}
	s, _, _ := h.CreateSession(context.Background(), "1.1.1.1", host)
	h.JoinSession(context.Background(), s.ID, "2.2.2.2", guest)

	*now = now.Add(2 * time.Minute)
	h.ReapOnce()

	if !host.isClosed() || !guest.isClosed() {
		t.Error("expected both peers closed after inactivity timeout")
	}
	if _, _, err := h.JoinSession(context.Background(), s.ID, "3.3.3.3", &fakeConn{}); err != ErrSessionNotFound {
		t.Errorf("session should be removed after inactivity reap, err = %v", err)
	}
}

func TestReapClosesRemainingPeerAfterReconnectGraceExpires(t *testing.T) {
	cfg := testConfig()
	cfg.ReconnectGracePeriod = 30 * time.Second
	cfg.SessionInactivityTimeout = time.Hour
	h, now := newTestHub(cfg)
	host := &fakeConn{}
	guest := &fakeConn{}
	s, _, _ := h.CreateSession(context.Background(), "1.1.1.1", host)
	h.JoinSession(context.Background(), s.ID, "2.2.2.2", guest)

	h.HandleDisconnect(context.Background(), s, RoleHost)

	// Still within grace period: reaping should do nothing yet.
	*now = now.Add(10 * time.Second)
	h.ReapOnce()
	if guest.isClosed() {
		t.Fatal("guest closed too early, still within reconnect grace period")
	}

	// Grace period expires: guest should be notified session_ended and closed.
	*now = now.Add(30 * time.Second)
	h.ReapOnce()
	if !guest.isClosed() {
		t.Error("expected guest closed after reconnect grace period expired")
	}
	last := guest.sent[len(guest.sent)-1]
	var payload proto.SessionEndedPayload
	json.Unmarshal(last.Payload, &payload)
	if payload.Reason != proto.ReasonPeerTimeout {
		t.Errorf("reason = %s, want %s", payload.Reason, proto.ReasonPeerTimeout)
	}
}

func TestReapDoesNothingBeforeAnyTimeoutElapses(t *testing.T) {
	h, _ := newTestHub(testConfig())
	host := &fakeConn{}
	s, _, _ := h.CreateSession(context.Background(), "1.1.1.1", host)
	h.ReapOnce()
	if host.isClosed() {
		t.Error("session should not be reaped before any timeout elapses")
	}
	_ = s
}
