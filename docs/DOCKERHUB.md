# Quicksend

Self-hosted, end-to-end encrypted file transfer between a phone and
any browser — even across different networks. No native app, no
account, no files ever touched by the server.

## What it does

Quicksend pairs two browsers — the same page plays either role —
through a small relay you run yourself:

- **QR code**, for devices that are physically together: the receiver
  shows a QR/link carrying a session key that never touches the relay.
- **Short code + PAKE (SPAKE2)**, for remote devices: a 6-digit code
  read out over any channel derives a strong session key without the
  relay ever seeing it as more than an opaque routing token.

Files are sent chunk-by-chunk, encrypted end-to-end (AES-256-GCM, keys
derived per file with HKDF). The relay only ever forwards ciphertext
it can't read.

## Features

- QR and remote code+PAKE pairing
- End-to-end encrypted transfer with flow control, cancel, and
  reconnect after a dropped connection
- Swap sender/receiver roles mid-session
- Drag-and-drop sending; pick a save folder once instead of a dialog
  per file
- Light/dark theme, Polish/English UI
- Single image: the PWA is embedded in the same binary that runs the
  relay

## Quick start

```sh
docker run -d --name quicksend -p 8080:8080 marekotulakowski/quicksend
```

Open `http://localhost:8080`. **Note:** browsers only allow the
encryption Quicksend needs (Web Crypto) over HTTPS or on `localhost`
itself — plain HTTP to any other address (e.g. a LAN IP) will let you
look around the page but not actually pair or transfer. See the
project's `docker-compose.yml` for a real deployment behind
[Caddy](https://caddyserver.com/) with automatic TLS.

## Configuration

All limits are environment variables (`QUICKSEND_LISTEN_ADDR`,
`QUICKSEND_MAX_FILE_SIZE_BYTES`, `QUICKSEND_MAX_SESSIONS_PER_IP`,
`QUICKSEND_SESSION_INACTIVITY_TIMEOUT`, `QUICKSEND_RECONNECT_GRACE_PERIOD`,
`QUICKSEND_PAIRING_CODE_TTL`, `QUICKSEND_MAX_PAIRING_ATTEMPTS`) — see
the full table and defaults in the
[README](https://github.com/MarekOtulakowski/Quicksend#configuration).

## Source, docs, and license

Full source, wire protocol documentation, and the reasoning behind
every non-trivial design decision:
**https://github.com/MarekOtulakowski/Quicksend**

Licensed under [AGPL-3.0](https://github.com/MarekOtulakowski/Quicksend/blob/main/LICENSE).
If you run a modified version as a network service, the AGPL requires
you to make your modified source available to its users.

**No independent security audit.** A carefully-built tool for a
self-hosting-aware user, not a verified solution for high-stakes
secrets — see the README's threat model and known limitations.
