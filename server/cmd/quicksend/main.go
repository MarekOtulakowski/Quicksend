// Command quicksend runs the Quicksend relay: a WebSocket-based, end-to-end
// encrypted file transfer relay with an embedded PWA frontend.
package main

import (
	"context"
	"errors"
	"io/fs"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	quicksend "github.com/MarekOtulakowski/Quicksend"
	"github.com/MarekOtulakowski/Quicksend/server/internal/config"
	"github.com/MarekOtulakowski/Quicksend/server/internal/session"
	"github.com/MarekOtulakowski/Quicksend/server/internal/ws"
)

// reapInterval is how often the hub scans for idle/expired sessions.
// It only needs to be finer-grained than the shortest configured
// timeout so expiry is noticed promptly.
const reapInterval = 5 * time.Second

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	slog.SetDefault(logger)

	cfg, err := config.Load()
	if err != nil {
		slog.Error("invalid configuration", "error", err)
		os.Exit(1)
	}

	webRoot, err := fs.Sub(quicksend.WebFS, "web")
	if err != nil {
		slog.Error("failed to load embedded web assets", "error", err)
		os.Exit(1)
	}

	hub := session.NewHub(cfg)

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", handleHealthz)
	mux.Handle("GET /ws", ws.NewHandler(hub))
	mux.Handle("/", noCache(http.FileServer(http.FS(webRoot))))

	srv := &http.Server{
		Addr:              cfg.ListenAddr,
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	go hub.Run(ctx, reapInterval)

	go func() {
		slog.Info("listening", "addr", cfg.ListenAddr)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			slog.Error("server failed", "error", err)
			os.Exit(1)
		}
	}()

	<-ctx.Done()
	slog.Info("shutting down")

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		slog.Error("graceful shutdown failed", "error", err)
	}
}

func handleHealthz(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte("ok"))
}

// noCache forces every static asset request to revalidate with the
// origin instead of being cached for hours by the browser or an
// intermediate CDN. http.FileServer sets no Cache-Control header of
// its own — a proxied Cloudflare zone in front of this app was filling
// that gap with its own default (max-age=14400, 4 hours), silently
// serving a stale pairing.js/styles.css to every visitor for hours
// after each deploy (see docs/DECISIONS.md). "no-cache" still allows
// caching, it just requires a conditional request each time — which
// http.FileServer already answers with a cheap 304 via its automatic
// ETag/Last-Modified handling when nothing changed.
func noCache(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-cache")
		next.ServeHTTP(w, r)
	})
}
