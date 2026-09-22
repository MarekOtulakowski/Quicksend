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

## Code+PAKE: library, curve, and the WASM size tradeoff

**What:** `github.com/schollz/pake/v3` (SPAKE2), curve **P-256**,
compiled to WASM (`wasm/pake`) and loaded by `web/pake.js` — the same
Go package, not a parallel JS SPAKE2 implementation.

**Why:** this is the one place in the project where hand-rolling or
improvising was explicitly off the table from the start. schollz/pake
is the PAKE library behind `croc`, a widely-used file-transfer tool
solving the same problem (short code, relay, no direct connection),
which is real-world exposure rather than a from-scratch design. Before
committing to it, I ran an actual spike rather than trusting the docs:

- Confirmed empirically (not just by reading the source) that its
  wire messages (`Bytes()`) never leak the password or the private
  ephemeral scalar — both are stripped by a `Public()` copy before
  marshaling, even though the struct's Go field names are technically
  exported.
- Confirmed a correct shared password yields matching session keys on
  both sides, and a wrong one yields *different* keys without any
  protocol-level error — which is why key confirmation (below) exists
  at all.
- Curve: the library also offers its own "siec" curve, p384/p521, and
  an Edwards25519 adaptation. P-256 was chosen — and confirmed to work
  correctly in this library — for being the standard NIST curve with
  the widest independent scrutiny and implementation, over the
  library's own bespoke curve.
- WASM size: compiling this package for `GOOS=js GOARCH=wasm` produces
  a **~4.5MB binary (~1–1.3MB gzip/brotli-compressed)** — the Go
  runtime, not the PAKE logic itself, dominates that size. This is far
  more than a rough "few hundred KB" estimate made when the WASM
  approach was first proposed; the real number was confirmed by
  actually building it before proceeding, and reviewed explicitly
  before writing the rest of this feature. Decision: keep WASM anyway
  (one PAKE implementation is worth a one-time, service-worker-cached
  ~1MB download for a file-transfer tool), rather than switching to a
  separate vetted JS SPAKE2 library, or trying TinyGo (which has real,
  unverified gaps in `crypto/elliptic` support — not worth the risk
  for this specific code path).

**Rejected:** a separate JS SPAKE2 implementation (would reintroduce
the "two independent implementations" problem PAKE specifically was
called out as too risky for); TinyGo (unverified crypto stdlib
support); the library's non-standard "siec" curve as the default.

## PAKE key confirmation is homemade, on top of the library

**What:** After the SPAKE2 exchange, both sides independently compute
`HMAC-SHA256(sessionKey, "quicksend-pake-confirm")` and exchange it as
a `pake_confirm` message (relayed opaquely, like `pake_msg`). Each
side compares the *received* tag against its own computed value.
Mismatch means the two sides used different codes.

**Why:** confirmed empirically during the schollz/pake spike above —
the library has no built-in way to detect a wrong password; both
sides just complete the protocol and silently end up with different
keys. Without an explicit confirmation step, a mistyped code would
only surface much later as a failed decryption on the first real file
chunk, exactly the "sometimes doesn't connect" failure mode this
project is trying to avoid. A plain HMAC over the derived key with a
fixed context string is enough: it doesn't need to be a challenge or
carry any per-side asymmetry, because its only job is proving both
sides landed on the same key, not authenticating a specific party.

## Pairing code doubles as both the routing key and the PAKE password

**What:** The relay looks up `join_by_code`'s code to find the
matching session (the routing/matchmaking role), and the client uses
the *same* code as the SPAKE2 password. There's no separate secret.

**Why:** a 6-digit code communicated by voice/SMS is the only shared
secret the two humans have for this flow — there's nothing else to
split the routing key and the password from. This means a correct
guess is automatically a full compromise (finding the session *is*
knowing the password), which shapes the attempt-limiting design below:
protection has to happen at the *guessing* layer, not by trying to
keep the routing lookup and the password conceptually separate.

## Pairing-code brute-force protection: per-IP guess budget, not per-session

**What:** `join_by_code` tracks wrong guesses **per IP address** in a
rolling window matching the code's TTL (5 minutes): after
`QUICKSEND_MAX_PAIRING_ATTEMPTS` (default 5) wrong guesses, that IP is
rejected with `too_many_attempts` until the window rolls over. A code
itself is consumed (deleted from the registry) the moment any
`join_by_code` call matches it, whether or not the PAKE confirmation
that follows actually succeeds — so it's single-use regardless.

**Why:** the intro brief specified "5 wrong attempts per session, then
the session is invalidated," which is ambiguous once the code is both
the routing key and the password (previous entry): a wrong guess
usually doesn't match *any* session, so there's no specific target to
attribute the attempt to. Tracking the budget per guessing IP instead
directly targets the actual threat — a client scanning through the
~1,000,000-code space looking for *any* live session — regardless of
which (if any) session a given guess happened to almost hit. Combined
with the code's own short TTL and the existing per-IP concurrent
session limit, this keeps brute-forcing the whole code space
infeasible within any single code's lifetime. This was discussed and
confirmed explicitly before implementation, given the ambiguity.

## `clientIP` trust (see the earlier X-Forwarded-For entry) now also gates pairing-code brute-force protection

The per-IP guess budget above inherits the same trust assumption as
`QUICKSEND_MAX_SESSIONS_PER_IP`: it only meaningfully rate-limits
brute-force attempts when the relay sits behind a trusted reverse
proxy that sets `X-Forwarded-For`/`X-Real-IP` correctly, per the
earlier entry in this document.
