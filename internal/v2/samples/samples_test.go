package samples

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"ledger/internal/v2/auth"
	"ledger/internal/v2/blob"
	"ledger/internal/v2/diag"
	"ledger/internal/v2/norm"
	"ledger/internal/v2/oplog"
	"ledger/internal/v2/pgtest"
)

func TestMain(m *testing.M) { os.Exit(pgtest.Main(m)) }

var bg = context.Background()

// ---------------------------------------------------------------------------
// The published claim
// ---------------------------------------------------------------------------

// disclosedColumns is the field list spec §2 promises users, restated here
// independently of the migration and of the INSERTs.
//
// IT IS A PUBLISHED CLAIM, NOT AN IMPLEMENTATION DETAIL. §2 is adopted verbatim
// into the user-facing privacy page, and this is the ONE table in v2 that holds
// a user's mail in the clear on purpose, so a column here that §2 does not name
// is a false statement about what a breach of this server yields.
//
// The pattern is Task 23's, deliberately: the first test below fails on any new
// column, and the second keeps failing until §2 names it too, in the same
// commit.
var disclosedColumns = []string{
	"consent",
	"consented_at",
	"created_at",
	"expires_at",
	"id",
	"ingest_id",
	"raw",
	"received_at",
	"sender_domain",
	"structure_sig",
	"user_id",
}

func TestDonatedSamplesTableHasExactlyTheDisclosedColumns(t *testing.T) {
	pool := pgtest.New(t)
	rows, err := pool.Query(bg, `SELECT column_name FROM information_schema.columns
	                              WHERE table_schema='public' AND table_name='donated_samples'
	                              ORDER BY column_name`)
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
		t.Fatal("donated_samples does not exist")
	}
	if strings.Join(got, ",") != strings.Join(disclosedColumns, ",") {
		t.Fatalf("donated_samples columns drifted from the disclosed set.\n"+
			" in database: %v\n disclosed:   %v\n"+
			"A column here is a promise in the privacy page; update spec §2 in the SAME commit.",
			got, disclosedColumns)
	}
}

// The Go-side twin. A column arrives as a struct field first, so failing here
// puts the objection in front of the person while they are still writing Go.
func TestSampleStructHasExactlyTheDisclosedFields(t *testing.T) {
	fieldToColumn := map[string]string{
		"ID":           "id",
		"UserID":       "user_id",
		"SenderDomain": "sender_domain",
		"StructureSig": "structure_sig",
		"IngestID":     "ingest_id",
		"Raw":          "raw",
		"ReceivedAt":   "received_at",
		"Consent":      "consent",
		"ConsentedAt":  "consented_at",
		"CreatedAt":    "created_at",
		"ExpiresAt":    "expires_at",
	}
	rt := reflect.TypeOf(Sample{})
	seen := map[string]bool{}
	for i := 0; i < rt.NumField(); i++ {
		name := rt.Field(i).Name
		col, ok := fieldToColumn[name]
		if !ok {
			t.Errorf("Sample.%s is not a disclosed field. Adding one is a change to what "+
				"spec §2 tells users a breach yields — see disclosedColumns.", name)
			continue
		}
		seen[col] = true
	}
	for _, col := range disclosedColumns {
		if !seen[col] {
			t.Errorf("no Sample field carries the disclosed column %s", col)
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

// The half that cannot be silenced by editing a Go literal: it fails until the
// document users are shown names the column. Backticked, not a bare substring —
// `raw`, `consent` and `received_at` are all ordinary English that could drift
// into the section at any time, which is the exact false pass Task 23 measured.
func TestEveryDisclosedColumnIsNamedInSpecSection2(t *testing.T) {
	sec := specSection2(t)
	for _, col := range disclosedColumns {
		if col == "id" {
			continue // row identity; a breach of it yields nothing to disclose
		}
		if !strings.Contains(sec, "`"+col+"`") {
			t.Errorf("spec §2 does not name donated_samples.%s as `%s` — §2 is the privacy "+
				"page, so an unnamed column is an undisclosed one", col, col)
		}
	}
	if !strings.Contains(sec, "`donated_samples`") {
		t.Error("spec §2 does not name the `donated_samples` table")
	}
	// The retention window is the other half of the promise. A table holding a
	// user's mail in the clear whose lifetime is not published is a table with
	// no lifetime at all.
	if !strings.Contains(sec, fmt.Sprintf("%d days", int(DefaultRetention/(24*time.Hour)))) {
		t.Errorf("spec §2 does not state the %d-day donated-sample retention window",
			int(DefaultRetention/(24*time.Hour)))
	}
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type harness struct {
	t    *testing.T
	pool *pgxpool.Pool
	s    *Samples
	d    *diag.Diag
	app  *oplog.Appender
	now  time.Time
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	pool := pgtest.New(t)
	// MILLISECONDS, not microseconds. Postgres stores timestamptz at microsecond
	// precision, but a cold record's received_at also round-trips through
	// oplog.EncodeRawBody, which canonicalises to milliseconds so the Go and
	// TypeScript executors cannot disagree about an exact tie. A clock finer
	// than the coarsest hop makes the fixture unrepresentable somewhere in the
	// middle and the test fails on a truncation rather than on behaviour.
	now := time.Now().UTC().Truncate(time.Millisecond)
	return &harness{
		t: t, pool: pool, now: now,
		s:   &Samples{Pool: pool, Now: func() time.Time { return now }},
		d:   &diag.Diag{Pool: pool, Now: func() time.Time { return now }},
		app: &oplog.Appender{Pool: pool},
	}
}

func (h *harness) user(sub string) uuid.UUID {
	h.t.Helper()
	u, err := auth.UpsertUser(bg, h.pool, auth.Identity{IdP: auth.IdPApple, Subject: sub})
	if err != nil {
		h.t.Fatal(err)
	}
	return u
}

func rawMail(body string) []byte {
	return []byte("From: alerts@testbank.test\r\n" +
		"Subject: Transaction Alert\r\n" +
		"Date: Thu, 01 Jan 2026 10:00:00 +0400\r\n" +
		"Content-Type: text/plain; charset=utf-8\r\n" +
		"\r\n" + body + "\r\n")
}

// receive puts a message through the two records a real arrival leaves behind:
// the cold blob that holds the body and the diagnostics row that holds the
// VERIFIED origin. Donation reads both, so a test that planted only one would
// not exercise the path production takes.
func (h *harness) receive(user uuid.UUID, raw []byte, domain string) []byte {
	h.t.Helper()
	return h.receiveAt(user, raw, domain, h.now)
}

func (h *harness) receiveAt(user uuid.UUID, raw []byte, domain string, at time.Time) []byte {
	h.t.Helper()
	sum := sha256.Sum256(raw)
	cold, err := oplog.EncodeRawBody(oplog.RawBody{
		IngestID:   hex.EncodeToString(sum[:]),
		ReceivedAt: at,
		RawBase64:  base64.StdEncoding.EncodeToString(raw),
	})
	if err != nil {
		h.t.Fatal(err)
	}
	if _, err := h.app.AppendIngest(bg, user, []oplog.IngestBlob{
		{Stream: blob.StreamCold, Plaintext: cold, CreatedAt: at},
	}); err != nil {
		h.t.Fatal(err)
	}
	// The diagnostics half carries the layout fingerprint the server computed at
	// arrival, exactly as ingest writes it — that value IS the report path's
	// signature now, so a fixture that left it empty would exercise a shape
	// production never produces.
	h.arrivalWith(user, sum[:], domain, sigOf(h.t, raw, at), at)
	return sum[:]
}

// sigOf is what the server records at arrival: the structure signature of the
// normalized body.
func sigOf(t *testing.T, raw []byte, at time.Time) string {
	t.Helper()
	res, err := norm.Normalize(norm.CurrentVersion, raw, at)
	if err != nil {
		return ""
	}
	return diag.StructureSig(res.Text)
}

// arrival writes only the diagnostics half, for the tests that need an origin
// record with no body behind it.
func (h *harness) arrival(user uuid.UUID, ingestID []byte, domain string, at time.Time) {
	h.t.Helper()
	h.arrivalWith(user, ingestID, domain, diag.StructureSig("You spent AED 0 at A on 0/0/0"), at)
}

func (h *harness) arrivalWith(user uuid.UUID, ingestID []byte, domain, sig string, at time.Time) {
	h.t.Helper()
	if err := h.d.Record(bg, diag.Record{
		UserID:            uuid.NullUUID{UUID: user, Valid: true},
		Event:             diag.EventArrival,
		IngestID:          ingestID,
		ReceivedAt:        at,
		SenderDomain:      domain,
		DKIMResult:        diag.ResultPass,
		ARCResult:         diag.ResultNone,
		NormalizerVersion: 1,
		Tier:              diag.TierNone,
		BodySizeBucket:    1 << 10,
		StructureSig:      sig,
		Outcome:           diag.OutcomeAppended,
	}); err != nil {
		h.t.Fatal(err)
	}
}

func (h *harness) count() int {
	h.t.Helper()
	var n int
	if err := h.pool.QueryRow(bg, `SELECT count(*) FROM donated_samples`).Scan(&n); err != nil {
		h.t.Fatal(err)
	}
	return n
}

// rowsAsText renders every stored row, every column, as one string. It is how
// the content-free claim is checked against what is actually on disk rather
// than against the fields a test remembered to look at.
func (h *harness) rowsAsText() string {
	h.t.Helper()
	rows, err := h.pool.Query(bg, `SELECT donated_samples::text FROM donated_samples`)
	if err != nil {
		h.t.Fatal(err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var s string
		if err := rows.Scan(&s); err != nil {
			h.t.Fatal(err)
		}
		out = append(out, s)
	}
	if err := rows.Err(); err != nil {
		h.t.Fatal(err)
	}
	return strings.Join(out, "\n")
}

// ---------------------------------------------------------------------------
// Consent
// ---------------------------------------------------------------------------

func TestDonateRequiresRecordedConsent(t *testing.T) {
	h := newHarness(t)
	u := h.user("alice")
	id := h.receive(u, rawMail("You spent AED 250.00 at STARBUCKS on 01/01/2026"), "testbank.test")

	err := h.s.Donate(bg, Sample{UserID: u, IngestID: id})
	if !errors.Is(err, ErrNoConsent) {
		t.Fatalf("Donate with no consent = %v, want ErrNoConsent", err)
	}
	if n := h.count(); n != 0 {
		t.Fatalf("a consentless donation stored %d rows", n)
	}
}

// A consent record is an identifier of the text the user was actually shown,
// not free prose. Anything else makes this column the note field every other
// text column in v2 is constrained out of being.
func TestDonateRefusesAConsentStringThatIsNotAnIdentifier(t *testing.T) {
	h := newHarness(t)
	u := h.user("alice")
	id := h.receive(u, rawMail("You spent AED 250.00 at STARBUCKS on 01/01/2026"), "testbank.test")

	for _, bad := range []string{
		"I agree to donate my Starbucks receipt for AED 250.00",
		"Donate Sample V1", // spaces and capitals
		strings.Repeat("x", 65),
	} {
		err := h.s.Donate(bg, Sample{UserID: u, IngestID: id, Consent: bad})
		if !errors.Is(err, ErrNoConsent) {
			t.Errorf("Donate with consent %q = %v, want ErrNoConsent", bad, err)
		}
	}
	if n := h.count(); n != 0 {
		t.Fatalf("a malformed consent stored %d rows", n)
	}
}

// Well-formed is not the same as REAL. The package doc claims the row makes
// "what did they actually agree to" answerable a year later — and that is only
// true if the identifier names a text somebody versioned. Until 2026-08-01 the
// only check was a grammar, so `whatever-v3` was accepted and attested to
// nothing, indistinguishably from a genuine record.
func TestDonateRefusesAConsentIdentifierNoTextIsRegisteredUnder(t *testing.T) {
	h := newHarness(t)
	u := h.user("alice")
	id := h.receive(u, rawMail("You spent AED 250.00 at STARBUCKS on 01/01/2026"), "testbank.test")

	for _, unknown := range []string{
		"donate-sample-v2",     // the next version, before anybody wrote it
		"donate-sample-v1.1",   // a typo away from the real one
		"alpha-plaintext-v1",   // a real consent text, for a different thing
		"terms-and-conditions", // plausible, unversioned, meaningless
	} {
		err := h.s.Donate(bg, Sample{UserID: u, IngestID: id, Consent: unknown})
		if !errors.Is(err, ErrUnknownConsent) {
			t.Errorf("Donate with consent %q = %v, want ErrUnknownConsent", unknown, err)
		}
	}
	if n := h.count(); n != 0 {
		t.Fatalf("%d donations attested to a text nobody has", n)
	}
}

// The registry itself has to be answerable, which means every identifier in it
// names a document a reader can go and find — and §2, the text users are
// actually shown, is where the naming happens.
func TestEveryRegisteredConsentIdentifierIsNamedInSpecSection2(t *testing.T) {
	if len(ConsentTexts) == 0 {
		t.Fatal("no consent text is registered, so no donation can ever be accepted")
	}
	sec := specSection2(t)
	for id, where := range ConsentTexts {
		if !reConsent.MatchString(id) {
			t.Errorf("registered consent identifier %q is not an identifier", id)
		}
		if strings.TrimSpace(where) == "" {
			t.Errorf("consent identifier %q names no document; the row it justifies is "+
				"unanswerable a year from now", id)
		}
		if !strings.Contains(sec, "`"+id+"`") {
			t.Errorf("spec §2 does not name the consent text `%s` — §2 is the privacy page, "+
				"and a consent identifier users' rows attest to must appear in it", id)
		}
	}
}

func TestDonateRecordsWhatWasAgreedAndWhen(t *testing.T) {
	h := newHarness(t)
	u := h.user("alice")
	id := h.receive(u, rawMail("You spent AED 250.00 at STARBUCKS on 01/01/2026"), "testbank.test")

	if err := h.s.Donate(bg, Sample{UserID: u, IngestID: id, Consent: "donate-sample-v1"}); err != nil {
		t.Fatal(err)
	}
	var (
		consent string
		at      time.Time
		expires time.Time
	)
	if err := h.pool.QueryRow(bg,
		`SELECT consent, consented_at, expires_at FROM donated_samples`).
		Scan(&consent, &at, &expires); err != nil {
		t.Fatal(err)
	}
	if consent != "donate-sample-v1" {
		t.Fatalf("consent = %q", consent)
	}
	if !at.Equal(h.now) {
		t.Fatalf("consented_at = %v, want the server's own clock %v", at, h.now)
	}
	if want := h.now.Add(DefaultRetention); !expires.Equal(want) {
		t.Fatalf("expires_at = %v, want %v", expires, want)
	}
}

// ---------------------------------------------------------------------------
// The content-free default path
// ---------------------------------------------------------------------------

func TestReportPathStoresNoRawBody(t *testing.T) {
	h := newHarness(t)
	u := h.user("alice")
	id := h.receive(u, rawMail("You spent AED 250.00 at STARBUCKS on 01/01/2026"), "testbank.test")

	if err := h.s.Report(bg, Sample{UserID: u, IngestID: id}); err != nil {
		t.Fatal(err)
	}
	var (
		raw        []byte
		consent    *string
		ingestID   []byte
		receivedAt *time.Time
	)
	if err := h.pool.QueryRow(bg,
		`SELECT raw, consent, ingest_id, received_at FROM donated_samples`).
		Scan(&raw, &consent, &ingestID, &receivedAt); err != nil {
		t.Fatal(err)
	}
	if raw != nil {
		t.Fatalf("a structural report stored %d bytes of body", len(raw))
	}
	if consent != nil || ingestID != nil || receivedAt != nil {
		t.Fatalf("a structural report stored provenance it has no content to justify: "+
			"consent=%v ingest_id=%v received_at=%v", consent, ingestID, receivedAt)
	}
}

// The whole argument for the default path, checked against the bytes on disk.
//
// Two messages that differ ONLY in amount, merchant and date must produce the
// SAME signature — that is what makes the fingerprint a layout fact rather than
// a content fact — and no fragment of either message may appear anywhere in the
// stored rows.
func TestAStructuralReportCarriesNoFragmentOfTheMessage(t *testing.T) {
	h := newHarness(t)
	a := h.user("alice")
	b := h.user("bob")

	const (
		aliceBody = "You spent AED 250.00 at STARBUCKS DIFC on 01/01/2026"
		bobBody   = "You spent AED 9,912.45 at DR ALIA FERTILITY CLINIC on 12/03/2026"
	)
	sigA := diag.StructureSig(aliceBody)
	sigB := diag.StructureSig(bobBody)
	if sigA != sigB {
		t.Fatalf("two messages of the same layout fingerprinted differently (%s vs %s); "+
			"the signature is tracking content", sigA, sigB)
	}
	// A genuinely different layout must NOT collide, or the signature would
	// cluster everything together and be content-free only by being useless.
	if other := diag.StructureSig("Amount: AED 250.00\nMerchant: STARBUCKS\nDate: 01/01/2026"); other == sigA {
		t.Fatal("a different layout produced the same signature")
	}

	for _, r := range []struct {
		u    uuid.UUID
		body string
	}{{a, aliceBody}, {b, bobBody}} {
		id := h.receive(r.u, rawMail(r.body), "testbank.test")
		if err := h.s.Report(bg, Sample{UserID: r.u, IngestID: id}); err != nil {
			t.Fatal(err)
		}
	}

	stored := h.rowsAsText()
	for _, forbidden := range []string{
		"STARBUCKS", "DIFC", "ALIA", "FERTILITY", "CLINIC",
		"250.00", "9,912.45", "01/01/2026", "12/03/2026",
		"spent", "Transaction", "alerts@testbank.test",
	} {
		if strings.Contains(stored, forbidden) {
			t.Errorf("a structural report stored %q; the row is: %s", forbidden, stored)
		}
	}
	// And the positive half: what IS stored is the digest the SERVER computed for
	// that message at arrival, and the bank it verified.
	wantSig := sigOf(t, rawMail(aliceBody), h.now)
	if wantSig == "" {
		t.Fatal("the fixture message does not normalize; the report path has nothing to store")
	}
	if !strings.Contains(stored, wantSig) || !strings.Contains(stored, "testbank.test") {
		t.Fatalf("the report did not store the recorded signature %s and the sender domain: %s",
			wantSig, stored)
	}
}

// One row per user per format, not one per message. A report per unparsed email
// would make this table a per-user transaction-timing ledger for the sake of a
// count that nothing reads.
func TestRepeatedReportsOfOneFormatStoreOneRow(t *testing.T) {
	h := newHarness(t)
	u := h.user("alice")
	// Five DIFFERENT messages of the same layout — which is what a user actually
	// generates — not one message reported five times.
	for i := 0; i < 5; i++ {
		id := h.receive(u, rawMail(fmt.Sprintf("You spent AED %d.00 at MERCHANT %d on 0%d/01/2026",
			100+i, i, i+1)), "testbank.test")
		if err := h.s.Report(bg, Sample{UserID: u, IngestID: id}); err != nil {
			t.Fatal(err)
		}
	}
	if n := h.count(); n != 1 {
		t.Fatalf("five reports of one format stored %d rows", n)
	}
}

// ---------------------------------------------------------------------------
// The report path's PROVENANCE (spec §2:25)
// ---------------------------------------------------------------------------

// §2 — the text adopted verbatim into the privacy page — says of this table
// that it "takes the sender domain from its own verification record rather than
// from the request", and describes the report row's sender_domain as "the
// cryptographically verified signing domain, never an envelope claim". The
// migration repeats it on the column.
//
// Until 2026-08-01 that was true of Donate and FALSE of Report, which is the
// path §3.5:114 says the client takes BY DEFAULT: it inserted whatever domain
// and signature the session sent. Any account could file ~1,440 rows a day
// under any bank's name, and Clusters — the view that decides which parser gets
// written next — was steerable by its own users.
//
// The request now names one of the caller's OWN messages by ingest id and
// carries nothing else. There is no field for a domain, and one supplied through
// the Go API is refused rather than ignored.
func TestReportTakesItsProvenanceFromTheServersOwnRecord(t *testing.T) {
	h := newHarness(t)
	u := h.user("alice")
	raw := rawMail("You spent AED 250.00 at STARBUCKS on 01/01/2026")
	id := h.receive(u, raw, "testbank.test")

	if err := h.s.Report(bg, Sample{UserID: u, IngestID: id}); err != nil {
		t.Fatal(err)
	}
	var domain, sig string
	if err := h.pool.QueryRow(bg,
		`SELECT sender_domain, structure_sig FROM donated_samples`).Scan(&domain, &sig); err != nil {
		t.Fatal(err)
	}
	if domain != "testbank.test" {
		t.Fatalf("stored sender_domain = %q, want the domain THIS SERVER verified at arrival", domain)
	}
	if want := sigOf(t, raw, h.now); sig != want {
		t.Fatalf("stored structure_sig = %q, want the fingerprint this server recorded (%q)", sig, want)
	}
}

// The other half, and the one that was exploitable: a caller cannot name the
// bank. Not "it is ignored" — refused, so a call site cannot believe it filed a
// report under a domain it chose.
func TestReportRefusesACallerSuppliedOrigin(t *testing.T) {
	h := newHarness(t)
	u := h.user("alice")
	id := h.receive(u, rawMail("You spent AED 250.00 at STARBUCKS on 01/01/2026"), "testbank.test")

	for name, s := range map[string]Sample{
		"a domain":      {UserID: u, IngestID: id, SenderDomain: "dib.ae"},
		"a signature":   {UserID: u, IngestID: id, StructureSig: "0123456789abcdef0123456789abcdef"},
		"both of them":  {UserID: u, IngestID: id, SenderDomain: "dib.ae", StructureSig: "0123456789abcdef0123456789abcdef"},
		"another bank":  {UserID: u, IngestID: id, SenderDomain: "emiratesnbd.com"},
		"an empty host": {UserID: u, IngestID: id, SenderDomain: " "},
	} {
		if err := h.s.Report(bg, s); !errors.Is(err, ErrOriginNotCallerSupplied) {
			t.Errorf("Report with %s = %v, want ErrOriginNotCallerSupplied", name, err)
		}
	}
	if n := h.count(); n != 0 {
		t.Fatalf("%d reports with a caller-supplied origin were stored", n)
	}
}

// The concrete attack the old shape allowed, run end to end: an account that
// has never received a message from a bank cannot put a row under that bank's
// name, however many signatures it invents.
func TestAnAccountCannotFileAReportUnderABankItDoesNotUse(t *testing.T) {
	h := newHarness(t)
	alice := h.user("alice")
	mallory := h.user("mallory")

	// Alice really does bank at testbank.test.
	aliceMail := h.receive(alice, rawMail("You spent AED 250.00 at STARBUCKS on 01/01/2026"), "testbank.test")
	if err := h.s.Report(bg, Sample{UserID: alice, IngestID: aliceMail}); err != nil {
		t.Fatal(err)
	}

	// Mallory has received nothing at all. Every id she can name is either
	// somebody else's or made up, and both answer the same way.
	for name, id := range map[string][]byte{
		"another account's message": aliceMail,
		"an invented digest":        sha256Of("no such message"),
	} {
		if err := h.s.Report(bg, Sample{UserID: mallory, IngestID: id}); !errors.Is(err, ErrNotIngested) {
			t.Errorf("Report of %s = %v, want ErrNotIngested", name, err)
		}
	}

	cl, err := h.s.Clusters(bg)
	if err != nil {
		t.Fatal(err)
	}
	if len(cl) != 1 || cl[0].UserCount != 1 {
		t.Fatalf("clusters = %+v, want exactly Alice's one report: the demand signal the "+
			"operator reads must not include rows for banks nobody uses", cl)
	}
}

func sha256Of(s string) []byte {
	sum := sha256.Sum256([]byte(s))
	return sum[:]
}

// A report is evidence about a bank's format, so it needs the same proof a
// donation does: a domain that was only ever an envelope claim cannot gate a
// template, and storing one would launder an assertion into evidence.
func TestReportRefusesAnUnverifiedOrigin(t *testing.T) {
	h := newHarness(t)
	u := h.user("alice")
	id := sha256Of("an arrival nobody could verify")
	h.arrival(u, id, diag.UnverifiedPrefix+"testbank.test", h.now)

	if err := h.s.Report(bg, Sample{UserID: u, IngestID: id}); !errors.Is(err, ErrUnverifiedOrigin) {
		t.Fatalf("Report of an unverified arrival = %v, want ErrUnverifiedOrigin", err)
	}
	if n := h.count(); n != 0 {
		t.Fatalf("%d unverified reports stored", n)
	}
}

// A message the normalizer could not read has no layout to fingerprint, so
// there is no cluster to file it under. The row would be "this person uses this
// bank" and nothing else, which is a fact about a person rather than about a
// format — and the table's own CHECK refuses it.
func TestReportRefusesAMessageWithNoRecordedLayout(t *testing.T) {
	h := newHarness(t)
	u := h.user("alice")
	id := sha256Of("a message with no text part")
	h.arrivalWith(u, id, "testbank.test", "", h.now)

	if err := h.s.Report(bg, Sample{UserID: u, IngestID: id}); !errors.Is(err, ErrNoRecordedStructure) {
		t.Fatalf("Report of an unnormalizable arrival = %v, want ErrNoRecordedStructure", err)
	}
	if n := h.count(); n != 0 {
		t.Fatalf("%d reports with no layout stored", n)
	}
}

func TestBothPathsRefuseAnIngestIDThatIsNotOne(t *testing.T) {
	h := newHarness(t)
	u := h.user("alice")
	for name, id := range map[string][]byte{
		"absent":    nil,
		"too short": make([]byte, 31),
		"too long":  make([]byte, 33),
	} {
		if err := h.s.Report(bg, Sample{UserID: u, IngestID: id}); !errors.Is(err, ErrInvalidSample) {
			t.Errorf("Report with an ingest id that is %s = %v, want ErrInvalidSample", name, err)
		}
		// The same rule on the donation path, in Go rather than at the HTTP
		// layer: a shorter id would make the diagnostics lookup a PREFIX match on
		// nothing in particular.
		err := h.s.Donate(bg, Sample{UserID: u, IngestID: id, Consent: consentDonateSampleV1})
		if !errors.Is(err, ErrInvalidSample) {
			t.Errorf("Donate with an ingest id that is %s = %v, want ErrInvalidSample", name, err)
		}
	}
}

// A report is the content-free path, and "content-free" is enforced rather than
// documented: a caller holding a body has taken the wrong route, and silently
// dropping the extra field would let it believe it had donated.
func TestReportRefusesAnythingWithContentOrConsentOnIt(t *testing.T) {
	h := newHarness(t)
	u := h.user("alice")
	raw := rawMail("You spent AED 250.00 at STARBUCKS on 01/01/2026")
	id := h.receive(u, raw, "testbank.test")

	for name, s := range map[string]Sample{
		"a body":    {UserID: u, IngestID: id, Raw: raw},
		"a consent": {UserID: u, IngestID: id, Consent: consentDonateSampleV1},
	} {
		if err := h.s.Report(bg, s); !errors.Is(err, ErrInvalidSample) {
			t.Errorf("Report carrying %s = %v, want ErrInvalidSample", name, err)
		}
	}
	if n := h.count(); n != 0 {
		t.Fatalf("%d rows stored", n)
	}
}

// Re-reporting refreshes the EXPIRY and nothing else. created_at is what
// Cluster.FirstSeen reports — "how long have people been hitting this format" —
// and bumping it on every repeat would make a format somebody has hit for
// months look like it appeared this morning.
func TestARepeatedReportRefreshesTheExpiryAndNotTheFirstSighting(t *testing.T) {
	h := newHarness(t)
	u := h.user("alice")
	first := h.receive(u, rawMail("You spent AED 250.00 at STARBUCKS on 01/01/2026"), "testbank.test")
	if err := h.s.Report(bg, Sample{UserID: u, IngestID: first}); err != nil {
		t.Fatal(err)
	}

	later := h.now.Add(30 * 24 * time.Hour)
	h.s.Now = func() time.Time { return later }
	second := h.receiveAt(u, rawMail("You spent AED 12.75 at PARKING METER on 02/02/2026"),
		"testbank.test", later)
	if err := h.s.Report(bg, Sample{UserID: u, IngestID: second}); err != nil {
		t.Fatal(err)
	}

	var created, expires time.Time
	if err := h.pool.QueryRow(bg,
		`SELECT created_at, expires_at FROM donated_samples`).Scan(&created, &expires); err != nil {
		t.Fatal(err)
	}
	if !created.Equal(h.now) {
		t.Fatalf("created_at = %v, want the FIRST sighting %v", created, h.now)
	}
	if want := later.Add(DefaultRetention); !expires.Equal(want) {
		t.Fatalf("expires_at = %v, want it refreshed to %v: a format somebody is still hitting "+
			"is still live demand", expires, want)
	}
}

// The package doc claims a donation "lands in the SAME cluster the user's
// earlier content-free reports of that format did". That is only true if the
// two signatures come out the same, and until the report path derived its
// signature server-side the two came from different executors entirely — the
// client's TypeScript for a report, Go for a donation — with no conformance
// suite between them. Now both are this server's own.
func TestAReportAndADonationOfTheSameFormatShareOneCluster(t *testing.T) {
	h := newHarness(t)
	u := h.user("alice")
	first := h.receive(u, rawMail("You spent AED 250.00 at STARBUCKS on 01/01/2026"), "testbank.test")
	second := h.receive(u, rawMail("You spent AED 12.75 at PARKING METER on 02/01/2026"), "testbank.test")

	if err := h.s.Report(bg, Sample{UserID: u, IngestID: first}); err != nil {
		t.Fatal(err)
	}
	if err := h.s.Donate(bg, Sample{UserID: u, IngestID: second, Consent: consentDonateSampleV1}); err != nil {
		t.Fatal(err)
	}
	cl, err := h.s.Clusters(bg)
	if err != nil {
		t.Fatal(err)
	}
	if len(cl) != 1 {
		t.Fatalf("a report and a donation of one format produced %d clusters: %+v", len(cl), cl)
	}
	if cl[0].SampleCount != 2 || cl[0].DonatedCount != 1 || cl[0].UserCount != 1 {
		t.Fatalf("cluster = %+v, want 2 samples, 1 of them donated, 1 user", cl[0])
	}
}

// ---------------------------------------------------------------------------
// The opt-in, content-bearing path
// ---------------------------------------------------------------------------

func TestDonateOnlyAcceptsAnIngestIDTheUserActuallyReceived(t *testing.T) {
	h := newHarness(t)
	alice := h.user("alice")
	bob := h.user("bob")
	bobsMail := h.receive(bob, rawMail("You spent AED 9,912.45 at DR ALIA FERTILITY CLINIC on 12/03/2026"), "testbank.test")

	err := h.s.Donate(bg, Sample{UserID: alice, IngestID: bobsMail, Consent: "donate-sample-v1"})
	if !errors.Is(err, ErrNotIngested) {
		t.Fatalf("donating another user's message = %v, want ErrNotIngested", err)
	}
	if n := h.count(); n != 0 {
		t.Fatalf("a cross-account donation stored %d rows", n)
	}

	// The assertion above is short-circuited by verifiedOrigin, which runs first
	// and is scoped by the arrival row — so it passes even with the cold-stream
	// read made COMPLETELY user-unscoped (proved by mutation, 2026-08-01). The
	// body read has to be pinned where it happens. It is protected in fact by
	// blob.Envelope binding user_id into the AAD, but that is a property of
	// another package, and a Phase 3 rewrite of coldBody would lose it silently.
	if _, _, err := h.s.coldBody(bg, alice, bobsMail); !errors.Is(err, ErrNotIngested) {
		t.Fatalf("coldBody(alice, bob's message) = %v, want ErrNotIngested: one account's cold "+
			"stream must not be reachable through another's donation", err)
	}
	// And the positive control, so the test above cannot pass by reading nothing.
	if _, _, err := h.s.coldBody(bg, bob, bobsMail); err != nil {
		t.Fatalf("coldBody(bob, bob's own message) = %v, want the body", err)
	}
}

// ---------------------------------------------------------------------------
// Which arrival row decides the origin
// ---------------------------------------------------------------------------

// A DIB alert forwarded through Gmail arrives with sender_domain=gmail.com and,
// when the inner signature validated, inner_origin_domain=dib.ae. The sample
// must be filed under DIB: templates match the bank's domain, so a sample under
// the forwarder's domain gates nothing at all — and Gmail forwarding is the
// primary onboarding path, so this is the common case rather than the exotic
// one. parse_diagnostics refuses an inner_origin_domain unless a signature
// passed, which is what makes a stored value an attestation.
func TestTheOriginIsTheAttestedInnerDomainWhenThereIsOne(t *testing.T) {
	h := newHarness(t)
	u := h.user("alice")
	raw := rawMail("You spent AED 250.00 at STARBUCKS on 01/01/2026")
	sum := sha256.Sum256(raw)

	if err := h.d.Record(bg, diag.Record{
		UserID:            uuid.NullUUID{UUID: u, Valid: true},
		Event:             diag.EventArrival,
		IngestID:          sum[:],
		ReceivedAt:        h.now,
		SenderDomain:      "gmail.com",
		InnerOriginDomain: "dib.ae",
		DKIMResult:        diag.ResultPass,
		ARCResult:         diag.ResultPass,
		NormalizerVersion: 1,
		Tier:              diag.TierNone,
		BodySizeBucket:    1 << 10,
		StructureSig:      sigOf(t, raw, h.now),
		Outcome:           diag.OutcomeAppended,
	}); err != nil {
		t.Fatal(err)
	}
	if err := h.s.Report(bg, Sample{UserID: u, IngestID: sum[:]}); err != nil {
		t.Fatal(err)
	}
	var domain string
	if err := h.pool.QueryRow(bg, `SELECT sender_domain FROM donated_samples`).Scan(&domain); err != nil {
		t.Fatal(err)
	}
	if domain != "dib.ae" {
		t.Fatalf("a forwarded DIB alert was filed under %q; a sample filed under the forwarder "+
			"gates no template at all", domain)
	}
}

// A message can leave more than one arrival row — a redelivery from the backup
// relay, a retry after a transient failure — and they do not all carry the same
// evidence. The row that RECORDED a domain wins over one that recorded none,
// whatever the clock says, and among rows that both recorded one the EARLIEST
// wins: the first arrival is the one whose signature was actually checked
// against the network.
func TestTheOriginComesFromTheEarliestArrivalRowThatRecordedOne(t *testing.T) {
	t.Run("an earlier row beats a later one", func(t *testing.T) {
		h := newHarness(t)
		u := h.user("alice")
		id := sha256Of("delivered twice")
		h.arrival(u, id, "testbank.test", h.now)
		h.arrival(u, id, "elsewhere.test", h.now.Add(time.Second))

		if err := h.s.Report(bg, Sample{UserID: u, IngestID: id}); err != nil {
			t.Fatal(err)
		}
		var domain string
		if err := h.pool.QueryRow(bg, `SELECT sender_domain FROM donated_samples`).Scan(&domain); err != nil {
			t.Fatal(err)
		}
		if domain != "testbank.test" {
			t.Fatalf("origin = %q, want the first arrival's", domain)
		}
	})

	t.Run("a row with no domain never wins a tie", func(t *testing.T) {
		h := newHarness(t)
		u := h.user("alice")
		id := sha256Of("delivered twice at the same instant")
		// Same received_at: the id tiebreak is a random uuid, so a query that
		// depended on it would pick one of these at random and the donation would
		// 409 as unverified_origin roughly half the time.
		h.arrivalWith(u, id, "", diag.StructureSig("You spent AED 0 at A on 0/0/0"), h.now)
		h.arrival(u, id, "testbank.test", h.now)

		if err := h.s.Report(bg, Sample{UserID: u, IngestID: id}); err != nil {
			t.Fatalf("Report over a tie with an empty-domain row = %v", err)
		}
		var domain string
		if err := h.pool.QueryRow(bg, `SELECT sender_domain FROM donated_samples`).Scan(&domain); err != nil {
			t.Fatal(err)
		}
		if domain != "testbank.test" {
			t.Fatalf("origin = %q, want the row that actually recorded a domain", domain)
		}
	})
}

// The other half of the same rule: a caller may not hand this store a body at
// all. It is not a check that can be forgotten at a call site — the store reads
// the bytes out of the user's OWN cold stream and refuses any that arrive with
// the request, which is what makes "a donation can never introduce content the
// user did not receive" a property of the type rather than of a handler.
func TestDonateRefusesACallerSuppliedBody(t *testing.T) {
	h := newHarness(t)
	u := h.user("alice")
	id := h.receive(u, rawMail("You spent AED 250.00 at STARBUCKS on 01/01/2026"), "testbank.test")

	err := h.s.Donate(bg, Sample{
		UserID: u, IngestID: id, Consent: "donate-sample-v1",
		Raw: rawMail("Transfer of AED 1.00 to MULE ACCOUNT on 01/01/2026"),
	})
	if !errors.Is(err, ErrBodySupplied) {
		t.Fatalf("Donate with a supplied body = %v, want ErrBodySupplied", err)
	}
	if n := h.count(); n != 0 {
		t.Fatalf("a supplied body stored %d rows", n)
	}
}

// The sender domain is the server's own verified record, never the caller's
// claim. A caller who could name the domain could plant a sample under any
// bank and block that bank's template publishes for ever.
func TestDonateRefusesACallerSuppliedSenderDomain(t *testing.T) {
	h := newHarness(t)
	u := h.user("alice")
	id := h.receive(u, rawMail("You spent AED 250.00 at STARBUCKS on 01/01/2026"), "testbank.test")

	err := h.s.Donate(bg, Sample{
		UserID: u, IngestID: id, Consent: "donate-sample-v1", SenderDomain: "dib.ae",
	})
	if !errors.Is(err, ErrOriginNotCallerSupplied) {
		t.Fatalf("Donate naming its own domain = %v, want ErrOriginNotCallerSupplied", err)
	}
	if n := h.count(); n != 0 {
		t.Fatalf("a caller-named domain stored %d rows", n)
	}
}

func TestDonateStoresTheBodyAndTheVerifiedOrigin(t *testing.T) {
	h := newHarness(t)
	u := h.user("alice")
	raw := rawMail("You spent AED 250.00 at STARBUCKS on 01/01/2026")
	id := h.receive(u, raw, "alerts.testbank.test")

	if err := h.s.Donate(bg, Sample{UserID: u, IngestID: id, Consent: "donate-sample-v1"}); err != nil {
		t.Fatal(err)
	}
	got, err := h.s.ForSender(bg, "testbank.test")
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 {
		t.Fatalf("ForSender returned %d samples", len(got))
	}
	if string(got[0].Raw) != string(raw) {
		t.Fatal("the stored body is not the message the user received")
	}
	if got[0].SenderDomain != "alerts.testbank.test" {
		t.Fatalf("sender_domain = %q, want the verified signing domain", got[0].SenderDomain)
	}
	if !got[0].ReceivedAt.Equal(h.now) {
		t.Fatalf("received_at = %v, want the cold record's own arrival time", got[0].ReceivedAt)
	}
	// The signature is computed server-side from the donated body, so a donated
	// sample joins the same cluster the user's earlier content-free reports did.
	if got[0].StructureSig == "" {
		t.Fatal("a donated sample carries no structure signature, so it clusters with nothing")
	}
}

// Mail whose origin was never cryptographically proven cannot gate a template:
// templates match the VERIFIED signing domain, and storing an envelope claim
// under the bare hostname would launder an assertion into evidence.
func TestDonateRefusesAnUnverifiedOrigin(t *testing.T) {
	h := newHarness(t)
	u := h.user("alice")
	raw := rawMail("You spent AED 250.00 at STARBUCKS on 01/01/2026")
	id := h.receive(u, raw, diag.UnverifiedPrefix+"testbank.test")

	err := h.s.Donate(bg, Sample{UserID: u, IngestID: id, Consent: "donate-sample-v1"})
	if !errors.Is(err, ErrUnverifiedOrigin) {
		t.Fatalf("donating unverified mail = %v, want ErrUnverifiedOrigin", err)
	}
	if n := h.count(); n != 0 {
		t.Fatalf("unverified mail stored %d rows", n)
	}
}

// A message that arrived but whose body is not in the cold stream (it is held
// in quarantine, or the log was compacted) is not donatable. The refusal is the
// same one a cross-account attempt gets, because from here they are the same
// fact: this user's log does not contain that body.
func TestDonateRefusesAnIngestIDWithNoStoredBody(t *testing.T) {
	h := newHarness(t)
	u := h.user("alice")
	sum := sha256.Sum256(rawMail("held in quarantine"))
	h.arrival(u, sum[:], "testbank.test", h.now)

	err := h.s.Donate(bg, Sample{UserID: u, IngestID: sum[:], Consent: "donate-sample-v1"})
	if !errors.Is(err, ErrNotIngested) {
		t.Fatalf("donating a message with no stored body = %v, want ErrNotIngested", err)
	}
	if n := h.count(); n != 0 {
		t.Fatalf("%d rows stored", n)
	}
}

func TestDonatingTheSameMessageTwiceStoresOneRow(t *testing.T) {
	h := newHarness(t)
	u := h.user("alice")
	id := h.receive(u, rawMail("You spent AED 250.00 at STARBUCKS on 01/01/2026"), "testbank.test")
	for i := 0; i < 3; i++ {
		h.s.Now = func() time.Time { return h.now.Add(time.Duration(i) * time.Hour) }
		if err := h.s.Donate(bg, Sample{UserID: u, IngestID: id, Consent: "donate-sample-v1"}); err != nil {
			t.Fatalf("donation %d: %v", i, err)
		}
	}
	if n := h.count(); n != 1 {
		t.Fatalf("three donations of one message stored %d rows", n)
	}
	// And the row is the FIRST donation's, untouched. A repeat that overwrote
	// consented_at would move the record of when the person agreed, and one that
	// extended expires_at would quietly turn a 180-day promise into an
	// indefinite one for anybody whose client retries.
	var consentedAt, expires time.Time
	if err := h.pool.QueryRow(bg,
		`SELECT consented_at, expires_at FROM donated_samples`).Scan(&consentedAt, &expires); err != nil {
		t.Fatal(err)
	}
	if !consentedAt.Equal(h.now) {
		t.Fatalf("consented_at = %v, want the instant of the FIRST donation %v", consentedAt, h.now)
	}
	if want := h.now.Add(DefaultRetention); !expires.Equal(want) {
		t.Fatalf("expires_at = %v, want %v: a donation's retention window is fixed when it is "+
			"stored and never extended", expires, want)
	}
}

// The pool is warmed first: a cold pgxpool opens connections on demand, and the
// first few goroutines would otherwise be timing connection setup rather than
// the contended insert this test exists to exercise.
func TestConcurrentDonationsOfOneMessageStoreOneRow(t *testing.T) {
	h := newHarness(t)
	u := h.user("alice")
	id := h.receive(u, rawMail("You spent AED 250.00 at STARBUCKS on 01/01/2026"), "testbank.test")

	const n = 8
	warm := make([]*pgxpool.Conn, 0, n)
	for i := 0; i < n; i++ {
		c, err := h.pool.Acquire(bg)
		if err != nil {
			t.Fatal(err)
		}
		warm = append(warm, c)
	}
	for _, c := range warm {
		c.Release()
	}

	var (
		wg   sync.WaitGroup
		mu   sync.Mutex
		errs []error
	)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := h.s.Donate(bg, Sample{UserID: u, IngestID: id, Consent: "donate-sample-v1"}); err != nil {
				mu.Lock()
				errs = append(errs, err)
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	if len(errs) > 0 {
		t.Fatalf("concurrent donations failed: %v", errs)
	}
	if got := h.count(); got != 1 {
		t.Fatalf("%d concurrent donations of one message stored %d rows", n, got)
	}
}

// ---------------------------------------------------------------------------
// Clusters — the operator's demand view
// ---------------------------------------------------------------------------

func TestClustersCountDistinctUsersNotSamples(t *testing.T) {
	h := newHarness(t)
	alice := h.user("alice")
	bob := h.user("bob")

	// Five different messages from alice in ONE layout, one from bob.
	for i := 0; i < 5; i++ {
		id := h.receive(alice, rawMail(fmt.Sprintf("You spent AED %d.00 at STARBUCKS on 0%d/01/2026", 10+i, i+1)), "testbank.test")
		if err := h.s.Donate(bg, Sample{UserID: alice, IngestID: id, Consent: "donate-sample-v1"}); err != nil {
			t.Fatal(err)
		}
	}
	id := h.receive(bob, rawMail("You spent AED 99.00 at CARREFOUR on 09/01/2026"), "testbank.test")
	if err := h.s.Donate(bg, Sample{UserID: bob, IngestID: id, Consent: "donate-sample-v1"}); err != nil {
		t.Fatal(err)
	}

	got, err := h.s.Clusters(bg)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 {
		t.Fatalf("six messages of one layout formed %d clusters: %+v", len(got), got)
	}
	c := got[0]
	if c.UserCount != 2 || c.SampleCount != 6 {
		t.Fatalf("cluster = %d users / %d samples, want 2 and 6", c.UserCount, c.SampleCount)
	}
	if c.DonatedCount != 6 {
		t.Fatalf("cluster reports %d replayable bodies, want 6", c.DonatedCount)
	}
	if c.SenderDomain != "testbank.test" || c.StructureSig == "" {
		t.Fatalf("cluster is not keyed by domain and signature: %+v", c)
	}
	if !c.FirstSeen.Equal(h.now) {
		t.Fatalf("first_seen = %v, want %v", c.FirstSeen, h.now)
	}
}

// §3.5's actual question: which untemplated format do the most people hit. The
// answer must be ordered by PEOPLE, and a content-free report must count.
func TestClustersRankByUserCountAndCountReportsToo(t *testing.T) {
	h := newHarness(t)
	// Two genuinely different layouts, each reported by its own users off their
	// own mail — which is the only way a report can be filed at all now.
	const (
		loudBody  = "Amount: AED 250.00\nMerchant: STARBUCKS\nDate: 01/01/2026"
		quietBody = "You spent AED 250.00 at STARBUCKS on 01/01/2026"
	)
	if sigOf(t, rawMail(loudBody), h.now) == sigOf(t, rawMail(quietBody), h.now) {
		t.Fatal("the two fixture layouts fingerprint the same; the test cannot see two clusters")
	}
	for i := 0; i < 14; i++ {
		u := h.user(fmt.Sprintf("user-%d", i))
		id := h.receive(u, rawMail(loudBody), "fab.ae")
		if err := h.s.Report(bg, Sample{UserID: u, IngestID: id}); err != nil {
			t.Fatal(err)
		}
	}
	for i := 0; i < 3; i++ {
		u := h.user(fmt.Sprintf("other-%d", i))
		id := h.receive(u, rawMail(quietBody), "testbank.test")
		if err := h.s.Report(bg, Sample{UserID: u, IngestID: id}); err != nil {
			t.Fatal(err)
		}
	}

	got, err := h.s.Clusters(bg)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 {
		t.Fatalf("%d clusters, want 2: %+v", len(got), got)
	}
	if got[0].SenderDomain != "fab.ae" || got[0].UserCount != 14 {
		t.Fatalf("the most-hit format is not first: %+v", got)
	}
	if got[0].DonatedCount != 0 {
		t.Fatalf("a cluster built from content-free reports claims %d replayable bodies",
			got[0].DonatedCount)
	}
	if got[1].UserCount != 3 {
		t.Fatalf("second cluster = %+v", got[1])
	}
}

// ---------------------------------------------------------------------------
// ForSender — the corpus the publish gate replays
// ---------------------------------------------------------------------------

func TestForSenderCoversSubdomainsAndNotLookalikes(t *testing.T) {
	h := newHarness(t)
	u := h.user("alice")
	for i, dom := range []string{"testbank.test", "alerts.testbank.test", "eviltestbank.test", "testbank.test.evil.com"} {
		id := h.receive(u, rawMail(fmt.Sprintf("You spent AED %d.00 at STARBUCKS on 01/01/2026", i+1)), dom)
		if err := h.s.Donate(bg, Sample{UserID: u, IngestID: id, Consent: "donate-sample-v1"}); err != nil {
			t.Fatalf("%s: %v", dom, err)
		}
	}
	got, err := h.s.ForSender(bg, "testbank.test")
	if err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	for _, s := range got {
		seen[s.SenderDomain] = true
	}
	if len(seen) != 2 || !seen["testbank.test"] || !seen["alerts.testbank.test"] {
		t.Fatalf("ForSender(testbank.test) covered %v; it must cover the domain and its "+
			"subdomains and nothing else", seen)
	}
}

// The corpus a gate replays is the corpus of BODIES. A content-free report has
// nothing to replay, and counting it as a sample would make a publish report
// claim it validated against mail it never saw.
func TestForSenderReturnsOnlyReplayableSamples(t *testing.T) {
	h := newHarness(t)
	u := h.user("alice")
	id := h.receive(u, rawMail("You spent AED 250.00 at STARBUCKS on 01/01/2026"), "testbank.test")
	if err := h.s.Report(bg, Sample{UserID: u, IngestID: id}); err != nil {
		t.Fatal(err)
	}
	got, err := h.s.ForSender(bg, "testbank.test")
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 0 {
		t.Fatalf("ForSender returned %d rows for a corpus of structure-only reports", len(got))
	}
}

func TestForSenderRefusesADomainThatIsNotOne(t *testing.T) {
	h := newHarness(t)
	for _, bad := range []string{"", "%", "_estbank.test", ".testbank.test", "testbank"} {
		if _, err := h.s.ForSender(bg, bad); !errors.Is(err, ErrInvalidSample) {
			t.Errorf("ForSender(%q) = %v, want ErrInvalidSample", bad, err)
		}
	}
}

// ---------------------------------------------------------------------------
// Retention and retirement
// ---------------------------------------------------------------------------

func TestExpiredSamplesAreDeleted(t *testing.T) {
	h := newHarness(t)
	u := h.user("alice")
	old := h.now.Add(-DefaultRetention - time.Hour)
	id := h.receiveAt(u, rawMail("You spent AED 250.00 at STARBUCKS on 01/01/2026"), "testbank.test", old)

	past := &Samples{Pool: h.pool, Now: func() time.Time { return old }}
	if err := past.Donate(bg, Sample{UserID: u, IngestID: id, Consent: "donate-sample-v1"}); err != nil {
		t.Fatal(err)
	}
	fresh := h.receive(u, rawMail("You spent AED 75.50 at CARREFOUR on 02/01/2026"), "testbank.test")
	if err := h.s.Donate(bg, Sample{UserID: u, IngestID: fresh, Consent: "donate-sample-v1"}); err != nil {
		t.Fatal(err)
	}

	n, err := h.s.ExpireDue(bg)
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("ExpireDue removed %d samples, want 1", n)
	}
	if got := h.count(); got != 1 {
		t.Fatalf("%d samples left, want the one still inside its window", got)
	}
}

// Deleting the account deletes the mail. This is the promise §3.10 rests on and
// the reason the column is a foreign key rather than a bare uuid.
func TestDeletingAUserDeletesTheirDonatedSamples(t *testing.T) {
	h := newHarness(t)
	u := h.user("alice")
	id := h.receive(u, rawMail("You spent AED 250.00 at STARBUCKS on 01/01/2026"), "testbank.test")
	if err := h.s.Donate(bg, Sample{UserID: u, IngestID: id, Consent: "donate-sample-v1"}); err != nil {
		t.Fatal(err)
	}
	if _, err := h.pool.Exec(bg, `DELETE FROM users WHERE id = $1`, u); err != nil {
		t.Fatal(err)
	}
	if n := h.count(); n != 0 {
		t.Fatalf("%d donated samples survived their donor's account", n)
	}
}

// The escape hatch the publish gate's absolute refusal depends on: an operator
// who genuinely means to stop parsing a format retires the sample rather than
// forcing the publish.
func TestRetireRemovesASampleFromTheCorpus(t *testing.T) {
	h := newHarness(t)
	u := h.user("alice")
	id := h.receive(u, rawMail("You spent AED 250.00 at STARBUCKS on 01/01/2026"), "testbank.test")
	if err := h.s.Donate(bg, Sample{UserID: u, IngestID: id, Consent: "donate-sample-v1"}); err != nil {
		t.Fatal(err)
	}
	got, err := h.s.ForSender(bg, "testbank.test")
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 {
		t.Fatalf("%d samples", len(got))
	}
	ok, err := h.s.Retire(bg, got[0].ID)
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("Retire reported no such sample")
	}
	if n := h.count(); n != 0 {
		t.Fatalf("%d rows survived retirement", n)
	}
	if ok, err := h.s.Retire(bg, got[0].ID); err != nil || ok {
		t.Fatalf("retiring a retired sample = %v, %v; want false, nil", ok, err)
	}
}

// ---------------------------------------------------------------------------
// The database is the backstop
// ---------------------------------------------------------------------------

// Every constraint the Go validation enforces is also enforced by the table, so
// a repair script, a psql session or a future caller cannot put content into
// the columns that promise to hold none.
func TestTheDatabaseRefusesFreeTextWhenGoIsBypassed(t *testing.T) {
	h := newHarness(t)
	u := h.user("alice")
	sig := diag.StructureSig("x")

	cases := []struct {
		name string
		sql  string
		args []any
	}{
		{
			"a subject line in sender_domain",
			`INSERT INTO donated_samples (user_id, sender_domain, structure_sig, created_at, expires_at)
			 VALUES ($1, 'Your DIB card was charged AED 250.00', $2, now(), now() + interval '1 day')`,
			[]any{u, sig},
		},
		{
			"a body fragment in structure_sig",
			`INSERT INTO donated_samples (user_id, sender_domain, structure_sig, created_at, expires_at)
			 VALUES ($1, 'testbank.test', 'STARBUCKS DIFC AED 250.00', now(), now() + interval '1 day')`,
			[]any{u},
		},
		{
			"free prose in consent",
			`INSERT INTO donated_samples (user_id, sender_domain, structure_sig, ingest_id, raw,
			                              received_at, consent, consented_at, created_at, expires_at)
			 VALUES ($1, 'testbank.test', $2, $3, 'mail', now(),
			         'I agree to donate my STARBUCKS receipt', now(), now(), now() + interval '1 day')`,
			[]any{u, sig, make([]byte, 32)},
		},
		{
			"a body with no consent behind it",
			`INSERT INTO donated_samples (user_id, sender_domain, structure_sig, ingest_id, raw,
			                              received_at, created_at, expires_at)
			 VALUES ($1, 'testbank.test', $2, $3, 'mail', now(), now(), now() + interval '1 day')`,
			[]any{u, sig, make([]byte, 32)},
		},
		{
			"a row that holds neither a body nor a signature",
			`INSERT INTO donated_samples (user_id, sender_domain, structure_sig, created_at, expires_at)
			 VALUES ($1, 'testbank.test', '', now(), now() + interval '1 day')`,
			[]any{u},
		},
		{
			"an unverified origin",
			`INSERT INTO donated_samples (user_id, sender_domain, structure_sig, created_at, expires_at)
			 VALUES ($1, 'unverified:testbank.test', $2, now(), now() + interval '1 day')`,
			[]any{u, sig},
		},
		{
			"a row with no expiry ahead of it",
			`INSERT INTO donated_samples (user_id, sender_domain, structure_sig, created_at, expires_at)
			 VALUES ($1, 'testbank.test', $2, now(), now() - interval '1 day')`,
			[]any{u, sig},
		},
		{
			"an ingest id that is not a sha-256",
			`INSERT INTO donated_samples (user_id, sender_domain, structure_sig, ingest_id, raw,
			                              received_at, consent, consented_at, created_at, expires_at)
			 VALUES ($1, 'testbank.test', $2, 'short', 'mail', now(),
			         'donate-sample-v1', now(), now(), now() + interval '1 day')`,
			[]any{u, sig},
		},
	}
	for _, c := range cases {
		if _, err := h.pool.Exec(bg, c.sql, c.args...); err == nil {
			t.Errorf("the database accepted %s", c.name)
		}
	}
	if n := h.count(); n != 0 {
		t.Fatalf("%d rows were stored despite every insert being refused", n)
	}
}

// The stored body's ceiling is the cold stream's ceiling. Two copies of one
// number is how a limit drifts, and drifting UP here would mean this table can
// hold a message larger than any message the system can actually receive —
// which is only reachable by something writing to it that is not a donation.
func TestTheSQLBodyCeilingMatchesTheColdMailCeiling(t *testing.T) {
	h := newHarness(t)
	u := h.user("alice")
	ins := `INSERT INTO donated_samples
	  (user_id, sender_domain, structure_sig, ingest_id, raw, received_at,
	   consent, consented_at, created_at, expires_at)
	  VALUES ($1, 'testbank.test', $2, $3, $4, now(), 'donate-sample-v1', now(),
	          now(), now() + interval '1 day')`
	sig := diag.StructureSig("x")

	if _, err := h.pool.Exec(bg, ins, u, sig, make([]byte, 32), make([]byte, blob.MaxColdMail)); err != nil {
		t.Errorf("the table refuses a body of exactly blob.MaxColdMail (%d): %v", blob.MaxColdMail, err)
	}
	id := make([]byte, 32)
	id[0] = 1
	if _, err := h.pool.Exec(bg, ins, u, sig, id, make([]byte, blob.MaxColdMail+1)); err == nil {
		t.Errorf("the table accepted a body larger than blob.MaxColdMail (%d), which is "+
			"larger than any message this system can receive", blob.MaxColdMail)
	}
}
