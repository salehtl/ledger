package dict

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"ledger/internal/v2/pgtest"
)

var bg = context.Background()

func TestMain(m *testing.M) { os.Exit(pgtest.Main(m)) }

// A fixed key: every assertion about what is STORED has to be reproducible, and
// a random key per run would make a failing HMAC comparison unreadable.
const testKeyHex = "0011223344556677889900aabbccddeeff112233445566778899aabbccddeeff"

var testKey = mustKey(testKeyHex)

func mustKey(s string) []byte {
	k, err := ParseKey(s)
	if err != nil {
		panic(err)
	}
	return k
}

func newDict(t *testing.T) *Dict {
	t.Helper()
	return &Dict{Pool: pgtest.New(t), HMACKey: testKey}
}

// mkUsers returns n stable, distinct user ids.
func mkUsers(n int) []uuid.UUID {
	out := make([]uuid.UUID, n)
	for i := range out {
		out[i] = uuid.NewSHA1(uuid.NameSpaceOID, []byte(fmt.Sprintf("dict-test-user-%d", i)))
	}
	return out
}

func submit(t *testing.T, d *Dict, u uuid.UUID, pattern, category string) {
	t.Helper()
	if err := d.Submit(bg, u, pattern, category); err != nil {
		t.Fatalf("Submit(%s, %s): %v", pattern, category, err)
	}
}

func moderate(t *testing.T, d *Dict, pattern, category string, approved bool) {
	t.Helper()
	if err := d.Moderate(bg, pattern, category, approved, "reviewed by test"); err != nil {
		t.Fatalf("Moderate(%s, %s, %v): %v", pattern, category, approved, err)
	}
}

func published(t *testing.T, d *Dict) []Entry {
	t.Helper()
	got, err := d.Published(bg)
	if err != nil {
		t.Fatalf("Published: %v", err)
	}
	return got
}

func countRows(t *testing.T, pool *pgxpool.Pool, sql string, args ...any) int {
	t.Helper()
	var n int
	if err := pool.QueryRow(bg, sql, args...).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

// ---------------------------------------------------------------------------
// The privacy inventory. These two tests are the Task 23 tripwire, applied to
// this table: the first fails the moment a column is added, and the second
// keeps failing until spec §2 — which is adopted verbatim into the user-facing
// privacy page — names it too, in the SAME commit.
// ---------------------------------------------------------------------------

// disclosedSubmissionColumns is the complete column list of dict_submissions.
// This is the table that holds anything even adjacent to a user, so the list is
// deliberately as short as the counting requires.
var disclosedSubmissionColumns = []string{
	"category",
	"created_at",
	"pattern",
	"submitter_hmac",
}

// disclosedEntryColumns is the complete column list of dict_entries — the
// global dictionary itself. Its published rows are handed to every client by
// design; its unpublished rows are the part a breach would newly reveal.
var disclosedEntryColumns = []string{
	"approved",
	"category",
	"distinct_submitter_count",
	"match_type",
	"moderator_note",
	"pattern",
	"published_at",
	"source",
	"version",
}

func tableColumns(t *testing.T, pool *pgxpool.Pool, table string) []string {
	t.Helper()
	rows, err := pool.Query(bg, `SELECT column_name FROM information_schema.columns
	                              WHERE table_schema='public' AND table_name=$1
	                              ORDER BY column_name`, table)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var got []string
	for rows.Next() {
		var c string
		if err := rows.Scan(&c); err != nil {
			t.Fatal(err)
		}
		got = append(got, c)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if len(got) == 0 {
		t.Fatalf("table %s does not exist", table)
	}
	return got
}

func TestDictionaryTablesHaveExactlyTheDisclosedColumns(t *testing.T) {
	pool := pgtest.New(t)
	for table, want := range map[string][]string{
		"dict_submissions": disclosedSubmissionColumns,
		"dict_entries":     disclosedEntryColumns,
	} {
		got := tableColumns(t, pool, table)
		if strings.Join(got, ",") != strings.Join(want, ",") {
			t.Errorf("%s columns drifted from the disclosed set.\n in database: %v\n disclosed:   %v\n"+
				"A column here is a promise in the privacy page; update spec §2 in the SAME commit.",
				table, got, want)
		}
	}
}

// specSection2 returns the text of spec §2, the breach inventory adopted
// verbatim into the privacy page.
func specSection2(t *testing.T) string {
	t.Helper()
	path := filepath.Join("..", "..", "..", "docs", "superpowers", "specs",
		"2026-07-31-multi-user-beta-design.md")
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read spec: %v", err)
	}
	s := string(b)
	start := strings.Index(s, "## 2.")
	end := strings.Index(s, "## 3.")
	if start < 0 || end < 0 || end < start {
		t.Fatalf("cannot locate §2 in %s", path)
	}
	return s[start:end]
}

func TestEveryDisclosedDictionaryColumnIsNamedInSpecSection2(t *testing.T) {
	sec := specSection2(t)
	for _, table := range []string{"dict_submissions", "dict_entries"} {
		if !strings.Contains(sec, "`"+table+"`") {
			t.Errorf("spec §2 does not name the `%s` table — §2 IS the privacy page, "+
				"so an unnamed table is an undisclosed one", table)
		}
	}
	cols := append(append([]string{}, disclosedSubmissionColumns...), disclosedEntryColumns...)
	for _, col := range cols {
		if !strings.Contains(sec, "`"+col+"`") {
			t.Errorf("spec §2 does not name the merchant-dictionary column `%s`", col)
		}
	}
}

// The k threshold is a published claim in §3.6 AND a literal inside a CHECK
// constraint that cannot reference a Go constant. This pins the three together.
func TestTheKThresholdMatchesTheSQLLiteralAndTheSpec(t *testing.T) {
	if K != 3 {
		t.Fatalf("K = %d; plan Decision 8 fixes it at 3", K)
	}
	pool := pgtest.New(t)
	// The constraint that makes "publishable implies published_at" a database
	// guarantee embeds K. Read its definition back and confirm the number.
	var def string
	err := pool.QueryRow(bg, `SELECT pg_get_constraintdef(oid) FROM pg_constraint
	                           WHERE conname = 'dict_entries_publishable_rows_are_published'`).Scan(&def)
	if err != nil {
		t.Fatalf("read the publication constraint: %v", err)
	}
	if !strings.Contains(def, fmt.Sprintf("%d", K)) {
		t.Fatalf("the SQL publication gate does not embed K=%d: %s", K, def)
	}
}

// ---------------------------------------------------------------------------
// No user linkage
// ---------------------------------------------------------------------------

func TestDictionaryStoresNoUserID(t *testing.T) {
	pool := pgtest.New(t)
	n := countRows(t, pool, `SELECT count(*) FROM information_schema.columns
	  WHERE table_schema='public' AND table_name IN ('dict_submissions','dict_entries')
	    AND column_name = 'user_id'`)
	if n != 0 {
		t.Fatal("spec §3.6: a merchant pattern is never user-linked; storing user_id here " +
			"builds a per-user merchant ledger the privacy page does not disclose")
	}
}

// The breach test. It dumps EVERY value in both tables and asserts the user id
// appears in none of them, in any encoding a dump would render it in — and that
// the stored identifier is not derivable without the key.
func TestABreachOfTheseTablesCannotLinkAUserToAMerchant(t *testing.T) {
	d := newDict(t)
	u := mkUsers(1)[0]
	submit(t, d, u, "CARREFOUR", "Groceries")

	dump := tableDump(t, d.Pool, "dict_submissions") + tableDump(t, d.Pool, "dict_entries")
	raw := u[:]
	for name, enc := range map[string]string{
		"canonical uuid": u.String(),
		"hex, no dashes": hex.EncodeToString(raw),
		"raw bytes, hex": "\\x" + hex.EncodeToString(raw),
		"base64":         base64.StdEncoding.EncodeToString(raw),
	} {
		if strings.Contains(strings.ToLower(dump), strings.ToLower(enc)) {
			t.Errorf("the stored rows carry the submitter's user id as %s", name)
		}
	}

	// The identifier that IS stored must depend on the key. An unkeyed digest
	// of the same inputs would be reproducible by anyone holding the dump.
	var stored []byte
	if err := d.Pool.QueryRow(bg, `SELECT submitter_hmac FROM dict_submissions`).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	unkeyed := sha256.Sum256(append(append([]byte{}, raw...), []byte("carrefour")...))
	if bytes.Equal(stored, unkeyed[:]) {
		t.Fatal("submitter_hmac is an UNKEYED digest: anyone holding the dump can recompute it")
	}
	other := &Dict{Pool: d.Pool, HMACKey: mustKey(strings.Repeat("ab", 32))}
	if bytes.Equal(stored, other.submitterHMAC(u, "carrefour", "groceries")) {
		t.Fatal("submitter_hmac does not depend on LEDGER_DICT_HMAC_KEY")
	}
	if !bytes.Equal(stored, d.submitterHMAC(u, "carrefour", "groceries")) {
		t.Fatal("submitter_hmac is not the keyed HMAC of the canonicalized submission")
	}
}

func tableDump(t *testing.T, pool *pgxpool.Pool, table string) string {
	t.Helper()
	rows, err := pool.Query(bg, `SELECT to_jsonb(x)::text FROM `+table+` x`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var out strings.Builder
	for rows.Next() {
		var s string
		if err := rows.Scan(&s); err != nil {
			t.Fatal(err)
		}
		out.WriteString(s)
		out.WriteString("\n")
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return out.String()
}

func TestSubmitterHMACsAreNotLinkableAcrossPatterns(t *testing.T) {
	d := newDict(t)
	u := mkUsers(1)[0]
	submit(t, d, u, "CARREFOUR", "Groceries")
	submit(t, d, u, "SPINNEYS", "Groceries")

	rows, err := d.Pool.Query(bg, `SELECT pattern, submitter_hmac FROM dict_submissions ORDER BY pattern`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	seen := map[string][]byte{}
	for rows.Next() {
		var p string
		var h []byte
		if err := rows.Scan(&p, &h); err != nil {
			t.Fatal(err)
		}
		seen[p] = h
	}
	if len(seen) != 2 {
		t.Fatalf("expected two submissions, got %d", len(seen))
	}
	if bytes.Equal(seen["carrefour"], seen["spinneys"]) {
		t.Fatal("one user's identifier is the SAME under two patterns: the two rows are " +
			"trivially linkable, which is the cross-pattern profile the salt exists to prevent")
	}
}

// The same argument one level down: the same user voting two different
// categories for one pattern must not be linkable either.
func TestSubmitterHMACsAreNotLinkableAcrossCategories(t *testing.T) {
	d := newDict(t)
	u := mkUsers(1)[0]
	submit(t, d, u, "NOON", "Shopping")
	submit(t, d, u, "NOON", "Dining")

	rows, err := d.Pool.Query(bg, `SELECT category, submitter_hmac FROM dict_submissions ORDER BY category`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var hmacs [][]byte
	for rows.Next() {
		var c string
		var h []byte
		if err := rows.Scan(&c, &h); err != nil {
			t.Fatal(err)
		}
		hmacs = append(hmacs, h)
	}
	if len(hmacs) != 2 {
		t.Fatalf("expected two submissions, got %d", len(hmacs))
	}
	if bytes.Equal(hmacs[0], hmacs[1]) {
		t.Fatal("one user's identifier is the SAME under two categories for one pattern")
	}
}

// ---------------------------------------------------------------------------
// The k gate
// ---------------------------------------------------------------------------

func TestEntryIsSuppressedBelowK(t *testing.T) {
	d := newDict(t)
	users := mkUsers(K)
	for i := 0; i < K-1; i++ {
		submit(t, d, users[i], "CARREFOUR", "Groceries")
	}
	moderate(t, d, "CARREFOUR", "Groceries", true)

	if got := published(t, d); len(got) != 0 {
		t.Fatalf("k=%d not reached (%d submitters); entry must stay suppressed, got %v", K, K-1, got)
	}

	submit(t, d, users[K-1], "CARREFOUR", "Groceries")
	got := published(t, d)
	if len(got) != 1 {
		t.Fatalf("k reached; entry must publish, got %v", got)
	}
	want := Entry{Pattern: "carrefour", Match: MatchContains, Category: "groceries"}
	if got[0] != want {
		t.Fatalf("published %+v, want %+v", got[0], want)
	}
}

func TestRepeatedSubmissionsFromOneUserDoNotReachK(t *testing.T) {
	d := newDict(t)
	u := mkUsers(1)[0]
	for i := 0; i < K+2; i++ {
		submit(t, d, u, "CARREFOUR", "Groceries")
	}
	moderate(t, d, "CARREFOUR", "Groceries", true)

	if n := countRows(t, d.Pool, `SELECT distinct_submitter_count FROM dict_entries`); n != 1 {
		t.Fatalf("one user submitting %d times counted as %d distinct submitters", K+2, n)
	}
	if got := published(t, d); len(got) != 0 {
		t.Fatalf("one user cannot reach k on their own; got %v", got)
	}
	if n := countRows(t, d.Pool, `SELECT count(*) FROM dict_submissions`); n != 1 {
		t.Fatalf("%d submission rows stored for one user's %d submissions", n, K+2)
	}
}

// Case and spacing must not be a way around the threshold either: three
// spellings of one merchant from one user is still one submitter.
func TestCaseVariantsFromOneUserDoNotReachK(t *testing.T) {
	d := newDict(t)
	u := mkUsers(1)[0]
	for _, p := range []string{"CARREFOUR", "Carrefour", "  carrefour  "} {
		submit(t, d, u, p, "Groceries")
	}
	if n := countRows(t, d.Pool, `SELECT count(*) FROM dict_entries`); n != 1 {
		t.Fatalf("three spellings of one merchant produced %d entries", n)
	}
	if n := countRows(t, d.Pool, `SELECT distinct_submitter_count FROM dict_entries`); n != 1 {
		t.Fatalf("one user's three spellings counted as %d distinct submitters", n)
	}
}

func TestUnmoderatedEntryNeverPublishesEvenAboveK(t *testing.T) {
	d := newDict(t)
	for _, u := range mkUsers(K + 3) {
		submit(t, d, u, "AMAZON", "Charity")
	}
	if got := published(t, d); len(got) != 0 {
		t.Fatalf("an unmoderated entry published on crowd volume alone: %v — this is the "+
			"dictionary-poisoning gate (spec §3.6)", got)
	}
}

func TestRejectedEntryNeverPublishesHoweverManySubmitIt(t *testing.T) {
	d := newDict(t)
	for _, u := range mkUsers(K + 3) {
		submit(t, d, u, "AMAZON", "Charity")
	}
	moderate(t, d, "AMAZON", "Charity", false)
	if got := published(t, d); len(got) != 0 {
		t.Fatalf("a moderator-REJECTED entry published anyway: %v", got)
	}
}

func TestOperatorSeedBypassesKButNotModeration(t *testing.T) {
	d := newDict(t)
	seed := []Entry{{Pattern: "SPINNEYS DUBAI LLC", Match: MatchContains, Category: "Groceries"}}
	if err := d.SeedFromV1(bg, seed); err != nil {
		t.Fatalf("SeedFromV1: %v", err)
	}
	if got := published(t, d); len(got) != 0 {
		t.Fatalf("the operator seed published without moderation: %v", got)
	}
	if n := countRows(t, d.Pool, `SELECT distinct_submitter_count FROM dict_entries`); n != 0 {
		t.Fatalf("seeded entry claims %d distinct submitters; it has none", n)
	}
	moderate(t, d, "SPINNEYS DUBAI LLC", "Groceries", true)
	got := published(t, d)
	if len(got) != 1 {
		t.Fatalf("an approved operator seed must publish with zero crowd submitters, got %v", got)
	}
	if got[0].Pattern != "spinneys dubai llc" || got[0].Category != "groceries" {
		t.Fatalf("seeded entry was not canonicalized: %+v", got[0])
	}
}

// The database, not just the Go code, refuses a publishable row that was never
// marked published — the flag the retraction feed depends on.
func TestTheDatabaseRefusesAPublishableRowThatWasNeverPublished(t *testing.T) {
	pool := pgtest.New(t)
	_, err := pool.Exec(bg, `INSERT INTO dict_entries
	  (pattern, match_type, category, source, distinct_submitter_count, approved, version)
	  VALUES ('carrefour','contains','groceries','crowd',$1,true, nextval('dict_entry_version_seq'))`, K)
	if err == nil {
		t.Fatal("the database accepted an approved, above-k entry with no published_at; " +
			"the retraction feed silently loses that entry forever")
	}
}

// ---------------------------------------------------------------------------
// The submitter identifiers live exactly as long as the counting requires
// ---------------------------------------------------------------------------

func TestPublicationDeletesTheSubmitterRows(t *testing.T) {
	d := newDict(t)
	users := mkUsers(K)
	for i := 0; i < K-1; i++ {
		submit(t, d, users[i], "CARREFOUR", "Groceries")
	}
	if n := countRows(t, d.Pool, `SELECT count(*) FROM dict_submissions`); n != K-1 {
		t.Fatalf("expected %d submitter rows below k, got %d", K-1, n)
	}
	moderate(t, d, "CARREFOUR", "Groceries", true)
	submit(t, d, users[K-1], "CARREFOUR", "Groceries")

	if got := published(t, d); len(got) != 1 {
		t.Fatalf("entry did not publish: %v", got)
	}
	if n := countRows(t, d.Pool, `SELECT count(*) FROM dict_submissions`); n != 0 {
		t.Fatalf("%d submitter rows survive publication; the identifiers must not outlive "+
			"the count that needed them", n)
	}
}

// Stricter than publication: the identifiers stop being needed the moment the
// count is reached, whether or not a moderator has looked at the entry yet.
func TestSubmitterRowsAreDeletedTheMomentKIsReachedEvenUnmoderated(t *testing.T) {
	d := newDict(t)
	for _, u := range mkUsers(K) {
		submit(t, d, u, "AMAZON", "Charity")
	}
	if n := countRows(t, d.Pool, `SELECT count(*) FROM dict_submissions`); n != 0 {
		t.Fatalf("%d submitter rows survive reaching k on an unmoderated entry", n)
	}
	if n := countRows(t, d.Pool, `SELECT distinct_submitter_count FROM dict_entries`); n != K {
		t.Fatalf("the count was lost with the rows: %d, want %d", n, K)
	}
}

// Once an entry has stopped counting, further submissions store nothing at all.
func TestSubmissionsAfterTheThresholdStoreNoIdentifier(t *testing.T) {
	d := newDict(t)
	for _, u := range mkUsers(K) {
		submit(t, d, u, "CARREFOUR", "Groceries")
	}
	for _, u := range mkUsers(K + 5)[K:] {
		submit(t, d, u, "CARREFOUR", "Groceries")
	}
	if n := countRows(t, d.Pool, `SELECT count(*) FROM dict_submissions`); n != 0 {
		t.Fatalf("%d identifiers stored for submissions that could not change any outcome", n)
	}
}

// An operator-seeded entry needs no crowd at all, so it must never accumulate
// identifiers either.
func TestSubmissionsToASeededEntryStoreNoIdentifier(t *testing.T) {
	d := newDict(t)
	if err := d.SeedFromV1(bg, []Entry{{Pattern: "CARREFOUR", Category: "Groceries"}}); err != nil {
		t.Fatalf("SeedFromV1: %v", err)
	}
	submit(t, d, mkUsers(1)[0], "CARREFOUR", "Groceries")
	if n := countRows(t, d.Pool, `SELECT count(*) FROM dict_submissions`); n != 0 {
		t.Fatalf("%d identifiers stored against an entry whose k-gate is already bypassed", n)
	}
}

func TestForgetSubmitterRemovesAPurgedUsersSubmissions(t *testing.T) {
	d := newDict(t)
	users := mkUsers(2)
	submit(t, d, users[0], "CARREFOUR", "Groceries")
	submit(t, d, users[0], "SPINNEYS", "Groceries")
	submit(t, d, users[1], "CARREFOUR", "Groceries")

	n, err := d.ForgetSubmitter(bg, users[0])
	if err != nil {
		t.Fatalf("ForgetSubmitter: %v", err)
	}
	if n != 2 {
		t.Fatalf("ForgetSubmitter removed %d rows, want 2", n)
	}
	if got := countRows(t, d.Pool, `SELECT count(*) FROM dict_submissions`); got != 1 {
		t.Fatalf("%d submitter rows survive the purge, want 1 (the other user's)", got)
	}
	// The counts must follow the rows, or a purged user keeps voting.
	if got := countRows(t, d.Pool,
		`SELECT distinct_submitter_count FROM dict_entries WHERE pattern='carrefour'`); got != 1 {
		t.Fatalf("carrefour still counts %d submitters after one of its two was purged", got)
	}
	if got := countRows(t, d.Pool,
		`SELECT distinct_submitter_count FROM dict_entries WHERE pattern='spinneys'`); got != 0 {
		t.Fatalf("spinneys still counts %d submitters after its only one was purged", got)
	}
	// Idempotent: a re-run of a purge must not report phantom work.
	again, err := d.ForgetSubmitter(bg, users[0])
	if err != nil {
		t.Fatalf("ForgetSubmitter (second run): %v", err)
	}
	if again != 0 {
		t.Fatalf("re-purging the same user removed %d more rows", again)
	}
}

func TestExpireStaleSubmissionsDropsIdentifiersThatNeverReachedK(t *testing.T) {
	d := newDict(t)
	submit(t, d, mkUsers(1)[0], "CARREFOUR", "Groceries")
	if _, err := d.Pool.Exec(bg,
		`UPDATE dict_submissions SET created_at = now() - interval '400 days'`); err != nil {
		t.Fatal(err)
	}
	n, err := d.ExpireStaleSubmissions(bg, 365*24*time.Hour)
	if err != nil {
		t.Fatalf("ExpireStaleSubmissions: %v", err)
	}
	if n != 1 {
		t.Fatalf("expired %d rows, want 1", n)
	}
	if got := countRows(t, d.Pool,
		`SELECT distinct_submitter_count FROM dict_entries WHERE pattern='carrefour'`); got != 0 {
		t.Fatalf("the entry still counts %d submitters whose identifiers are gone", got)
	}
}

// ---------------------------------------------------------------------------
// Distribution
// ---------------------------------------------------------------------------

// A client's delta feed must never carry a pattern that has not published —
// that is the whole point of suppression, and a "removed" list is the easiest
// place to leak one.
func TestSinceNeverLeaksASuppressedPattern(t *testing.T) {
	d := newDict(t)
	// One published entry, so the client has a real cursor to move.
	for _, u := range mkUsers(K) {
		submit(t, d, u, "CARREFOUR", "Groceries")
	}
	moderate(t, d, "CARREFOUR", "Groceries", true)
	first, err := d.Since(bg, 0)
	if err != nil {
		t.Fatalf("Since(0): %v", err)
	}
	if len(first.Entries) != 1 {
		t.Fatalf("first pull carried %d entries, want 1", len(first.Entries))
	}

	// Now a rare merchant is submitted by one user and rejected by the
	// moderator. Neither event may be visible to a client.
	submit(t, d, mkUsers(9)[8], "DR ALIA FERTILITY CLINIC", "Healthcare")
	moderate(t, d, "DR ALIA FERTILITY CLINIC", "Healthcare", false)

	next, err := d.Since(bg, first.Version)
	if err != nil {
		t.Fatalf("Since(%d): %v", first.Version, err)
	}
	blob := fmt.Sprintf("%+v", next)
	if strings.Contains(strings.ToLower(blob), "alia") {
		t.Fatalf("the delta feed leaked a suppressed, never-published pattern: %s", blob)
	}
	if next.Version != first.Version {
		t.Fatalf("the cursor advanced on an invisible change: %d -> %d; that alone tells a "+
			"client something was submitted", first.Version, next.Version)
	}
}

func TestSinceReportsARetractionForAnEntryThatWasActuallyPublished(t *testing.T) {
	d := newDict(t)
	for _, u := range mkUsers(K) {
		submit(t, d, u, "AMAZON", "Charity")
	}
	moderate(t, d, "AMAZON", "Charity", true)
	first, err := d.Since(bg, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(first.Entries) != 1 || len(first.Removed) != 0 {
		t.Fatalf("first pull: %+v", first)
	}
	moderate(t, d, "AMAZON", "Charity", false)

	next, err := d.Since(bg, first.Version)
	if err != nil {
		t.Fatal(err)
	}
	if len(next.Entries) != 0 {
		t.Fatalf("a retracted entry was re-served: %+v", next.Entries)
	}
	if len(next.Removed) != 1 || next.Removed[0].Pattern != "amazon" {
		t.Fatalf("the retraction was not reported: %+v", next.Removed)
	}
	if next.Version <= first.Version {
		t.Fatalf("the cursor did not advance past the retraction: %d -> %d", first.Version, next.Version)
	}
}

func TestSinceOmitsRetractionsForAFreshClient(t *testing.T) {
	d := newDict(t)
	for _, u := range mkUsers(K) {
		submit(t, d, u, "AMAZON", "Charity")
	}
	moderate(t, d, "AMAZON", "Charity", true)
	moderate(t, d, "AMAZON", "Charity", false)
	got, err := d.Since(bg, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Removed) != 0 {
		t.Fatalf("a client with an empty dictionary was sent %d deletions", len(got.Removed))
	}
}

// ---------------------------------------------------------------------------
// Input handling
// ---------------------------------------------------------------------------

func TestSubmitRefusesAMissingOrWeakHMACKey(t *testing.T) {
	pool := pgtest.New(t)
	for name, key := range map[string][]byte{
		"absent": nil,
		"short":  []byte("tooshort"),
	} {
		d := &Dict{Pool: pool, HMACKey: key}
		if err := d.Submit(bg, mkUsers(1)[0], "CARREFOUR", "Groceries"); !errors.Is(err, ErrNoKey) {
			t.Errorf("Submit with a %s key returned %v, want ErrNoKey — an empty key would "+
				"make every stored identifier recomputable by anyone", name, err)
		}
	}
	if _, err := ParseKey("not-hex"); err == nil {
		t.Error("ParseKey accepted a non-hex key")
	}
	if _, err := ParseKey(strings.Repeat("ab", 8)); err == nil {
		t.Error("ParseKey accepted a 64-bit key")
	}
}

func TestRegexPatternsAreRefused(t *testing.T) {
	d := newDict(t)
	err := d.SeedFromV1(bg, []Entry{{Pattern: "carrefour|spinneys", Match: "regex", Category: "Groceries"}})
	if !errors.Is(err, ErrInvalidEntry) {
		t.Fatalf("SeedFromV1 accepted a regex entry (%v); a regex published to every client "+
			"is a fleet-wide ReDoS surface, and v1's whole rule set is `contains`", err)
	}
}

func TestPatternsAndCategoriesAreBoundedAndCanonicalized(t *testing.T) {
	d := newDict(t)
	u := mkUsers(1)[0]
	for name, tc := range map[string]struct{ pattern, category string }{
		"empty pattern":      {"", "Groceries"},
		"one-character":      {"a", "Groceries"},
		"no letter or digit": {"---", "Groceries"},
		"overlong pattern":   {strings.Repeat("a", 65), "Groceries"},
		"newline in pattern": {"carrefour\nnote to self", "Groceries"},
		"empty category":     {"CARREFOUR", ""},
		"free-text category": {"CARREFOUR", "spent this at my therapist's office"},
		"overlong category":  {"CARREFOUR", strings.Repeat("a", 33)},
	} {
		if err := d.Submit(bg, u, tc.pattern, tc.category); !errors.Is(err, ErrInvalidEntry) {
			t.Errorf("Submit(%s) returned %v, want ErrInvalidEntry", name, err)
		}
	}
	// A validation error must never echo the value it rejected: the reason
	// travels to an operator log, and the value is the merchant string itself.
	err := d.Submit(bg, u, "SOME VERY PRIVATE PLACE\n", "Groceries")
	if err == nil {
		t.Fatal("expected an error")
	}
	if strings.Contains(strings.ToUpper(err.Error()), "PRIVATE") {
		t.Fatalf("the validation error echoed the rejected value: %v", err)
	}

	// The happy path canonicalizes rather than rejecting.
	submit(t, d, u, "  Carrefour   Hypermarket  ", " Groceries ")
	var pattern, category string
	if err := d.Pool.QueryRow(bg, `SELECT pattern, category FROM dict_entries`).Scan(&pattern, &category); err != nil {
		t.Fatal(err)
	}
	if pattern != "carrefour hypermarket" || category != "groceries" {
		t.Fatalf("stored (%q, %q), want (%q, %q)", pattern, category, "carrefour hypermarket", "groceries")
	}
}

// The Go bound ("at least one letter or digit", unicode.IsLetter) and the SQL
// bound (pattern ~ '[[:alnum:]]') are two checks of one rule, and they are
// written in different languages against different Unicode tables. A merchant
// name in Arabic is the case where they could disagree — UAE bank mail carries
// them — and the failure would be silent until the first such merchant appears.
func TestANonASCIIMerchantNameIsStorable(t *testing.T) {
	d := newDict(t)
	for _, pattern := range []string{"كارفور", "カルフール", "Café Rider"} {
		if err := d.Submit(bg, mkUsers(1)[0], pattern, "Groceries"); err != nil {
			t.Errorf("Submit(%q): %v — the Go check and the SQL CHECK disagree about "+
				"what counts as a letter", pattern, err)
		}
	}
	if n := countRows(t, d.Pool, `SELECT count(*) FROM dict_entries`); n != 3 {
		t.Fatalf("%d entries stored, want 3", n)
	}
}

func TestModerateRefusesAnEntryThatDoesNotExist(t *testing.T) {
	d := newDict(t)
	if err := d.Moderate(bg, "CARREFOUR", "Groceries", true, ""); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Moderate on a nonexistent entry returned %v, want ErrNotFound", err)
	}
}

func TestSeedFromV1IsIdempotentAndPreservesModeration(t *testing.T) {
	d := newDict(t)
	seed := []Entry{
		{Pattern: "CARREFOUR", Match: MatchContains, Category: "Groceries"},
		{Pattern: "carrefour", Match: MatchContains, Category: "groceries"}, // same entry
		{Pattern: "TALABAT", Match: MatchContains, Category: "Dining"},
	}
	if err := d.SeedFromV1(bg, seed); err != nil {
		t.Fatalf("SeedFromV1: %v", err)
	}
	if n := countRows(t, d.Pool, `SELECT count(*) FROM dict_entries`); n != 2 {
		t.Fatalf("%d entries from a seed carrying one duplicate, want 2", n)
	}
	moderate(t, d, "CARREFOUR", "Groceries", true)
	if err := d.SeedFromV1(bg, seed); err != nil {
		t.Fatalf("SeedFromV1 (re-run): %v", err)
	}
	if n := countRows(t, d.Pool, `SELECT count(*) FROM dict_entries`); n != 2 {
		t.Fatalf("re-seeding produced %d entries, want 2", n)
	}
	if got := published(t, d); len(got) != 1 {
		t.Fatalf("re-seeding reset an approval: published %v", got)
	}
}

// ---------------------------------------------------------------------------
// Concurrency
// ---------------------------------------------------------------------------

// Every distinct user counts exactly once even when they all arrive at the same
// instant, and the entry publishes exactly once.
func TestConcurrentSubmissionsCountEachUserExactlyOnce(t *testing.T) {
	d := newDict(t)
	const n = 8
	users := mkUsers(n)
	warmPool(t, d.Pool, n)

	var wg sync.WaitGroup
	errs := make([]error, n*2)
	for i := 0; i < n; i++ {
		for dup := 0; dup < 2; dup++ { // each user races themselves too
			wg.Add(1)
			go func(i, dup int) {
				defer wg.Done()
				errs[i*2+dup] = d.Submit(bg, users[i], "CARREFOUR", "Groceries")
			}(i, dup)
		}
	}
	wg.Wait()
	for _, err := range errs {
		if err != nil {
			t.Fatalf("concurrent Submit: %v", err)
		}
	}
	got := countRows(t, d.Pool, `SELECT distinct_submitter_count FROM dict_entries`)
	if got != K {
		t.Fatalf("distinct_submitter_count is %d after %d concurrent users; it must freeze at "+
			"exactly K=%d, because counting stops the moment the threshold is met", got, n, K)
	}
	if rows := countRows(t, d.Pool, `SELECT count(*) FROM dict_submissions`); rows != 0 {
		t.Fatalf("%d identifiers survive a race that reached the threshold", rows)
	}
}

// warmPool forces n connections to exist before the timed/raced section, so the
// race is between the statements and not between pgxpool's connection setup.
func warmPool(t *testing.T, pool *pgxpool.Pool, n int) {
	t.Helper()
	conns := make([]*pgxpool.Conn, 0, n)
	for i := 0; i < n; i++ {
		c, err := pool.Acquire(bg)
		if err != nil {
			t.Fatal(err)
		}
		conns = append(conns, c)
	}
	for _, c := range conns {
		c.Release()
	}
}
