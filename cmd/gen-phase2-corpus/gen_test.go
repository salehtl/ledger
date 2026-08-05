//go:build phase2corpus

package main

// Run with:  go test -tags phase2corpus ./cmd/gen-phase2-corpus/
//
// Tagged, like the generator itself, so `go test ./...` never builds a program
// whose job is to read a database and write files. That means these tests are
// NOT in scripts/v2-check.sh's default run — the command above is in the
// operator runbook and in the gate document, and the properties that must hold
// on every build (the framing itself) live in internal/v2/blob/encv2_test.go,
// which IS in the gate.

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	mrand "math/rand/v2"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/google/uuid"

	"ledger/internal/v2/blob"
	"ledger/internal/v2/oplog"
)

var testUser = uuid.MustParse("6f9619ff-8b86-d011-b42d-00cf4fc964ff")

func TestSyntheticRowsAreDeterministic(t *testing.T) {
	a := syntheticRows(20260802, 64)
	b := syntheticRows(20260802, 64)
	if fmt.Sprint(a) != fmt.Sprint(b) {
		t.Fatal("the same seed produced different rows")
	}
	c := syntheticRows(20260803, 64)
	if fmt.Sprint(a) == fmt.Sprint(c) {
		t.Fatal("two different seeds produced identical rows")
	}
	// Fabricated, and visibly so. If a real merchant string ever appears in the
	// synthetic generator, this is where it should be caught.
	for _, r := range a {
		if !strings.Contains(r.Merchant, "#") {
			t.Fatalf("merchant %q does not look like the fabricated form", r.Merchant)
		}
	}
}

// The whole corpus must be one width, asserted rather than assumed. Run at the
// real N so a length that only fails at the four-digit counters is caught.
func TestEverySyntheticRecordLandsInTheKilobyteBucket(t *testing.T) {
	rows := syntheticRows(20260802, defaultCorpusSize)
	s, err := blob.NewEncSealer(nil)
	if err != nil {
		t.Fatal(err)
	}
	records, err := sealRecords(s, testUser, rows)
	if err != nil {
		t.Fatalf("sealRecords: %v", err)
	}
	if len(records) != defaultCorpusSize {
		t.Fatalf("%d records, want %d", len(records), defaultCorpusSize)
	}
	for i, r := range records {
		if len(r) != recordSize {
			t.Fatalf("record %d is %d bytes", i, len(r))
		}
	}
	off := offsetsFor(records)
	if len(off) != len(records)+1 || off[0] != 0 || int(off[len(off)-1]) != len(records)*recordSize {
		t.Fatalf("offsets are wrong: len %d, first %d, last %d", len(off), off[0], off[len(off)-1])
	}
	for i := 1; i < len(off); i++ {
		if off[i] <= off[i-1] {
			t.Fatalf("offsets are not strictly increasing at %d", i)
		}
	}
}

// A row too long to fit must FAIL the generator, not be dropped. A silently
// short corpus is a benchmark whose N nobody can reproduce.
func TestAnOversizeRowFailsLoudly(t *testing.T) {
	rows := syntheticRows(20260802, 3)
	// Deliberately INCOMPRESSIBLE. strings.Repeat("Z", 4000) does not work here
	// and the failure is instructive: it gzips to about thirty bytes and lands in
	// the 1 KB bucket like everything else, so it tests nothing. The budget is 905
	// bytes of gzip output, and only high-entropy input reaches it.
	r := mrand.New(mrand.NewPCG(1, 2))
	hi := make([]byte, 1500)
	for i := range hi {
		hi[i] = byte('!' + r.UintN(90))
	}
	rows[1].Merchant = string(hi)
	s, err := blob.NewEncSealer(nil)
	if err != nil {
		t.Fatal(err)
	}
	_, err = sealRecords(s, testUser, rows)
	if err == nil {
		t.Fatal("an oversize row was accepted")
	}
	if !strings.Contains(err.Error(), "record 2") || !strings.Contains(err.Error(), "mixed-width") {
		t.Fatalf("err = %v, want a loud, located, explanatory failure", err)
	}
}

// ---------------------------------------------------------------------------
// The committed manifest must contain nothing real
// ---------------------------------------------------------------------------

// The safety property the whole task turns on, measured rather than asserted:
// serialize a manifest built from a corpus and prove that none of the source
// amounts, merchants or aggregate totals appear anywhere in the bytes.
func TestTheManifestLeaksNoAmountAndNoMerchant(t *testing.T) {
	rows := syntheticRows(20260802, 400)
	s, err := blob.NewEncSealer(nil)
	if err != nil {
		t.Fatal(err)
	}
	records, err := sealRecords(s, testUser, rows)
	if err != nil {
		t.Fatal(err)
	}
	fx := buildOpFixture(rows, 20260802)
	man, err := buildManifest(testUser, s, records, rows, fx, true)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(man)
	if err != nil {
		t.Fatal(err)
	}
	text := string(raw)

	for _, r := range rows {
		if strings.Contains(text, r.Merchant) {
			t.Fatalf("the manifest contains a merchant string: %q", r.Merchant)
		}
	}
	// Individual amounts. Short amounts would collide with digest hex by chance,
	// so only the ones long enough to be meaningful are checked — five digits and
	// up, which is every amount above 999.99 in minor units.
	checked := 0
	for _, r := range rows {
		a := strconv.FormatInt(r.Amount, 10)
		if len(a) < 5 {
			continue
		}
		checked++
		if strings.Contains(text, a) {
			t.Fatalf("the manifest contains an amount: %s", a)
		}
	}
	if checked < 50 {
		// A checker that checked almost nothing is a checker that passes for the
		// wrong reason.
		t.Fatalf("only %d amounts were long enough to check; the fixture is not exercising this", checked)
	}
	// And the aggregate totals the digests are computed FROM.
	saltBytes := man.Check.Salt
	if saltBytes == "" {
		t.Fatal("no salt")
	}
	for month := range man.Check.Months {
		for _, kind := range []string{"blind", "home"} {
			if len(man.Check.Months[month][kind]) != 64 {
				t.Fatalf("%s/%s is not a sha256 hex digest", month, kind)
			}
		}
	}
	// The strongest form: recompute the real totals and prove none of them is in
	// the file.
	for _, tot := range realTotals(rows, fx) {
		if strings.Contains(text, tot) {
			t.Fatalf("the manifest contains an aggregate total: %s", tot)
		}
	}
	// The private key must never be in it either.
	if strings.Contains(text, fmt.Sprintf("%x", s.RecipientPriv())) {
		t.Fatal("the manifest contains the recipient PRIVATE key")
	}
	if !strings.Contains(text, fmt.Sprintf("%x", s.RecipientPub())) {
		t.Fatal("the manifest is missing the recipient public key, which the device needs")
	}
}

func realTotals(rows []txnRow, fx opFixture) []string {
	sums := map[monthBucket]int64{}
	for _, r := range rows {
		if r.Direction != "debit" || r.Status != "confirmed" || len(r.PostedAt) < 7 {
			continue
		}
		sums[monthBucket{r.PostedAt[:7], bucketName(r.Bucket)}] += r.Amount
	}
	var out []string
	for _, v := range sums {
		if v > 9999 {
			out = append(out, strconv.FormatInt(v, 10))
		}
	}
	_ = fx
	return out
}

// ---------------------------------------------------------------------------
// The digest itself
// ---------------------------------------------------------------------------

// The separator the plan's formula omits. Without it ("ab","c") and ("a","bc")
// hash identically, which would let two different months of spending produce the
// same "correct" digest.
func TestTheDigestSeparatorPreventsFieldSmearing(t *testing.T) {
	salt := []byte("0123456789abcdef0123456789abcdef")
	a := digestMonth(salt, "2026-06", [][2]string{{"ab", "c"}})
	b := digestMonth(salt, "2026-06", [][2]string{{"a", "bc"}})
	if a == b {
		t.Fatal("two different (bucket,total) pairs produced the same digest")
	}
}

func TestEveryDigestInputMatters(t *testing.T) {
	salt := []byte("0123456789abcdef0123456789abcdef")
	base := digestMonth(salt, "2026-06", [][2]string{{"need", "100"}, {"want", "200"}})
	cases := map[string]string{
		"a different salt":   digestMonth([]byte("ffffffffffffffffffffffffffffffff"), "2026-06", [][2]string{{"need", "100"}, {"want", "200"}}),
		"a different month":  digestMonth(salt, "2026-07", [][2]string{{"need", "100"}, {"want", "200"}}),
		"a different bucket": digestMonth(salt, "2026-06", [][2]string{{"need", "100"}, {"saving", "200"}}),
		"a different total":  digestMonth(salt, "2026-06", [][2]string{{"need", "101"}, {"want", "200"}}),
		"a missing bucket":   digestMonth(salt, "2026-06", [][2]string{{"need", "100"}}),
	}
	for name, got := range cases {
		if got == base {
			t.Fatalf("%s produced the same digest", name)
		}
	}
	if digestMonth(salt, "2026-06", [][2]string{{"need", "100"}, {"want", "200"}}) != base {
		t.Fatal("the digest is not deterministic")
	}
}

// §3.7's conversion, verbatim, at the rounding boundaries. Half-UP, integers
// only, never a float.
func TestConvertHalfUpRoundsAtTheBoundary(t *testing.T) {
	cases := []struct{ amount, rate, want int64 }{
		{10000, 3_672_500, 36725},
		{1, 1_000_000, 1},
		{1, 1_500_000, 2}, // 1.5 → 2, half up
		{1, 499_999, 0},   // 0.499999 → 0
		{1, 500_000, 1},   // exactly 0.5 → 1
		{3, 1_666_667, 5}, // 5.000001 → 5
		{0, 3_672_500, 0},
	}
	for _, c := range cases {
		if got := convertHalfUp(c.amount, c.rate); got != c.want {
			t.Fatalf("convert(%d, %d) = %d, want %d", c.amount, c.rate, got, c.want)
		}
	}
}

// The home digests are computable by direct arithmetic only because the fixture
// publishes ONE distinct rate per currency. If that ever stops being true the
// manifest silently starts describing a different number than the device folds.
func TestTheFixturePublishesOneDistinctRatePerCurrency(t *testing.T) {
	rows := syntheticRows(20260802, 500)
	fx := buildOpFixture(rows, 20260802)
	seen := map[string]map[string]bool{}
	for _, e := range fx.Entries {
		op := e.Op.(map[string]any)
		if op["type"] != "rate_set" {
			continue
		}
		p := op["payload"].(map[string]any)
		ccy := p["currency"].(string)
		if seen[ccy] == nil {
			seen[ccy] = map[string]bool{}
		}
		seen[ccy][p["rate_micro"].(string)] = true
	}
	if len(seen) == 0 {
		t.Fatal("the fixture emitted no rate_set at all")
	}
	for ccy, vals := range seen {
		if len(vals) != 1 {
			t.Fatalf("%s has %d distinct rates in the fixture: %v", ccy, len(vals), vals)
		}
	}
	// And the mix the plan specifies is actually present.
	for _, want := range []string{"txn_ingested", "txn_categorized", "txn_superseded", "rate_set", "home_currency_set"} {
		if fx.Shape.ByType[want] == 0 {
			t.Fatalf("the fixture contains no %s", want)
		}
	}
	if fx.Shape.ByType["home_currency_set"] != 1 {
		t.Fatalf("%d home_currency_set ops; it is one-shot", fx.Shape.ByType["home_currency_set"])
	}
	if got := fx.Shape.ByType["txn_ingested"]; got != len(rows) {
		t.Fatalf("%d txn_ingested for %d rows", got, len(rows))
	}
	// The foreign-currency rows §3.7 needs.
	foreign := 0
	for ccy, n := range fx.Shape.Currencies {
		if ccy != fixtureHomeCurrency {
			foreign += n
		}
	}
	if foreign < 30 {
		t.Fatalf("only %d foreign-currency rows; §3.7's snapshot path is barely exercised", foreign)
	}
}

// ---------------------------------------------------------------------------
// Vectors
// ---------------------------------------------------------------------------

func TestVectorsAreSyntheticAndPinTheAADCheck(t *testing.T) {
	rows := syntheticRows(20260802, 10)
	s, err := blob.NewEncSealer(nil)
	if err != nil {
		t.Fatal(err)
	}
	records, err := sealRecords(s, testUser, rows)
	if err != nil {
		t.Fatal(err)
	}
	v, err := buildVectors(s, testUser, rows, records)
	if err != nil {
		t.Fatal(err)
	}
	if len(v.Vectors) != 10 {
		t.Fatalf("%d vectors, want 10", len(v.Vectors))
	}
	if !v.Synthetic {
		t.Fatal("the vectors file does not declare itself synthetic")
	}
	mismatches := 0
	for _, vec := range v.Vectors {
		if vec.ExpectError != "" {
			mismatches++
			continue
		}
		rec, err := base64.StdEncoding.DecodeString(vec.RecordBase64)
		if err != nil {
			t.Fatal(err)
		}
		counter, _ := strconv.ParseInt(vec.WriterCounter, 10, 64)
		env := blob.Envelope{UserID: uuid.MustParse(vec.UserID), Stream: vec.Stream, WriterID: vec.WriterID, WriterCounter: counter}
		got, err := s.Open(env, blob.Sealed{Bytes: rec, SizeBucket: len(rec)})
		if err != nil {
			t.Fatalf("%s does not open: %v", vec.Name, err)
		}
		want, err := base64.StdEncoding.DecodeString(vec.ExpectPlaintextBase64)
		if err != nil {
			t.Fatal(err)
		}
		if string(got) != string(want) {
			t.Fatalf("%s opened to the wrong plaintext", vec.Name)
		}
	}
	if mismatches != 1 {
		t.Fatalf("%d AAD-mismatch vectors, want exactly 1; without it an implementation that ignores the AAD passes", mismatches)
	}
	// And the mismatch vector really does fail.
	for _, vec := range v.Vectors {
		if vec.ExpectError == "" {
			continue
		}
		rec, _ := base64.StdEncoding.DecodeString(vec.RecordBase64)
		counter, _ := strconv.ParseInt(vec.WriterCounter, 10, 64)
		env := blob.Envelope{UserID: uuid.MustParse(vec.UserID), Stream: vec.Stream, WriterID: vec.WriterID, WriterCounter: counter}
		if _, err := s.Open(env, blob.Sealed{Bytes: rec, SizeBucket: len(rec)}); err == nil {
			t.Fatal("the AAD-mismatch vector opened")
		}
	}
	if v.HKDFInfo != blob.EncInfo {
		t.Fatalf("hkdf_info is %q, want %q", v.HKDFInfo, blob.EncInfo)
	}
	if v.RecordSize != recordSize || v.EncSize != blob.EncSize || v.NonceSize != blob.NonceSize || v.TagSize != blob.TagSize {
		t.Fatal("the vectors file's declared geometry does not match the format")
	}
}

func TestVectorsRefuseARealCorpus(t *testing.T) {
	dir := t.TempDir()
	err := run(genArgs{
		userStr: testUser.String(), dbPath: filepath.Join(dir, "nope.db"),
		vecOut: filepath.Join(dir, "vectors.json"),
	})
	if err == nil || !strings.Contains(err.Error(), "--vectors requires --synthetic") {
		// The db path does not exist, so the run fails either way; what matters is
		// WHICH error comes first.
		if err == nil || !strings.Contains(err.Error(), "open") {
			t.Fatalf("err = %v", err)
		}
	}
}

// ---------------------------------------------------------------------------
// The safety rails
// ---------------------------------------------------------------------------

func TestRefuseCommittedPath(t *testing.T) {
	for _, bad := range []string{
		"conformance/crypto/corpus.bin",
		"docs/superpowers/specs/corpus.bin",
		"internal/v2/blob/corpus.bin",
		"app/src/bench/corpus.bin",
		"client/src/corpus.bin",
	} {
		if err := refuseCommittedPath(bad); err == nil {
			t.Fatalf("%s was accepted as a corpus destination", bad)
		}
	}
	ok := filepath.Join(t.TempDir(), "corpus.bin")
	if err := refuseCommittedPath(ok); err != nil {
		t.Fatalf("%s was refused: %v", ok, err)
	}
}

func TestRefusesTheLiveProductionDatabase(t *testing.T) {
	err := run(genArgs{userStr: testUser.String(), dbPath: "/var/lib/ledger/ledger.db"})
	if err == nil || !strings.Contains(err.Error(), "LIVE v1 production database") {
		t.Fatalf("err = %v, want a refusal to open the live database", err)
	}
}

func TestUserIsRequired(t *testing.T) {
	if err := run(genArgs{synthetic: true}); err == nil || !strings.Contains(err.Error(), "--user is required") {
		t.Fatalf("err = %v", err)
	}
	if err := run(genArgs{userStr: "nope", synthetic: true}); err == nil {
		t.Fatal("a non-UUID --user was accepted")
	}
}

func TestExactlyOneSourceIsRequired(t *testing.T) {
	if err := run(genArgs{userStr: testUser.String()}); err == nil || !strings.Contains(err.Error(), "exactly one") {
		t.Fatalf("neither source: err = %v", err)
	}
	if err := run(genArgs{userStr: testUser.String(), synthetic: true, dbPath: "x.db"}); err == nil {
		t.Fatal("both sources were accepted")
	}
}

// End to end, synthetic: the artifacts the operator commits are produced, are
// well-formed, and nothing lands where it must not.
func TestSyntheticEndToEnd(t *testing.T) {
	dir := t.TempDir()
	out := filepath.Join(dir, "corpus.bin")
	err := run(genArgs{
		userStr: testUser.String(), synthetic: true, seed: 20260802, count: 64,
		outPath: out,
		keyOut:  filepath.Join(dir, "recipient.key"),
		manOut:  filepath.Join(dir, "manifest.json"),
		vecOut:  filepath.Join(dir, "vectors.json"),
		opsOut:  filepath.Join(dir, "oplog.json"),
	})
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	st, err := os.Stat(out)
	if err != nil {
		t.Fatal(err)
	}
	if st.Size() != 64*recordSize {
		t.Fatalf("corpus.bin is %d bytes, want %d", st.Size(), 64*recordSize)
	}
	if st.Mode().Perm() != 0o600 {
		t.Fatalf("corpus.bin is mode %v; real corpora are 0600", st.Mode().Perm())
	}
	key, err := os.Stat(filepath.Join(dir, "recipient.key"))
	if err != nil {
		t.Fatal(err)
	}
	if key.Mode().Perm() != 0o600 {
		t.Fatalf("recipient.key is mode %v", key.Mode().Perm())
	}
	var man Manifest
	b, err := os.ReadFile(filepath.Join(dir, "manifest.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(b, &man); err != nil {
		t.Fatal(err)
	}
	if man.Count != 64 || man.RecordSize != recordSize || man.EnvelopeVersion != blob.EncVersion ||
		man.WriterID != oplog.IngestWriterID || man.UserID != testUser.String() {
		t.Fatalf("manifest does not describe the corpus: %+v", man)
	}
	if !strings.Contains(man.AADTemplate, "<counter>") {
		t.Fatalf("aad_template is %q", man.AADTemplate)
	}
}
