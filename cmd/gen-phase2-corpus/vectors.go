//go:build phase2corpus

package main

// vectors.go — the cross-language conformance vectors.
//
// These are the ONLY sealed records that may be committed, and they are
// SYNTHETIC: fabricated merchants, fabricated amounts, from a seeded PRNG. A
// fabricated record pins the format exactly as well as a real one does, and an
// earlier draft of the Phase 2 plan committed ten real transactions in
// cleartext, in a repository with a `gh pr create` workflow.
//
// The recipient PRIVATE key is committed here too, and that is safe for exactly
// one reason: it protects nothing. It is minted fresh for this file and seals
// only fabricated data. It must never be reused for a real corpus, which is why
// the generator writes the real one to $W/recipient.key and nowhere else.
//
// The last vector is DELIBERATELY WRONG: it is sealed at counter 9 and declared
// at counter 999. Without it, an implementation that ignores the AAD entirely
// passes the whole suite — the exact defect Phase 1's Task 10 caught in its own
// first draft.

import (
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"

	"github.com/google/uuid"

	"ledger/internal/v2/blob"
	"ledger/internal/v2/oplog"
)

type vector struct {
	Name string `json:"name"`
	Note string `json:"note,omitempty"`
	// Envelope the reader is expected to open the record AT. For the mismatch
	// vector this is deliberately not the position it was sealed at.
	UserID        string `json:"user_id"`
	Stream        string `json:"stream"`
	WriterID      string `json:"writer_id"`
	WriterCounter string `json:"writer_counter"`
	RecordBase64  string `json:"record_base64"`
	// ExpectPlaintextBase64 is empty exactly when ExpectError is set.
	ExpectPlaintextBase64 string `json:"expect_plaintext_base64,omitempty"`
	ExpectError           string `json:"expect_error,omitempty"`
	EmbeddedAADUTF8       string `json:"embedded_aad_utf8"`
}

type vectorFile struct {
	Note            string   `json:"note"`
	EnvelopeVersion int      `json:"envelope_version"`
	RecordSize      int      `json:"record_size"`
	EncSize         int      `json:"enc_size"`
	NonceSize       int      `json:"nonce_size"`
	TagSize         int      `json:"tag_size"`
	HKDFInfo        string   `json:"hkdf_info"`
	Construction    string   `json:"construction"`
	RecipientPub    string   `json:"recipient_pub"`
	RecipientPriv   string   `json:"recipient_priv"`
	Synthetic       bool     `json:"synthetic"`
	Vectors         []vector `json:"vectors"`
}

func buildVectors(s blob.EncSealer, user uuid.UUID, rows []txnRow, records [][]byte) (vectorFile, error) {
	if len(records) < 10 {
		return vectorFile{}, fmt.Errorf("need at least 10 synthetic records for the vectors, have %d", len(records))
	}
	out := vectorFile{
		Note: "SYNTHETIC ONLY. Fabricated merchants and amounts from a seeded PRNG; the recipient private key " +
			"below protects nothing and must never be reused for a real corpus. Envelope framing version 2 is a " +
			"BENCHMARK format (Phase 2 plan Decision 12) and is not a product path.",
		EnvelopeVersion: blob.EncVersion,
		RecordSize:      recordSize,
		EncSize:         blob.EncSize,
		NonceSize:       blob.NonceSize,
		TagSize:         blob.TagSize,
		HKDFInfo:        blob.EncInfo,
		Construction: "shared = X25519(recipientPriv, enc); salt = enc||recipientPub; " +
			"key = HKDF-SHA256(ikm=shared, salt=salt, info=hkdf_info, L=32); " +
			"plain = AES-256-GCM.open(key, nonce, ct||tag, aad=embedded AAD). " +
			"The opened region is [4B BE payloadLen][gzip payload][zero padding]; the reader gunzips it itself.",
		RecipientPub:  hex.EncodeToString(s.RecipientPub()),
		RecipientPriv: hex.EncodeToString(s.RecipientPriv()),
		Synthetic:     true,
	}

	for i := range 9 {
		plain, err := json.Marshal(rows[i])
		if err != nil {
			return vectorFile{}, err
		}
		env := blob.Envelope{
			UserID: user, Stream: blob.StreamHot, WriterID: oplog.IngestWriterID, WriterCounter: int64(i + 1),
		}
		aad, err := blob.EmbeddedAADV(records[i])
		if err != nil {
			return vectorFile{}, err
		}
		out.Vectors = append(out.Vectors, vector{
			Name:                  fmt.Sprintf("record-%02d", i+1),
			UserID:                env.UserID.String(),
			Stream:                env.Stream,
			WriterID:              env.WriterID,
			WriterCounter:         fmt.Sprintf("%d", env.WriterCounter),
			RecordBase64:          base64.StdEncoding.EncodeToString(records[i]),
			ExpectPlaintextBase64: base64.StdEncoding.EncodeToString(plain),
			EmbeddedAADUTF8:       string(aad),
		})
	}

	// The tenth: sealed at counter 9, offered at counter 999. An implementation
	// that never looks at the AAD opens it and fails this suite.
	bad := records[8]
	badAAD, err := blob.EmbeddedAADV(bad)
	if err != nil {
		return vectorFile{}, err
	}
	out.Vectors = append(out.Vectors, vector{
		Name: "aad-mismatch",
		Note: "Sealed at writer_counter 9 and offered at 999. MUST throw. Without this vector an implementation " +
			"that ignores the associated data entirely passes every other case.",
		UserID:          user.String(),
		Stream:          blob.StreamHot,
		WriterID:        oplog.IngestWriterID,
		WriterCounter:   "999",
		RecordBase64:    base64.StdEncoding.EncodeToString(bad),
		ExpectError:     "aad",
		EmbeddedAADUTF8: string(badAAD),
	})
	return out, nil
}
