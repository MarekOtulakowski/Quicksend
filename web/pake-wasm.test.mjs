// Verifies the WASM build of wasm/pake/main.go (schollz/pake/v3
// exposed via syscall/js) behaves correctly, without a browser: Node
// can run Go-compiled WASM directly via the Go toolchain's
// wasm_exec.js. Requires `make wasm` to have been run first so
// vendor/pake.wasm and vendor/wasm_exec.js exist (gitignored build
// artifacts, always built fresh from source — see docs/DECISIONS.md).
//
// Run with: node --test web/pake-wasm.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createRequire } from "node:module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

globalThis.require = createRequire(import.meta.url);
await import("./vendor/wasm_exec.js").catch(() => {
  throw new Error('web/vendor/wasm_exec.js not found — run "make wasm" first');
}); // side effect: sets globalThis.Go

async function loadPake() {
  const go = new globalThis.Go();
  const wasmPath = path.join(__dirname, "vendor", "pake.wasm");
  const wasmBytes = await readFile(wasmPath).catch(() => {
    throw new Error(`${wasmPath} not found — run "make wasm" first`);
  });
  const { instance } = await WebAssembly.instantiate(wasmBytes, go.importObject);
  go.run(instance); // never resolves (main() blocks on select{}); don't await.
  await new Promise((r) => setTimeout(r, 50));
  if (!globalThis.quicksendPake) throw new Error("quicksendPake global not set");
  return globalThis.quicksendPake;
}

const pakePromise = loadPake();

test("matching passwords derive the same session key", async () => {
  const pake = await pakePromise;
  const password = "482193";

  const A = pake.init(password, 0);
  assert.equal(A.error, undefined);
  assert.ok(A.message.length > 0);

  const B = pake.init(password, 1);
  assert.equal(B.error, undefined);
  assert.equal(B.message, "");

  const bUpdate = pake.update(B.handle, A.message);
  assert.equal(bUpdate.error, undefined);
  assert.ok(bUpdate.message.length > 0);

  const aUpdate = pake.update(A.handle, bUpdate.message);
  assert.equal(aUpdate.error, undefined);
  assert.equal(aUpdate.message, "");

  const aKey = pake.sessionKey(A.handle);
  const bKey = pake.sessionKey(B.handle);
  assert.equal(aKey.error, undefined);
  assert.equal(bKey.error, undefined);
  assert.equal(aKey.sessionKeyHex, bKey.sessionKeyHex);
  assert.match(aKey.sessionKeyHex, /^[0-9a-f]{64}$/);

  pake.free(A.handle);
  pake.free(B.handle);
});

test("mismatched passwords derive different session keys without a protocol error", async () => {
  const pake = await pakePromise;

  const A = pake.init("482193", 0);
  const B = pake.init("000000", 1);
  const bUpdate = pake.update(B.handle, A.message);
  assert.equal(bUpdate.error, undefined);
  const aUpdate = pake.update(A.handle, bUpdate.message);
  assert.equal(aUpdate.error, undefined);

  const aKey = pake.sessionKey(A.handle);
  const bKey = pake.sessionKey(B.handle);
  assert.notEqual(aKey.sessionKeyHex, bKey.sessionKeyHex);

  pake.free(A.handle);
  pake.free(B.handle);
});

test("unknown handle returns an error instead of crashing", async () => {
  const pake = await pakePromise;
  const r = pake.update(999999999, "garbage");
  assert.equal(r.error, "unknown pake handle");
});

test("malformed message returns an error", async () => {
  const pake = await pakePromise;
  const A = pake.init("482193", 1);
  const r = pake.update(A.handle, "not valid json");
  assert.ok(r.error);
  pake.free(A.handle);
});
