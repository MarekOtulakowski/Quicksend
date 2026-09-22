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

## Not yet in this document

- Pairing key exchange: QR fragment format and the code+PAKE flow
  (`pake_msg`).
- Reconnect: how a client re-attaches to its existing session and
  resumes a transfer.
- File transfer: `file_meta`, chunk framing (binary frames), `chunk_ack`,
  `file_abort`, `file_complete`.
- Role swap: `role_swap_request`/`role_swap_response`/`role_swap_applied`.

Each will be appended here as its build step lands.
