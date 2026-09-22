//go:build js && wasm

// Command pake_wasm compiles to WebAssembly and exposes schollz/pake/v3's
// SPAKE2 exchange to the browser via a small syscall/js API
// (window.quicksendPake). This is the WASM build of the exact same Go
// package a native Go program would use, so there is exactly one PAKE
// implementation rather than a parallel JS reimplementation — see
// docs/DECISIONS.md.
//
// It never runs on the relay: only the two pairing browsers load this,
// and the password/session key never leave their own memory.
package main

import (
	"encoding/hex"
	"errors"
	"sync"
	"syscall/js"

	pake "github.com/schollz/pake/v3"
)

// curve is fixed at P-256: the standard NIST curve, chosen over this
// library's other options (its own "siec" curve, p384/p521, an
// Edwards25519 adaptation) for being the most widely analyzed and
// implemented. See docs/DECISIONS.md.
const curve = "p256"

var (
	mu       sync.Mutex
	nextID   int
	byHandle = map[int]*pake.Pake{}
)

var errUnknownHandle = errors.New("unknown pake handle")

// jsInit starts a PAKE exchange: quicksendPake.init(password, role).
// role 0 is the initiator (gets an initial message to send); role 1
// is the responder (must wait for the initiator's message before it
// has anything to send). Returns {handle, message} or {error}.
func jsInit(_ js.Value, args []js.Value) any {
	password := args[0].String()
	role := args[1].Int()

	p, err := pake.InitCurve([]byte(password), role, curve)
	if err != nil {
		return errValue(err)
	}

	mu.Lock()
	nextID++
	handle := nextID
	byHandle[handle] = p
	mu.Unlock()

	message := ""
	if role == 0 {
		message = string(p.Bytes())
	}
	return js.ValueOf(map[string]any{"handle": handle, "message": message})
}

// jsUpdate processes the other party's message:
// quicksendPake.update(handle, message). Returns {message} (the
// response to send onward — empty if there is none, i.e. this was the
// initiator's final step) or {error} if the message was malformed.
// It does not itself detect a wrong password; see sessionKey.
func jsUpdate(_ js.Value, args []js.Value) any {
	handle := args[0].Int()
	message := args[1].String()

	mu.Lock()
	p, ok := byHandle[handle]
	mu.Unlock()
	if !ok {
		return errValue(errUnknownHandle)
	}

	if err := p.Update([]byte(message)); err != nil {
		return errValue(err)
	}

	// Role 1 (the responder) computes its own message (Y) and its
	// session key in this same Update call, and must send Y onward.
	// Role 0 (the initiator) has nothing left to send at this point —
	// its Update call is the final step of the exchange.
	response := ""
	if p.Role == 1 {
		response = string(p.Bytes())
	}
	return js.ValueOf(map[string]any{"message": response})
}

// jsSessionKey returns the derived session key as hex:
// quicksendPake.sessionKey(handle). Only meaningful after the
// exchange above has fully completed on this side. Returns
// {sessionKeyHex} or {error}.
func jsSessionKey(_ js.Value, args []js.Value) any {
	handle := args[0].Int()

	mu.Lock()
	p, ok := byHandle[handle]
	mu.Unlock()
	if !ok {
		return errValue(errUnknownHandle)
	}

	key, err := p.SessionKey()
	if err != nil {
		return errValue(err)
	}
	return js.ValueOf(map[string]any{"sessionKeyHex": hex.EncodeToString(key)})
}

// jsFree releases a handle's state: quicksendPake.free(handle).
func jsFree(_ js.Value, args []js.Value) any {
	handle := args[0].Int()
	mu.Lock()
	delete(byHandle, handle)
	mu.Unlock()
	return js.Undefined()
}

func errValue(err error) js.Value {
	return js.ValueOf(map[string]any{"error": err.Error()})
}

func main() {
	js.Global().Set("quicksendPake", js.ValueOf(map[string]any{
		"init":       js.FuncOf(jsInit),
		"update":     js.FuncOf(jsUpdate),
		"sessionKey": js.FuncOf(jsSessionKey),
		"free":       js.FuncOf(jsFree),
	}))

	select {} // keep the Go runtime alive so the callbacks above keep working
}
