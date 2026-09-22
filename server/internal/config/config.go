// Package config loads relay configuration from environment variables.
package config

import (
	"fmt"
	"os"
	"strconv"
	"time"
)

// Config holds all tunable relay limits and settings. Every field is
// configurable via environment variable so the relay can be sized for a
// given deployment without code changes.
type Config struct {
	// ListenAddr is the address the HTTP/WebSocket server binds to.
	// TLS is expected to be terminated by a reverse proxy in front of us.
	ListenAddr string

	// MaxFileSize is the maximum size in bytes of a single file the relay
	// will allow to be transferred in one session.
	MaxFileSize int64

	// MaxSessionsPerIP limits how many concurrent sessions a single
	// client IP may hold open, to bound relay resource usage per client.
	MaxSessionsPerIP int

	// SessionInactivityTimeout is how long a session may sit idle (no
	// frames from either side) before the relay tears it down.
	SessionInactivityTimeout time.Duration

	// ReconnectGracePeriod is how long the relay keeps a session alive
	// after a WebSocket disconnect, waiting for the same client to
	// reconnect with a valid reconnect token, before discarding it.
	ReconnectGracePeriod time.Duration

	// PairingCodeTTL is how long a pairing code generated for code+PAKE
	// pairing remains valid before it expires.
	PairingCodeTTL time.Duration

	// MaxPairingAttempts is the number of wrong pairing-code attempts
	// allowed before the session is invalidated.
	MaxPairingAttempts int
}

const (
	defaultListenAddr               = ":8080"
	defaultMaxFileSize        int64 = 10 * 1024 * 1024 * 1024 // 10 GiB
	defaultMaxSessionsPerIP         = 10
	defaultSessionInactivity        = 5 * time.Minute
	defaultReconnectGrace           = 45 * time.Second
	defaultPairingCodeTTL           = 5 * time.Minute
	defaultMaxPairingAttempts       = 5
)

// Load reads configuration from environment variables, falling back to
// documented defaults for anything unset.
func Load() (Config, error) {
	cfg := Config{
		ListenAddr:               getEnvString("QUICKSEND_LISTEN_ADDR", defaultListenAddr),
		MaxFileSize:              defaultMaxFileSize,
		MaxSessionsPerIP:         defaultMaxSessionsPerIP,
		SessionInactivityTimeout: defaultSessionInactivity,
		ReconnectGracePeriod:     defaultReconnectGrace,
		PairingCodeTTL:           defaultPairingCodeTTL,
		MaxPairingAttempts:       defaultMaxPairingAttempts,
	}

	var err error
	if cfg.MaxFileSize, err = getEnvInt64("QUICKSEND_MAX_FILE_SIZE_BYTES", defaultMaxFileSize); err != nil {
		return Config{}, err
	}
	if cfg.MaxSessionsPerIP, err = getEnvInt("QUICKSEND_MAX_SESSIONS_PER_IP", defaultMaxSessionsPerIP); err != nil {
		return Config{}, err
	}
	if cfg.SessionInactivityTimeout, err = getEnvDuration("QUICKSEND_SESSION_INACTIVITY_TIMEOUT", defaultSessionInactivity); err != nil {
		return Config{}, err
	}
	if cfg.ReconnectGracePeriod, err = getEnvDuration("QUICKSEND_RECONNECT_GRACE_PERIOD", defaultReconnectGrace); err != nil {
		return Config{}, err
	}
	if cfg.PairingCodeTTL, err = getEnvDuration("QUICKSEND_PAIRING_CODE_TTL", defaultPairingCodeTTL); err != nil {
		return Config{}, err
	}
	if cfg.MaxPairingAttempts, err = getEnvInt("QUICKSEND_MAX_PAIRING_ATTEMPTS", defaultMaxPairingAttempts); err != nil {
		return Config{}, err
	}

	if cfg.MaxFileSize <= 0 {
		return Config{}, fmt.Errorf("QUICKSEND_MAX_FILE_SIZE_BYTES must be positive")
	}
	if cfg.MaxSessionsPerIP <= 0 {
		return Config{}, fmt.Errorf("QUICKSEND_MAX_SESSIONS_PER_IP must be positive")
	}
	if cfg.MaxPairingAttempts <= 0 {
		return Config{}, fmt.Errorf("QUICKSEND_MAX_PAIRING_ATTEMPTS must be positive")
	}

	return cfg, nil
}

func getEnvString(key, fallback string) string {
	if v, ok := os.LookupEnv(key); ok && v != "" {
		return v
	}
	return fallback
}

func getEnvInt(key string, fallback int) (int, error) {
	v, ok := os.LookupEnv(key)
	if !ok || v == "" {
		return fallback, nil
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return 0, fmt.Errorf("%s: %w", key, err)
	}
	return n, nil
}

func getEnvInt64(key string, fallback int64) (int64, error) {
	v, ok := os.LookupEnv(key)
	if !ok || v == "" {
		return fallback, nil
	}
	n, err := strconv.ParseInt(v, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("%s: %w", key, err)
	}
	return n, nil
}

func getEnvDuration(key string, fallback time.Duration) (time.Duration, error) {
	v, ok := os.LookupEnv(key)
	if !ok || v == "" {
		return fallback, nil
	}
	d, err := time.ParseDuration(v)
	if err != nil {
		return 0, fmt.Errorf("%s: %w", key, err)
	}
	return d, nil
}
