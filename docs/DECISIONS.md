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
