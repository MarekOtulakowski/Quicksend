# syntax=docker/dockerfile:1

FROM golang:1.26-alpine AS build
WORKDIR /src

COPY go.mod go.sum ./
RUN go mod download

COPY assets.go ./
COPY server/ server/
COPY web/ web/
COPY wasm/ wasm/

# Built fresh from source rather than committed to git (see
# docs/DECISIONS.md) — must happen before the server build below,
# since go:embed silently embeds whatever web/ contains at build time
# rather than erroring if these are missing.
RUN GOOS=js GOARCH=wasm go build -trimpath -ldflags="-s -w" \
    -o web/vendor/pake.wasm ./wasm/pake
RUN cp "$(go env GOROOT)/lib/wasm/wasm_exec.js" web/vendor/wasm_exec.js

RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" \
    -o /out/quicksend ./server/cmd/quicksend
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" \
    -o /out/healthcheck ./server/cmd/healthcheck

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/quicksend /quicksend
COPY --from=build /out/healthcheck /healthcheck

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD ["/healthcheck"]

ENTRYPOINT ["/quicksend"]
