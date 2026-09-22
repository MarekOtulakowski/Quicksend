// Package cryptoutil defines Quicksend's key-derivation and per-chunk
// encryption scheme (HKDF-SHA256 + AES-256-GCM). It exists to give the
// scheme a single, precisely specified reference implementation that
// both this Go code and the browser's Web Crypto implementation
// (web/crypto.js) are checked against via the shared test vectors in
// /testvectors — see docs/DECISIONS.md for why each choice was made.
//
// None of this runs inside the relay at request time: the relay never
// has sessionKey and only ever forwards ciphertext it can't read. This
// package is a spec-as-code and test fixture, kept in Go because Go's
// standard library crypto is a convenient, well-audited reference to
// check the browser-side Web Crypto implementation against.
package cryptoutil

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hkdf"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/binary"
	"fmt"
)

const (
	// KeySize is the length in bytes of a session key, an epoch key,
	// and a file key: 256 bits, matching AES-256.
	KeySize = 32
	// NonceSize is the standard AES-GCM nonce length.
	NonceSize = 12
	// FileIDSize is the length in bytes of a per-file identifier.
	FileIDSize = 16

	epochInfo     = "quicksend-epoch-v1"
	fileInfo      = "quicksend-v1"
	reconnectInfo = "quicksend-reconnect"
)

// DeriveEpochKey derives the key used for all files sent during one
// "epoch" of a session. Epoch 0 covers the session from pairing until
// its first reconnect; epoch N covers the period after the Nth
// successful reconnect. Rotating the derived key on every reconnect
// bounds the impact of an epoch key being exposed (e.g. by a future
// bug) to the files transferred in that epoch, without needing to
// rotate on every single chunk. See docs/DECISIONS.md.
//
// Deliberately not exported as part of any client-facing wire format:
// epoch is a purely local counter both peers derive identically from
// having jointly observed the same sequence of successful reconnects.
func DeriveEpochKey(sessionKey []byte, epoch uint32) ([]byte, error) {
	if len(sessionKey) != KeySize {
		return nil, fmt.Errorf("cryptoutil: sessionKey must be %d bytes, got %d", KeySize, len(sessionKey))
	}
	salt := make([]byte, 4)
	binary.BigEndian.PutUint32(salt, epoch)
	return hkdf.Key(sha256.New, sessionKey, salt, epochInfo, KeySize)
}

// DeriveFileKey derives the per-file AES-256-GCM key from the current
// epoch key and a per-file identifier (fileID). fileID only needs to
// be unique per file within an epoch; it does not need to be secret.
func DeriveFileKey(epochKey, fileID []byte) ([]byte, error) {
	if len(epochKey) != KeySize {
		return nil, fmt.Errorf("cryptoutil: epochKey must be %d bytes, got %d", KeySize, len(epochKey))
	}
	if len(fileID) != FileIDSize {
		return nil, fmt.Errorf("cryptoutil: fileID must be %d bytes, got %d", FileIDSize, len(fileID))
	}
	return hkdf.Key(sha256.New, epochKey, fileID, fileInfo, KeySize)
}

// chunkNonce builds the 12-byte AES-GCM nonce for chunk index i: 4
// zero bytes followed by the index as an 8-byte big-endian integer.
// This is safe because every (fileKey, nonce) pair is used to encrypt
// exactly one plaintext value: fileKey is unique per file (via the
// fileID salt above), and within a file, chunkIndex is used at most
// once per distinct plaintext — a resend of the same chunk re-encrypts
// the same plaintext bytes, which is not a nonce-reuse violation (GCM's
// nonce-reuse danger is reusing (key, nonce) across *different*
// plaintexts).
func chunkNonce(chunkIndex uint64) []byte {
	nonce := make([]byte, NonceSize)
	binary.BigEndian.PutUint64(nonce[4:], chunkIndex)
	return nonce
}

// chunkAAD builds the additional authenticated data binding a chunk's
// ciphertext to its file, position, and whether it's the final chunk —
// so a chunk can't be replayed at a different index, spliced into a
// different file's stream, or have the stream truncated without the
// receiver detecting it (the AEAD tag check fails).
func chunkAAD(fileID []byte, chunkIndex uint64, last bool) []byte {
	aad := make([]byte, 0, len(fileID)+8+1)
	aad = append(aad, fileID...)
	idx := make([]byte, 8)
	binary.BigEndian.PutUint64(idx, chunkIndex)
	aad = append(aad, idx...)
	if last {
		aad = append(aad, 1)
	} else {
		aad = append(aad, 0)
	}
	return aad
}

// EncryptChunk seals one plaintext chunk with AES-256-GCM. The
// returned slice is ciphertext with the 16-byte authentication tag
// appended, matching the Web Crypto AES-GCM default.
func EncryptChunk(fileKey, fileID []byte, chunkIndex uint64, last bool, plaintext []byte) ([]byte, error) {
	gcm, err := newGCM(fileKey)
	if err != nil {
		return nil, err
	}
	if len(fileID) != FileIDSize {
		return nil, fmt.Errorf("cryptoutil: fileID must be %d bytes, got %d", FileIDSize, len(fileID))
	}
	nonce := chunkNonce(chunkIndex)
	aad := chunkAAD(fileID, chunkIndex, last)
	return gcm.Seal(nil, nonce, plaintext, aad), nil
}

// DecryptChunk opens a chunk sealed by EncryptChunk, verifying it
// belongs to fileID at chunkIndex with the claimed last-chunk flag.
func DecryptChunk(fileKey, fileID []byte, chunkIndex uint64, last bool, ciphertext []byte) ([]byte, error) {
	gcm, err := newGCM(fileKey)
	if err != nil {
		return nil, err
	}
	if len(fileID) != FileIDSize {
		return nil, fmt.Errorf("cryptoutil: fileID must be %d bytes, got %d", FileIDSize, len(fileID))
	}
	nonce := chunkNonce(chunkIndex)
	aad := chunkAAD(fileID, chunkIndex, last)
	return gcm.Open(nil, nonce, ciphertext, aad)
}

func newGCM(key []byte) (cipher.AEAD, error) {
	if len(key) != KeySize {
		return nil, fmt.Errorf("cryptoutil: key must be %d bytes, got %d", KeySize, len(key))
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}

// DeriveReconnectToken computes the bearer credential a client
// presents to the relay to resume sessionID after a disconnect. It's
// an HMAC over the session ID keyed by sessionKey: the relay stores
// the opaque output and compares it byte-for-byte on reconnect, but
// — since it never has sessionKey — can't compute or forge it itself.
// Derived from the root sessionKey (not a rotated epoch key) because
// it must stay valid across the exact reconnect events that advance
// the epoch counter.
func DeriveReconnectToken(sessionKey []byte, sessionID string) ([]byte, error) {
	if len(sessionKey) != KeySize {
		return nil, fmt.Errorf("cryptoutil: sessionKey must be %d bytes, got %d", KeySize, len(sessionKey))
	}
	mac := hmac.New(sha256.New, sessionKey)
	mac.Write([]byte(reconnectInfo))
	mac.Write([]byte(sessionID))
	return mac.Sum(nil), nil
}
