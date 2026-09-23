package ws

import (
	"context"
	"sync"
	"time"

	"github.com/coder/websocket"
)

const writeTimeout = 10 * time.Second

// conn adapts a coder/websocket.Conn to the session.Conn interface.
// WebSocket connections don't support concurrent writers, but a peer's
// connection can be written to both by its own handler goroutine
// (relaying messages it read) and by the hub's background reaper
// goroutine (session-lifecycle notifications), so every write is
// serialized through a mutex. Send blocks its caller for the duration
// of the write (bounded by writeTimeout); that's fine for control-plane
// traffic and, importantly, guarantees a message like session_ended is
// actually on the wire before a subsequent Close can run.
type conn struct {
	raw       *websocket.Conn
	mu        sync.Mutex
	closeOnce sync.Once
	closeErr  error
}

func newConn(raw *websocket.Conn) *conn {
	return &conn{raw: raw}
}

// Send implements session.Conn.
func (c *conn) Send(ctx context.Context, binary bool, data []byte) error {
	typ := websocket.MessageText
	if binary {
		typ = websocket.MessageBinary
	}

	writeCtx, cancel := context.WithTimeout(ctx, writeTimeout)
	defer cancel()

	c.mu.Lock()
	defer c.mu.Unlock()
	return c.raw.Write(writeCtx, typ, data)
}

// Ping sends a WebSocket ping and waits for the peer's pong (answered
// automatically by any spec-compliant client, including every
// browser — no application code needed on the other end). Per
// coder/websocket's docs, Ping relies on a concurrently-running Read
// loop to actually observe the pong frame; ServeHTTP's blocking read
// loop provides that. Held behind the same mutex as Send/Close since
// the underlying connection has no concurrent-writer support.
func (c *conn) Ping(ctx context.Context) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.raw.Ping(ctx)
}

// Close implements session.Conn. Safe to call more than once.
func (c *conn) Close(reason string) error {
	c.closeOnce.Do(func() {
		c.mu.Lock()
		defer c.mu.Unlock()
		c.closeErr = c.raw.Close(websocket.StatusNormalClosure, reason)
	})
	return c.closeErr
}
