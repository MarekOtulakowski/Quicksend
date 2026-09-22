// Quicksend's key-derivation and per-chunk encryption scheme, built on
// the browser's native Web Crypto API. This must byte-for-byte match
// server/internal/cryptoutil (Go) — both are checked against the same
// frozen vectors in /testvectors/crypto_v1.json. See docs/DECISIONS.md
// for why each choice (HKDF chaining, nonce/AAD construction) was made.
//
// None of this ever runs on the relay: sessionKey and everything
// derived from it live only in the two paired browsers.

const KEY_SIZE_BITS = 256;
const NONCE_SIZE = 12;
const FILE_ID_SIZE = 16;
const TAG_LENGTH_BITS = 128;

/** Reserved chunk index used to encrypt a file's metadata under the
 * same fileKey, instead of a separate construction — see
 * cryptoutil.MetadataChunkIndex (Go) and docs/PROTOCOL.md. A BigInt
 * since 2^64-1 can't be represented exactly as a JS Number. */
export const METADATA_CHUNK_INDEX = 0xffffffffffffffffn;

const EPOCH_INFO = new TextEncoder().encode("quicksend-epoch-v1");
const FILE_INFO = new TextEncoder().encode("quicksend-v1");
const RECONNECT_INFO = new TextEncoder().encode("quicksend-reconnect");

function assertLength(bytes, expected, name) {
  if (bytes.byteLength !== expected) {
    throw new Error(`${name} must be ${expected} bytes, got ${bytes.byteLength}`);
  }
}

async function hkdf(ikm, salt, info, lengthBits) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info },
    key,
    lengthBits,
  );
  return new Uint8Array(bits);
}

/**
 * Derives the key used for all files sent during one "epoch" of a
 * session (epoch 0 = until the first reconnect, epoch N = after the
 * Nth successful reconnect). See docs/DECISIONS.md for why keys rotate
 * per epoch rather than staying fixed for the whole session.
 */
export async function deriveEpochKey(sessionKey, epoch) {
  assertLength(sessionKey, 32, "sessionKey");
  const salt = new Uint8Array(4);
  new DataView(salt.buffer).setUint32(0, epoch, false);
  return hkdf(sessionKey, salt, EPOCH_INFO, KEY_SIZE_BITS);
}

/** Derives the per-file AES-256-GCM key from the current epoch key. */
export async function deriveFileKey(epochKey, fileID) {
  assertLength(epochKey, 32, "epochKey");
  assertLength(fileID, FILE_ID_SIZE, "fileID");
  return hkdf(epochKey, fileID, FILE_INFO, KEY_SIZE_BITS);
}

function chunkNonce(chunkIndex) {
  const nonce = new Uint8Array(NONCE_SIZE);
  // 4 zero bytes + 8-byte big-endian chunk index. Safe because fileKey
  // is unique per file (via the fileID salt above) and, within a file,
  // a resent chunk re-encrypts identical plaintext at the same index
  // rather than reusing (key, nonce) across two different plaintexts.
  new DataView(nonce.buffer).setBigUint64(4, BigInt(chunkIndex), false);
  return nonce;
}

function chunkAAD(fileID, chunkIndex, last) {
  const aad = new Uint8Array(fileID.byteLength + 8 + 1);
  aad.set(fileID, 0);
  new DataView(aad.buffer).setBigUint64(fileID.byteLength, BigInt(chunkIndex), false);
  aad[aad.byteLength - 1] = last ? 1 : 0;
  return aad;
}

async function importAesKey(fileKey) {
  assertLength(fileKey, 32, "fileKey");
  return crypto.subtle.importKey("raw", fileKey, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/**
 * Encrypts one plaintext chunk with AES-256-GCM. Returns ciphertext
 * with the 16-byte authentication tag appended (Web Crypto's default),
 * matching Go's cipher.AEAD.Seal output layout.
 */
export async function encryptChunk(fileKey, fileID, chunkIndex, last, plaintext) {
  assertLength(fileID, FILE_ID_SIZE, "fileID");
  const key = await importAesKey(fileKey);
  const nonce = chunkNonce(chunkIndex);
  const aad = chunkAAD(fileID, chunkIndex, last);
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce, additionalData: aad, tagLength: TAG_LENGTH_BITS },
    key,
    plaintext,
  );
  return new Uint8Array(ct);
}

/**
 * Decrypts and authenticates a chunk produced by encryptChunk,
 * verifying it belongs to fileID at chunkIndex with the claimed
 * last-chunk flag. Throws if the tag doesn't verify (tampering,
 * truncation, reordering, or wrong parameters).
 */
export async function decryptChunk(fileKey, fileID, chunkIndex, last, ciphertext) {
  assertLength(fileID, FILE_ID_SIZE, "fileID");
  const key = await importAesKey(fileKey);
  const nonce = chunkNonce(chunkIndex);
  const aad = chunkAAD(fileID, chunkIndex, last);
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: nonce, additionalData: aad, tagLength: TAG_LENGTH_BITS },
    key,
    ciphertext,
  );
  return new Uint8Array(pt);
}

/**
 * Computes the bearer credential a client presents to the relay to
 * resume a session after a disconnect: HMAC-SHA256 over the session ID
 * keyed by the root sessionKey. The relay stores the opaque output and
 * compares it byte-for-byte on reconnect; since it never has
 * sessionKey, it can't compute or forge this itself.
 */
export async function deriveReconnectToken(sessionKey, sessionId) {
  assertLength(sessionKey, 32, "sessionKey");
  const key = await crypto.subtle.importKey("raw", sessionKey, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const message = new Uint8Array(RECONNECT_INFO.byteLength + new TextEncoder().encode(sessionId).byteLength);
  message.set(RECONNECT_INFO, 0);
  message.set(new TextEncoder().encode(sessionId), RECONNECT_INFO.byteLength);
  const sig = await crypto.subtle.sign("HMAC", key, message);
  return new Uint8Array(sig);
}
