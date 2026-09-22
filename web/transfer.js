// File transfer over an already-paired session (docs/PROTOCOL.md).
// The sender reads a File chunk-by-chunk (never loading the whole
// file into memory), encrypts each chunk, and sends it as a binary
// WebSocket frame; the receiver decrypts chunks in order and hands
// them to a sink (file-writer.js). Metadata (name/size/mime) is
// encrypted too, under the same per-file key, using a reserved chunk
// index — see cryptoutil.MetadataChunkIndex / crypto.js's
// METADATA_CHUNK_INDEX.

import { deriveFileKey, encryptChunk, decryptChunk, METADATA_CHUNK_INDEX } from "./crypto.js";
import { sendEnvelope, parseEnvelope } from "./ws-client.js";
import { toHex, fromHex } from "./hex.js";

export const CHUNK_SIZE = 256 * 1024;
// How many unacknowledged chunks the sender allows in flight before
// pausing — backpressure instead of a fixed messages/minute cap, so
// throughput adapts to how fast the receiver can decrypt+write.
export const WINDOW_SIZE = 8;

const FRAME_TYPE_CHUNK = 0x01;

function buildChunkFrame(fileId, index, isLast, ciphertext) {
  const frame = new Uint8Array(1 + 1 + 16 + 8 + ciphertext.length);
  frame[0] = FRAME_TYPE_CHUNK;
  frame[1] = isLast ? 1 : 0;
  frame.set(fileId, 2);
  new DataView(frame.buffer).setBigUint64(18, BigInt(index), false);
  frame.set(ciphertext, 26);
  return frame;
}

function parseChunkFrame(buffer) {
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 26 || bytes[0] !== FRAME_TYPE_CHUNK) return null;
  const isLast = (bytes[1] & 1) === 1;
  const fileId = bytes.slice(2, 18);
  const index = new DataView(bytes.buffer, bytes.byteOffset + 18, 8).getBigUint64(0, false);
  const ciphertext = bytes.slice(26);
  return { fileId, index, isLast, ciphertext };
}

/**
 * Sends one file over socket, encrypted under a fresh per-file key
 * derived from epochKey. Resolves once the receiver has acked the
 * final chunk. `onProgress({sent, total})` is called after each chunk.
 *
 * `signal` (an AbortSignal) lets the caller cancel mid-transfer — the
 * receiver is told via `file_abort` and the returned promise rejects
 * with a DOMException named "AbortError" (the same convention as
 * `fetch`), distinguishing a user-initiated cancel from a real error.
 * The receiver can also initiate the cancel itself (its own
 * `abortCurrent`, see attachReceiver below); either way this function
 * sees the same `file_abort` message and stops, only re-sending it
 * itself when *we* were the ones who decided to cancel.
 */
export async function sendFile(socket, epochKey, file, { onProgress, signal } = {}) {
  const fileId = crypto.getRandomValues(new Uint8Array(16));
  const fileIdHex = toHex(fileId);
  const fileKey = await deriveFileKey(epochKey, fileId);

  const metaPlaintext = new TextEncoder().encode(
    JSON.stringify({ name: file.name, size: file.size, mime: file.type || "application/octet-stream" }),
  );
  const metaCiphertext = await encryptChunk(fileKey, fileId, METADATA_CHUNK_INDEX, true, metaPlaintext);
  sendEnvelope(socket, "file_meta", { fileId: fileIdHex, ciphertext: toHex(metaCiphertext) });

  const totalChunks = Math.max(1, Math.ceil(file.size / CHUNK_SIZE));
  let ackedUpTo = -1;
  let ackWaiters = [];
  let connectionLost = null;
  let aborted = null; // { remote: bool } once either side cancels

  function wakeWaiters() {
    const waiters = ackWaiters;
    ackWaiters = [];
    waiters.forEach((resolve) => resolve());
  }
  function onMessage(event) {
    const env = parseEnvelope(event);
    if (!env) return;
    if (env.type === "chunk_ack" && env.payload.fileId === fileIdHex) {
      ackedUpTo = env.payload.ackedUpTo;
      wakeWaiters();
    } else if (env.type === "file_abort" && env.payload.fileId === fileIdHex) {
      aborted = { remote: true };
      wakeWaiters();
    }
  }
  // If the connection drops mid-transfer, a reconnect (if any) replaces
  // this socket with a new one rather than resuming it — see
  // docs/DECISIONS.md — so an in-flight send can never be acked from
  // here on. Fail fast instead of hanging forever on an ack that will
  // never come.
  function onClose() {
    connectionLost = new Error("connection_lost");
    wakeWaiters();
  }
  function onSignalAbort() {
    aborted = { remote: false };
    wakeWaiters();
  }
  socket.addEventListener("message", onMessage);
  socket.addEventListener("close", onClose);
  if (signal) signal.addEventListener("abort", onSignalAbort);

  try {
    for (let index = 0; index < totalChunks; index++) {
      while (index - 1 - ackedUpTo >= WINDOW_SIZE) {
        await new Promise((resolve) => ackWaiters.push(resolve));
        if (connectionLost) throw connectionLost;
        if (aborted) break;
      }
      if (aborted) break;

      const start = index * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, file.size);
      const plaintext = new Uint8Array(await file.slice(start, end).arrayBuffer());
      const isLast = index === totalChunks - 1;
      const ciphertext = await encryptChunk(fileKey, fileId, index, isLast, plaintext);
      socket.send(buildChunkFrame(fileId, index, isLast, ciphertext));

      if (onProgress) onProgress({ sent: end, total: file.size });
    }

    while (!aborted && ackedUpTo < totalChunks - 1) {
      await new Promise((resolve) => ackWaiters.push(resolve));
      if (connectionLost) throw connectionLost;
    }

    if (aborted) {
      if (!aborted.remote) sendEnvelope(socket, "file_abort", { fileId: fileIdHex });
      throw new DOMException("Transfer canceled", "AbortError");
    }
  } finally {
    socket.removeEventListener("message", onMessage);
    socket.removeEventListener("close", onClose);
    if (signal) signal.removeEventListener("abort", onSignalAbort);
  }
}

/**
 * Attaches a receiver to socket that decrypts incoming files as they
 * arrive. Only one file is ever in flight at a time (the sender sends
 * sequentially), so chunks are assumed to arrive in order for the
 * current file; anything else is treated as a protocol error.
 *
 * handlers:
 *   onFileStart({fileId, name, size, mime})
 *   onChunk({fileId, index, isLast, plaintext})  — called per decrypted chunk
 *   onFileComplete({fileId})
 *   onAborted({fileId})  — this file was canceled (by either side); discard it
 *   onError(err)
 *
 * Returns { detach, abortCurrent }: detach() removes the receiver's
 * listeners; abortCurrent() cancels whichever file is currently being
 * received (a no-op if none), telling the sender via `file_abort` so
 * it stops too.
 */
export function attachReceiver(socket, epochKey, handlers) {
  let current = null; // { fileIdHex, fileKey, expectedIndex }

  async function handleFileMeta(payload) {
    const fileId = fromHex(payload.fileId);
    const fileKey = await deriveFileKey(epochKey, fileId);
    let plaintext;
    try {
      plaintext = await decryptChunk(fileKey, fileId, METADATA_CHUNK_INDEX, true, fromHex(payload.ciphertext));
    } catch (err) {
      handlers.onError && handlers.onError(err);
      return;
    }
    const meta = JSON.parse(new TextDecoder().decode(plaintext));
    current = { fileIdHex: payload.fileId, fileKey, expectedIndex: 0 };
    if (handlers.onFileStart) {
      await handlers.onFileStart({
        fileId: payload.fileId,
        name: meta.name,
        size: meta.size,
        mime: meta.mime,
      });
    }
  }

  async function handleChunkFrame(buffer) {
    const frame = parseChunkFrame(buffer);
    if (!frame) return;

    // No file in progress: either a stray/malformed frame, or (the
    // common case) a chunk that was already in flight when we or the
    // sender aborted this file a moment ago. Either way there's
    // nothing to do with it now — silently dropping it is what makes
    // abort's race with in-flight chunks harmless.
    if (!current) return;
    const fileIdHex = toHex(frame.fileId);
    if (fileIdHex !== current.fileIdHex || frame.index !== BigInt(current.expectedIndex)) {
      handlers.onError && handlers.onError(new Error("file chunk out of order or for the wrong file"));
      return;
    }

    let plaintext;
    try {
      plaintext = await decryptChunk(current.fileKey, frame.fileId, frame.index, frame.isLast, frame.ciphertext);
    } catch (err) {
      handlers.onError && handlers.onError(err);
      return;
    }

    const index = current.expectedIndex;
    if (handlers.onChunk) {
      // Awaited so the ack — and therefore the sender's flow-control
      // window — reflects the chunk actually being durably handled
      // (e.g. written to disk), not just decrypted. Sending the ack
      // any earlier could let the sender race ahead of a slow sink
      // (a native save-file prompt, a slow disk) and have this chunk
      // silently dropped instead of backpressured.
      await handlers.onChunk({ fileId: fileIdHex, index, isLast: frame.isLast, plaintext });
    }
    sendEnvelope(socket, "chunk_ack", { fileId: fileIdHex, ackedUpTo: index });

    current.expectedIndex++;
    if (frame.isLast) {
      current = null;
      handlers.onFileComplete && handlers.onFileComplete({ fileId: fileIdHex });
    }
  }

  /** Handles a file_abort from the sender: if it's for the file we're
   * currently receiving, abandon it. A file_abort for anything else
   * (already completed, or a stale message) is ignored. */
  async function handleFileAbort(payload) {
    if (!current || payload.fileId !== current.fileIdHex) return;
    const fileIdHex = current.fileIdHex;
    current = null;
    handlers.onAborted && handlers.onAborted({ fileId: fileIdHex });
  }

  // WebSocket message events fire as frames arrive, regardless of
  // whether a previous (async) handler has finished — without this
  // chain, a chunk frame could start processing before file_meta's
  // onFileStart (e.g. a native save-file prompt) has resolved, or
  // before the previous chunk's onChunk has finished writing it.
  let processingChain = Promise.resolve();

  // Each step catches its own errors so one bad message (or a
  // throwing handler) can't permanently wedge the chain for every
  // message after it.
  function chainStep(fn) {
    processingChain = processingChain.then(fn).catch((err) => handlers.onError && handlers.onError(err));
  }

  function onMessage(event) {
    if (typeof event.data === "string") {
      const env = parseEnvelope(event);
      if (!env) return;
      if (env.type === "file_meta") chainStep(() => handleFileMeta(env.payload));
      else if (env.type === "file_abort") chainStep(() => handleFileAbort(env.payload));
      return;
    }
    chainStep(() => handleChunkFrame(event.data));
  }

  // A dropped connection mid-transfer abandons whatever file is
  // currently in flight (a reconnect, if any, starts fresh over a new
  // socket rather than resuming this one — see docs/DECISIONS.md), so
  // surface it as an error instead of leaving the receiver stuck
  // waiting for chunks that will never arrive.
  function onClose() {
    if (current) {
      current = null;
      handlers.onError && handlers.onError(new Error("connection_lost"));
    }
  }

  /** Cancels whatever file is currently being received (no-op if
   * none): stops locally and tells the sender via file_abort so it
   * stops sending too, rather than pushing chunks nobody wants. */
  function abortCurrent() {
    if (!current) return;
    const fileIdHex = current.fileIdHex;
    current = null;
    sendEnvelope(socket, "file_abort", { fileId: fileIdHex });
    handlers.onAborted && handlers.onAborted({ fileId: fileIdHex });
  }

  socket.addEventListener("message", onMessage);
  socket.addEventListener("close", onClose);
  return {
    detach: () => {
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("close", onClose);
    },
    abortCurrent,
  };
}
