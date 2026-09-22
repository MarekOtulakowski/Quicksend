.PHONY: wasm test test-go test-js

# Builds the PAKE WASM module the PWA loads for code+PAKE pairing.
# Not committed to git (see .gitignore) — always built fresh from
# wasm/pake so the binary can never drift from its source.
wasm:
	GOOS=js GOARCH=wasm go build -trimpath -ldflags="-s -w" -o web/vendor/pake.wasm ./wasm/pake
	cp "$$(go env GOROOT)/lib/wasm/wasm_exec.js" web/vendor/wasm_exec.js

test: test-go test-js

test-go:
	go test ./...

test-js:
	node --test web/*.test.mjs
