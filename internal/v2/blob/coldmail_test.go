// This file is package blob_test, not package blob, and that is load-bearing:
// it is the one blob test that needs a real oplog.RawBody record, and oplog
// imports blob (oplog/append.go needs StreamHot/StreamCold and BucketFor). An
// in-package test file importing oplog would therefore make the blob test
// binary an import cycle. An external test package can depend on both.
package blob_test

import (
	"encoding/base64"
	"math"
	"math/rand"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"ledger/internal/v2/blob"
	"ledger/internal/v2/oplog"
)

// incompressible mirrors the helper in blob_test.go; the two files are in
// different packages so it cannot be shared. Same fixed seed, same bytes.
func incompressible(n int) []byte {
	b := make([]byte, n)
	rand.New(rand.NewSource(1)).Read(b)
	return b
}

// TestWorstCaseColdMailFitsABucket is the assertion that matters for ingest,
// and it deliberately does not check MaxPlaintext: the binding limit on a cold
// blob is MaxBucket, on the COMPRESSED frame. So it builds the actual worst
// case — an incompressible message at exactly the DATA cap, base64'd into a
// real RawBody record, at the longest envelope ingest can produce — and
// requires it to seal. An earlier version of this test asserted a MaxPlaintext
// inequality instead; it passed while Seal was in fact refusing legal mail.
func TestWorstCaseColdMailFitsABucket(t *testing.T) {
	// MaxColdMail IS the DATA cap: config.validate rejects any
	// mail.max_message_bytes above it, so proving the ceiling here proves it
	// for every configuration that loads. (This file cannot import config —
	// config imports blob for exactly this constant.)
	raw := incompressible(blob.MaxColdMail)
	rec, err := oplog.EncodeRawBody(oplog.RawBody{
		IngestID:   strings.Repeat("f", 64),
		ReceivedAt: time.Now().UTC(),
		RawBase64:  base64.StdEncoding.EncodeToString(raw),
	})
	if err != nil {
		t.Fatal(err)
	}

	// The longest AAD the ingest writer can produce: the widest counter it will
	// ever reach costs the most header bytes, which is the case most likely to
	// tip a blob past its bucket.
	e := blob.Envelope{UserID: uuid.MustParse("11111111-1111-1111-1111-111111111111"),
		Stream: blob.StreamCold, WriterID: "ingest", WriterCounter: math.MaxInt64}

	s := blob.PlaintextSealer{}
	sealed, err := s.Seal(e, rec)
	if err != nil {
		t.Fatalf("a message at the DATA cap (%d bytes, incompressible) must seal, "+
			"or SMTP accepts mail ingest cannot store: %v", blob.MaxColdMail, err)
	}
	if sealed.SizeBucket != blob.MaxBucket {
		t.Logf("worst-case cold blob landed in the %d KB bucket", sealed.SizeBucket>>10)
	}
	got, err := s.Open(e, sealed)
	if err != nil {
		t.Fatal(err)
	}
	back, err := oplog.DecodeRawBody(got)
	if err != nil {
		t.Fatal(err)
	}
	if back.RawBase64 != base64.StdEncoding.EncodeToString(raw) {
		t.Fatal("worst-case cold round trip lost the message")
	}
}
