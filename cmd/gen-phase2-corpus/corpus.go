//go:build phase2corpus

package main

// corpus.go — reading source rows, sealing them at framing version 2, and the
// assertions that keep the corpus a single width.

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"math/rand/v2"
	"os"
	"path/filepath"
	"strings"

	"database/sql"

	_ "modernc.org/sqlite"

	"github.com/google/uuid"

	"ledger/internal/v2/blob"
	"ledger/internal/v2/oplog"
)

// recordSize is asserted, not assumed. The plan's own review found an earlier
// draft claiming records were both "1 KB-bucket-padded" and "fixed-width with a
// single record_size", which are only compatible if every record really does
// land in the 1 KB bucket. A mixed-width corpus would silently invalidate the
// offsets array the native batch API is driven by, and every per-blob figure
// derived from it.
const recordSize = 1 << 10

// defaultCorpusSize is Phase 0's corpus count, so the two are comparable.
const defaultCorpusSize = 3683

// txnRow is one source transaction: exactly the columns
// spike/phase0/blobgen selected, so counts and payload sizes stay comparable
// across the two spikes.
type txnRow struct {
	IID       string `json:"iid"`
	PostedAt  string `json:"posted_at"`
	Amount    int64  `json:"amount"`
	Currency  string `json:"currency"`
	Direction string `json:"direction"`
	Merchant  string `json:"merchant"`
	Bucket    string `json:"bucket"`
	Status    string `json:"status"`
}

// sourceQuery is verbatim from spike/phase0/blobgen so the two corpora describe
// the same population.
const sourceQuery = `
	SELECT t.fingerprint, t.posted_at, t.amount, t.currency, t.direction,
	       COALESCE(t.merchant_raw,''), COALESCE(c.bucket,''), t.status
	FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
	ORDER BY t.posted_at`

func readV1Rows(path string, maxMerchant int) ([]txnRow, error) {
	// Opened read-only through the URI, belt and braces on top of the
	// "point --db at a backup copy" rule in main.go's package comment.
	db, err := sql.Open("sqlite", "file:"+path+"?mode=ro")
	if err != nil {
		return nil, fmt.Errorf("open %s: %w", path, err)
	}
	defer db.Close()
	rows, err := db.Query(sourceQuery)
	if err != nil {
		return nil, fmt.Errorf("query: %w", err)
	}
	defer rows.Close()
	var out []txnRow
	for rows.Next() {
		var r txnRow
		if err := rows.Scan(&r.IID, &r.PostedAt, &r.Amount, &r.Currency, &r.Direction,
			&r.Merchant, &r.Bucket, &r.Status); err != nil {
			return nil, err
		}
		// Deterministic and reported, exactly as blobgen did it. Truncation is
		// the only lossy step and it is bounded and stated, rather than a row
		// silently dropped for being too long.
		if len(r.Merchant) > maxMerchant {
			r.Merchant = r.Merchant[:maxMerchant]
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// syntheticRows fabricates a corpus from a seeded PRNG. Every merchant and every
// amount is invented; nothing here comes from a real account. This is the only
// generator whose output may be committed.
func syntheticRows(seed uint64, n int) []txnRow {
	r := rand.New(rand.NewPCG(seed, 0x5eed))
	merchants := []string{
		"NORTHWIND GROCERS", "ACME FUEL 114", "BLUE HERON CAFE", "PARAGON TELECOM",
		"CITY TRANSIT AUTH", "HOLLOWAY BOOKS", "MERIDIAN PHARMACY", "TIDEWATER UTILITIES",
		"SUNSET HARDWARE", "ORCHARD LANE DINER", "KESTREL AIRWAYS", "LUMEN STREAMING",
	}
	buckets := []string{"need", "want", "saving", ""}
	currencies := []string{"AED", "AED", "AED", "AED", "AED", "USD", "EUR", "GBP"}
	out := make([]txnRow, n)
	for i := range out {
		month := (i % 12) + 1
		day := (i % 27) + 1
		out[i] = txnRow{
			IID:       fmt.Sprintf("%064x", sha256Uint64(seed, uint64(i))),
			PostedAt:  fmt.Sprintf("2026-%02d-%02dT%02d:%02d:00Z", month, day, i%24, (i*7)%60),
			Amount:    int64(r.UintN(250_000)) + 100,
			Currency:  currencies[r.UintN(uint(len(currencies)))],
			Direction: []string{"debit", "debit", "debit", "credit"}[r.UintN(4)],
			Merchant:  merchants[r.UintN(uint(len(merchants)))] + fmt.Sprintf(" #%04d", i),
			Bucket:    buckets[r.UintN(uint(len(buckets)))],
			Status:    []string{"confirmed", "confirmed", "confirmed", "needs_review"}[r.UintN(4)],
		}
	}
	return out
}

// sealRecords frames every source row at envelope version 2 and asserts the
// single-width invariant. It fails LOUDLY on any row that does not fit rather
// than dropping it: a silently short corpus is a benchmark whose N nobody can
// reproduce.
func sealRecords(s blob.EncSealer, user uuid.UUID, rows []txnRow) ([][]byte, error) {
	out := make([][]byte, 0, len(rows))
	for i, r := range rows {
		plain, err := json.Marshal(r)
		if err != nil {
			return nil, err
		}
		env := blob.Envelope{
			UserID: user, Stream: blob.StreamHot, WriterID: oplog.IngestWriterID, WriterCounter: int64(i + 1),
		}
		sealed, err := s.Seal(env, plain)
		if err != nil {
			return nil, fmt.Errorf("record %d (%s): %w", i+1, r.IID, err)
		}
		if sealed.SizeBucket != recordSize {
			l, _ := blob.FrameLayoutFor(blob.EncVersion)
			return nil, fmt.Errorf(
				"record %d landed in the %d-byte bucket, not %d. The corpus must be a single width or the "+
					"offsets array and every per-blob figure derived from it are meaningless. This row's "+
					"plaintext is %d bytes and the v2 framing overhead at this position is %d, leaving %d for "+
					"the gzip payload — shorten --max-merchant or exclude the row explicitly, but do not let "+
					"a mixed-width corpus through",
				i+1, sealed.SizeBucket, recordSize, len(plain), l.Overhead(len(env.AAD())), recordSize-l.Overhead(len(env.AAD())))
		}
		// The reader's own check, run here rather than trusted: EmbeddedAADV must
		// return exactly the envelope's AAD. If the generator and the reader made
		// the same offset mistake symmetrically, a round trip would still pass —
		// comparing against env.AAD(), which is computed from the envelope and
		// not from the frame, is what makes this a measurement.
		got, err := blob.EmbeddedAADV(sealed.Bytes)
		if err != nil {
			return nil, fmt.Errorf("record %d: %w", i+1, err)
		}
		if string(got) != string(env.AAD()) {
			return nil, fmt.Errorf("record %d: embedded AAD %q, envelope AAD %q", i+1, got, env.AAD())
		}
		// And it must actually open, under the key that sealed it, back to the
		// bytes that went in. A corpus that seals and does not open is 3,683
		// records of nothing.
		back, err := s.Open(env, sealed)
		if err != nil {
			return nil, fmt.Errorf("record %d does not open: %w", i+1, err)
		}
		if string(back) != string(plain) {
			return nil, fmt.Errorf("record %d opened to different bytes", i+1)
		}
		out = append(out, sealed.Bytes)
	}
	return out, nil
}

func writeRecords(path string, records [][]byte) error {
	if err := refuseCommittedPath(path); err != nil {
		return err
	}
	buf := make([]byte, 0, len(records)*recordSize)
	for _, r := range records {
		buf = append(buf, r...)
	}
	return os.WriteFile(path, buf, 0o600)
}

func writeSecret(path, contents string) error {
	if err := refuseCommittedPath(path); err != nil {
		return err
	}
	return os.WriteFile(path, []byte(contents), 0o600)
}

func writeJSON(path string, v any, mode os.FileMode) error {
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return os.WriteFile(path, append(b, '\n'), mode)
}

// refuseCommittedPath is the last line of defence on the "nothing real is ever
// committed" rule. Real corpora and private keys go to spike/phase2/work, which
// is gitignored in its entirety; anywhere under conformance/ or docs/ is a
// committed tree and a mistake worth refusing rather than warning about.
func refuseCommittedPath(path string) error {
	abs, err := filepath.Abs(path)
	if err != nil {
		return err
	}
	for _, bad := range []string{"/conformance/", "/docs/", "/internal/", "/client/", "/app/"} {
		if strings.Contains(abs, bad) {
			return fmt.Errorf("refusing to write real corpus bytes to %s: %q is a committed tree. "+
				"Write to spike/phase2/work, which is gitignored", abs, strings.Trim(bad, "/"))
		}
	}
	return nil
}

// offsetsFor produces the Uint32Array the native batch API is driven by:
// offsets[i]..offsets[i+1] is record i, with N+1 entries. Explicit offsets
// rather than a fixed width because real blobs are bucketed at seven sizes, so a
// (records, recordSize) signature is one production could never call — which
// would make "the production candidate" arm a measurement of an API that does
// not exist.
func offsetsFor(records [][]byte) []uint32 {
	out := make([]uint32, len(records)+1)
	var n uint32
	for i, r := range records {
		out[i] = n
		n += uint32(len(r))
	}
	out[len(records)] = n
	return out
}

func sha256Uint64(a, b uint64) uint64 {
	var buf [16]byte
	binary.BigEndian.PutUint64(buf[0:8], a)
	binary.BigEndian.PutUint64(buf[8:16], b)
	return binary.BigEndian.Uint64(sha256Sum(buf[:])[:8])
}
