package session

import (
	"context"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
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
		PairingCodeTTL:           5 * time.Minute,
		MaxPairingAttempts:       5,
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

func TestCreateCodeSessionSendsCode(t *testing.T) {
	h, _ := newTestHub(testConfig())
	host := &fakeConn{}

	_, role, err := h.CreateCodeSession(context.Background(), "1.1.1.1", host)
	if err != nil {
		t.Fatalf("CreateCodeSession error = %v", err)
	}
	if role != RoleHost {
		t.Errorf("role = %v, want RoleHost", role)
	}
	if len(host.sent) != 1 || host.sent[0].Type != proto.TypeCodeSessionCreated {
		t.Fatalf("host received %v, want [code_session_created]", host.types())
	}
	var payload proto.CodeSessionCreatedPayload
	if err := json.Unmarshal(host.sent[0].Payload, &payload); err != nil {
		t.Fatalf("unmarshal payload: %v", err)
	}
	if len(payload.Code) != 6 {
		t.Errorf("code = %q, want 6 digits", payload.Code)
	}
	for _, c := range payload.Code {
		if c < '0' || c > '9' {
			t.Errorf("code = %q, want all digits", payload.Code)
		}
	}
}

func TestJoinByCodePairsBothPeers(t *testing.T) {
	h, _ := newTestHub(testConfig())
	host := &fakeConn{}
	guest := &fakeConn{}

	h.CreateCodeSession(context.Background(), "1.1.1.1", host)
	var created proto.CodeSessionCreatedPayload
	json.Unmarshal(host.sent[0].Payload, &created)

	_, role, err := h.JoinByCode(context.Background(), created.Code, "2.2.2.2", guest)
	if err != nil {
		t.Fatalf("JoinByCode error = %v", err)
	}
	if role != RoleGuest {
		t.Errorf("role = %v, want RoleGuest", role)
	}
	if got := guest.types(); len(got) != 1 || got[0] != proto.TypePaired {
		t.Errorf("guest messages = %v, want [paired]", got)
	}
	if got := host.types(); len(got) != 2 || got[1] != proto.TypePaired {
		t.Errorf("host messages = %v, want [code_session_created paired]", got)
	}
}

func TestJoinByCodeWrongCodeFails(t *testing.T) {
	h, _ := newTestHub(testConfig())
	host := &fakeConn{}
	h.CreateCodeSession(context.Background(), "1.1.1.1", host)
	var created proto.CodeSessionCreatedPayload
	json.Unmarshal(host.sent[0].Payload, &created)

	wrong := "000000"
	if wrong == created.Code {
		wrong = "111111"
	}
	if _, _, err := h.JoinByCode(context.Background(), wrong, "2.2.2.2", &fakeConn{}); err != ErrInvalidCode {
		t.Errorf("err = %v, want ErrInvalidCode", err)
	}
}

func TestJoinByCodeIsSingleUse(t *testing.T) {
	h, _ := newTestHub(testConfig())
	host := &fakeConn{}
	h.CreateCodeSession(context.Background(), "1.1.1.1", host)
	var created proto.CodeSessionCreatedPayload
	json.Unmarshal(host.sent[0].Payload, &created)

	if _, _, err := h.JoinByCode(context.Background(), created.Code, "2.2.2.2", &fakeConn{}); err != nil {
		t.Fatalf("first JoinByCode failed: %v", err)
	}
	// Second attempt with the same code, from a third party, must fail
	// even though the underlying session might still have a free-ish
	// state momentarily — the code itself is already consumed.
	if _, _, err := h.JoinByCode(context.Background(), created.Code, "3.3.3.3", &fakeConn{}); err != ErrInvalidCode {
		t.Errorf("err = %v, want ErrInvalidCode (code must be single-use)", err)
	}
}

func TestJoinByCodeExpiredFails(t *testing.T) {
	cfg := testConfig()
	cfg.PairingCodeTTL = 5 * time.Minute
	h, now := newTestHub(cfg)
	host := &fakeConn{}
	h.CreateCodeSession(context.Background(), "1.1.1.1", host)
	var created proto.CodeSessionCreatedPayload
	json.Unmarshal(host.sent[0].Payload, &created)

	*now = now.Add(5*time.Minute + time.Second)

	if _, _, err := h.JoinByCode(context.Background(), created.Code, "2.2.2.2", &fakeConn{}); err != ErrInvalidCode {
		t.Errorf("err = %v, want ErrInvalidCode after TTL expiry", err)
	}
}

func TestJoinByCodeRateLimitsWrongGuessesPerIP(t *testing.T) {
	cfg := testConfig()
	cfg.MaxPairingAttempts = 5
	h, _ := newTestHub(cfg)
	host := &fakeConn{}
	h.CreateCodeSession(context.Background(), "1.1.1.1", host)
	var created proto.CodeSessionCreatedPayload
	json.Unmarshal(host.sent[0].Payload, &created)

	attackerIP := "6.6.6.6"
	for i := 0; i < 5; i++ {
		wrong := fmt.Sprintf("%06d", i+900000) // won't collide with the real code in practice
		if _, _, err := h.JoinByCode(context.Background(), wrong, attackerIP, &fakeConn{}); err != ErrInvalidCode {
			t.Fatalf("attempt %d: err = %v, want ErrInvalidCode", i, err)
		}
	}

	// 6th attempt from the same IP is throttled, even with the *correct* code.
	if _, _, err := h.JoinByCode(context.Background(), created.Code, attackerIP, &fakeConn{}); err != ErrTooManyAttempts {
		t.Errorf("err = %v, want ErrTooManyAttempts", err)
	}

	// A different IP is unaffected and can still use the correct code.
	if _, _, err := h.JoinByCode(context.Background(), created.Code, "7.7.7.7", &fakeConn{}); err != nil {
		t.Errorf("JoinByCode from a fresh IP should succeed, got %v", err)
	}
}

func TestJoinByCodeGuessBudgetResetsAfterWindow(t *testing.T) {
	cfg := testConfig()
	cfg.PairingCodeTTL = 5 * time.Minute
	cfg.MaxPairingAttempts = 5
	h, now := newTestHub(cfg)
	ip := "8.8.8.8"

	for i := 0; i < 5; i++ {
		h.JoinByCode(context.Background(), fmt.Sprintf("%06d", i), ip, &fakeConn{})
	}
	if _, _, err := h.JoinByCode(context.Background(), "999999", ip, &fakeConn{}); err != ErrTooManyAttempts {
		t.Fatalf("expected budget exhausted, got %v", err)
	}

	*now = now.Add(cfg.PairingCodeTTL + time.Second)

	if _, _, err := h.JoinByCode(context.Background(), "999999", ip, &fakeConn{}); err != ErrInvalidCode {
		t.Errorf("after window reset, err = %v, want ErrInvalidCode (budget should have reset, not still blocked)", err)
	}
}

func TestReconnectResumesSessionAndNotifiesOtherPeer(t *testing.T) {
	h, _ := newTestHub(testConfig())
	host := &fakeConn{}
	guest := &fakeConn{}
	s, _, _ := h.CreateSession(context.Background(), "1.1.1.1", host)
	h.JoinSession(context.Background(), s.ID, "2.2.2.2", guest)

	token := []byte("host-reconnect-token")
	h.RegisterReconnectToken(s, RoleHost, token)

	h.HandleDisconnect(context.Background(), s, RoleHost)

	newHostConn := &fakeConn{}
	rs, role, err := h.Reconnect(context.Background(), s.ID, RoleHost, token, "3.3.3.3", newHostConn)
	if err != nil {
		t.Fatalf("Reconnect error = %v", err)
	}
	if rs != s || role != RoleHost {
		t.Fatalf("Reconnect returned (%v, %v), want (%v, RoleHost)", rs, role, s)
	}

	if got := newHostConn.types(); len(got) != 1 || got[0] != proto.TypeReconnected {
		t.Errorf("reconnecting conn received %v, want [reconnected]", got)
	}
	last := guest.types()
	if len(last) == 0 || last[len(last)-1] != proto.TypePeerReconnected {
		t.Errorf("guest messages = %v, want last to be peer_reconnected", last)
	}

	// The relay should now route through the new connection, not the
	// stale one that dropped.
	h.Relay(context.Background(), s, RoleGuest, false, []byte(`{"type":"pake_msg"}`))
	if len(newHostConn.types()) != 2 {
		t.Errorf("expected relay to reach the new host connection")
	}
	if got := len(host.types()); got != 2 {
		t.Errorf("the old, dropped host connection should not receive anything further, got %d messages", got)
	}
}

func TestReconnectRejectsWrongToken(t *testing.T) {
	h, _ := newTestHub(testConfig())
	host := &fakeConn{}
	s, _, _ := h.CreateSession(context.Background(), "1.1.1.1", host)
	h.RegisterReconnectToken(s, RoleHost, []byte("correct-token"))
	h.HandleDisconnect(context.Background(), s, RoleHost)

	_, _, err := h.Reconnect(context.Background(), s.ID, RoleHost, []byte("wrong-token"), "1.1.1.1", &fakeConn{})
	if err != ErrInvalidReconnectToken {
		t.Errorf("err = %v, want ErrInvalidReconnectToken", err)
	}
}

func TestReconnectRejectsUnknownSession(t *testing.T) {
	h, _ := newTestHub(testConfig())
	_, _, err := h.Reconnect(context.Background(), "does-not-exist", RoleHost, []byte("token"), "1.1.1.1", &fakeConn{})
	if err != ErrInvalidReconnectToken {
		t.Errorf("err = %v, want ErrInvalidReconnectToken", err)
	}
}

func TestReconnectRejectsWhenStillConnected(t *testing.T) {
	h, _ := newTestHub(testConfig())
	host := &fakeConn{}
	s, _, _ := h.CreateSession(context.Background(), "1.1.1.1", host)
	h.RegisterReconnectToken(s, RoleHost, []byte("token"))

	// Host never disconnected; a reconnect attempt for its slot must
	// not be able to hijack the still-live connection.
	_, _, err := h.Reconnect(context.Background(), s.ID, RoleHost, []byte("token"), "9.9.9.9", &fakeConn{})
	if err != ErrInvalidReconnectToken {
		t.Errorf("err = %v, want ErrInvalidReconnectToken", err)
	}
}

func TestReconnectWithoutRegisteredTokenFails(t *testing.T) {
	h, _ := newTestHub(testConfig())
	host := &fakeConn{}
	s, _, _ := h.CreateSession(context.Background(), "1.1.1.1", host)
	h.HandleDisconnect(context.Background(), s, RoleHost)

	// Never called RegisterReconnectToken: nothing should ever match.
	_, _, err := h.Reconnect(context.Background(), s.ID, RoleHost, []byte(""), "1.1.1.1", &fakeConn{})
	if err != ErrInvalidReconnectToken {
		t.Errorf("err = %v, want ErrInvalidReconnectToken", err)
	}
}

func TestReconnectReleasesGraceAndSurvivesReap(t *testing.T) {
	cfg := testConfig()
	cfg.ReconnectGracePeriod = 30 * time.Second
	cfg.SessionInactivityTimeout = time.Hour
	h, now := newTestHub(cfg)
	host := &fakeConn{}
	guest := &fakeConn{}
	s, _, _ := h.CreateSession(context.Background(), "1.1.1.1", host)
	h.JoinSession(context.Background(), s.ID, "2.2.2.2", guest)

	token := []byte("host-token")
	h.RegisterReconnectToken(s, RoleHost, token)
	h.HandleDisconnect(context.Background(), s, RoleHost)

	*now = now.Add(10 * time.Second)
	if _, _, err := h.Reconnect(context.Background(), s.ID, RoleHost, token, "3.3.3.3", &fakeConn{}); err != nil {
		t.Fatalf("Reconnect error = %v", err)
	}

	// Well past the original grace period: since the host reconnected,
	// the reaper must not tear the session down on that basis anymore.
	*now = now.Add(time.Minute)
	h.ReapOnce()
	if guest.isClosed() {
		t.Error("guest should not be closed: host successfully reconnected before the grace period expired")
	}
}

func TestReconnectRespectsPerIPSessionLimit(t *testing.T) {
	cfg := testConfig()
	cfg.MaxSessionsPerIP = 1
	h, _ := newTestHub(cfg)
	host := &fakeConn{}
	s, _, _ := h.CreateSession(context.Background(), "1.1.1.1", host)
	token := []byte("token")
	h.RegisterReconnectToken(s, RoleHost, token)
	h.HandleDisconnect(context.Background(), s, RoleHost)

	// The disconnect released 1.1.1.1's slot; occupy it with something
	// else so the reconnect attempt from the same IP is over budget.
	h.CreateSession(context.Background(), "1.1.1.1", &fakeConn{})

	_, _, err := h.Reconnect(context.Background(), s.ID, RoleHost, token, "1.1.1.1", &fakeConn{})
	if err != ErrTooManySessions {
		t.Errorf("err = %v, want ErrTooManySessions", err)
	}
}

// recordingConn captures every Send call (binary chunk frames as well
// as JSON envelopes), unlike fakeConn which panics on non-JSON data —
// needed here since these tests mix both on the same connection (a
// relayed chunk frame, then a relay-initiated file_abort envelope).
type recordingConn struct {
	mu   sync.Mutex
	sent []recordedSend
}

type recordedSend struct {
	binary bool
	data   []byte
}

func (r *recordingConn) Send(_ context.Context, binary bool, data []byte) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.sent = append(r.sent, recordedSend{binary, append([]byte(nil), data...)})
	return nil
}

func (r *recordingConn) Close(string) error { return nil }

func (r *recordingConn) binaryFrames() [][]byte {
	r.mu.Lock()
	defer r.mu.Unlock()
	var out [][]byte
	for _, m := range r.sent {
		if m.binary {
			out = append(out, m.data)
		}
	}
	return out
}

func (r *recordingConn) envelopes() []proto.Envelope {
	r.mu.Lock()
	defer r.mu.Unlock()
	var out []proto.Envelope
	for _, m := range r.sent {
		if m.binary {
			continue
		}
		var env proto.Envelope
		if json.Unmarshal(m.data, &env) == nil {
			out = append(out, env)
		}
	}
	return out
}

// fileAbortsReceived filters envelopes() down to file_abort messages
// only, since CreateSession/attach already put an unrelated
// session_created (or similar) envelope on these connections before
// any of these tests' Relay calls happen.
func (r *recordingConn) fileAbortsReceived() []proto.Envelope {
	var out []proto.Envelope
	for _, env := range r.envelopes() {
		if env.Type == proto.TypeFileAbort {
			out = append(out, env)
		}
	}
	return out
}

// buildChunkFrame constructs a binary chunk frame matching
// transfer.js's wire format (docs/PROTOCOL.md): type byte, last-chunk
// flag, 16-byte fileId, 8-byte BE chunk index, then ciphertextLen
// bytes of (here, meaningless — size tracking never reads them)
// payload.
func buildChunkFrame(fileID [16]byte, index uint64, isLast bool, ciphertextLen int) []byte {
	frame := make([]byte, chunkFrameHeaderLen+ciphertextLen)
	frame[0] = chunkFrameTypeFile
	if isLast {
		frame[1] = 1
	}
	copy(frame[2:18], fileID[:])
	binary.BigEndian.PutUint64(frame[18:26], index)
	return frame
}

func TestRelayAbortsFileExceedingMaxSize(t *testing.T) {
	cfg := testConfig()
	cfg.MaxFileSize = 50
	h, _ := newTestHub(cfg)
	host := &recordingConn{}
	guest := &recordingConn{}
	s, _, _ := h.CreateSession(context.Background(), "1.1.1.1", host)
	s.attach(RoleGuest, guest, "2.2.2.2", h.now())

	var fileID [16]byte
	copy(fileID[:], []byte("0123456789abcdef"))

	// 26-byte header + 100 bytes of "ciphertext" = 126 bytes, over the
	// 50-byte cap in a single frame.
	frame := buildChunkFrame(fileID, 0, false, 100)
	if !h.Relay(context.Background(), s, RoleHost, true, frame) {
		t.Fatal("expected the crossing frame itself to still be delivered")
	}

	if got := guest.binaryFrames(); len(got) != 1 || len(got[0]) != len(frame) {
		t.Fatalf("expected the crossing frame relayed exactly once, got %d frames", len(got))
	}

	for _, conn := range []*recordingConn{host, guest} {
		envs := conn.fileAbortsReceived()
		if len(envs) != 1 {
			t.Fatalf("expected exactly one file_abort to this peer, got %v", envs)
		}
		var payload proto.FileAbortPayload
		if err := json.Unmarshal(envs[0].Payload, &payload); err != nil {
			t.Fatalf("unmarshal file_abort payload: %v", err)
		}
		if payload.Reason != proto.FileAbortReasonSizeLimit {
			t.Errorf("reason = %q, want %q", payload.Reason, proto.FileAbortReasonSizeLimit)
		}
		if payload.FileID != hex.EncodeToString(fileID[:]) {
			t.Errorf("fileID = %q, want %q", payload.FileID, hex.EncodeToString(fileID[:]))
		}
	}

	// A further chunk for the same, already-aborted file must be
	// dropped, not relayed — an honest client stops on its own after
	// file_abort, but a slow/misbehaving one shouldn't keep costing
	// the relay bandwidth for a file it already rejected.
	h.Relay(context.Background(), s, RoleHost, true, buildChunkFrame(fileID, 1, false, 10))
	if got := guest.binaryFrames(); len(got) != 1 {
		t.Errorf("expected no further frames relayed for an already-aborted file, got %d", len(got))
	}
}

func TestRelayAllowsFileUnderMaxSize(t *testing.T) {
	cfg := testConfig()
	cfg.MaxFileSize = 1000
	h, _ := newTestHub(cfg)
	host := &recordingConn{}
	guest := &recordingConn{}
	s, _, _ := h.CreateSession(context.Background(), "1.1.1.1", host)
	s.attach(RoleGuest, guest, "2.2.2.2", h.now())

	var fileID [16]byte
	copy(fileID[:], []byte("0123456789abcdef"))

	for i := 0; i < 3; i++ {
		isLast := i == 2
		if !h.Relay(context.Background(), s, RoleHost, true, buildChunkFrame(fileID, uint64(i), isLast, 100)) {
			t.Fatalf("chunk %d: expected delivery", i)
		}
	}

	if got := guest.binaryFrames(); len(got) != 3 {
		t.Fatalf("expected all 3 chunks relayed, got %d", len(got))
	}
	for _, conn := range []*recordingConn{host, guest} {
		if envs := conn.fileAbortsReceived(); len(envs) != 0 {
			t.Errorf("expected no file_abort for a file under the limit, got %v", envs)
		}
	}
}

func TestRelayResetsFileSizeCounterAfterLastChunk(t *testing.T) {
	cfg := testConfig()
	cfg.MaxFileSize = 150
	h, _ := newTestHub(cfg)
	host := &recordingConn{}
	guest := &recordingConn{}
	s, _, _ := h.CreateSession(context.Background(), "1.1.1.1", host)
	s.attach(RoleGuest, guest, "2.2.2.2", h.now())

	var file1, file2 [16]byte
	copy(file1[:], []byte("file1-aaaaaaaaaa"))
	copy(file2[:], []byte("file2-bbbbbbbbbb"))

	// Each file is 100 bytes (under the 150-byte cap) sent as a single
	// last chunk. If the byte counter weren't reset after file1's last
	// chunk, file2 would wrongly appear as 200 bytes cumulative and
	// get blocked.
	h.Relay(context.Background(), s, RoleHost, true, buildChunkFrame(file1, 0, true, 74))
	h.Relay(context.Background(), s, RoleHost, true, buildChunkFrame(file2, 0, true, 74))

	for _, conn := range []*recordingConn{host, guest} {
		if envs := conn.fileAbortsReceived(); len(envs) != 0 {
			t.Errorf("expected no file_abort — each file is individually under the limit, got %v", envs)
		}
	}
	if got := guest.binaryFrames(); len(got) != 2 {
		t.Fatalf("expected both files' chunks relayed, got %d", len(got))
	}
}

func TestRelayDoesNotTrackNonChunkBinaryFrames(t *testing.T) {
	cfg := testConfig()
	cfg.MaxFileSize = 10
	h, _ := newTestHub(cfg)
	host := &recordingConn{}
	guest := &recordingConn{}
	s, _, _ := h.CreateSession(context.Background(), "1.1.1.1", host)
	s.attach(RoleGuest, guest, "2.2.2.2", h.now())

	frame := make([]byte, 200)
	frame[0] = 0x99 // not the recognized chunk-frame type; well over the 10-byte cap
	if !h.Relay(context.Background(), s, RoleHost, true, frame) {
		t.Fatal("expected delivery")
	}
	if got := guest.binaryFrames(); len(got) != 1 {
		t.Fatalf("expected the frame relayed once, got %d", len(got))
	}
	for _, conn := range []*recordingConn{host, guest} {
		if envs := conn.fileAbortsReceived(); len(envs) != 0 {
			t.Errorf("expected no file_abort for an unrecognized frame type, got %v", envs)
		}
	}
}
