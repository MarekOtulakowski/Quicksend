// Command healthcheck is a minimal HTTP client used as a Docker
// HEALTHCHECK for the quicksend image, which has no shell or curl.
// It exits 0 if the relay's /healthz endpoint responds with 200 OK,
// and 1 otherwise.
package main

import (
	"net/http"
	"os"
	"time"
)

func main() {
	addr := os.Getenv("QUICKSEND_HEALTHCHECK_ADDR")
	if addr == "" {
		addr = "http://127.0.0.1:8080/healthz"
	}

	client := http.Client{Timeout: 3 * time.Second}
	resp, err := client.Get(addr)
	if err != nil {
		os.Exit(1)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		os.Exit(1)
	}
}
