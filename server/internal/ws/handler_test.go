package ws

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/MarekOtulakowski/Quicksend/server/internal/config"
	"github.com/MarekOtulakowski/Quicksend/server/internal/proto"
	"github.com/MarekOtulakowski/Quicksend/server/internal/session"
)

func testServer(t *testing.T) (*httptest.Server, *session.Hub) {
	t.Helper()
	cfg := config.Config{
		MaxSessionsPerIP:         10,
		SessionInactivityTimeout: time.Minute,
		ReconnectGracePeriod:     time.Second,
	}
	hub := session.NewHub(cfg)
	srv := httptest.NewServer(NewHandler(hub))
	t.Cleanup(srv.Close)
	return srv, hub
}

func wsURL(httpURL string) string {
	return "ws" + strings.TrimPrefix(httpURL, "http")
}

func dial(t *testing.T, url string) *websocket.Conn {
	t.Helper()
	c, _, err := websocket.Dial(context.Background(), url, nil)
	if err != nil {
		t.Fatalf("dial %s: %v", url, err)
	}
	t.Cleanup(func() { c.Close(websocket.StatusNormalClosure, "test done") })
	return c
}

func send(t *testing.T, c *websocket.Conn, msgType string, payload any) {
	t.Helper()
	var raw json.RawMessage
	if payload != nil {
		b, err := json.Marshal(payload)
		if err != nil {
			t.Fatalf("marshal payload: %v", err)
		}
		raw = b
	}
	b, err := json.Marshal(proto.Envelope{Type: msgType, Payload: raw})
	if err != nil {
		t.Fatalf("marshal envelope: %v", err)
	}
	if err := c.Write(context.Background(), websocket.MessageText, b); err != nil {
		t.Fatalf("write: %v", err)
	}
}

func readEnvelope(t *testing.T, c *websocket.Conn) proto.Envelope {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	typ, data, err := c.Read(ctx)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if typ != websocket.MessageText {
		t.Fatalf("read message type = %v, want text", typ)
	}
	var env proto.Envelope
	if err := json.Unmarshal(data, &env); err != nil {
		t.Fatalf("unmarshal envelope: %v (data=%s)", err, data)
	}
	return env
}

func TestEndToEndPairingAndRelay(t *testing.T) {
	srv, _ := testServer(t)
	url := wsURL(srv.URL)

	host := dial(t, url)
	send(t, host, proto.TypeCreateSession, nil)
	created := readEnvelope(t, host)
	if created.Type != proto.TypeSessionCreated {
		t.Fatalf("host got %s, want session_created", created.Type)
	}
	var createdPayload proto.SessionCreatedPayload
	if err := json.Unmarshal(created.Payload, &createdPayload); err != nil {
		t.Fatalf("unmarshal session_created payload: %v", err)
	}
	if createdPayload.SessionID == "" {
		t.Fatal("expected non-empty session ID")
	}

	guest := dial(t, url)
	send(t, guest, proto.TypeJoin, proto.JoinPayload{SessionID: createdPayload.SessionID})

	if env := readEnvelope(t, host); env.Type != proto.TypePaired {
		t.Fatalf("host got %s, want paired", env.Type)
	}
	if env := readEnvelope(t, guest); env.Type != proto.TypePaired {
		t.Fatalf("guest got %s, want paired", env.Type)
	}

	// A control-plane message the relay doesn't understand (e.g. a
	// future pake_msg) should pass through byte-for-byte.
	send(t, host, "pake_msg", map[string]string{"blob": "opaque-crypto-bytes"})
	relayed := readEnvelope(t, guest)
	if relayed.Type != "pake_msg" {
		t.Fatalf("guest got %s, want pake_msg relayed opaquely", relayed.Type)
	}

	// Binary frames (future file chunks) relay opaquely too.
	binaryPayload := []byte{0xDE, 0xAD, 0xBE, 0xEF}
	if err := host.Write(context.Background(), websocket.MessageBinary, binaryPayload); err != nil {
		t.Fatalf("write binary: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	typ, data, err := guest.Read(ctx)
	if err != nil {
		t.Fatalf("read binary: %v", err)
	}
	if typ != websocket.MessageBinary {
		t.Fatalf("guest got message type %v, want binary", typ)
	}
	if string(data) != string(binaryPayload) {
		t.Fatalf("guest got %v, want %v", data, binaryPayload)
	}

	// end_session tears the pairing down and notifies the other side.
	send(t, host, proto.TypeEndSession, nil)
	ended := readEnvelope(t, guest)
	if ended.Type != proto.TypeSessionEnded {
		t.Fatalf("guest got %s, want session_ended", ended.Type)
	}
	var endedPayload proto.SessionEndedPayload
	json.Unmarshal(ended.Payload, &endedPayload)
	if endedPayload.Reason != proto.ReasonEndedByPeer {
		t.Fatalf("reason = %s, want %s", endedPayload.Reason, proto.ReasonEndedByPeer)
	}
}

func TestJoinUnknownSessionReturnsError(t *testing.T) {
	srv, _ := testServer(t)
	c := dial(t, wsURL(srv.URL))

	send(t, c, proto.TypeJoin, proto.JoinPayload{SessionID: "does-not-exist"})
	env := readEnvelope(t, c)
	if env.Type != proto.TypeError {
		t.Fatalf("got %s, want error", env.Type)
	}
	var payload proto.ErrorPayload
	if err := json.Unmarshal(env.Payload, &payload); err != nil {
		t.Fatalf("unmarshal error payload: %v", err)
	}
	if payload.Code != proto.ErrCodeSessionNotFound {
		t.Errorf("code = %s, want %s", payload.Code, proto.ErrCodeSessionNotFound)
	}
}

func TestInvalidFirstMessageReturnsError(t *testing.T) {
	srv, _ := testServer(t)
	c := dial(t, wsURL(srv.URL))

	send(t, c, "not_a_real_type", nil)
	env := readEnvelope(t, c)
	if env.Type != proto.TypeError {
		t.Fatalf("got %s, want error", env.Type)
	}
}

func TestReconnectEndToEnd(t *testing.T) {
	srv, _ := testServer(t)
	url := wsURL(srv.URL)

	host := dial(t, url)
	send(t, host, proto.TypeCreateSession, nil)
	created := readEnvelope(t, host)
	var createdPayload proto.SessionCreatedPayload
	json.Unmarshal(created.Payload, &createdPayload)

	guest := dial(t, url)
	send(t, guest, proto.TypeJoin, proto.JoinPayload{SessionID: createdPayload.SessionID})
	readEnvelope(t, host)  // paired
	readEnvelope(t, guest) // paired

	// Both sides register their reconnect token right after pairing,
	// as pairing.js does.
	send(t, host, proto.TypeReconnectToken, proto.ReconnectTokenPayload{TokenHex: "aa"})
	send(t, guest, proto.TypeReconnectToken, proto.ReconnectTokenPayload{TokenHex: "bb"})

	// Host drops. Guest is told, but the session survives.
	host.Close(websocket.StatusNormalClosure, "simulated drop")
	if env := readEnvelope(t, guest); env.Type != proto.TypePeerDisconnected {
		t.Fatalf("guest got %s, want peer_disconnected", env.Type)
	}

	// Host reconnects with its registered token.
	newHost := dial(t, url)
	send(t, newHost, proto.TypeReconnect, proto.ReconnectPayload{
		SessionID: createdPayload.SessionID,
		Role:      proto.RoleHostWire,
		TokenHex:  "aa",
	})
	if env := readEnvelope(t, newHost); env.Type != proto.TypeReconnected {
		t.Fatalf("reconnecting host got %s, want reconnected", env.Type)
	}
	if env := readEnvelope(t, guest); env.Type != proto.TypePeerReconnected {
		t.Fatalf("guest got %s, want peer_reconnected", env.Type)
	}

	// The relay now routes through the new connection.
	send(t, newHost, "pake_msg", map[string]string{"blob": "post-reconnect"})
	relayed := readEnvelope(t, guest)
	if relayed.Type != "pake_msg" {
		t.Fatalf("guest got %s after reconnect, want pake_msg relayed opaquely", relayed.Type)
	}
}

func TestReconnectWrongTokenReturnsError(t *testing.T) {
	srv, _ := testServer(t)
	url := wsURL(srv.URL)

	host := dial(t, url)
	send(t, host, proto.TypeCreateSession, nil)
	created := readEnvelope(t, host)
	var createdPayload proto.SessionCreatedPayload
	json.Unmarshal(created.Payload, &createdPayload)
	send(t, host, proto.TypeReconnectToken, proto.ReconnectTokenPayload{TokenHex: "aa"})
	host.Close(websocket.StatusNormalClosure, "simulated drop")

	c := dial(t, url)
	send(t, c, proto.TypeReconnect, proto.ReconnectPayload{
		SessionID: createdPayload.SessionID,
		Role:      proto.RoleHostWire,
		TokenHex:  "bb",
	})
	env := readEnvelope(t, c)
	if env.Type != proto.TypeError {
		t.Fatalf("got %s, want error", env.Type)
	}
	var payload proto.ErrorPayload
	json.Unmarshal(env.Payload, &payload)
	if payload.Code != proto.ErrCodeInvalidReconnectToken {
		t.Errorf("code = %s, want %s", payload.Code, proto.ErrCodeInvalidReconnectToken)
	}
}

func TestPeerDisconnectNotifiesOtherSide(t *testing.T) {
	srv, _ := testServer(t)
	url := wsURL(srv.URL)

	host := dial(t, url)
	send(t, host, proto.TypeCreateSession, nil)
	created := readEnvelope(t, host)
	var createdPayload proto.SessionCreatedPayload
	json.Unmarshal(created.Payload, &createdPayload)

	guest := dial(t, url)
	send(t, guest, proto.TypeJoin, proto.JoinPayload{SessionID: createdPayload.SessionID})
	readEnvelope(t, host)  // paired
	readEnvelope(t, guest) // paired

	// Host disconnects abruptly (not via end_session).
	host.Close(websocket.StatusNormalClosure, "simulated drop")

	env := readEnvelope(t, guest)
	if env.Type != proto.TypePeerDisconnected {
		t.Fatalf("guest got %s, want peer_disconnected", env.Type)
	}
}

// TestKeepalivePingsDontDisconnectAResponsiveClient guards against the
// most likely way to get the keepalive ping loop (added after a real
// mobile network was silently dropping idle-looking connections — see
// docs/DECISIONS.md) wrong: accidentally disconnecting a perfectly
// healthy peer. A real browser always has an internal read pump
// answering pings automatically regardless of what application code
// is doing; this test's client simulates that with its own background
// reader, since coder/websocket only answers a ping during an active
// Read call (see its Ping docs) — without this goroutine, the test
// client just wouldn't reply and would falsely appear dead.
//
// It does not attempt to verify the reverse (an unresponsive peer
// actually gets disconnected) — reliably simulating "stops responding
// mid-connection" at the wire level from a test would need low-level
// socket manipulation that's disproportionate to what this loop does
// (send a ping, close on failure); that half is exercised by the ping
// timeout/close logic being a straightforward two-line error check.
func TestKeepalivePingsDontDisconnectAResponsiveClient(t *testing.T) {
	oldInterval, oldTimeout := pingInterval, pingTimeout
	pingInterval, pingTimeout = 30*time.Millisecond, 100*time.Millisecond
	t.Cleanup(func() { pingInterval, pingTimeout = oldInterval, oldTimeout })

	srv, _ := testServer(t)
	url := wsURL(srv.URL)
	host := dial(t, url)

	done := make(chan struct{})
	t.Cleanup(func() { <-done })
	go func() {
		defer close(done)
		for {
			if _, _, err := host.Read(context.Background()); err != nil {
				return
			}
		}
	}()

	send(t, host, proto.TypeCreateSession, nil)

	// Several ping cycles' worth of real time: if the loop were
	// mistakenly closing a responsive connection, sending anything
	// after this would fail.
	time.Sleep(20 * pingInterval)

	if err := host.Write(context.Background(), websocket.MessageText, []byte(`{"type":"end_session"}`)); err != nil {
		t.Fatalf("connection was closed despite responding to every ping: %v", err)
	}
}
