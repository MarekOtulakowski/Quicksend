// Verifies web/crypto.js against the same frozen vectors
// server/internal/cryptoutil is checked against (see
// /testvectors/crypto_v1.json), proving the Go and Web Crypto
// implementations of Quicksend's KDF/AEAD scheme agree byte-for-byte.
//
// Run with: node --test web/crypto.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  deriveEpochKey,
  deriveFileKey,
  encryptChunk,
  decryptChunk,
  deriveReconnectToken,
  METADATA_CHUNK_INDEX,
} from "./crypto.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function hexToBytes(hex) {
  if (hex.length === 0) return new Uint8Array(0);
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes) {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function loadVectors() {
  const p = path.join(__dirname, "..", "testvectors", "crypto_v1.json");
  const data = await readFile(p, "utf8");
  return JSON.parse(data);
}

test("epoch key derivation matches frozen vectors", async () => {
  const v = await loadVectors();
  const sessionKey = hexToBytes(v.sessionKeyHex);
  for (const ev of v.epochKeyVectors) {
    const got = await deriveEpochKey(sessionKey, ev.epoch);
    assert.equal(bytesToHex(got), ev.expectedEpochKeyHex, `epoch ${ev.epoch}`);
  }
});

test("file key derivation matches frozen vector", async () => {
  const v = await loadVectors();
  const sessionKey = hexToBytes(v.sessionKeyHex);
  const fileID = hexToBytes(v.fileIDHex);
  const epochVector = v.epochKeyVectors.find((e) => e.epoch === v.fileKeyVector.epoch);
  const epochKey = await deriveEpochKey(sessionKey, epochVector.epoch);
  const fileKey = await deriveFileKey(epochKey, fileID);
  assert.equal(bytesToHex(fileKey), v.fileKeyVector.expectedFileKeyHex);
});

test("chunk encryption matches frozen vectors and round-trips", async () => {
  const v = await loadVectors();
  const sessionKey = hexToBytes(v.sessionKeyHex);
  const fileID = hexToBytes(v.fileIDHex);
  const epochVector = v.epochKeyVectors.find((e) => e.epoch === v.fileKeyVector.epoch);
  const epochKey = await deriveEpochKey(sessionKey, epochVector.epoch);
  const fileKey = await deriveFileKey(epochKey, fileID);

  for (const cv of v.chunkVectors) {
    await test(cv.name, async () => {
      const plaintext = hexToBytes(cv.plaintextHex);
      const ct = await encryptChunk(fileKey, fileID, cv.chunkIndex, cv.last, plaintext);
      assert.equal(bytesToHex(ct), cv.expectedCiphertextHex);

      const opened = await decryptChunk(fileKey, fileID, cv.chunkIndex, cv.last, ct);
      assert.equal(bytesToHex(opened), cv.plaintextHex);
    });
  }
});

test("reconnect token matches frozen vector", async () => {
  const v = await loadVectors();
  const sessionKey = hexToBytes(v.sessionKeyHex);
  const token = await deriveReconnectToken(sessionKey, v.reconnectTokenVector.sessionId);
  assert.equal(bytesToHex(token), v.reconnectTokenVector.expectedTokenHex);
});

test("decryptChunk rejects tampered AAD (wrong index, last-flag, or fileID)", async () => {
  const sessionKey = new Uint8Array(32);
  const fileID = Uint8Array.from({ length: 16 }, (_, i) => i);
  const epochKey = await deriveEpochKey(sessionKey, 0);
  const fileKey = await deriveFileKey(epochKey, fileID);

  const plaintext = new TextEncoder().encode("payload");
  const ct = await encryptChunk(fileKey, fileID, 5, false, plaintext);

  await assert.rejects(() => decryptChunk(fileKey, fileID, 6, false, ct));
  await assert.rejects(() => decryptChunk(fileKey, fileID, 5, true, ct));

  const otherFileID = Uint8Array.from(fileID);
  otherFileID[0] ^= 0xff;
  await assert.rejects(() => decryptChunk(fileKey, otherFileID, 5, false, ct));

  const opened = await decryptChunk(fileKey, fileID, 5, false, ct);
  assert.equal(new TextDecoder().decode(opened), "payload");
});

test("different epochs and fileIDs yield different keys", async () => {
  const sessionKey = new Uint8Array(32);
  const k0 = await deriveEpochKey(sessionKey, 0);
  const k1 = await deriveEpochKey(sessionKey, 1);
  assert.notEqual(bytesToHex(k0), bytesToHex(k1));

  const epochKey = new Uint8Array(32);
  const fileA = new Uint8Array(16).fill(0xaa);
  const fileB = new Uint8Array(16).fill(0xbb);
  const kA = await deriveFileKey(epochKey, fileA);
  const kB = await deriveFileKey(epochKey, fileB);
  assert.notEqual(bytesToHex(kA), bytesToHex(kB));
});

test("metadata encryption (reserved sentinel index) matches frozen vector", async () => {
  const v = await loadVectors();
  const sessionKey = hexToBytes(v.sessionKeyHex);
  const fileID = hexToBytes(v.fileIDHex);
  const epochVector = v.epochKeyVectors.find((e) => e.epoch === v.fileKeyVector.epoch);
  const epochKey = await deriveEpochKey(sessionKey, epochVector.epoch);
  const fileKey = await deriveFileKey(epochKey, fileID);

  const plaintext = hexToBytes(v.metadataVector.plaintextHex);
  const ct = await encryptChunk(fileKey, fileID, METADATA_CHUNK_INDEX, true, plaintext);
  assert.equal(bytesToHex(ct), v.metadataVector.expectedCiphertextHex);

  const opened = await decryptChunk(fileKey, fileID, METADATA_CHUNK_INDEX, true, ct);
  assert.equal(bytesToHex(opened), v.metadataVector.plaintextHex);
});
