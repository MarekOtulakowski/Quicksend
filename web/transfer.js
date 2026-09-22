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
 */
export async function sendFile(socket, epochKey, file, { onProgress } = {}) {
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

  function onMessage(event) {
    const env = parseEnvelope(event);
    if (!env || env.type !== "chunk_ack" || env.payload.fileId !== fileIdHex) return;
    ackedUpTo = env.payload.ackedUpTo;
    const waiters = ackWaiters;
    ackWaiters = [];
    waiters.forEach((resolve) => resolve());
  }
  socket.addEventListener("message", onMessage);

  try {
    for (let index = 0; index < totalChunks; index++) {
      while (index - 1 - ackedUpTo >= WINDOW_SIZE) {
        await new Promise((resolve) => ackWaiters.push(resolve));
      }

      const start = index * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, file.size);
      const plaintext = new Uint8Array(await file.slice(start, end).arrayBuffer());
      const isLast = index === totalChunks - 1;
      const ciphertext = await encryptChunk(fileKey, fileId, index, isLast, plaintext);
      socket.send(buildChunkFrame(fileId, index, isLast, ciphertext));

      if (onProgress) onProgress({ sent: end, total: file.size });
    }

    while (ackedUpTo < totalChunks - 1) {
      await new Promise((resolve) => ackWaiters.push(resolve));
    }
  } finally {
    socket.removeEventListener("message", onMessage);
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
 *   onError(err)
 *
 * Returns a function that detaches the receiver.
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

    if (!current) {
      handlers.onError && handlers.onError(new Error("received a file chunk before file_meta"));
      return;
    }
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
      if (env && env.type === "file_meta") chainStep(() => handleFileMeta(env.payload));
      return;
    }
    chainStep(() => handleChunkFrame(event.data));
  }

  socket.addEventListener("message", onMessage);
  return () => socket.removeEventListener("message", onMessage);
}
