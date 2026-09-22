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
