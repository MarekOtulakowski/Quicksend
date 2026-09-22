# Decisions

Short log of non-trivial choices: what was decided, why, and what was
rejected. Ordered oldest first.

## WebSocket library: `github.com/coder/websocket`

**What:** Use `coder/websocket` (formerly `nhooyr.io/websocket`) for the
relay's WebSocket handling, rather than `gorilla/websocket`.

**Why:** Minimal dependency-free implementation, context-aware
`Read(ctx)`/`Write(ctx, ...)` API that fits Go's standard context
cancellation idioms, and an actively maintained RFC 6455 compliance
suite. This is a mechanical/ergonomics choice, not a security-sensitive
one — either library would have worked.

**Rejected:** `gorilla/websocket` — equally valid, but its callback/deadline-based
API (`SetReadDeadline`, etc.) is less idiomatic against `context.Context`.

## Session ID vs. pairing code are different things

**What:** The relay generates a 128-bit random `sessionId`
(`crypto/rand`, base64url, 16 bytes) to route WebSocket messages between
two peers. This is *not* the short human-typed pairing code used for
the remote (PAKE) pairing flow, which will have far less entropy and
different protections (attempt limiting, short TTL).

**Why:** `sessionId` only needs to be unguessable enough that a third
party can't join someone else's pairing session before the real second
party does — it never appears in a UI a human types, so it can (and
should) carry full cryptographic entropy. The pairing *code*, by
contrast, must be short enough for a person to read over the phone,
so it needs PAKE plus attempt-limiting to stay safe with much less
entropy. Conflating the two would either make the code unusably long
or make the session ID guessable.

**Alternatives rejected:** Sequential/short session IDs (rejected —
guessable, would let an attacker "join" an active session's guest slot
before the intended peer).

## Relay is a mostly-opaque message pipe

**What:** The WebSocket handler and hub only parse/act on a small
allowlist of JSON message types: `create_session`, `join`, and
`end_session`. Every other message — including future `pake_msg`,
`file_meta`, `chunk_ack`, `role_swap_*`, etc. — is relayed byte-for-byte
between the two paired peers without being parsed or understood by the
server, whether it arrives as a text (JSON) or binary (file chunk)
WebSocket frame.

**Why:** This is what makes the "relay never sees plaintext" property
structurally true rather than just a promise: the server *can't*
inspect content it never parses. It also keeps the relay from needing
to know about pairing/crypto/transfer message formats as those evolve
in later build steps — only the small set of session-lifecycle
messages needs relay-side logic at all.

## `session.Conn.Send` is synchronous, not queued

**What:** The `ws` package's `conn.Send` writes directly to the
underlying WebSocket connection under a mutex, blocking the caller for
the write's duration (bounded by a 10s timeout), rather than enqueuing
onto an internal channel serviced by a separate writer goroutine.

**Why:** An earlier version used an async queue + writer goroutine to
serialize concurrent writers (a peer's own handler goroutine relaying
messages, plus the hub's background reaper sending session-lifecycle
notices). That introduced a real bug: `Send` returned as soon as the
message was *enqueued*, so code that did `sendError(...); conn.Close()`
could close the connection before the queued message was actually
flushed — the integration tests caught this as a "connection closed
before message received" failure. A mutex-guarded direct write makes
`Send` return only once the message is actually on the wire, so a
subsequent `Close()` can never race ahead of it. The mutex still solves
the original concurrent-writer problem (WebSocket connections don't
support concurrent `Write` calls).

## Per-IP client address trusts `X-Forwarded-For`/`X-Real-IP`

**What:** `clientIP()` in the `ws` package reads `X-Forwarded-For` (or
`X-Real-IP`) in preference to the raw TCP `RemoteAddr`, for the
purposes of the `QUICKSEND_MAX_SESSIONS_PER_IP` limit.

**Why:** Quicksend's documented deployment model terminates TLS at a
reverse proxy in front of the container, so `RemoteAddr` as seen by the
relay would otherwise always be the proxy's address, making the per-IP
limit meaningless (it would count every client as one IP: the proxy).

**Caveat:** this is only safe when the container is *not* directly
reachable from untrusted networks — otherwise these headers are
trivially spoofable and the limit becomes worthless. The example
`docker-compose.yml` keeps the relay off any publicly published port
other than through the proxy; anyone deploying without a trusted proxy
in front should be aware the per-IP limit offers no real protection in
that configuration.
