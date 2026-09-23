# Quicksend

Self-hosted, end-to-end encrypted file transfer between a phone and any
browser, even when the two devices are on different networks. No native
app, no account, no files ever touched by the server.

https://github.com/user-attachments/assets/591f6405-199c-4088-94c4-4bffedfa224c

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

Open `http://localhost:8080` — that's enough to look around the UI on
one machine, but **not** enough to actually pair two devices or send a
file: browsers only expose the Web Crypto API Quicksend needs for
*any* of that in a secure context (HTTPS, or literally `localhost`),
never over plain HTTP to a LAN IP. Pairing itself can look like it
works there (it only needs `crypto.getRandomValues`, which has no such
restriction), but everything after it — PAKE confirmation, encryption,
reconnect tokens — silently fails. See "Testing between two real
devices" below for the actual way to try it across devices, and
[docs/DECISIONS.md](docs/DECISIONS.md) for why.

For real use, put a reverse proxy (Caddy, Traefik, Cloudflare Tunnel)
in front for TLS — the container itself only speaks plain HTTP and is
not meant to be exposed directly to the internet.

### Testing between two real devices

The plain `docker run` above only serves plain HTTP, which — per the
note above — isn't a secure context except on `localhost` itself, so
it can't actually pair two *different* devices, and
[`docker-compose.yml`](docker-compose.yml) (see "Production
deployment" below) needs a real domain on Cloudflare — it can't issue
a certificate for a bare LAN IP. Without either of those, the only way
to exercise real pairing/encryption/transfer is two browser
tabs/windows on the same machine, both on `http://localhost:8080`:
that's enough to confirm the whole protocol works correctly, just not
a physically-separate-device test. For an actual cross-device test,
skip straight to "Production deployment" with a real domain.

### Production deployment

[`docker-compose.yml`](docker-compose.yml) runs the relay alongside
[Caddy](https://caddyserver.com/) as a reverse proxy that terminates
TLS automatically (via Let's Encrypt) and forwards to the relay over
Docker's internal network — the relay itself has no port published to
the host, so it's never reachable except through Caddy. This is also
what makes `QUICKSEND_MAX_SESSIONS_PER_IP` meaningful in this setup:
it trusts the `X-Forwarded-For` header Caddy sets, which only means
anything when the relay can't be reached any other way (see
[docs/DECISIONS.md](docs/DECISIONS.md)).

Caddy proves domain ownership to Let's Encrypt via a DNS TXT record
through Cloudflare's API (the "DNS-01" challenge) rather than by
answering an inbound HTTP request (the default "HTTP-01" challenge) —
**only port 443 needs to be reachable from the internet, never port
80.** This requires the domain's DNS to be managed by Cloudflare and a
scoped Cloudflare API token (see `.env.example` for exactly which
permission it needs). `caddy/Dockerfile` builds Caddy with the
Cloudflare DNS module from source via `xcaddy`, since the plain
`caddy:2-alpine` image doesn't include it.

```sh
cp .env.example .env
# edit .env: set QUICKSEND_DOMAIN (its DNS must be on Cloudflare) and
# CLOUDFLARE_API_TOKEN (see .env.example for how to scope it)
docker compose up -d
```

### Configuration

All limits are environment variables with sane defaults:

| Variable | Default | Meaning |
|---|---|---|
| `QUICKSEND_LISTEN_ADDR` | `:8080` | Address the relay binds to |
| `QUICKSEND_MAX_FILE_SIZE_BYTES` | 10 GiB | Max size of a single file the relay will keep relaying (see below) |
| `QUICKSEND_MAX_SESSIONS_PER_IP` | 10 | Concurrent sessions allowed per client IP |
| `QUICKSEND_SESSION_INACTIVITY_TIMEOUT` | 5m | Idle session teardown |
| `QUICKSEND_RECONNECT_GRACE_PERIOD` | 45s | How long a session survives a dropped connection |
| `QUICKSEND_PAIRING_CODE_TTL` | 5m | How long a remote pairing code stays valid |
| `QUICKSEND_MAX_PAIRING_ATTEMPTS` | 5 | Wrong pairing-code guesses allowed per IP before throttling |

`QUICKSEND_MAX_FILE_SIZE_BYTES` is enforced by counting the bytes of
whichever file is currently being relayed — using only the chunk
frame's outer header (its file ID and last-chunk flag), never its
ciphertext — so the relay can cut off an oversized file without ever
decrypting or understanding its content. Once a file crosses the
limit, the relay cancels it for both peers (the same `file_abort`
mechanism a user's own "Cancel" button uses) and the session otherwise
carries on normally. See docs/DECISIONS.md.

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
- Cancelling a single in-progress transfer, from either side, without
  ending the session
- Manually disconnecting the whole session on demand, from either
  side, instead of only ever exiting via an error
- Sharing the pairing link/code via the native share sheet or
  clipboard, with a persistent warning that whoever has it can join
  the transfer
- Sending files via a proper button or by dragging them onto the page
  from the desktop
- Saving via the File System Access API — pick a destination folder
  once and every file writes straight into it with no further
  per-file dialogs, falling back to a per-file save prompt or an
  in-memory Blob download on browsers without that API
- A clear error instead of a silent failure when the page is opened
  somewhere Web Crypto isn't available (see "Testing between two real
  devices" above)
- Light/dark theme, Polish/English UI
- `docker-compose.yml` for a production deployment behind Caddy
  (automatic TLS via Cloudflare DNS-01 — no need to open port 80 —
  relay never directly exposed)

### Not yet implemented

- Resuming a file transfer that was in flight across a reconnect
  (currently: the whole file is simply resent)
- Bundling multiple files into a streamed ZIP (currently saved as
  separate files)
- Service Worker streaming as a save fallback (currently File System
  Access API, else an in-memory Blob)

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
- **Picking a file from the Google Photos app on Android** can
  disconnect the sender while the picker is open: opening it
  backgrounds and freezes the browser tab long enough for
  Android/Chrome's own resource management to close the WebSocket
  outright — a platform limitation, not something an app in the page
  can prevent (see docs/DECISIONS.md). The app reconnects and still
  sends the picked file automatically either way, whether the
  reconnect finishes before or after the picker returns.
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
