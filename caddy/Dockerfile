# Builds a Caddy binary that includes the Cloudflare DNS provider
# module, so Caddy can prove domain ownership to Let's Encrypt via a
# DNS TXT record (the "DNS-01" ACME challenge) through Cloudflare's
# API, instead of the default HTTP-01 challenge — which needs port 80
# reachable from the internet. Built from source via xcaddy, the
# officially documented way to add a Caddy module, rather than pulling
# a third-party prebuilt image. See docs/DECISIONS.md.

FROM caddy:2-builder-alpine AS build
RUN xcaddy build --with github.com/caddy-dns/cloudflare

FROM caddy:2-alpine
COPY --from=build /usr/bin/caddy /usr/bin/caddy
