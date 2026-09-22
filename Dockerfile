# syntax=docker/dockerfile:1

FROM golang:1.26-alpine AS build
WORKDIR /src

COPY go.mod ./
RUN go mod download

COPY assets.go ./
COPY server/ server/
COPY web/ web/

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
