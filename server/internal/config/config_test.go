package config

import (
	"testing"
	"time"
)

func TestLoadDefaults(t *testing.T) {
	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if cfg.ListenAddr != defaultListenAddr {
		t.Errorf("ListenAddr = %q, want %q", cfg.ListenAddr, defaultListenAddr)
	}
	if cfg.MaxFileSize != defaultMaxFileSize {
		t.Errorf("MaxFileSize = %d, want %d", cfg.MaxFileSize, defaultMaxFileSize)
	}
	if cfg.MaxPairingAttempts != defaultMaxPairingAttempts {
		t.Errorf("MaxPairingAttempts = %d, want %d", cfg.MaxPairingAttempts, defaultMaxPairingAttempts)
	}
}

func TestLoadOverridesFromEnv(t *testing.T) {
	t.Setenv("QUICKSEND_LISTEN_ADDR", ":9090")
	t.Setenv("QUICKSEND_MAX_FILE_SIZE_BYTES", "1024")
	t.Setenv("QUICKSEND_MAX_SESSIONS_PER_IP", "3")
	t.Setenv("QUICKSEND_SESSION_INACTIVITY_TIMEOUT", "1m")
	t.Setenv("QUICKSEND_RECONNECT_GRACE_PERIOD", "10s")
	t.Setenv("QUICKSEND_PAIRING_CODE_TTL", "2m")
	t.Setenv("QUICKSEND_MAX_PAIRING_ATTEMPTS", "2")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if cfg.ListenAddr != ":9090" {
		t.Errorf("ListenAddr = %q, want :9090", cfg.ListenAddr)
	}
	if cfg.MaxFileSize != 1024 {
		t.Errorf("MaxFileSize = %d, want 1024", cfg.MaxFileSize)
	}
	if cfg.MaxSessionsPerIP != 3 {
		t.Errorf("MaxSessionsPerIP = %d, want 3", cfg.MaxSessionsPerIP)
	}
	if cfg.SessionInactivityTimeout != time.Minute {
		t.Errorf("SessionInactivityTimeout = %v, want 1m", cfg.SessionInactivityTimeout)
	}
	if cfg.ReconnectGracePeriod != 10*time.Second {
		t.Errorf("ReconnectGracePeriod = %v, want 10s", cfg.ReconnectGracePeriod)
	}
	if cfg.PairingCodeTTL != 2*time.Minute {
		t.Errorf("PairingCodeTTL = %v, want 2m", cfg.PairingCodeTTL)
	}
	if cfg.MaxPairingAttempts != 2 {
		t.Errorf("MaxPairingAttempts = %d, want 2", cfg.MaxPairingAttempts)
	}
}

func TestLoadRejectsInvalidValues(t *testing.T) {
	cases := map[string]string{
		"QUICKSEND_MAX_FILE_SIZE_BYTES":  "0",
		"QUICKSEND_MAX_SESSIONS_PER_IP":  "0",
		"QUICKSEND_MAX_PAIRING_ATTEMPTS": "0",
	}
	for key, val := range cases {
		t.Run(key, func(t *testing.T) {
			t.Setenv(key, val)
			if _, err := Load(); err == nil {
				t.Errorf("Load() with %s=%s: expected error, got nil", key, val)
			}
		})
	}
}

func TestLoadRejectsMalformedValues(t *testing.T) {
	t.Setenv("QUICKSEND_SESSION_INACTIVITY_TIMEOUT", "not-a-duration")
	if _, err := Load(); err == nil {
		t.Error("Load() with malformed duration: expected error, got nil")
	}
}
