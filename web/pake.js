// Loads the WASM build of schollz/pake/v3 (wasm/pake) and exposes it
// as a small async API. This is the code+PAKE pairing flow's crypto
// engine — see docs/PROTOCOL.md and docs/DECISIONS.md for the exact
// wire flow and why PAKE runs as WASM rather than a separate JS
// SPAKE2 implementation.

let goInstanceStarted = false;
let readyPromise = null;

function waitFor(predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const start = performance.now();
    (function poll() {
      if (predicate()) return resolve();
      if (performance.now() - start > timeoutMs) return reject(new Error("timed out waiting for WASM PAKE module"));
      setTimeout(poll, 10);
    })();
  });
}

async function ensureLoaded() {
  if (readyPromise) return readyPromise;
  readyPromise = (async () => {
    if (!goInstanceStarted) {
      await import("./vendor/wasm_exec.js"); // side effect: sets globalThis.Go
      const go = new globalThis.Go();
      const resp = await fetch(new URL("./vendor/pake.wasm", import.meta.url));
      const { instance } = await WebAssembly.instantiateStreaming(resp, go.importObject);
      go.run(instance); // never resolves (main() blocks on select{}); don't await.
      goInstanceStarted = true;
    }
    await waitFor(() => !!globalThis.quicksendPake);
  })();
  return readyPromise;
}

/** Starts a PAKE exchange. role 0 is the initiator (host), role 1 is
 * the responder (guest) — see docs/PROTOCOL.md for the role mapping.
 * Returns { handle, message }; message is "" for role 1 until update()
 * is called with the initiator's message. */
export async function init(password, role) {
  await ensureLoaded();
  const result = globalThis.quicksendPake.init(password, role);
  if (result.error) throw new Error(result.error);
  return result;
}

/** Processes the other side's message. Returns { message }: for role
 * 1 this is the response to send back; for role 0's final call it's
 * always "" (nothing left to send). Does not itself detect a wrong
 * password — see confirmSessionKey below. */
export async function update(handle, message) {
  await ensureLoaded();
  const result = globalThis.quicksendPake.update(handle, message);
  if (result.error) throw new Error(result.error);
  return result;
}

/** Returns the raw derived session key as a Uint8Array(32). Only
 * meaningful after the exchange above has completed on this side. */
export async function sessionKey(handle) {
  await ensureLoaded();
  const result = globalThis.quicksendPake.sessionKey(handle);
  if (result.error) throw new Error(result.error);
  const hex = result.sessionKeyHex;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  return bytes;
}

/** Releases WASM-side state for handle. */
export async function free(handle) {
  await ensureLoaded();
  globalThis.quicksendPake.free(handle);
}

const CONFIRM_INFO = new TextEncoder().encode("quicksend-pake-confirm");

/** Computes the key-confirmation tag both sides exchange to detect a
 * wrong code: schollz/pake's SPAKE2 exchange itself can't tell a wrong
 * password from a right one (both sides just derive different keys
 * silently) — see docs/DECISIONS.md. HMAC-SHA256(sessionKey, fixed
 * context); both sides compute this over their OWN derived key and
 * compare against what the other side sends, so a mismatch surfaces
 * immediately as "wrong code" instead of a much-later decrypt failure. */
export async function computeConfirmTag(sessionKeyBytes) {
  const key = await crypto.subtle.importKey("raw", sessionKeyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, CONFIRM_INFO);
  return new Uint8Array(sig);
}

function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function verifyConfirmTag(sessionKeyBytes, receivedTag) {
  const expected = await computeConfirmTag(sessionKeyBytes);
  return bytesEqual(expected, receivedTag);
}
