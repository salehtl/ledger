//go:build phase2corpus

package main

// manifest.go — the ONE artifact of this generator that is committed, and the
// salted digests that let a device's materialized totals be checked without any
// real amount ever appearing in the repository.

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"sort"
	"strconv"

	"github.com/google/uuid"

	"ledger/internal/v2/blob"
	"ledger/internal/v2/oplog"
)

// digestSep separates fields inside a digest preimage.
//
// The plan wrote the preimage as `SHA-256(salt ‖ month ‖ bucket ‖ total)`, plain
// concatenation. That is ambiguous — ("ab","c") and ("a","bc") hash the same —
// so a separator is added. It is a strengthening of the plan's formula, not a
// departure from it, and it is 0x1F (ASCII unit separator) precisely because no
// month, bucket name or decimal string can contain it.
const digestSep = 0x1f

// CheckDigests is the correctness reference Task 28 compares against.
//
// Digests, not totals. A monthly need/want/saving figure is a real AED amount
// and the Global Constraints forbid committing one; it is also small enough to
// be worth guessing at, which is why the digest is SALTED. The salt is committed
// because it is not a secret: it exists so the digest is not a rainbow-table
// lookup of a four-figure number.
type CheckDigests struct {
	Salt      string                       `json:"salt"`
	DigestAlg string                       `json:"digest_alg"`
	Preimage  string                       `json:"preimage"`
	Months    map[string]map[string]string `json:"months"`
	// HomeCurrency and Rates are what the `home` digests were computed against.
	// They are published because a device that folded a different rate schedule
	// must fail LOUDLY rather than mismatch for an unexplained reason.
	HomeCurrency string            `json:"home_currency"`
	Rates        map[string]string `json:"rates"`
	// HomeNullCount is how many source rows had no head rate and are excluded
	// from the `home` digests. A plain count reveals nothing and turns "the
	// device's total is lower" into a checkable fact.
	HomeNullCount int `json:"home_null_count"`
	// SelfTest is the DUAL-EXECUTOR pin on the digest itself: fabricated inputs
	// and the digest this Go function produced for them. app/src/bench/digest.ts
	// recomputes it and must agree byte for byte.
	//
	// Without it the two implementations could disagree and nothing would notice
	// until Task 28 reported a mismatch that looked like a fold bug. The inputs
	// are invented, so this field is safe in a committed file — which is exactly
	// why it can be committed at all, unlike the real months above.
	SelfTest DigestSelfTest `json:"self_test"`
}

// DigestSelfTest is one worked example of the digest, with fabricated inputs.
type DigestSelfTest struct {
	SaltHex string      `json:"salt_hex"`
	Month   string      `json:"month"`
	Buckets [][2]string `json:"buckets"`
	Digest  string      `json:"digest"`
}

// selfTestVector is fixed, not random: it has to produce the same digest every
// time the manifest is regenerated or the cross-executor check is untestable.
var selfTestVector = DigestSelfTest{
	SaltHex: "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff",
	Month:   "2026-06",
	Buckets: [][2]string{{"need", "123456"}, {"saving", "0"}, {"uncategorized", "-77"}, {"want", "98765"}},
}

// Manifest is the committed description of a corpus.
type Manifest struct {
	Count           int          `json:"count"`
	RecordSize      int          `json:"record_size"`
	EnvelopeVersion int          `json:"envelope_version"`
	Stream          string       `json:"stream"`
	WriterID        string       `json:"writer_id"`
	UserID          string       `json:"user_id"`
	RecipientPub    string       `json:"recipient_pub"`
	AADTemplate     string       `json:"aad_template"`
	Synthetic       bool         `json:"synthetic"`
	Check           CheckDigests `json:"check"`
	// Ops describes the Task 1b fixture built from the same source rows, so the
	// on-device fixture builder can assert it produced the same shape.
	Ops OpFixtureShape `json:"ops"`
}

func buildManifest(user uuid.UUID, s blob.EncSealer, records [][]byte, rows []txnRow, fx opFixture, synthetic bool) (Manifest, error) {
	if len(records) == 0 {
		return Manifest{}, fmt.Errorf("empty corpus")
	}
	for i, r := range records {
		if len(r) != recordSize {
			return Manifest{}, fmt.Errorf("record %d is %d bytes, not %d", i, len(r), recordSize)
		}
	}
	salt := make([]byte, 32)
	if _, err := rand.Read(salt); err != nil {
		return Manifest{}, err
	}
	months, nullCount := monthDigests(salt, rows, fx.Rates, fx.HomeCurrency)
	rates := map[string]string{}
	for ccy, micro := range fx.Rates {
		rates[ccy] = strconv.FormatInt(micro, 10)
	}
	return Manifest{
		Count:           len(records),
		RecordSize:      recordSize,
		EnvelopeVersion: blob.EncVersion,
		Stream:          blob.StreamHot,
		WriterID:        oplog.IngestWriterID,
		UserID:          user.String(),
		RecipientPub:    hex.EncodeToString(s.RecipientPub()),
		AADTemplate:     user.String() + "|" + blob.StreamHot + "|" + oplog.IngestWriterID + "|<counter>",
		Synthetic:       synthetic,
		Check: CheckDigests{
			Salt:      hex.EncodeToString(salt),
			DigestAlg: "sha256",
			Preimage: "sha256(salt_bytes || utf8(month) || repeat[ 0x1F || utf8(bucket) || 0x1F || " +
				"utf8(decimal minor-unit total) ]) over buckets sorted by byte order",
			Months:        months,
			HomeCurrency:  fx.HomeCurrency,
			Rates:         rates,
			HomeNullCount: nullCount,
			SelfTest:      buildSelfTest(),
		},
		Ops: fx.Shape,
	}, nil
}

// monthDigests computes the two digest families.
//
//   - `blind` is the currency-BLIND sum of confirmed debits per bucket, which is
//     exactly the aggregate spike/phase0 computed. It is the weaker check and it
//     is kept because it is the one a device can compute before FX has folded.
//   - `home` converts each amount into the home currency at that currency's head
//     rate, half-up, in int64 minor units, per spec §3.7.
//
// The fixture publishes exactly ONE distinct rate per currency, which is what
// makes the expected `home` total computable here by direct arithmetic rather
// than by re-running the fold. That independence is the point: if this function
// folded the log to get its answer, it would be checking the fold against itself
// — the "true by construction" defect this project has hit thirteen times.
func monthDigests(salt []byte, rows []txnRow, rates map[string]int64, home string) (map[string]map[string]string, int) {
	blind := map[monthBucket]int64{}
	homeTotals := map[monthBucket]int64{}
	months := map[string]bool{}
	nullCount := 0

	for _, r := range rows {
		if r.Direction != "debit" || r.Status != "confirmed" {
			continue
		}
		if len(r.PostedAt) < 7 {
			continue
		}
		k := monthBucket{month: r.PostedAt[:7], bucket: bucketName(r.Bucket)}
		months[k.month] = true
		blind[k] += r.Amount

		micro, ok := headRate(rates, home, r.Currency)
		if !ok {
			nullCount++
			continue
		}
		homeTotals[k] += convertHalfUp(r.Amount, micro)
	}

	out := map[string]map[string]string{}
	for m := range months {
		out[m] = map[string]string{
			"blind": digestMonth(salt, m, collect(blind, m)),
			"home":  digestMonth(salt, m, collect(homeTotals, m)),
		}
	}
	return out, nullCount
}

func bucketName(b string) string {
	if b == "" {
		return "uncategorized"
	}
	return b
}

// headRate is §3.7's identity rule plus a lookup. The home currency's rate is
// IMPLICIT — 1.000000 by construction (spec §3.7:124) — and is never a rate_set.
func headRate(rates map[string]int64, home, ccy string) (int64, bool) {
	if ccy == home {
		return 1_000_000, true
	}
	m, ok := rates[ccy]
	return m, ok
}

// convertHalfUp is spec §3.7's conversion, verbatim:
// (amountMinor * rateMicro + 500_000) / 1_000_000, half-up, integers only.
func convertHalfUp(amountMinor, rateMicro int64) int64 {
	return (amountMinor*rateMicro + 500_000) / 1_000_000
}

// monthBucket is a named type rather than an anonymous struct so that collect
// can take the same map type the caller builds.
type monthBucket struct{ month, bucket string }

func collect(m map[monthBucket]int64, month string) [][2]string {
	var out [][2]string
	for k, v := range m {
		if k.month == month {
			out = append(out, [2]string{k.bucket, strconv.FormatInt(v, 10)})
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i][0] < out[j][0] })
	return out
}

// digestMonth is the preimage the manifest documents, and the one
// app/src/bench/digest.ts must reproduce byte for byte.
func digestMonth(salt []byte, month string, buckets [][2]string) string {
	h := sha256.New()
	h.Write(salt)
	h.Write([]byte(month))
	for _, b := range buckets {
		h.Write([]byte{digestSep})
		h.Write([]byte(b[0]))
		h.Write([]byte{digestSep})
		h.Write([]byte(b[1]))
	}
	return hex.EncodeToString(h.Sum(nil))
}

func sha256Sum(b []byte) []byte {
	s := sha256.Sum256(b)
	return s[:]
}

// buildSelfTest fills in the digest of the fixed vector above.
func buildSelfTest() DigestSelfTest {
	v := selfTestVector
	salt, err := hex.DecodeString(v.SaltHex)
	if err != nil {
		panic("gen-phase2-corpus: the self-test salt is not hex: " + err.Error())
	}
	v.Digest = digestMonth(salt, v.Month, v.Buckets)
	return v
}
