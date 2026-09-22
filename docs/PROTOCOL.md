# Protocol

This document describes the wire protocol between a Quicksend client
(the PWA, or an alternative implementation) and the relay, in enough
detail to implement a compatible client without reading the Go source.

It's written incrementally as features land. This revision adds
aborting a single transfer on top of session lifecycle, pairing, file
transfer, reconnect, and role swap.

## Transport

One WebSocket connection per client, at `GET /ws`. Two kinds of
messages travel over it, distinguished by the WebSocket frame's own
type:

- **Text frames** carry JSON control-plane messages (the *envelope*,
  below).
- **Binary frames** carry raw file-chunk ciphertext (format defined
  once the transfer step lands). The relay never parses binary frames;
  it only forwards them to the other peer in the session.

## Envelope

Every text frame is a JSON object:

```json
{ "type": "<message type>", "payload": { ... } }
```

`payload` is omitted (or `null`) for messages that don't carry one.

## Relay behavior

The relay only parses and acts on a handful of message types:
`create_session`, `join`, `create_code_session`, `join_by_code`,
`end_session`, `reconnect`, and `reconnect_token` (below). Every other
text message — and every binary frame — is relayed byte-for-byte to
the other peer in the session, unparsed. This is intentional: it's
what lets pairing (`pake_msg`), transfer metadata (`file_meta`), acks,
role-swap negotiation, etc. be end-to-end between the two clients
without the relay needing to understand (or be updated for) their
formats.

A session has exactly two slots, host and guest:

- **Host** is whoever sent `create_session`.
- **Guest** is whoever successfully `join`s that session.

These are *not* sender/receiver transfer roles (those can be swapped
later on top of an established session) — they only describe the two
WebSocket connections the relay pipes messages between.

## Session lifecycle messages

### `create_session` (client → relay)

First message a client sends to start a new pairing session. No
payload.

### `session_created` (relay → client)

Reply to `create_session`.

```json
{ "type": "session_created", "payload": { "sessionId": "<base64url>" } }
```

`sessionId` is 128 bits of randomness, base64url-encoded (no padding).
It is a routing identifier, not a secret — the actual pairing secret
(the session key) is established separately (QR fragment or PAKE,
documented once those steps land) and the relay never sees it.

### `join` (client → relay)

First message the second client sends, to attach to an existing
session as guest.

```json
{ "type": "join", "payload": { "sessionId": "<base64url>" } }
```

### `paired` (relay → both clients)

Sent to both host and guest once `join` (or `join_by_code`) succeeds.

```json
{ "type": "paired", "payload": { "sessionId": "<base64url>" } }
```

Once both sides have received `paired`, any further message either
side sends is relayed to the other (see "Relay behavior" above).
`sessionId` lets each client register a reconnect token (see
"Reconnect" below) — for QR pairing the client already knows it from
`session_created`, but it's the *only* way a code+PAKE client learns
its session ID, since `create_code_session`/`join_by_code` deliberately
never expose it (the pairing code is the only identifier a
code+PAKE user ever sees).

### `end_session` (either client → relay)

Explicitly ends the session. No payload.

The relay closes the *other* peer's connection after sending it
`session_ended` (reason `ended_by_peer`), and discards the session.
The sender's own connection is expected to be closed client-side.

### `session_ended` (relay → remaining client)

```json
{ "type": "session_ended", "payload": { "reason": "<reason>" } }
```

Reasons:

| Reason                | Meaning                                                                 |
|------------------------|--------------------------------------------------------------------------|
| `ended_by_peer`        | The other peer sent `end_session`.                                      |
| `peer_timeout`         | The other peer disconnected and didn't reconnect within the grace period.|
| `inactivity_timeout`   | Neither peer sent any message for longer than the inactivity timeout.    |

The relay closes the connection immediately after sending this.

### `peer_disconnected` (relay → remaining client)

Sent when the other peer's WebSocket connection drops (network blip,
tab closed, etc.), *before* the grace period expires. No payload. The
session is kept alive; the client should show a "reconnecting" status
rather than treating this as fatal. If the peer reconnects in time
(see "Reconnect" below), the session (though not any transfer that was
mid-flight — see below) picks back up; if not, `session_ended` with
reason `peer_timeout` follows once the grace period elapses.

### `error` (relay → client)

```json
{ "type": "error", "payload": { "code": "<code>", "message": "<human-readable>" } }
```

Codes:

| Code                  | Meaning                                                        |
|------------------------|------------------------------------------------------------------|
| `session_not_found`    | `join`'s sessionId doesn't exist, expired, or its host left.     |
| `session_full`         | The session already has a connected guest.                      |
| `too_many_sessions`    | The client's IP is at `QUICKSEND_MAX_SESSIONS_PER_IP`.           |
| `already_in_session`   | Reserved for future use.                                         |
| `invalid_message`      | The first message wasn't valid JSON, or wasn't a recognized session-starting type. |
| `invalid_code`         | `join_by_code`'s code doesn't match any active, unexpired code session. |
| `too_many_attempts`    | Too many wrong `join_by_code` guesses recently from this IP.     |
| `invalid_reconnect_token` | `reconnect`'s sessionId/role/token don't match a resumable, currently-disconnected peer slot. |

An `error` in response to the *first* message is followed by the relay
closing the connection.

## Limits

All configurable via environment variables (see README):

- **`QUICKSEND_MAX_SESSIONS_PER_IP`** — concurrent sessions (as host or
  guest) allowed per client IP.
- **`QUICKSEND_SESSION_INACTIVITY_TIMEOUT`** — a session with no
  messages from either side for this long is torn down.
- **`QUICKSEND_RECONNECT_GRACE_PERIOD`** — how long a session survives
  after one peer disconnects, waiting for it to reconnect, before the
  other peer is told `session_ended`.

## QR pairing (physically-together devices)

Used when both devices are in the same place. No PAKE is involved —
the shared secret is generated locally by the receiver and carried
optically (QR) or via a pasted link, never typed by a human, so it can
be full-strength random rather than a short code.

1. The receiver opens a WebSocket, sends `create_session`, and gets
   back `session_created` with a `sessionId`.
2. The receiver generates a random 32-byte `sessionKey`
   (`crypto.getRandomValues`) — this never touches the relay.
3. The receiver builds a URL:
   ```
   https://<host>/<path>#s=<sessionId>&k=<sessionKey, base64url, unpadded>
   ```
   and displays it as a QR code, plus as plain selectable text as a
   fallback. `Referrer-Policy: no-referrer` (set via a `<meta>` tag)
   and keeping the key in the fragment (`#`, never `?`) keep it out of
   HTTP requests, `Referer` headers, and server logs.
4. The sender obtains that URL one of three ways, all converging on
   the same join step:
   - **Scanning the QR** with the page's own camera (jsQR decoding
     live video frames) — useful for a laptop scanning a phone's QR
     or vice versa.
   - **Opening the link directly** — the common case when a phone's
     *native* camera app scans the QR, since that just navigates to
     the URL. On load, the page detects `#s=...&k=...` in its own
     URL, immediately scrubs it from the visible address bar/history
     (`history.replaceState`) so the key doesn't linger there, and
     shows a "join this session?" confirmation before connecting.
   - **Pasting the link manually** — fallback if scanning isn't
     available (no camera permission, desktop without a webcam
     pointed at anything, etc).
5. The sender opens a WebSocket and sends `join` with `sessionId`
   extracted from the URL fragment. `sessionKey` is extracted from the
   same fragment and never sent anywhere.
6. Both sides receive `paired` and now hold the same `sessionKey`,
   ready to use as the epoch-0 root key (see "Cryptography" below).

QR codes are always rendered black-on-white regardless of the app's
light/dark theme, for maximum scanner compatibility.

## Cryptography

None of this runs on the relay — it only ever forwards ciphertext it
can't read. `sessionKey` (32 bytes) is established out-of-band (QR
fragment or, later, code+PAKE) and never leaves the two paired
browsers. See docs/DECISIONS.md for the reasoning behind each choice
below.

### Key derivation

```
epochKey = HKDF-SHA256(ikm=sessionKey, salt=epoch (4-byte BE uint32), info="quicksend-epoch-v1", len=32)
fileKey  = HKDF-SHA256(ikm=epochKey,   salt=fileID (16 bytes),         info="quicksend-v1",       len=32)
```

- `epoch` starts at 0 for a fresh pairing and increments by one on
  every successful reconnect. Both peers derive it identically without
  it ever appearing on the wire: the reconnecting peer bumps it on
  receiving `reconnected`, the other peer bumps it on receiving
  `peer_reconnected` — see "Reconnect" below.
- `fileID` is 16 bytes chosen by the sender, unique per file, sent
  (encrypted) as part of that file's metadata (`file_meta`, format
  TBD).

### Chunk encryption (AES-256-GCM)

Each chunk of a file is sealed independently under `fileKey`:

- **Nonce** (12 bytes) = `0x00000000` ‖ chunk index as an 8-byte
  big-endian integer.
- **AAD** = `fileID (16 bytes)` ‖ `chunkIndex (8-byte BE)` ‖
  `lastChunkFlag (1 byte)`.
- Output = ciphertext ‖ 16-byte GCM tag (this is Web Crypto's default
  `AES-GCM` output layout, which Go's implementation matches).

A receiver must reject a chunk whose AEAD tag doesn't verify — this
happens automatically if the chunk was replayed at the wrong index,
spliced from a different file, or the last-chunk flag doesn't match
what the sender used.

### Reconnect token

```
reconnectToken = HMAC-SHA256(key=sessionKey, message="quicksend-reconnect" ‖ sessionId)
```

Computed once by each peer right after pairing (see `paired`'s
`sessionId`) and registered with the relay as an opaque bearer
credential via `reconnect_token` — the relay stores and compares it,
but can never compute or forge it itself since it doesn't have
`sessionKey`. Presented again in `reconnect` to resume the session
after a disconnect — see "Reconnect" below.

### Reference implementations & test vectors

- Go: `server/internal/cryptoutil` (`go test ./server/internal/cryptoutil/...`)
- JS: `web/crypto.js`, built on the native Web Crypto API
  (`node --test web/crypto.test.mjs`)
- Both are checked against the same frozen vectors in
  `/testvectors/crypto_v1.json`, so a change that breaks agreement
  between the two implementations fails a test rather than surfacing
  later as "sometimes doesn't connect."

## Code+PAKE pairing (remote devices)

Used when the two devices are in different networks and can't scan a
QR code, so the shared secret has to be a short code a human can read
over the phone/SMS/chat. Unlike QR pairing, the relay is involved in
looking up which session a code refers to (see docs/DECISIONS.md for
why this is safe against online brute-force), but the cryptographic
key exchange itself is still entirely between the two clients.

1. The receiver sends `create_code_session` (no payload). The relay
   creates a session (internally identical to the QR flow's) and a
   random 6-digit code bound to it, and replies with
   `code_session_created`:
   ```json
   { "type": "code_session_created", "payload": { "code": "482193", "expiresAt": "2026-01-01T12:05:00Z" } }
   ```
   The receiver shows this code (e.g. as `482-193`) for the user to
   read out over whatever channel they're using.
2. The sender sends `join_by_code` with the code they were given:
   ```json
   { "type": "join_by_code", "payload": { "code": "482193" } }
   ```
   The relay looks this up (rate-limited per IP — see
   docs/DECISIONS.md), consumes it (single-use), and — exactly like
   QR's `join` — attaches the sender as guest and sends `paired` to
   both sides. A wrong or expired code gets `error{code:
   "invalid_code"}`; too many wrong guesses from one IP gets
   `error{code: "too_many_attempts"}`.
3. Once `paired`, the two clients run a SPAKE2 exchange using the code
   itself as the PAKE password (relayed opaquely as `pake_msg` — the
   relay never parses or sees the password). The host is always PAKE
   role 0 (initiator), the guest role 1 (responder):
   - Host: `init(code, 0)` → sends its message as `pake_msg`.
   - Guest: `init(code, 1)`, waits for the host's `pake_msg`, calls
     `update()` (this derives the guest's session key *and* its
     response in one step) → sends the response as `pake_msg`.
   - Host: receives the guest's `pake_msg`, calls `update()` (derives
     its session key — nothing more to send).
   ```json
   { "type": "pake_msg", "payload": { "message": "<schollz/pake wire JSON>" } }
   ```
4. **Key confirmation.** SPAKE2 itself can't tell a wrong password from
   a right one — both sides just silently derive different keys (see
   docs/DECISIONS.md). So both sides then compute
   `HMAC-SHA256(sessionKey, "quicksend-pake-confirm")` and exchange it:
   ```json
   { "type": "pake_confirm", "payload": { "tagHex": "<hex>" } }
   ```
   Each side compares the received tag against its own computed value.
   Match → pairing is done, `sessionKey` is the epoch-0 root key (same
   as QR). Mismatch → wrong code; each side independently detects this
   (no relay involvement) and should end the session so both users know
   to try again with a fresh code.

PAKE runs as the WASM build of the same Go package
(`schollz/pake/v3`) used to test this flow, not a separate JS SPAKE2
implementation — see docs/DECISIONS.md for why, including the curve
choice (P-256) and the real cost of shipping Go-compiled WASM.

## File transfer

Runs over an already-`paired` session. Pairing "host" is always the
file receiver and "guest" the sender for this initial session (role
swap, a later build step, is what lets them flip this without
re-pairing) — see docs/DECISIONS.md.

Files are sent one at a time, in order; a second file's `file_meta`
only appears after the previous file's last chunk. Multiple selected
files are currently saved as separate files, not bundled into a ZIP —
see docs/DECISIONS.md for why that's deferred.

### `file_meta` (sender → receiver, relayed opaquely)

Announces one file. The relay never parses this — it's encrypted the
same way a chunk is (see below), so the relay learns neither the
plaintext metadata nor even that this particular message is metadata
rather than transfer control chatter, beyond its message `type`.

```json
{ "type": "file_meta", "payload": { "fileId": "<32 hex chars>", "ciphertext": "<hex>" } }
```

`fileId` is 16 random bytes (hex-encoded) chosen by the sender, unique
per file. `ciphertext` decrypts (see "Chunk encryption" in the
Cryptography section) to:

```json
{ "name": "photo.jpg", "size": 123456, "mime": "image/jpeg" }
```

using the **reserved metadata chunk index** (`2^64-1`, `last=true`) in
place of a real chunk index — see `cryptoutil.MetadataChunkIndex` /
`crypto.js`'s `METADATA_CHUNK_INDEX`.

### Chunk frame (binary WebSocket frame, sender → receiver)

```
byte 0      : frame type (0x01 = file chunk)
byte 1      : flags (bit0 = last chunk of this file)
bytes 2–17  : fileId (16 bytes, matches file_meta's)
bytes 18–25 : chunk index (uint64 BE)
bytes 26..  : AES-256-GCM ciphertext (with 16-byte tag) — see Cryptography
```

Plaintext chunks are up to 256 KiB (`transfer.js`'s `CHUNK_SIZE`); the
last chunk of a file may be smaller (or, for an empty file, the only
chunk, index 0, zero-length plaintext).

### `chunk_ack` (receiver → sender, relayed opaquely)

Sent after a chunk has been decrypted **and** handed to the receiver's
sink (e.g. written to disk) — not merely decrypted — so it reflects
the chunk being durably handled, not just received.

```json
{ "type": "chunk_ack", "payload": { "fileId": "<hex>", "ackedUpTo": 41 } }
```

### Flow control

The sender keeps at most `WINDOW_SIZE` (8) chunks unacknowledged at
once, pausing further reads/sends until `chunk_ack`s catch up —
backpressure that adapts to how fast the receiver can actually consume
data, rather than a fixed messages-per-minute cap.

### `file_abort` (either side → the other, relayed opaquely)

Cancels one file transfer without ending the session — the other side
keeps its socket, its role, everything, and can send/receive more
files afterward.

```json
{ "type": "file_abort", "payload": { "fileId": "<hex>" } }
```

Either side can send this for whichever file is currently in flight:

- The **sender** cancelling its own send (user clicks cancel while
  sending) tells the receiver via `file_abort` so it stops waiting for
  more chunks and discards the partial file.
- The **receiver** declining to keep receiving (user clicks cancel
  while receiving) tells the sender via `file_abort` so it stops
  pushing chunks nobody wants.

Whichever side receives a `file_abort` for the file it's currently
working on abandons it silently — it does **not** send its own
`file_abort` back (that would ping-pong forever). A `file_abort` for
any other fileId (already completed, or stale) is ignored. Any chunk
frame that arrives for a file that's just been aborted — a normal race,
since the other side may not know yet — is also silently dropped
rather than treated as a protocol error.

## Reconnect

Lets a session survive a dropped WebSocket connection (network blip,
backgrounded tab, brief Wi-Fi handoff) without re-pairing. It resumes
the *session* — both peers keep `sessionKey` and can keep sending
files under it — but **not any file transfer that was in flight at the
moment of the drop**: `sendFile`/`attachReceiver` both fail fast on a
closed socket rather than hang, so the sender must resend and the
receiver discards the partial file. Full byte-level transfer resume is
deferred (see docs/DECISIONS.md).

### `reconnect_token` (client → relay, relayed to no one)

Sent once by each peer right after receiving `paired`, registering the
bearer credential (see "Reconnect token" above) the relay will require
from that peer to resume this session later.

```json
{ "type": "reconnect_token", "payload": { "tokenHex": "<hex>" } }
```

The relay stores this opaquely against whichever slot (host/guest) the
sending connection occupies. It never relays it to the other peer and
never computes or checks its contents — it only compares byte-for-byte
against what a later `reconnect` presents.

### `reconnect` (client → relay)

Sent as the first message on a *new* connection, in place of
`create_session`/`join`/etc, to resume an existing session after its
previous connection for this peer dropped.

```json
{ "type": "reconnect", "payload": { "sessionId": "<base64url>", "role": "host", "tokenHex": "<hex>" } }
```

`role` is `"host"` or `"guest"`, matching whichever slot this peer
occupied before disconnecting. The relay accepts this only if:

- `sessionId` refers to a session that still exists (within its
  reconnect grace period or inactivity timeout — see "Limits"),
- `role`'s slot in that session is currently disconnected (not already
  resumed by someone else, and not still connected — a live connection
  can't be hijacked by a reconnect attempt), and
- `tokenHex` byte-for-byte matches the token that role registered via
  `reconnect_token`.

Any mismatch — unknown session, wrong role, wrong token, or a role
that's still connected — gets the *same* `error{code:
"invalid_reconnect_token"}` rather than distinguishing which case it
was, so a failed guess can't be used to probe which sessions exist.

### `reconnected` (relay → the reconnecting client)

Confirms a `reconnect` succeeded. No payload. The client bumps its
local epoch counter on receiving this (see "Key derivation" above) and
should rebuild its transfer UI against the new epoch key — any file
that was mid-transfer is not resumed (see above).

### `peer_reconnected` (relay → the other, still-connected client)

Sent to whichever peer *didn't* drop, once the other side's `reconnect`
succeeds. No payload. This peer's own socket is untouched — only its
local epoch counter and derived epoch key need to advance, kept in
lockstep with the reconnecting peer purely by both sides reacting to
their respective message (`reconnected` there, `peer_reconnected`
here) for the same event, without the epoch number itself ever
crossing the wire.

## Role swap

Lets the two paired peers flip which one is currently sending and
which is receiving, without ending the session or re-pairing. This is
purely a client-side concept — the relay's `host`/`guest` slots never
change, and neither does any cryptographic key material (a file's key
is derived from `epochKey` and a sender-chosen `fileID`, regardless of
which peer is doing the sending at the time, so no new key derivation
is needed for this feature).

Both messages below are relayed opaquely between the two clients, like
`pake_msg` — the relay never parses or acts on them.

### `role_swap_request` (either client → the other)

No payload. Sent when a user clicks "swap roles."

### `role_swap_response` (the other client → the requester)

```json
{ "type": "role_swap_response", "payload": { "accepted": true } }
```

The responding client sends `accepted: false` if it currently has a
transfer in progress (swapping mid-file isn't supported — a receiver
can't suddenly become a sender partway through decrypting a file the
other side is still sending) or if it already has a swap request of
its own in flight (see below). Otherwise it accepts and flips its own
transfer role immediately, before or as it sends the response.

The requester only flips its own transfer role upon *receiving*
`accepted: true` — never optimistically beforehand. A client also
refuses to even send `role_swap_request` if it itself currently has a
transfer in progress, which is the common case: whichever peer would
need to click "swap" while a transfer is running is, by construction,
one of that transfer's two active participants (there's no way for
a transfer to be running without both sides being "busy" for its
duration), so this local check alone covers most cases; the responder
still re-checks its own busy state independently to close the narrow
race where a transfer starts in the moment between the request being
sent and received.

**Simultaneous requests:** if both peers click "swap" at nearly the
same moment, each one's own outstanding request makes it consider
itself "busy" (via the same-swap-in-flight check above) when the
other's request arrives, so both get rejected — no swap happens, and
either side can just click again. This trades a rare, harmless no-op
for avoiding a scenario where both sides accept each other's request
and each flips twice, landing back where they started but through a
confusing double round-trip.

## Not yet in this document

- Bundling multiple files into a streamed ZIP.
- Resuming a file transfer that was in flight across a reconnect
  (currently: the whole file is simply resent from scratch).

Each will be appended here as its build step lands.
