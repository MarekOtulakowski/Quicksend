package cryptoutil

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"os"
	"testing"
)

type vectorsFile struct {
	SessionKeyHex   string `json:"sessionKeyHex"`
	FileIDHex       string `json:"fileIDHex"`
	EpochKeyVectors []struct {
		Epoch               uint32 `json:"epoch"`
		ExpectedEpochKeyHex string `json:"expectedEpochKeyHex"`
	} `json:"epochKeyVectors"`
	FileKeyVector struct {
		Epoch              uint32 `json:"epoch"`
		ExpectedFileKeyHex string `json:"expectedFileKeyHex"`
	} `json:"fileKeyVector"`
	ChunkVectors []struct {
		Name                  string `json:"name"`
		ChunkIndex            uint64 `json:"chunkIndex"`
		Last                  bool   `json:"last"`
		PlaintextHex          string `json:"plaintextHex"`
		ExpectedCiphertextHex string `json:"expectedCiphertextHex"`
	} `json:"chunkVectors"`
	ReconnectTokenVector struct {
		SessionID        string `json:"sessionId"`
		ExpectedTokenHex string `json:"expectedTokenHex"`
	} `json:"reconnectTokenVector"`
	MetadataVector struct {
		PlaintextHex          string `json:"plaintextHex"`
		ExpectedCiphertextHex string `json:"expectedCiphertextHex"`
	} `json:"metadataVector"`
}

func loadVectors(t *testing.T) vectorsFile {
	t.Helper()
	data, err := os.ReadFile("../../../testvectors/crypto_v1.json")
	if err != nil {
		t.Fatalf("reading test vectors: %v", err)
	}
	var v vectorsFile
	if err := json.Unmarshal(data, &v); err != nil {
		t.Fatalf("parsing test vectors: %v", err)
	}
	return v
}

func hexBytes(t *testing.T, s string) []byte {
	t.Helper()
	b, err := hex.DecodeString(s)
	if err != nil {
		t.Fatalf("invalid hex %q: %v", s, err)
	}
	return b
}

// TestVectorsMatchGoImplementation proves this Go implementation
// reproduces the frozen shared test vectors. web/crypto.js is checked
// against the exact same file (see web/crypto.test.mjs) — together
// these prove the two independent implementations agree byte-for-byte.
func TestVectorsMatchGoImplementation(t *testing.T) {
	v := loadVectors(t)
	sessionKey := hexBytes(t, v.SessionKeyHex)
	fileID := hexBytes(t, v.FileIDHex)

	epochKeys := make(map[uint32][]byte)
	for _, ev := range v.EpochKeyVectors {
		got, err := DeriveEpochKey(sessionKey, ev.Epoch)
		if err != nil {
			t.Fatalf("DeriveEpochKey(epoch=%d): %v", ev.Epoch, err)
		}
		want := hexBytes(t, ev.ExpectedEpochKeyHex)
		if !bytes.Equal(got, want) {
			t.Errorf("epoch %d key = %x, want %x", ev.Epoch, got, want)
		}
		epochKeys[ev.Epoch] = got
	}

	epochKey, ok := epochKeys[v.FileKeyVector.Epoch]
	if !ok {
		t.Fatalf("no epoch key vector for epoch %d referenced by fileKeyVector", v.FileKeyVector.Epoch)
	}
	fileKey, err := DeriveFileKey(epochKey, fileID)
	if err != nil {
		t.Fatalf("DeriveFileKey: %v", err)
	}
	wantFileKey := hexBytes(t, v.FileKeyVector.ExpectedFileKeyHex)
	if !bytes.Equal(fileKey, wantFileKey) {
		t.Errorf("file key = %x, want %x", fileKey, wantFileKey)
	}

	for _, cv := range v.ChunkVectors {
		t.Run(cv.Name, func(t *testing.T) {
			plaintext := hexBytes(t, cv.PlaintextHex)
			got, err := EncryptChunk(fileKey, fileID, cv.ChunkIndex, cv.Last, plaintext)
			if err != nil {
				t.Fatalf("EncryptChunk: %v", err)
			}
			want := hexBytes(t, cv.ExpectedCiphertextHex)
			if !bytes.Equal(got, want) {
				t.Errorf("ciphertext = %x, want %x", got, want)
			}

			// Round-trip: decrypting our own vector's ciphertext must
			// recover the exact plaintext.
			opened, err := DecryptChunk(fileKey, fileID, cv.ChunkIndex, cv.Last, want)
			if err != nil {
				t.Fatalf("DecryptChunk: %v", err)
			}
			if !bytes.Equal(opened, plaintext) {
				t.Errorf("decrypted = %x, want %x", opened, plaintext)
			}
		})
	}

	token, err := DeriveReconnectToken(sessionKey, v.ReconnectTokenVector.SessionID)
	if err != nil {
		t.Fatalf("DeriveReconnectToken: %v", err)
	}
	wantToken := hexBytes(t, v.ReconnectTokenVector.ExpectedTokenHex)
	if !bytes.Equal(token, wantToken) {
		t.Errorf("reconnect token = %x, want %x", token, wantToken)
	}

	metaPlaintext := hexBytes(t, v.MetadataVector.PlaintextHex)
	metaCT, err := EncryptChunk(fileKey, fileID, MetadataChunkIndex, true, metaPlaintext)
	if err != nil {
		t.Fatalf("EncryptChunk(metadata): %v", err)
	}
	wantMetaCT := hexBytes(t, v.MetadataVector.ExpectedCiphertextHex)
	if !bytes.Equal(metaCT, wantMetaCT) {
		t.Errorf("metadata ciphertext = %x, want %x", metaCT, wantMetaCT)
	}
}

func TestDecryptChunkRejectsTamperedAAD(t *testing.T) {
	sessionKey := make([]byte, KeySize)
	fileID := make([]byte, FileIDSize)
	for i := range fileID {
		fileID[i] = byte(i)
	}
	epochKey, err := DeriveEpochKey(sessionKey, 0)
	if err != nil {
		t.Fatal(err)
	}
	fileKey, err := DeriveFileKey(epochKey, fileID)
	if err != nil {
		t.Fatal(err)
	}

	ct, err := EncryptChunk(fileKey, fileID, 5, false, []byte("payload"))
	if err != nil {
		t.Fatal(err)
	}

	// Wrong index: simulates a chunk spliced into a different position.
	if _, err := DecryptChunk(fileKey, fileID, 6, false, ct); err == nil {
		t.Error("expected decryption to fail for wrong chunk index")
	}
	// Wrong last-flag: simulates truncating the stream early.
	if _, err := DecryptChunk(fileKey, fileID, 5, true, ct); err == nil {
		t.Error("expected decryption to fail for wrong last flag")
	}
	// Wrong fileID: simulates splicing a chunk from a different file.
	otherFileID := make([]byte, FileIDSize)
	copy(otherFileID, fileID)
	otherFileID[0] ^= 0xFF
	if _, err := DecryptChunk(fileKey, otherFileID, 5, false, ct); err == nil {
		t.Error("expected decryption to fail for wrong fileID")
	}
	// Sanity: correct parameters do decrypt.
	pt, err := DecryptChunk(fileKey, fileID, 5, false, ct)
	if err != nil {
		t.Fatalf("expected successful decryption, got %v", err)
	}
	if string(pt) != "payload" {
		t.Errorf("plaintext = %q, want %q", pt, "payload")
	}
}

func TestDeriveEpochKeyDiffersPerEpoch(t *testing.T) {
	sessionKey := make([]byte, KeySize)
	k0, _ := DeriveEpochKey(sessionKey, 0)
	k1, _ := DeriveEpochKey(sessionKey, 1)
	if bytes.Equal(k0, k1) {
		t.Error("epoch 0 and epoch 1 keys must differ")
	}
}

func TestDeriveFileKeyDiffersPerFile(t *testing.T) {
	epochKey := make([]byte, KeySize)
	fileA := bytes.Repeat([]byte{0xAA}, FileIDSize)
	fileB := bytes.Repeat([]byte{0xBB}, FileIDSize)
	kA, _ := DeriveFileKey(epochKey, fileA)
	kB, _ := DeriveFileKey(epochKey, fileB)
	if bytes.Equal(kA, kB) {
		t.Error("different fileIDs must yield different file keys")
	}
}
