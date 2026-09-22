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

## Key derivation chain: sessionKey → epochKey → fileKey

**What:** File encryption keys are derived through two HKDF-SHA256
steps, not directly from `sessionKey`:

```
epochKey = HKDF-SHA256(ikm=sessionKey, salt=epoch (4-byte BE uint32), info="quicksend-epoch-v1", len=32)
fileKey  = HKDF-SHA256(ikm=epochKey,   salt=fileID,                  info="quicksend-v1",       len=32)
```

`epoch` starts at 0 and increments by one on every successful
reconnect (both peers derive it identically, having jointly observed
the same sequence of reconnects — it's never sent over the wire).
`fileID` is a 16-byte per-file identifier generated by the sender.

**Why:** The intro brief specifically asked for key rotation across a
long session with multiple reconnects, rather than relying on a single
`sessionKey` unchanged for the session's entire lifetime, on the
reasoning that if a derived key were ever exposed (e.g. by a future
bug), the blast radius should be limited to one epoch's transfers, not
every file ever sent in that session. Rotating on every chunk would
address the same goal but is unnecessary overhead: chunk-level
uniqueness is already handled by the nonce (see below), so the actual
risk that motivates rotation — a derived *key* leaking — only needs to
be bounded per-reconnect. HKDF is used for both steps because it's a
standard, well-analyzed way to derive multiple independent-looking
keys from one secret via domain separation (distinct `info` strings)
and per-context salts; it introduces no new cryptographic assumptions
beyond "HKDF-SHA256 is a secure PRF," which is the same primitive the
scheme already depends on for `fileKey` itself.

**Note:** the reconnect token (below) is deliberately derived from the
*root* `sessionKey`, not a rotated epoch key, because it must remain
valid across the very reconnect event that advances the epoch counter.

**Status:** the derivation functions
(`cryptoutil.DeriveEpochKey`/`web/crypto.js`'s `deriveEpochKey`) are
implemented and cross-verified against `web/crypto.js` now; the
*trigger* — incrementing the epoch counter as part of a successful
reconnect handshake, kept synchronized on both sides — lands with the
reconnect build step. Until then, only epoch 0 is actually used.

## AES-256-GCM chunk framing: nonce and AAD construction

**What:** Each chunk is sealed with AES-256-GCM under `fileKey`:

- **Nonce** (12 bytes): 4 zero bytes + the chunk index as an 8-byte
  big-endian integer.
- **AAD**: `fileID (16 bytes) ‖ chunkIndex (8-byte BE) ‖ lastChunkFlag (1 byte: 0x00/0x01)`.
- Output is ciphertext with the 16-byte GCM tag appended, matching Web
  Crypto's default `AES-GCM` output layout so both sides produce
  identical bytes without extra reformatting.

**Why:** GCM's security requires a (key, nonce) pair never encrypt two
*different* plaintexts. Since `fileKey` is unique per file (via the
`fileID` HKDF salt), a nonce only needs to be unique per chunk index
*within* that file — a plain counter is sufficient and lets both sides
compute the nonce deterministically from data they already have,
with no extra field on the wire. Resending an unacked chunk after a
reconnect reuses the same (key, nonce, plaintext) triple, which is
safe (it's the *same* plaintext being re-encrypted, not a different
one) as long as retransmission always re-encrypts identical bytes.
Binding `chunkIndex` and the last-chunk flag into the AAD means a
receiver's AEAD tag check fails if a chunk is replayed at the wrong
position, spliced from a different file, or the stream is truncated
and the attacker tries to pass off an earlier chunk as the final one —
this is what the brief's "ochrona przed przestawieniem/obcięciem"
(protection against reordering/truncation) requires.

**Rejected:** a random nonce per chunk — would need to be transmitted
alongside the ciphertext (extra overhead per chunk) for no benefit,
since a deterministic counter nonce is already collision-free here.

## Cross-language test vectors live in `/testvectors`, not either implementation

**What:** `/testvectors/crypto_v1.json` holds frozen input/output pairs
for every derivation and chunk-encryption case. Both
`server/internal/cryptoutil` (Go, `go test`) and `web/crypto.js`
(`node --test web/crypto.test.mjs`) load and assert against this same
file, rather than each having its own hardcoded expectations.

**Why:** the point of the exercise is proving the two *independent*
implementations agree byte-for-byte, not just that each is internally
consistent. A shared, versioned fixture file makes that guarantee
explicit and keeps it from silently drifting if one side's test is
edited without the other's.

## Vendored QR libraries instead of a CDN or a bundler

**What:** `web/vendor/qrcode-generator.js` (MIT, kazuhikoarase) and
`web/vendor/jsQR.js` (Apache-2.0, cozmo/jsQR) are committed into the
repo, each an unmodified upstream build plus one appended
`export default ...;` line so they load as native ES modules. See
`web/vendor/NOTICE.md` for exact source/version.

**Why:** writing a QR encoder/decoder from scratch means reimplementing
Reed–Solomon error correction and finder-pattern detection — real
complexity worth not reinventing, unlike PAKE this isn't a security
primitive, so reusing a small, long-established, permissively-licensed
library is an ordinary engineering call rather than the kind of
decision that needed sign-off first. Vendoring rather than pointing at
a CDN keeps a self-hosted, privacy-focused tool from making runtime
requests to a third party, and keeps it working in offline/air-gapped
deployments. Both libraries are plain, dependency-free, single-file
builds, which made a one-line ESM shim enough — no bundler needed.

**Rejected:** pulling them from `cdn.jsdelivr.net` at runtime (rejected
for the third-party-request reason above); a bundler-based build step
just to get native ESM imports of these two files (unnecessary given
the one-line shim works).

## QR pairing link is scrubbed from the URL bar immediately on load

**What:** When a page loads with `#s=...&k=...` already in its URL
(the "opened the QR link directly" path), `pairing.js` calls
`history.replaceState` to remove the fragment before showing the
"join this session?" confirmation — not only if the user cancels.

**Why:** the fragment contains `sessionKey`. Leaving it sitting in the
visible address bar and in browser history for the whole confirmation
step (or indefinitely, if the user never acts) is an easy-to-avoid
exposure — a shoulder-surf, a screen share, or the browser's own
history/autocomplete UI could all leak it for no benefit, since the
key is already safely captured in memory by that point.
