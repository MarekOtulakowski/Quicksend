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

**Status:** implemented. The reconnect build step wired up the
*trigger*: the reconnecting peer bumps its epoch on receiving
`reconnected`, the other peer bumps its on receiving
`peer_reconnected` — see docs/PROTOCOL.md's "Reconnect" section and the
"Reconnect: session-level resume, not transfer-level" entry below.

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
with no extra field on the wire. Resending an unacked chunk within the
same connection reuses the same (key, nonce, plaintext) triple, which
is safe (it's the *same* plaintext being re-encrypted, not a different
one) as long as retransmission always re-encrypts identical bytes. (A
session-level reconnect, by contrast, doesn't resend under the old
key at all — it moves to a new epoch key and the sender starts the
file over with a fresh fileId; see "Reconnect: session-level resume,
not transfer-level" below.) Binding `chunkIndex` and the last-chunk
flag into the AAD means a
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

## Raised the relay's WebSocket message-size limit for file chunks

**What:** `ws.maxMessageSize` (1MiB) is set via `Conn.SetReadLimit`
right after accepting each connection.

**Why:** found by an end-to-end test that hung, not by inspection —
`coder/websocket` defaults to a 32KiB max message size. A 256KiB file
chunk plus its framing overhead silently tripped this on the very
first real chunk of any transfer, and the library's response to an
oversized message is to close the connection, which surfaced as the
*other* peer's socket going "already CLOSING/CLOSED" with no error
pointing at the real cause. This is exactly the kind of
protocol-mismatch bug the project's testing strategy (real WebSocket
connections, not mocks) exists to catch before it ships.

## Pairing host is always the file receiver, guest the sender (for now)

**What:** `transfer-ui.js` shows the receiver UI to whichever side has
pairing role "host" and the sender UI to "guest" — the same role a
user picked by clicking "Receive" or "Send" during pairing (both QR's
`create_session`/`join` and code's `create_code_session`/`join_by_code`
always assign host to the "Receive" click and guest to "Send").

**Why:** simplest possible mapping with zero extra coordination
needed — the two roles are already established before pairing even
finishes, so there's nothing left to negotiate. Role swap (see the
entry below) is what lets the two sides flip which one is currently
sending without re-pairing.

**Status:** superseded by role swap — see "Role swap: client-side only,
mutual-consent, opaque to the relay" below. This mapping is now only
the *initial* transfer role, not a fixed one for the session's
lifetime.

## Metadata is encrypted like a chunk, at a reserved sentinel index

**What:** File metadata (name/size/MIME) is encrypted with the same
`EncryptChunk`/`encryptChunk` function used for file data, at chunk
index `2^64-1` (`cryptoutil.MetadataChunkIndex` /
`crypto.js`'s `METADATA_CHUNK_INDEX`), always with `last=true`.

**Why:** avoids a second AEAD construction (nonce/AAD scheme) just for
one small JSON blob per file. No real file could ever reach 2^64
chunks (that's exabytes at 256KiB/chunk), so the index can never
collide with real data. The test vector for this lives alongside the
regular chunk vectors in `/testvectors/crypto_v1.json`, with the index
itself hardcoded on both sides rather than round-tripped through JSON
(2^64-1 can't survive a JS `Number` round-trip).

## `chunk_ack` is sent after the sink handles the chunk, not after decryption

**What:** `transfer.js`'s receiver only sends `chunk_ack` for a chunk
once the caller's `onChunk` handler (e.g. `file-writer.js` writing it
to disk) has resolved — decrypting it isn't enough. Message processing
is serialized through a promise chain for the same reason.

**Why:** found by writing a test with an artificially slow sink before
wiring up the real UI, not by inspection. WebSocket `message` events
fire as frames arrive regardless of whether a previous (async) handler
has finished; without the fix, a chunk frame could start decrypting
before `onFileStart` (a native save-file picker can block on user
input for an arbitrary time) had finished setting up the current
file's state, or the sender's flow-control window could race ahead of
a slow sink and have a chunk silently dropped instead of properly
backpressured. The fix: `await` the handler before acking, and funnel
all incoming messages through one `Promise` chain so each is fully
handled before the next starts.

## Deferred for a later pass: ZIP bundling and Service Worker streaming

**What:** two pieces of the original file-transfer design aren't in
this build step: sending multiple files bundles them into a single
streamed ZIP (store/no-compression) on the receiving end; and Service
Worker–based streaming as a save fallback for browsers without the
File System Access API (currently: File System Access API, else an
in-memory Blob download with a size warning).

**Why:** both are substantial, separable pieces of engineering — a
correct streaming ZIP writer (local + central directory records, CRC32,
large-file handling) and a Service Worker message-channel pipeline —
that would have significantly inflated an already large build step
without changing whether the core transfer (encryption, framing, flow
control, saving) works correctly. Multiple files currently save as
separate files instead of one ZIP; large files on browsers without
File System Access currently fall back to buffering in memory (with a
size warning) instead of a disk-backed streamed write. Both are
reasonable v1 behavior, not silently dropped — flagged here and to the
user rather than assumed away.

## Reconnect: session-level resume, not transfer-level

**What:** a dropped WebSocket connection can resume the same session
(same `sessionKey`, same relay-side session object) without re-pairing,
via a bearer token registered right after pairing
(`cryptoutil.DeriveReconnectToken` / `reconnect_token` /
`reconnect` — see docs/PROTOCOL.md's "Reconnect" section). What it
*doesn't* do: resume a file transfer that was mid-flight at the moment
of the drop. `sendFile`/`attachReceiver` (`web/transfer.js`) both treat
the underlying socket closing as fatal to whatever transfer is
currently running — the sender's promise rejects instead of hanging on
acks that will never arrive, and the receiver discards the partial
file and reports an error — rather than trying to pick a chunk stream
back up on a new connection.

**Why:** true byte-level resume needs both sides to agree, after the
fact, on exactly which chunk to continue from (the sender's last-sent
vs. the receiver's last-durably-written index can disagree if the drop
happened between "chunk delivered" and "chunk_ack sent" — see the
`chunk_ack`-after-sink-write decision below), which is a meaningfully
bigger protocol (a resume handshake, per-file position tracking that
survives the connection, idempotent re-delivery) than "the session
still works, send the file again." Session-level resume already
delivers the more common case (the pairing survives a network blip
instead of forcing the user to re-scan a QR code or exchange a new
code), and re-sending a file after a drop is a minor inconvenience,
not a correctness or security problem. Full transfer resume is left
for a later pass if it turns out to matter in practice.

**How it works:** each peer computes `reconnectToken =
HMAC-SHA256(sessionKey, "quicksend-reconnect" ‖ sessionId)` once, right
after pairing, and registers it with the relay over the same
connection (`reconnect_token`) — the relay stores it opaquely (it's an
HMAC output derived from a key the relay never has, so it can't compute
or forge one itself) against that peer's slot. To resume, a client
opens a new connection and sends `reconnect` with its `sessionId`,
`role`, and that same token; the relay accepts only if the slot is
currently disconnected (not hijackable while still live) and the token
matches byte-for-byte (`crypto/hmac.Equal`, constant-time). On success
the reconnecting peer gets `reconnected` and the other peer gets
`peer_reconnected` — both bump their local epoch counter on their
respective message, which is how `epoch` (see the key-derivation
decision above) stays synchronized without ever crossing the wire.

**A code+PAKE client needs its `sessionId` for this**, which
`create_code_session`/`join_by_code` deliberately never exposed before
(only the human-facing pairing code was). Rather than plumb it through
a separate message just for the code flow, `paired`'s payload now
carries `sessionId` for *every* pairing path — harmless redundancy for
QR clients (which already know it from `session_created`), and the
only way a code+PAKE client learns it.

**Client-side re-render on reconnect:** rather than trying to hot-swap
a live socket reference inside an already-rendered transfer UI,
`pairing.js` just re-renders the whole post-pairing screen (fresh
epoch key, fresh socket reference) on both `reconnected` (self) and
`peer_reconnected` (other side). This is what makes the "resend after
a drop" UX simple: the screen comes back looking exactly like a fresh
paired session. The one thing this requires discipline about: the
*previous* render's `attachReceiver` listener is attached directly to
the socket object, which outlives a `peer_reconnected` re-render (only
the *other* peer's connection changed, not this one) — so
`renderTransferUI` returns a detach function, and `pairing.js` calls it
before every re-render. Missing this was caught immediately by an
ad-hoc Playwright run: without it, the stale listener kept trying to
decrypt new file traffic under the old epoch key and threw
`OperationError` on every `file_meta` after a reconnect (harmless here
only because the *new* listener also processed the same message
correctly, but a real leak that would accumulate one listener per
reconnect and log confusing errors forever).

**Retry budget:** the client retries opening a new connection up to 6
times, 2 seconds apart, before giving up and showing a "connection
lost" error — comfortably inside the relay's default 45s
`QUICKSEND_RECONNECT_GRACE_PERIOD` without the client needing to know
the server's exact configured value.

## Role swap: client-side only, mutual-consent, opaque to the relay

**What:** either paired peer can ask to flip which one is currently
sending and which is receiving, via `role_swap_request`/
`role_swap_response` (see docs/PROTOCOL.md). The relay never
participates — no Go code changes were needed at all beyond adding the
two message-type constants for documentation, since the existing
"relay only parses a small allowlist, everything else is opaque"
architecture already covered this by construction. No new crypto is
needed either: `fileKey` is derived from `epochKey` and a
sender-chosen `fileID` regardless of which peer is sending at a given
moment, so swapping roles doesn't touch key derivation at all.

**Why mutual consent, not unilateral:** a swap changes what the *other*
peer's UI needs to do (show a file picker vs. an incoming-file list),
so both sides need to agree before either one commits — a peer can't
unilaterally decide it's now the sender if the other peer is still
mid-way through actually sending it a file. Rejecting is silent and
cheap (a boolean check), so requiring consent costs nothing when both
sides are idle, which is the common case.

**Why swaps are refused mid-transfer:** allowing a swap while a file is
actively being sent/received would mean a receiver becoming a sender
partway through decrypting an in-progress file (or vice versa) — a
state transfer.js was never designed to handle mid-stream, and
supporting it would require pausing and resuming a `sendFile`/
`attachReceiver` pair with the transfer role flipped underneath them.
Refusing until idle is a one-line check with no such complexity, and
matches how reconnect already treats an in-flight transfer as
something to fail cleanly and restart rather than surgically resume.

**Two-message design (not three):** the "not yet in this document"
placeholder written before this build step imagined three messages
(`role_swap_request`/`_response`/`_applied`), but a third confirmation
adds no real synchronization value here — there's no shared,
relay-side state that depends on transfer role, so each peer can
safely flip the instant it has enough information to do so: the
responder flips right as it accepts (it already knows its own answer),
and the requester flips upon receiving that acceptance. Two messages is
the whole protocol.

**Simultaneous-request handling:** each client also treats "I have my
own request outstanding" as a busy reason for incoming requests. Found
necessary while testing: without it, two peers clicking "swap" within
the same round-trip window would both see the other as idle, both
accept, and both flip *twice* (once for their own outgoing request's
acceptance, once for the incoming request they auto-accepted) —
correctness-neutral in the sense that two flips cancel out, but
confusing and pointless. Rejecting both requests in that case is
simpler than trying to deterministically pick a winner.

**A genuinely "busy" scenario is hard to hit with only two peers:** by
construction, a transfer running between exactly two peers means
*both* are active for its duration (one sending, one receiving) — so
the common path is the *requester's own* local busy check firing, not
the responder's. The responder's independent busy check only matters
for a narrow race (a transfer starts in the moment between the request
being sent and received). This made it hard to test reliably: an
initial ad-hoc Playwright run using a real multi-megabyte file to
create a "mid-transfer" window found that localhost throughput could
finish the whole transfer faster than two separate Playwright
round-trips could even issue the next command, so the swap request
always landed after the transfer had *already* completed — not
actually testing the busy path at all. Verified properly by
intercepting the sender's outgoing WebSocket frames in the test and
holding them un-sent (so `sendFile` on that side, and the receiver
waiting on it, are both durably and deterministically still "active")
rather than racing real wall-clock transfer speed.

## Abort transfer: AbortSignal on the sender, an exposed method on the receiver

**What:** either side can cancel one in-progress file transfer without
ending the session, via `file_abort` (see docs/PROTOCOL.md). The
sender's `sendFile` (`web/transfer.js`) takes a standard
[`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal)
— the same convention `fetch` uses — and rejects with a
`DOMException` named `"AbortError"` when canceled, so callers can
`if (err.name === "AbortError")` to show "Canceled" instead of "Error".
The receiver's `attachReceiver` instead returns an `abortCurrent()`
method directly (there's no equivalent "cancel this fetch" object to
reuse — a receiver isn't the one holding a controller for an operation
it initiated), which cancels whichever file is currently arriving.

**Why either side can send `file_abort`, and why the receiver never
echoes it back:** a sender giving up and a receiver declining are both
real scenarios (wrong file selected; changed your mind; the incoming
file turns out to be something you don't want after all), so the
message needs to work in both directions. Whichever side receives a
`file_abort` for its current file just abandons it — it must **not**
also send its own `file_abort` back, or two peers cancelling
"at each other" would ping-pong the message forever. `sendFile` tracks
this with a `{ remote: bool }` flag: `remote: true` (received a
`file_abort`) suppresses re-sending it; `remote: false` (the local
`AbortSignal` fired) sends it once.

**Why chunk frames for an aborted file are silently dropped, not
errored:** aborting is inherently racy — the side that didn't initiate
it doesn't find out until the `file_abort` message actually arrives,
and whatever the other side already had in flight over the network
before then still shows up afterward. `attachReceiver`'s "no file
currently in progress" case used to be a hard error ("received a chunk
before file_meta"), which was fine when the only way to reach that
state was a genuine protocol violation; extended to normal operation
(a stray post-abort chunk lands in exactly the same state), a hard
error would surface as spurious "transfer error" noise for a
completely expected race. Same reasoning on the UI side
(`transfer-ui.js`): each row tracks a `done` flag so a late `onChunk`
call for an already-aborted/completed file is a silent no-op instead
of writing to (or crashing on) an already-closed sink.

**Why a swap-mid-transfer-style busy check isn't needed here:**
aborting doesn't require the other side's permission — unlike role
swap (which changes what UI the *other* peer needs to show), a cancel
is a unilateral "stop, I'm done with this" that the other side simply
has to honor. There's no mutual-consent handshake, no busy/rejection
path, and no race to guard against beyond the ordinary "message is in
flight" one already covered above.

**Verified with the same held-frame Playwright technique as role
swap's busy check** (see the entry above) — a genuinely mid-transfer
cancel needed the sender's outgoing frames held back deterministically
rather than racing real localhost throughput, for the same reason.

## Link sharing: three-tier fallback, and a warning that's always visible

**What:** the receiver's QR/link screen (and, as a small extra, the
code+PAKE screen) got a "Share"/"Copy" button and a persistent security
warning. The button tries, in order: `navigator.share` (native OS
share sheet), then `navigator.clipboard.writeText` (silent copy), then
falls back to just telling the user to copy the already-visible text
manually. No wire-protocol change — this is a client-only convenience
around a URL/code that already existed.

**Why try Web Share before Clipboard Write:** on a phone (the case
this matters most for — sending someone a link via whatever messaging
app they actually use), the native share sheet is both more discoverable
and lets the user pick the destination app directly, instead of forcing
a copy-then-manually-open-the-app-then-paste round trip. Clipboard
Write is the desktop-friendly fallback where a share sheet either
doesn't exist or is less natural. The final manual-copy hint exists
because both APIs generally require a secure context (HTTPS or
localhost), which — as later discovered and corrected in README.md —
plain HTTP to a LAN IP never is, so the fallback chain has to degrade
to "you can still read and copy this text yourself" rather than
silently doing nothing.

**Why the warning is always visible, not just shown after clicking
Share:** the security-relevant fact — that this URL *is* full access to
the pairing, not a harmless preview link — is exactly as true whether
the user shares it via the button, screenshots the QR code, or reads
it aloud. Gating the warning behind the Share button would miss every
other way the link leaves the screen. This mirrors the threat model
already documented in README.md: the link/QR carries the actual
session key, so "don't send this to the wrong person" is the one thing
worth surfacing unconditionally, not an opt-in tip.

**Why the pairing *code* doesn't get the same warning:** a 6-digit
code alone can't compromise anything — it's a PAKE password, not a key
(see the "code doubles as routing key and PAKE password" decision
above), and the whole design point of code+PAKE pairing is that the
code is meant to be read out over an untrusted channel. It still got a
"Copy code" button for convenience (pasting into a chat is a common
real use), just without the warning that doesn't apply to it.

**Verified with Playwright** against a real (non-mocked) `navigator.clipboard`,
granted via the browser context's `clipboard-read`/`clipboard-write`
permissions — confirming not just that a "copied" status appears, but
that the clipboard's actual contents match the displayed link/code
exactly, not just some copy attempt that silently copied the wrong
string.

## MAX_FILE_SIZE_BYTES enforcement: reading the chunk-frame header, not the ciphertext

**What:** `QUICKSEND_MAX_FILE_SIZE_BYTES` was loaded and validated
from day one (`server/internal/config`) but never actually enforced —
flagged as a known gap while writing the README's configuration table,
and left open through several build steps since. It's now enforced in
`session.Session.recordChunkBytes`, called from `Hub.Relay` for every
binary frame: it sums frame lengths per in-flight fileId, and once a
file's running total exceeds the limit, the relay sends `file_abort`
(`reason: "size_limit_exceeded"`) to both peers and drops any further
frames for that file.

**Why this doesn't compromise "the relay never sees plaintext":** the
chunk frame's outer header — frame type, fileId, chunk index,
last-chunk flag (see docs/PROTOCOL.md) — was already designed to carry
no content: fileId is 16 random bytes with no meaning beyond "same
file, different chunk," the index is just a position counter, and the
flag reveals nothing about what's being sent. None of it is
ciphertext, and `recordChunkBytes` never reads past byte 26 of a
frame. This is a genuinely different case from, say, parsing
`file_meta`'s payload (which *is* encrypted content the relay must
never touch) — the header was always metadata the relay receives as
plain framing, whether or not any Go code happened to look at it.
Enforcing a real per-file limit this way is strictly better than the
alternative once considered (a total-bytes-relayed-per-session
counter): it matches what the config variable actually says
("max size of a **single file**") instead of a looser proxy for it.

**Why reuse `file_abort` instead of a new message type:** the relay
telling both peers "stop, this file is too big" is semantically
identical to a client cancelling — same cleanup on both sides (discard
partial state, stay paired, ready for the next file), same UI concept
(a canceled row). Reusing it meant **zero client-side protocol
changes** were needed for enforcement to work at all; the only client
change was cosmetic — plumbing a `reason` field through so "File too
large" can be shown instead of a generic "Canceled" (see
`FileAbortPayload.Reason` / `attachReceiver`'s and `sendFile`'s
`onAborted`/rejected-error handling). This is also why `file_abort`'s
doc comment now says "normally opaque... the one exception": every
other message in that opaque set is *never* something the relay itself
originates, only relays.

**Why the crossing frame is still relayed instead of dropped
immediately:** the goal is bounding relay resource usage per file, not
byte-exact content policing — relaying one frame past the limit before
cutting off is a rounding error against limits meant to be measured in
MB/GB, and simplifies the logic (no need to buffer or inspect the
frame before deciding).

**Verified against a live server** with
`QUICKSEND_MAX_FILE_SIZE_BYTES` set low via Playwright: an oversized
file gets cut off with the right status on both sides, and — the part
that would have been easy to get wrong — the session keeps working
normally for a subsequent file under the limit afterward, proving the
per-file counter actually resets rather than wedging the session.

## docker-compose.yml: Caddy specifically, and the relay never gets a published port

**Status:** the Caddy image and which port(s) are published both
changed after this entry was written — see "Production TLS: Cloudflare
DNS-01, not the default HTTP-01" below for the current setup (a
custom-built Caddy image, port 80 no longer published at all). The
reasoning below for picking Caddy itself, and for the relay never
having a published port, still holds.

**What (as originally built):** the example production
`docker-compose.yml` runs two services — the relay (built from the
repo's own `Dockerfile`, no `ports:` entry) and `caddy:2-alpine` (the
only one with published ports, 80 and 443) reverse-proxying to the
relay over the compose file's default internal network. The domain to
request a certificate for comes from `QUICKSEND_DOMAIN`, read from a
gitignored `.env` (a committed `.env.example` documents it); the
Caddyfile references it via Caddy's own `{$VAR}` env-var substitution
rather than needing any templating step.

**Why Caddy, specifically, for the example:** the brief left the choice
of reverse proxy open (Caddy, Traefik, and Cloudflare Tunnel are all
mentioned in the README as valid options) — Caddy was picked for the
one committed example because it gets automatic TLS via Let's Encrypt
from a two-line config with no separate ACME client, cert-renewal
cron job, or manual Certbot setup, and its `reverse_proxy` directive
handles WebSocket upgrades transparently with no extra configuration
(unlike some nginx setups, which need explicit `Upgrade`/`Connection`
header passthrough directives). That combination minimizes the config
surface a self-hoster has to get right just to stand the relay up
correctly, which matters more here than for a general-purpose example.

**Why the relay has no published port at all**, not even bound to
localhost: it doesn't need one — Caddy reaches it over the compose
network's internal DNS (`quicksend:8080`) regardless of whether the
host publishes anything. Leaving it unpublished is what makes the
already-documented `X-Forwarded-For` trust decision (see "Per-IP
client address trusts X-Forwarded-For/X-Real-IP" above) actually safe
in this deployment, rather than merely asserted in a comment: there's
no way to reach the relay directly and spoof that header, short of
already being inside the Docker host.

**Why `QUICKSEND_DOMAIN` is a required env var** (`${QUICKSEND_DOMAIN:?...}`
rather than a default): a docker-compose example is something people
copy and run; a silent fallback to some placeholder domain would let
someone `docker compose up` against a domain they don't own, which
would either fail obscurely (no DNS) or, worse, partially succeed in
confusing ways. Failing loudly with a clear message beats a working
default here.

**Verified against a real local run**, not just `docker compose
config`: built and started both containers via `docker compose up
--build`, confirmed the relay's own healthcheck reports healthy,
confirmed Caddy auto-provisions a certificate (using its internal CA
for a non-public `localhost` test domain — Let's Encrypt itself can
only be exercised against a real public domain, which isn't available
in this environment) and correctly issues an HTTP→HTTPS redirect, and
ran a full Playwright pairing-and-transfer test through
`https://localhost` end-to-end — proving the WebSocket upgrade, not
just plain HTTP requests, actually survives Caddy's proxying.

## Real-device bug: plain-HTTP LAN use silently broke everything past pairing

**What:** reported by the user testing against the Docker Desktop
container from a phone on the LAN: pairing via QR appeared to succeed
("Paired!" showed on both sides), but neither side ever got a working
transfer screen — no file picker for the sender, no "waiting for
files" for the receiver, no visible error at all. Root-caused by
reproducing it with Playwright pointed at the machine's real LAN IP
(`http://<LAN IP>:8080`, exactly matching README's own — as it turned
out, wrong — advice) instead of `localhost`: `window.isSecureContext`
is `false` and `window.crypto.subtle` is `undefined` there, and every
uncaught `TypeError` from calling into it (`deriveReconnectToken`
right after pairing, `deriveEpochKey` when the transfer UI tries to
render) was silently swallowed by a missing `.catch()`, so the
observable symptom was just "nothing happens."

**Why plain HTTP to a LAN IP breaks this and `localhost` doesn't:**
browsers only expose the Web Crypto API (`crypto.subtle`) in a
"secure context" — HTTPS, or the special-cased `localhost`/`127.0.0.1`
— never plain HTTP to any other host, including a private LAN address.
`crypto.getRandomValues` has no such restriction, which is exactly why
pairing (QR fragment key generation) looked fine while everything
downstream of it (PAKE confirmation, the reconnect token, all file
encryption) silently failed. This had gone unnoticed through every
earlier build step because every test — the entire Playwright test
suite built up over this whole project — ran against `http://localhost`,
which is exempt from the restriction by spec; nothing in automated
testing ever exercised the actual cross-device LAN scenario the app
exists for.

**Two-part fix:**

1. **Fail loudly instead of silently** (`web/pairing.js`'s
   `initPairing`): check `window.isSecureContext` up front, before
   rendering anything else, and show a plain-language error explaining
   why and how to fix it, instead of letting the app half-render and
   leave the user staring at nothing. This alone doesn't restore
   functionality on an insecure origin (nothing can — it's a browser
   platform restriction, not a bug fixable in application code without
   hand-rolling cryptography, which is out of scope by the original
   brief), but turns an undiagnosable silent failure into an
   actionable message.
2. **Give LAN testing a real working path**: `docker-compose.yml`
   already existed for production use with a real domain; the fix
   documents (README's new "LAN testing between two real devices"
   section) using the *same* compose file with `QUICKSEND_DOMAIN` set
   to the LAN IP instead. This surfaced a second, narrower bug in the
   Caddyfile itself — see the next entry.

**Verified** against the exact failure mode: reproduced the silent
failure on plain HTTP to a real LAN IP via Playwright first (confirming
the diagnosis, not just theorizing about it), confirmed the new error
screen appears and blocks role-select instead, then confirmed a full
pairing-and-transfer flow succeeds end-to-end once served over HTTPS
via docker-compose with the LAN IP as `QUICKSEND_DOMAIN`.

## Caddy needs `default_sni` for a bare-IP `QUICKSEND_DOMAIN`

**Status:** the scenario this fixed (self-signed LAN-IP testing) was
later ruled out entirely — see "Production TLS: Cloudflare DNS-01"
below — but the option itself is left in the Caddyfile, since it's
harmless for a real domain (which always sends proper SNI) and costs
nothing to keep.

**What:** using a LAN IP address as `QUICKSEND_DOMAIN` (per the fix
above) failed at the TLS layer even though Caddy had already obtained
a valid certificate for that exact identifier — every connection to
`https://<LAN IP>` got a generic TLS "internal error" alert, both from
curl and from real Chromium. Fixed by adding a global `default_sni
{$QUICKSEND_DOMAIN}` option to the Caddyfile.

**Why:** TLS's SNI extension is meant to carry a hostname, and RFC 6066
says clients shouldn't send it for literal IP addresses — in practice,
neither curl nor Chromium send SNI when connecting to a bare IP.
Caddy's automatic HTTPS normally picks which certificate to present
for a connection by matching the ClientHello's SNI against its
per-site configuration; with no SNI sent at all, it had nothing to
match against and refused the handshake outright, *despite* already
holding a perfectly valid certificate for the one site actually
configured. `default_sni` tells Caddy which name to assume when a
connection arrives with no SNI, which is exactly the "bare IP, no
hostname" case. This is invisible for the real production case (a
public domain), since normal browsers always send SNI for an actual
hostname — it only bites the "use an IP as a stand-in domain for local
testing" case this fix specifically exists for.

**Verified** the same way as the fix above: curl and a real (non-mocked)
Chromium browser both reached `https://<LAN IP>/` successfully after
adding this option, both having failed identically before it.

## Choosing a save folder once instead of a dialog per file

**What:** `file-writer.js` gained `chooseSaveDirectory()` (wraps
`showDirectoryPicker({mode: "readwrite"})`) and `createFileSink` now
accepts an optional `FileSystemDirectoryHandle`; when given one, it
creates the file directly inside that folder
(`dirHandle.getFileHandle(name, {create: true})`) with no dialog at
all. `transfer-ui.js`'s receiver screen shows a "Choose save folder"
button that, once clicked, applies to every file received for the
rest of that session — falling back to the original per-file
`showSaveFilePicker` prompt (and from there, the Blob-download
fallback) for anyone who skips it or whose browser lacks
`showDirectoryPicker`.

**Why a button the user must click, not something automatic:**
`showDirectoryPicker`, like `showSaveFilePicker`, only works in
response to a genuine user gesture — calling it automatically (e.g.
as soon as the receiver screen renders) throws, since there's no click
to satisfy the browser's transient-activation requirement. This is a
hard platform constraint, not a design choice: the "ask once, remember
it" flow the user asked for is only reachable by making that one ask
an explicit click.

**Why filenames get deduplicated (`" (1)"`, `" (2)"`, ...) only in this
mode:** writing straight into a chosen folder means a second file with
the same name as an earlier one in the same session would silently
overwrite it via `getFileHandle(name, {create: true})` — there's no
per-file dialog left for the user to notice and rename it themselves,
unlike the two fallback modes (a native save dialog, or a browser's own
download-manager renaming) which both already handle that on their
own. A simple in-memory `Set` of names used so far in this render is
enough; it resets if the user picks a different folder mid-session.

**Verified** with Playwright end-to-end over the real HTTPS deployment:
sent two files with the identical name after choosing a folder (backed
by a real origin-private-file-system directory handle, since
`showDirectoryPicker` itself can't be driven headlessly) and confirmed
both landed on "disk" as distinct files (`same-name.txt` and
`same-name (1).txt`), not one silently overwriting the other.

## Sender file picker: styled via `::file-selector-button`, plus drag-and-drop

**What:** the sender's `<input type="file" multiple>` had no styling
at all — it rendered as the browser's small default control, easy to
overlook (raised by the user after the secure-context fix, asking
whether a file-choosing button even existed). It's now wrapped in a
`.drop-zone` that also accepts a drag-and-drop of files from the
desktop, sharing the same `sendFiles()` path as the button so both
routes get identical per-file rows, progress, cancel, and error
handling.

**Why style the real `<input>` via `::file-selector-button` instead of
the common hidden-input-plus-styled-label trick:** it keeps the
element's native semantics and accessibility (keyboard focus,
screen-reader labeling, right-click "reveal" behavior) fully intact —
`::file-selector-button` is a standard CSS pseudo-element for exactly
this button, supported in all current major browsers, so there's no
need to fake a button and proxy clicks to a hidden input.

**Why drag-and-drop doesn't get its own send path:** `dataTransfer.files`
on a `drop` event is a `FileList`, the same shape `input.files` is —
both are normalized to a plain array and handed to the same
`sendFiles(files)` function, so there's exactly one place that owns
per-file row creation, the abort controller, and error handling,
rather than two parallel implementations to keep in sync.

**Why a drop while already sending is silently ignored, not queued:**
matches the existing behavior of the button itself, which the browser
makes unclickable (`input.disabled`) during a send — there was already
an implicit "only one batch in flight at a time" rule; a drop needed
its own explicit `if (sending) return` to honor the same rule, since
nothing native disables a `<div>` drop target.

**Verified** with Playwright by dispatching a real `dragenter`/`drop`
sequence carrying a `DataTransfer` (the standard way to drive HTML5
drag-and-drop without an actual OS-level drag gesture, which can't be
scripted) against a live paired session: confirmed the drop zone's
active-state styling toggles on `dragenter`, the dropped file sends
and is received successfully, and the ordinary click-to-pick button
still works immediately afterward in the same session.

## Production TLS: Cloudflare DNS-01, not the default HTTP-01

**What:** `docker-compose.yml`'s Caddy service now proves domain
ownership to Let's Encrypt via a DNS TXT record created through
Cloudflare's API (`tls { dns cloudflare {env.CLOUDFLARE_API_TOKEN} }`
in the Caddyfile), instead of Caddy's default behavior of answering an
inbound HTTP request on port 80 (the "HTTP-01" challenge). Only port
443 is published in `docker-compose.yml` now; port 80 is gone
entirely. Since the stock `caddy:2-alpine` image doesn't include any
DNS provider module, `caddy/Dockerfile` builds one from source via
`xcaddy build --with github.com/caddy-dns/cloudflare` — the officially
documented way to add a Caddy module — rather than pulling a
third-party prebuilt image with unknown provenance, consistent with
how the rest of this project builds everything (the PAKE WASM module,
the relay itself) from source rather than trusting prebuilt artifacts.

**Why this changed from the earlier HTTP-01 default:** requested by
the user, who didn't want to open port 80 on their VPS's firewall at
all — a reasonable stance; HTTP-01 needs an unauthenticated inbound
port reachable from the entire internet just to prove domain
ownership, which is more exposure than the DNS-01 alternative
requires. This also happened to make the earlier idea of testing with
`QUICKSEND_DOMAIN` set to a bare LAN IP a dead end for this same
compose file going forward: DNS-01 fundamentally needs a real domain
whose DNS records Caddy (via Cloudflare's API) can modify, which an IP
address doesn't have — that path is documented as no longer available
in README's "Testing between two real devices" section, after two
alternatives (accepting a self-signed certificate's warning, and
installing Caddy's local CA as a trusted root) were both explicitly
ruled out by the user: browsers on their real iOS/Android devices
hard-blocked the self-signed warning path rather than merely warning
about it, and installing a foreign root CA on a personal phone is a
real, standing trust decision they were right not to make lightly —
it would let that CA impersonate *any* site, not just this one.

**Why a scoped API token, not the account's Global API Key**
(documented in `.env.example`): a token restricted to "Zone / DNS /
Edit" on just the one zone that owns `QUICKSEND_DOMAIN` limits the
blast radius if it's ever leaked (e.g. via a compromised VPS) to DNS
records on that single domain — the Global API Key can modify
anything on the whole Cloudflare account, which is a needlessly large
amount of trust to hand to one server for one purpose.

**Verified:** built `caddy/Dockerfile` and confirmed the Cloudflare
module actually compiles in and is recognized (`caddy build-info`
equivalent: the binary loads a Caddyfile referencing `dns cloudflare`
without an "unrecognized module" error), and confirmed `caddy
validate` accepts the full Caddyfile — including `default_sni` and the
`tls { dns cloudflare ... }` block together — once given a
realistically-shaped (if fake) token; it correctly rejects an
obviously-malformed one first, proving the module's own token format
check runs before anything else. Actually obtaining a real certificate
via a live Cloudflare zone couldn't be verified from this environment,
which has no real domain or Cloudflare account to test against — that
step relies on Caddy's and the `caddy-dns/cloudflare` module's own
correctness, both well-established, non-experimental software.

## Flattened the pairing flow: QR is the default, code is one small link away

**What:** the start screen used to be role (Receive/Send) then method
(QR/code) as two separate screens, plus a third screen for Send+QR
(scan/paste) — three screens/clicks before a first-time user saw
anything concrete. It's now one screen: two large "Receive"/"Send"
actions that go straight into the QR flow, plus a single small text
link ("Remote? Pair with a code instead of QR") that reveals a
receive/send choice for the code+PAKE path only if actually clicked.
Send+QR's scan-or-paste choice is gone too — tapping "Send" goes
straight to the camera, with "paste link instead" now a small link on
the scanning screen itself rather than an upfront fork.

**Why QR gets the default path and code doesn't**: raised by the user
after real-world testing — for the overwhelmingly common case (both
devices physically together), forcing a "how do you want to pair"
decision before showing anything is friction with no payoff, since
there's only one sane answer. Code+PAKE pairing (remote devices) is
the minority case by construction — you only reach for it when you
*can't* scan a QR — so it stays reachable in exactly one extra click,
just not competing for equal visual weight with the primary path. This
is a UX prioritization based on actual usage frequency, not a
value judgment that the code flow matters less cryptographically — it
still gets full SPAKE2 protection either way.

**Verified** the flattened click counts directly with Playwright:
confirmed the receiver-QR screen (with a real pairing link/QR
rendered) is reached with exactly one click from a fresh page load,
and that the "remote code" link correctly reveals its own
receive/send sub-choice without affecting the primary buttons' single-
click behavior.

## Visual pass toward an Apple-style look

**What:** requested by the user directly ("ma być piękne jak
macOS/iOS"). Refreshed `styles.css`'s design tokens toward the actual
iOS/macOS system palette (`#007AFF`/`#0A84FF` accent, true black dark
mode background matching iOS's OLED-friendly `#000000` rather than a
dark gray), replaced most hard 1px borders on elevated surfaces (QR
card, file rows, pairing code, buttons) with soft layered shadows
(`--shadow`/`--shadow-sm` tokens) for a more "material" sense of depth,
increased border-radius across cards and buttons for softer corners,
added a translucent `backdrop-filter: blur()` header that stays
pinned while scrolling (an iOS navigation-bar convention), a brief
fade-in transition between screens, and a subtle press-down
(`scale(0.97)`) on button `:active` for tactile feedback. The two new
primary "start" actions get their own larger, icon-forward tile style
(`.start-button`) distinct from ordinary buttons, and the new
secondary code-path link gets a plain-text `.link-button` style with
no border/background, so visual weight matches actual priority (see
the flow-flattening entry above).

**Verified visually**, not just by code review: screenshotted the
start screen in both light and dark `prefers-color-scheme`
contexts via Playwright. The first dark-mode attempt looked broken
(everything near-invisible) — turned out to be the test itself taking
the screenshot mid-flight during the 200ms fade-in animation, not a
real rendering bug; waiting for the animation to settle before
screenshotting showed the actual clean, high-contrast result. Kept as
a reminder in this entry because it's an easy trap: a fast automated
screenshot isn't the same as how a human perceives a brief CSS
transition.

## Receiver "Open" link for Blob-fallback saves

**What:** requested by the user, prompted by receiving photos and
wanting to view them without digging through the Downloads folder.
`file-writer.js`'s Blob-mode sink (used on browsers without the File
System Access API, or when a user skips/cancels its picker) now
exposes `getPreviewUrl()`, returning the `Blob` object URL it already
creates internally to trigger the automatic download. `transfer-ui.js`
shows an "Open" link next to a completed file's row whenever that URL
is available, opening it in a new tab (`target="_blank"`) — for an
image, this just displays it; for other types, the browser's own
handling takes over (e.g. a PDF viewer).

**Why only for Blob-mode, not File System Access saves:** an FSA save
already went to a location the *user themselves* picked via the native
save dialog — they always have their own way back to it. A Blob-mode
download's destination is whatever the browser's own download manager
decides (typically a fixed Downloads folder the user didn't choose per-
file), which is exactly the "tempting to want a more direct way back
to it" gap the user described. Re-deriving a preview this way for FSA
saves would need reading the just-written file back into memory, which
would defeat the point of using FSA for a large file in the first
place; Blob-mode files are implicitly small enough to have been
memory-resident already (see `BLOB_FALLBACK_WARN_BYTES`), so exposing
that already-created object URL costs nothing extra.

**Why the URL lives for 10 minutes, not the previous 30 seconds:** the
old 30-second auto-revoke was tuned only for "give the download click
time to actually start," before any UI ever offered a reason to revisit
the URL afterward. Now that clicking "Open" *later* is an expected
interaction, revoking too eagerly would silently 404 a link the user
is looking right at. 10 minutes is generous enough to not matter in
practice while still eventually freeing memory in a long-running
session that receives many files.

**Verified** end-to-end with Playwright: paired two real pages, sent
an actual (minimal but valid) PNG, confirmed the "Open" link appears
pointing at a `blob:` URL once the transfer completes, clicked it, and
confirmed the resulting new tab actually renders an `<img>` — not just
that a link with the right href exists, but that the browser genuinely
treats it as a displayable image.

## Disabling HTTP/3 on the production Caddy: Android sends were dying mid-transfer

**What:** real-device testing on the deployed VPS found sending from
an Android phone (Chrome) reliably died partway through a transfer —
even a small (<5MB) file, ruling out any duration-based timeout —
while the identical flow from an iPhone (Safari) always completed.
Caddy's default config enables HTTP/3 (`"protocols":["h1","h2","h3"]`
in its startup log), which is QUIC running over UDP. Added
`protocols h1 h2` to disable it, as a `servers` block under the
Caddyfile's global options (not a per-site directive — `caddy
validate` rejects `protocols` written directly inside the site block
with "unrecognized directive"; the underlying listener is shared even
though this deployment only has one site).

**Why this is the likely cause:** QUIC/UDP is materially less
reliable than TCP across mobile-carrier NATs and middleboxes — packets
get silently dropped mid-connection on some networks in a way TCP's
own retransmission and congestion control don't experience, since
carrier-grade NAT and DPI boxes are far more mature and permissive for
plain TCP:443 than for arbitrary UDP:443 traffic. Chrome on Android
opportunistically upgrades to HTTP/3 far more aggressively than iOS
Safari once a server advertises it via `Alt-Svc` (including for the
WebSocket transport itself, via RFC 9220 WebSocket-over-HTTP/3) —
which lines up exactly with the platform split observed: same relay,
same client code, only the transport negotiation differs by browser.

**Why h1+h2 instead of trying to keep h3 working:** there's no real
benefit to HTTP/3 for this app — it's a single small WebSocket
connection per session, not a page with dozens of parallel requests
where QUIC's head-of-line-blocking avoidance would matter. Reliability
across arbitrary mobile networks matters far more here than the
marginal latency win HTTP/3 offers, so removing the failure mode
entirely was preferred over trying to debug QUIC behavior on carrier
networks that aren't reproducible from a dev machine.

**Verified:** `caddy validate` against the actual Cloudflare-DNS-module
build (`caddy/Dockerfile`, the same image pushed to Docker Hub's
`caddy` service) confirms the updated Caddyfile still adapts and
provisions correctly — validated with a realistically-shaped (if fake)
Cloudflare token, same pattern as the original DNS-01 Caddyfile
validation. Not yet re-verified against a real Android device post-fix
(needs the user to redeploy and retest) — this entry should be updated
once that's confirmed, or revisited if the problem persists.

**Status: did not fix it.** Redeployed and retested for real — Caddy's
`srv0` server confirmed `"protocols":["h1","h2"]` (h3 genuinely off),
and the Android sender still died mid-transfer, with the client
showing "Utracono połączenie i nie udało się go wznowić"
(`errConnectionLost`) — i.e. the paired WebSocket itself dropped *and*
the client's own reconnect attempt subsequently failed too. HTTP/3
wasn't the (sole) cause. Investigation continues below.

## Reconnect retry budget was too short for a real mobile network gap

**What:** while chasing the Android mid-transfer disconnects above, an
Explore pass over `server/internal/ws` and `server/internal/session`
found the relay has **no ping/pong keepalive at all** (confirmed via
`grep` across both packages — zero matches for
`Ping`/`Pong`/`SetReadDeadline`/`SetPongHandler`), and almost no
logging (`server/internal/ws/handler.go`'s main read loop discards the
actual read error entirely before tearing the connection down — see
handler.go's relay loop). So a stalled/dropped mobile connection is
invisible server-side until either side's next write fails, and there
was nothing to log to prove which failure mode was happening.

Separately, re-reading `pairing.js`'s `attemptReconnect` found a real,
independently-fixable bug: the client retried reconnecting only 6
times, 2 seconds apart — a 12-second total budget — while the relay
itself (`QUICKSEND_RECONNECT_GRACE_PERIOD`, default 45s) stays willing
to accept a reconnect for far longer. A mobile network gap (a cell
tower handover, a brief signal loss) lasting anywhere from 12 to 45
seconds — very plausible on a phone, rare on a stable WiFi/iPhone
connection — would make the client give up and show an unrecoverable
"connection lost" error even though the relay was still waiting.

**Fix:** changed `RECONNECT_MAX_ATTEMPTS` from 6 to 15 and
`RECONNECT_RETRY_DELAY_MS` from 2000 to 3000 (`web/pairing.js`) — 45
seconds total, matching the relay's own grace period, so the client
keeps trying for as long as the relay would actually still accept it
instead of quitting early on a connection that's still mid-recovery.

**Not yet confirmed as the (sole) fix for the Android symptom** — this
needs the user to redeploy and retest again. If it still fails, the
next step is adding the logging the Explore pass identified as missing
(the discarded read error in `handler.go`'s relay loop, and the
silently-discarded write-timeout error in `hub.go`'s relay path) so a
future reproduction actually produces diagnosable server-side evidence
instead of another guess.

## Manual "Disconnect" button on the paired screen

**What:** requested directly by the user while debugging the Android
issue above — there was no way to voluntarily leave a paired session;
the only exits were an error screen's "Try again" (only reachable
*after* something already broke) or closing the tab outright (which
just looks like a network drop to the other side, triggering their own
`peer_timeout` wait). Added a small `.danger-button`-styled
"Disconnect" button to `renderPaired`, which sends the relay's already-
existing (but previously unused by this client) `end_session` message
and locally resets to the start screen via the existing `setState`
teardown path. Deliberately placed in `renderPaired` itself (not just
the transfer sub-view) so it stays visible even while stuck in a
"reconnecting…" state — `attemptReconnect`'s retry chain already checks
`currentState.screen !== "paired"` before each attempt, so clicking
Disconnect during a stuck reconnect cleanly abandons it rather than
needing separate cancellation logic.

**Bug found and fixed along the way:** `wirePairedSocket`'s
`session_ended` handler was discarding the message's actual `reason`
field entirely and hardcoding `code: "session_ended"`, so every
session-ended error — regardless of whether it was the other peer
explicitly disconnecting (`ended_by_peer`), a reconnect grace period
expiring (`peer_timeout`), or the whole session going idle
(`inactivity_timeout`) — showed the same generic (and for the other
two reasons, actively wrong) message: "the other device didn't come
back in time". Now the real `payload.reason` drives which string is
shown; added the two previously-missing string keys (`errEndedByPeer`,
`errInactivityTimeout`) to `strings.js` in both locales.

**Verified end-to-end with Playwright**: paired two real pages,
clicked the new Disconnect button on one side, confirmed it returns to
the start screen locally and that the other side lands on the error
screen with the correct "The other device ended the session." text
(not the old generic "didn't come back in time" message).

**Status: fixed, then found undiscoverable, then fixed again.** The
Android reconnect-window fix above resolved the original transfer bug
(confirmed by the user on real Android and iPhone). Separately, the
user asked where the Disconnect button was — it had been appended
*after* the transfer UI (file list / drop zone), so on any screen
with content below the fold it was invisible without scrolling, and
its flat/borderless `.link-button`-style styling made it easy to miss
even when visible, since it read as plain text next to the
normal-weight "Swap roles" button rather than as a control. Moved it
to right after "Swap roles" (grouped with the other session-level
actions, above the transfer UI so file-list length can't push it out
of view) and restyled it as an ordinary bordered button tinted with
the danger color, instead of the flat link style — confirmed visually
via a fresh screenshot that it's now immediately visible, unmissable,
and self-evidently clickable right below "Swap roles".

**Status: the fix was correct but never reached the user's browser.**
The user still couldn't see the repositioned button after redeploying.
Checking the live site directly (`curl -sI
https://qs.makoff.ovh/pairing.js`/`styles.css`) found the real cause:
`Cache-Control: max-age=14400` (4 hours) with `cf-cache-status: HIT` —
the domain's Cloudflare DNS record is proxied (orange cloud; see the
HTTP/3 entry above), and Cloudflare applies its own default 4-hour
edge+browser cache to static file extensions like `.js`/`.css` when
the origin sends no `Cache-Control` header of its own, which
`http.FileServer` never does. Every redeploy updated the origin
correctly, but both Cloudflare's edge cache *and* the user's own
browser kept serving whichever copy they'd already cached, for up to 4
hours, regardless of how many times the origin changed underneath it.

**Fix:** wrapped the static file handler in `server/cmd/quicksend/main.go`
with a small `noCache` middleware that sets `Cache-Control: no-cache`
on every response. This doesn't disable caching outright — it forces a
conditional revalidation (If-None-Match/If-Modified-Since) on every
request, which `http.FileServer`'s built-in ETag/Last-Modified support
already answers with a cheap 304 when nothing changed — so a real
change is picked up on the very next load instead of silently waiting
out an arbitrary CDN's default TTL. Verified locally: `curl -sI
http://localhost:8080/pairing.js` now shows `Cache-Control: no-cache`.

**This only prevents the problem going forward** — it doesn't retroactively
clear whatever Cloudflare's edge already cached from before this fix
shipped. The user needs to purge Cloudflare's cache once after
deploying it (dashboard → Caching → Configuration → Purge Everything,
or purge the specific JS/CSS URLs) for the fix itself to take effect
immediately rather than waiting out the existing 4-hour TTL. Given
this is now the second unrelated bug traced back to the proxy being on
for a domain that only ever needed Cloudflare for its DNS API (DNS-01
cert issuance is unaffected by proxy status — it only ever talks to
Cloudflare's API, never the proxied traffic path), switching the
record to "DNS only" (grey cloud) was suggested to the user as the
more direct fix, with this code change kept regardless as defense in
depth for anyone self-hosting behind any CDN.

## sendFile now tells the receiver when a local file read fails

**What:** found while investigating a real-device Android report: a
photo picked from Google Photos (as opposed to one just taken with the
camera) would start sending, then silently die, and — critically — the
*receiving* PC side just stayed on "Waiting for files…" forever with no
error at all. Reading `sendFile`'s loop in `web/transfer.js` found why:
`file.slice(start, end).arrayBuffer()` throwing (which a cloud-backed
photo needing an on-demand download is a very plausible way to
trigger — Google Photos, iCloud, and similar providers can back a
`File` with content that isn't actually resident on the device yet)
propagated straight out of the function without ever notifying the
receiver via `file_abort`; that message was only ever sent from the
two paths that already know they're aborting (a local
`AbortController` cancel, or the peer's own `file_abort`). Any *other*
exception — a file read failure, an encryption error, anything — left
the receiver's `attachReceiver` waiting on a chunk that would never
come, indefinitely, with no visible sign anything had gone wrong.

**Fix:** added a `catch` in `sendFile` that sends `file_abort` for any
error that isn't already one of the two self-notifying paths (an
explicit `AbortError`, or the socket already confirmed gone via
`connectionLost`), then rethrows so the sender's own UI still shows
its usual error state. The receiver now always hears about a dead
transfer instead of only sometimes.

**Verified** with a new unit test
(`web/transfer.test.mjs`: "sendFile notifies the receiver via
file_abort when reading the file itself throws") using a fake `File`-
like object whose `.slice().arrayBuffer()` rejects — not reproducible
with a real `File` in a test environment — confirming both that
`sendFile` still rejects with the original error (so the sender's own
error UI is unaffected) and that a `file_abort` frame is now sent.
Not yet confirmed against the actual Google Photos scenario on a real
Android device (needs the user to redeploy and retest) — if reading
really is what's failing there, the receiver should now show the
"Canceled" state instead of hanging; if it still hangs, the failure
must be happening somewhere else entirely (e.g. the whole session
actually dying, not just this one file), which would need revisiting.

**Status: confirmed still hanging** — the user redeployed (this time
onto a genuinely fresh, uncached origin — see the Cloudflare caching
entry below) and the receiver still sat on "Waiting for files…"
forever. That rules out a thrown file-read exception as the cause
(the new `file_abort` notify would have fired). Investigation
continued below with two real, independent fixes.

## Cloudflare's proxy caching pairing.js/styles.css for 4 hours, silently

**What:** after redeploying, neither the user nor a direct `curl`
could see any code change take effect — the live site kept serving
JS/CSS from *before* the deploy. `curl -sI https://qs.makoff.ovh/pairing.js`
showed `cache-control: max-age=14400` (4h) and `cf-cache-status: HIT`.
`http.FileServer` (`server/cmd/quicksend/main.go`) sends no
`Cache-Control` header at all, so this was entirely Cloudflare's own
default caching behavior for the domain's proxied (orange-cloud) DNS
record — its default edge+browser cache for static file extensions
like `.js`/`.css`, applied because the origin left the door open by
not specifying anything itself. Every deploy updated the origin
correctly the whole time; Cloudflare (and every visitor's browser)
just kept serving whatever they'd already cached for up to 4 hours
regardless.

**Fix:** added a small `noCache` middleware in `main.go` wrapping the
static file handler, setting `Cache-Control: no-cache` on every
response — forces a conditional revalidation on every request rather
than blind caching, which `http.FileServer`'s built-in ETag/Last-
Modified support already answers with a cheap 304 when nothing
changed. This only prevents the problem *going forward*; Cloudflare's
existing cached copies needed a manual "Purge Everything" from the
user to actually clear.

**The user also switched the DNS record to "DNS only" (grey cloud)**
entirely, removing Cloudflare's proxy from the path altogether — this
domain never needed anything from Cloudflare's proxy/CDN layer, only
its DNS API (for the DNS-01 ACME challenge, which is unaffected by
proxy status either way). This is now the *second* Cloudflare-proxy-
specific bug hit today (after the HTTP/3 investigation above), and
removing the proxy removes the whole category rather than fixing
symptoms one at a time.

**A real trap hit while diagnosing this**: switching proxy status
changes the DNS record's *answer* (from Cloudflare's anycast IPs to
the origin's real IP), and that change takes a little while to
propagate through intermediate caching resolvers even though
Cloudflare's own authoritative nameservers answer correctly right
away. Querying `1.1.1.1` even shortly after the toggle still returned
stale (proxied) answers, which looked exactly like "the change didn't
take" until querying the zone's authoritative nameservers directly
(`dig qs.makoff.ovh @kelly.ns.cloudflare.com`) and connecting straight
to the real origin IP with `curl --resolve` (bypassing DNS entirely)
both confirmed the change *had* taken effect at the source — it just
hadn't reached every resolver yet. Worth remembering next time a DNS
change "isn't working": check the authoritative source directly before
concluding the change itself was wrong.

## Missing keepalive + unhandled `peer_disconnected` were the real cause

**What:** with caching ruled out as a confound, the Google Photos send
still hung the receiver forever with zero indication anything was
wrong. Two real, independent gaps compounded into this:

1. **No WebSocket ping/pong anywhere** (confirmed earlier via
   `grep -rn "Ping\|Pong\|SetReadDeadline" server/internal/ws
   server/internal/session` — zero matches). `ServeHTTP`'s main read
   loop (`server/internal/ws/handler.go`) calls `raw.Read(ctx)` with
   `ctx := context.Background()` — no deadline at all — so a
   connection a mobile carrier's NAT silently drops (no FIN, no RST,
   just stops forwarding packets) could block that Read forever, with
   neither side ever finding out. A long quiet stretch is exactly what
   reading a Google Photos original needing an on-demand cloud
   download produces — no chunks go out while that read is pending —
   which plausibly explains why a fresh camera photo (small, already
   local, read instantly) worked while a Google Photos pick (needs a
   slow fetch first) didn't: NATs commonly time out an idle-looking
   TCP mapping well under a minute, especially on cellular, and WiFi
   routers' NAT tables are typically far more lenient — matching why
   this was never seen from an iPhone.
2. **The client never handled `peer_disconnected`** (relay → remaining
   peer when the *other* side's connection drops — see
   `docs/PROTOCOL.md`). `grep -rn "peer_disconnected" web/` returned
   nothing before this fix. So even on the rare occasion the relay
   *did* correctly notice and report a dropped peer, the surviving
   side's UI had no code path reacting to it at all — a receiver mid-
   file just sat on "Waiting for files…" indefinitely no matter what
   actually killed the sender's connection, independent of cause #1.

**Fix, part 1 (server, `server/internal/ws/{conn,handler}.go`):** added
a `Ping` method to `conn` (serialized behind the same mutex as
`Send`/`Close`, since the underlying connection has no concurrent-
writer support) and a `pingLoop` goroutine started for the lifetime of
every paired connection, sending a ping every 20s (10s timeout to get
the pong back). Browsers answer WebSocket pings automatically with no
application code needed, so this needs zero client-side changes to
work — it just generates enough periodic real traffic to keep NAT
mappings alive, and a ping that never gets its pong actively closes
the connection, unblocking the otherwise-undead-lockable `raw.Read`
and running the existing disconnect path. `pingInterval`/`pingTimeout`
are vars, not consts, so `TestKeepalivePingsDontDisconnectAResponsiveClient`
(`handler_test.go`) can shorten them instead of a 20-second test.

**Fix, part 2 (client, `web/pairing.js`):** `wirePairedSocket` now
handles `peer_disconnected` by showing the same "reconnecting…" status
text/element `attemptReconnect` already uses for the symmetric case (a
peer's own socket dropping) — accurate wording from either
perspective, and naturally cleared the moment a fresh `render()` runs
for `peer_reconnected` or `session_ended`.

**Verified:** the new Go test dials a real client against a real
`httptest.Server`, running its own background read loop (mirroring
what a real browser's WebSocket stack does automatically) to prove a
genuinely responsive peer survives many ping cycles unaffected;
`go test -race ./...` and the full `node --test web/*.test.mjs` suite
both pass. End-to-end with Playwright: paired two real pages, closed
the sender's browser context outright (an abrupt drop, not the app's
own clean `end_session`), confirmed the receiver's page now shows
"Connection lost, trying to reconnect…" instead of nothing. Not yet
confirmed against the actual Google Photos scenario on a real Android
device — needs the user to redeploy and retest; if it still fails, the
next step is the server-side logging identified earlier (the discarded
read error in `handler.go`'s relay loop) since guessing further without
real evidence from a reproduction has had a poor hit rate today.
