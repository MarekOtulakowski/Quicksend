# Protocol

This document describes the wire protocol between a Quicksend client
(the PWA, or an alternative implementation) and the relay, in enough
detail to implement a compatible client without reading the Go source.

It's written incrementally as features land; sections for pairing
(QR / code+PAKE), file transfer, reconnect, and role swap will be added
as those build steps are implemented. This revision covers only the
session lifecycle and message transport.

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

The relay only parses and acts on three message types:
`create_session`, `join`, and `end_session` (below). Every other text
message — and every binary frame — is relayed byte-for-byte to the
other peer in the session, unparsed. This is intentional: it's what
lets pairing (`pake_msg`), transfer metadata (`file_meta`), acks,
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

Sent to both host and guest once `join` succeeds. No payload. Once
both sides have received `paired`, any further message either side
sends is relayed to the other (see "Relay behavior" above).

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
(reconnect protocol documented once that step lands), transfer can
resume; if not, `session_ended` with reason `peer_timeout` follows once
the grace period elapses.

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
| `invalid_message`      | The first message wasn't valid JSON, or wasn't `create_session`/`join`. |

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
  it ever appearing on the wire (protocol for keeping it synchronized
  across reconnects lands with that build step; until then only epoch
  0 exists).
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

Computed once by each peer after pairing and given to the relay as an
opaque bearer credential (the relay stores and compares it, but can
never compute or forge it itself since it doesn't have `sessionKey`).
Presented again to resume the session after a disconnect (exact
handshake documented once the reconnect build step lands).

### Reference implementations & test vectors

- Go: `server/internal/cryptoutil` (`go test ./server/internal/cryptoutil/...`)
- JS: `web/crypto.js`, built on the native Web Crypto API
  (`node --test web/crypto.test.mjs`)
- Both are checked against the same frozen vectors in
  `/testvectors/crypto_v1.json`, so a change that breaks agreement
  between the two implementations fails a test rather than surfacing
  later as "sometimes doesn't connect."

## Not yet in this document

- The code+PAKE pairing flow (`pake_msg`) for remote (different
  network) pairing.
- Reconnect: how a client re-attaches to its existing session, resumes
  a transfer, and how the epoch counter above stays synchronized.
- File transfer: `file_meta` format, `chunk_ack`, `file_abort`,
  `file_complete`.
- Role swap: `role_swap_request`/`role_swap_response`/`role_swap_applied`.

Each will be appended here as its build step lands.
