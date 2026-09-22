# Quicksend

Self-hosted, end-to-end encrypted file transfer between a phone and any
browser, even when the two devices are on different networks. No native
app, no account, no files ever touched by the server.

## What it is

Quicksend pairs two browsers — the same PWA plays either role — through
a small relay you self-host. Pairing happens one of two ways:

- **QR code**, when both devices are physically together: the receiver
  shows a QR/link carrying a session key that never touches the relay.
- **Short code + PAKE**, when the devices are remote: a 6-digit code
  read out over any channel (phone call, SMS, chat) is used with
  [SPAKE2](https://en.wikipedia.org/wiki/Password-authenticated_key_agreement)
  to derive a strong session key — the relay only ever sees the code as
  an opaque routing token, never as the actual secret.

Once paired, files are sent chunk-by-chunk, encrypted end-to-end
(AES-256-GCM, keys derived per file with HKDF). The relay only ever
relays ciphertext it cannot read — see [Threat model](#threat-model)
below for exactly what it *can* see.

## Quick start

```sh
git clone https://github.com/MarekOtulakowski/Quicksend.git
cd Quicksend
docker build -t quicksend .
docker run -d --name quicksend -p 8080:8080 quicksend
```

Open `http://localhost:8080`. To try it between two devices on the
same network, use your machine's LAN IP instead of `localhost` (camera
QR-scanning inside the page requires HTTPS or `localhost`; opening a
shared link directly, or pasting it, works over plain HTTP too — see
[docs/DECISIONS.md](docs/DECISIONS.md)).

For real use, put a reverse proxy (Caddy, Traefik, Cloudflare Tunnel)
in front for TLS — the container itself only speaks plain HTTP and is
not meant to be exposed directly to the internet.

### Configuration

All limits are environment variables with sane defaults:

| Variable | Default | Meaning |
|---|---|---|
| `QUICKSEND_LISTEN_ADDR` | `:8080` | Address the relay binds to |
| `QUICKSEND_MAX_FILE_SIZE_BYTES` | 10 GiB | Max size of a single file *(see note below — not yet enforced)* |
| `QUICKSEND_MAX_SESSIONS_PER_IP` | 10 | Concurrent sessions allowed per client IP |
| `QUICKSEND_SESSION_INACTIVITY_TIMEOUT` | 5m | Idle session teardown |
| `QUICKSEND_RECONNECT_GRACE_PERIOD` | 45s | How long a session survives a dropped connection |
| `QUICKSEND_PAIRING_CODE_TTL` | 5m | How long a remote pairing code stays valid |
| `QUICKSEND_MAX_PAIRING_ATTEMPTS` | 5 | Wrong pairing-code guesses allowed per IP before throttling |

> **Known gap:** `QUICKSEND_MAX_FILE_SIZE_BYTES` is parsed and
> validated but not yet enforced anywhere in the transfer path. Don't
> rely on it to bound resource usage yet.

## Architecture

One Go binary: a WebSocket relay plus the PWA frontend, embedded via
`go:embed` and served from the same process/port. No bundler on the
frontend (plain ES modules); the one piece of WebAssembly is the PAKE
exchange (`schollz/pake/v3` compiled to WASM), so there's a single
implementation of that protocol shared between what a native Go client
would use and what the browser runs.

The relay is deliberately a mostly-opaque message pipe: it only parses
the handful of session-lifecycle messages it must act on (pairing,
joining, ending a session) and relays everything else — pairing key
exchange, file metadata, file chunks — byte-for-byte between the two
paired browsers without understanding it. See
[docs/PROTOCOL.md](docs/PROTOCOL.md) for the exact wire format and
[docs/DECISIONS.md](docs/DECISIONS.md) for the reasoning behind
non-trivial choices (why WebAssembly for PAKE despite its size, the
pairing-code brute-force protection, the chunk encryption scheme, and
more).

### Implemented so far

- QR pairing and remote code+PAKE pairing
- End-to-end encrypted file transfer with flow-controlled backpressure
- Reconnecting a dropped connection without re-pairing (session-level;
  a file that was mid-transfer at the moment of the drop is not
  resumed — see docs/DECISIONS.md)
- Swapping sender/receiver roles mid-session, by mutual consent, without
  re-pairing (refused while a transfer is actively in progress)
- Saving via the File System Access API, with an in-memory Blob
  fallback for browsers without it
- Light/dark theme, Polish/English UI

### Not yet implemented

- Resuming a file transfer that was in flight across a reconnect
  (currently: the whole file is simply resent)
- Aborting a single transfer without ending the whole session
- Bundling multiple files into a streamed ZIP (currently saved as
  separate files)
- Service Worker streaming as a save fallback (currently File System
  Access API, else an in-memory Blob)
- `docker-compose.yml` with an example reverse-proxy setup

## Threat model

Quicksend encrypts file content, filenames, and file metadata
end-to-end — the relay cannot read any of it, by construction, since
it never receives the encryption keys and only relays messages it
mostly can't (and, for the ones it can, doesn't need to) parse.

**What the relay *can* still see**, the same way any relay server can
for connections passing through it (this is the same server-level
visibility a service like Signal has, not a Quicksend-specific
weakness):

- The IP addresses of both devices in a session
- When a session started and how long it lasted
- The total volume of data transferred (as ciphertext byte counts)
- Coarse traffic patterns (e.g. how many chunks, roughly how large)

If you need to hide *that a transfer happened at all* — not just its
content — from whoever operates the network path to your relay, that's
outside what Quicksend (or most relay-based tools) protects against;
consider what network-level protections (VPN, Tor, etc.) fit your
situation.

## Known limitations

- **No independent security audit.** This is a carefully-built tool
  for a self-hosting-aware user who understands the tradeoffs, not a
  verified solution for genuinely high-stakes secrets. Review
  [docs/DECISIONS.md](docs/DECISIONS.md) yourself if that matters for
  your use case.
- **Safari and other browsers without the File System Access API**
  fall back to buffering the whole file in memory before offering it
  as a download — fine for photos, potentially painful for very large
  files. See the size warning shown in the UI when this fallback is
  used.
- See "Not yet implemented" above for missing features.

## Development

```sh
go build ./...              # build the relay
go test ./...                # Go unit/integration tests
make wasm                    # build the PAKE WASM module (required once before running locally)
node --test web/*.test.mjs   # JS crypto/PAKE tests
```

`docs/PROTOCOL.md` documents the wire protocol in enough detail to
write an alternative client without reading the Go source.
`docs/DECISIONS.md` is a running log of non-trivial design decisions
and why each was made.

## License

[GNU AGPL-3.0](LICENSE). If you run a modified version of Quicksend as
a network service, the AGPL requires you to make your modified source
available to its users — see the license text for the exact terms.
