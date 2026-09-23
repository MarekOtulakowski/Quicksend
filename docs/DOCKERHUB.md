# Quicksend

![Docker Ready](https://img.shields.io/badge/Docker-Ready-2496ED?style=for-the-badge&logo=docker&logoColor=white)
![Self Hosted](https://img.shields.io/badge/self--hosted-yes-2ea44f?style=for-the-badge&logo=serverfault&logoColor=white)
![License](https://img.shields.io/badge/license-AGPL--3.0-lightgrey?style=for-the-badge&logo=open-source-initiative&logoColor=white)

Self-hosted, end-to-end encrypted file transfer between a phone and any browser — even across different networks, with no native app, no account, and no file ever touched by the server. Pair with a QR code (devices physically together) or a short spoken code (remote devices), then send.

## Features

- QR pairing and remote code+PAKE (SPAKE2) pairing
- End-to-end encryption (AES-256-GCM, per-file keys via HKDF) — the relay only ever forwards ciphertext it can't read
- Reconnect after a dropped connection, without re-pairing
- Swap sender/receiver roles mid-session
- Drag-and-drop sending; pick a save folder once instead of a dialog per file
- Light/dark theme, Polish/English UI
- Single image: the PWA is embedded in the same binary that runs the relay

## Quick Start

```bash
docker run -d --name quicksend -p 8080:8080 marekotulakowski/quicksend:latest
```

Open `http://localhost:8080`.

**Note:** browsers only allow the encryption Quicksend needs (Web Crypto) over HTTPS or on `localhost` itself — plain HTTP to any other address (e.g. a LAN IP) lets you look around the page but not actually pair or transfer. See "Production Deployment" below for real HTTPS.

## Docker Compose (local, no HTTPS)

```yaml
services:
  quicksend:
    image: marekotulakowski/quicksend:latest
    restart: unless-stopped
    ports:
      - "8080:8080"
```

```bash
docker compose up -d
```

Same `localhost`-only limitation as above — fine for a quick look, not for pairing with a phone over the network.

## Production Deployment (real HTTPS, no port 80)

This runs the relay behind [Caddy](https://caddyserver.com/) as a reverse proxy, with Caddy getting its certificate from Let's Encrypt via a Cloudflare DNS-01 challenge — **only port 443 needs to be open on your firewall, never port 80.** Requires your domain's DNS to be managed by Cloudflare.

### 1. Install Docker (skip if already installed)

```bash
curl -fsSL https://get.docker.com | sh
```

### 2. Fetch the deployment files

No need to clone the whole repository — just these four:

```bash
mkdir -p quicksend/caddy && cd quicksend
curl -fsSL -o docker-compose.yml https://raw.githubusercontent.com/MarekOtulakowski/Quicksend/main/docker-compose.yml
curl -fsSL -o Caddyfile https://raw.githubusercontent.com/MarekOtulakowski/Quicksend/main/Caddyfile
curl -fsSL -o caddy/Dockerfile https://raw.githubusercontent.com/MarekOtulakowski/Quicksend/main/caddy/Dockerfile
curl -fsSL -o .env.example https://raw.githubusercontent.com/MarekOtulakowski/Quicksend/main/.env.example
```

### 3. Configure

```bash
cp .env.example .env
```

Edit `.env`:
- `QUICKSEND_DOMAIN` — your domain (its DNS must be on Cloudflare)
- `CLOUDFLARE_API_TOKEN` — a token scoped to just that zone with "Zone / DNS / Edit" permission (create one at [dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens), the "Edit zone DNS" template) — **never your account's Global API Key**, which can edit every zone

### 4. Start it

```bash
docker compose up -d
```

Open `https://<QUICKSEND_DOMAIN>` — Caddy issues the certificate automatically on first request.

## Configuration

All limits are environment variables on the `quicksend` service:

| Variable | Default | Meaning |
|---|---|---|
| `QUICKSEND_LISTEN_ADDR` | `:8080` | Address the relay binds to |
| `QUICKSEND_MAX_FILE_SIZE_BYTES` | 10 GiB | Max size of a single file the relay will keep relaying |
| `QUICKSEND_MAX_SESSIONS_PER_IP` | 10 | Concurrent sessions allowed per client IP |
| `QUICKSEND_SESSION_INACTIVITY_TIMEOUT` | 5m | Idle session teardown |
| `QUICKSEND_RECONNECT_GRACE_PERIOD` | 45s | How long a session survives a dropped connection |
| `QUICKSEND_PAIRING_CODE_TTL` | 5m | How long a remote pairing code stays valid |
| `QUICKSEND_MAX_PAIRING_ATTEMPTS` | 5 | Wrong pairing-code guesses allowed per IP before throttling |

## Notes

- If your DNS is on Cloudflare, keep the domain **DNS only** (grey cloud), not proxied — Quicksend holds a long-lived WebSocket per session, and a proxied record adds a second layer (caching, protocol negotiation) that can cause real headaches for that kind of connection for no real benefit on a single small relay.
- The relay never sees plaintext file content, filenames, or encryption keys — architecturally, not just by policy. See the source for exactly what it does parse (a small allowlist of control messages).
- **No independent security audit.** A carefully-built tool for a self-hosting-aware user, not a verified solution for high-stakes secrets.
- Multi-arch image: `linux/amd64` + `linux/arm64`.
- Full source, wire protocol documentation, and the reasoning behind every non-trivial design decision: **https://github.com/MarekOtulakowski/Quicksend**
- Licensed under [AGPL-3.0](https://github.com/MarekOtulakowski/Quicksend/blob/main/LICENSE) — if you run a modified version as a network service, the AGPL requires you to make your modified source available to its users.
