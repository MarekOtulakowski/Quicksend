// Verifies transfer.js fails fast instead of hanging forever when the
// underlying socket drops mid-transfer (see docs/DECISIONS.md: a
// reconnect resumes the *session*, not an in-flight file — the sender
// must resend, and the receiver must discard the partial file). This
// only exercises transfer.js's own close-handling in isolation; the
// full reconnect handshake is covered by the Go ws-package tests and
// ad-hoc Playwright runs against a live server, not committed here.
//
// Run with: node --test web/transfer.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import { sendFile, attachReceiver } from "./transfer.js";
import { deriveEpochKey, deriveFileKey, encryptChunk, METADATA_CHUNK_INDEX } from "./crypto.js";

/** Minimal stand-in for a WebSocket, just enough of the
 * addEventListener/removeEventListener/send surface transfer.js and
 * ws-client.js actually use. */
class FakeSocket {
  constructor() {
    this.sent = [];
    this._listeners = { message: [], close: [] };
  }
  addEventListener(type, fn) {
    this._listeners[type].push(fn);
  }
  removeEventListener(type, fn) {
    this._listeners[type] = this._listeners[type].filter((f) => f !== fn);
  }
  send(data) {
    this.sent.push(data);
  }
  emitMessage(data) {
    const event = { data };
    for (const fn of [...this._listeners.message]) fn(event);
  }
  emitClose() {
    for (const fn of [...this._listeners.close]) fn({});
  }
}

function makeFile(bytes, name = "test.bin") {
  return new File([bytes], name, { type: "application/octet-stream" });
}

test("sendFile rejects instead of hanging when the socket closes before all chunks are acked", async () => {
  const socket = new FakeSocket();
  const sessionKey = crypto.getRandomValues(new Uint8Array(32));
  const epochKey = await deriveEpochKey(sessionKey, 0);

  // Bigger than one chunk so sendFile is still waiting on acks, not
  // already done, when we cut the connection. crypto.getRandomValues
  // caps out at 64KiB per call, so generate this via Node's crypto
  // module instead (see docs/DECISIONS.md).
  const bytes = new Uint8Array(randomBytes(300 * 1024));
  const file = makeFile(bytes);

  const sendPromise = sendFile(socket, epochKey, file, {});

  // Give the first chunk(s) a tick to go out, then simulate a drop
  // before any chunk_ack ever arrives.
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(socket.sent.length > 0, "expected at least one frame to have been sent before the drop");
  socket.emitClose();

  await assert.rejects(sendPromise, /connection_lost/);
});

test("sendFile resolves normally when every chunk is acked (control case)", async () => {
  const socket = new FakeSocket();
  const sessionKey = crypto.getRandomValues(new Uint8Array(32));
  const epochKey = await deriveEpochKey(sessionKey, 0);
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  const file = makeFile(bytes);

  // Auto-ack every outgoing chunk frame as if a receiver were present.
  const originalSend = socket.send.bind(socket);
  socket.send = (data) => {
    originalSend(data);
    if (typeof data !== "string") {
      const fileId = new Uint8Array(data.slice(2, 18));
      const fileIdHex = Array.from(fileId).map((b) => b.toString(16).padStart(2, "0")).join("");
      queueMicrotask(() =>
        socket.emitMessage(JSON.stringify({ type: "chunk_ack", payload: { fileId: fileIdHex, ackedUpTo: 0 } })),
      );
    }
  };

  await sendFile(socket, epochKey, file, {});
  const chunkFrames = socket.sent.filter((d) => typeof d !== "string");
  assert.equal(chunkFrames.length, 1, "expected exactly one chunk frame for a file smaller than CHUNK_SIZE");
});

test("attachReceiver reports an error instead of hanging when the socket closes mid-file", async () => {
  const socket = new FakeSocket();
  const sessionKey = crypto.getRandomValues(new Uint8Array(32));
  const epochKey = await deriveEpochKey(sessionKey, 0);

  const fileId = crypto.getRandomValues(new Uint8Array(16));
  const fileIdHex = Array.from(fileId).map((b) => b.toString(16).padStart(2, "0")).join("");
  const fileKey = await deriveFileKey(epochKey, fileId);
  const metaPlaintext = new TextEncoder().encode(JSON.stringify({ name: "a.bin", size: 5, mime: "application/octet-stream" }));
  const metaCiphertext = await encryptChunk(fileKey, fileId, METADATA_CHUNK_INDEX, true, metaPlaintext);
  const toHex = (b) => Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");

  let started = false;
  let completed = false;
  let errorCount = 0;

  attachReceiver(socket, epochKey, {
    onFileStart: async () => {
      started = true;
    },
    onChunk: async () => {},
    onFileComplete: async () => {
      completed = true;
    },
    onError: () => {
      errorCount++;
    },
  });

  socket.emitMessage(JSON.stringify({ type: "file_meta", payload: { fileId: fileIdHex, ciphertext: toHex(metaCiphertext) } }));
  // Let the async file_meta handler run before dropping the connection.
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(started, "expected onFileStart to have fired before the drop");

  socket.emitClose();
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(completed, false, "a dropped connection mid-file must not report completion");
  assert.equal(errorCount, 1, "expected exactly one onError call for the drop");
});
