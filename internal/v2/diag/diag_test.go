package diag

import (
	"context"
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
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"ledger/internal/v2/auth"
	"ledger/internal/v2/blob"
	"ledger/internal/v2/pgtest"
)

func TestMain(m *testing.M) { os.Exit(pgtest.Main(m)) }

var bg = context.Background()

// ---------------------------------------------------------------------------
// The published claim
// ---------------------------------------------------------------------------

// disclosedColumns is the field list spec §2 promises users, restated here
// independently of the migration and of diag.go's INSERT.
//
// IT IS A PUBLISHED CLAIM, NOT AN IMPLEMENTATION DETAIL. §2 is adopted
// verbatim into the user-facing privacy page, so a column that exists in the
// database and not in this list is a false statement to users about what a
// breach of this server yields.
//
// If you are here because you added a column and this test failed: that is the
// entire purpose of the test. Adding the name here is only half the fix — the
// other half is TestEveryDisclosedColumnIsNamedInSpecSection2 below, which
// fails until §2 names it too, in the same commit.
var disclosedColumns = []string{
	"arc_result",
	"body_size_bucket",
	"dkim_result",
	"empty_groups",
	"event",
	"id",
	"ingest_id",
	"inner_origin_domain",
	"matched",
	"normalizer_version",
	"outcome",
	"received_at",
	"reject_reason",
	"sender_domain",
	"structure_sig",
	"template_id",
	"template_version",
	"tier",
	"user_id",
}

func TestDiagnosticsTableHasExactlyTheDisclosedColumns(t *testing.T) {
	pool := pgtest.New(t)
	rows, err := pool.Query(bg, `SELECT column_name FROM information_schema.columns
	                              WHERE table_schema='public' AND table_name='parse_diagnostics'
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
		t.Fatal("parse_diagnostics does not exist")
	}
	if strings.Join(got, ",") != strings.Join(disclosedColumns, ",") {
		t.Fatalf("parse_diagnostics columns drifted from the disclosed set.\n"+
			" in database: %v\n disclosed:   %v\n"+
			"A column here is a promise in the privacy page; update spec §2 in the SAME commit.",
			got, disclosedColumns)
	}
}

// The Go-side twin of the column tripwire. The brief specifies Record as
// "exactly these fields and no others", and a struct field is how a column
// arrives: someone adds a field, then a column to carry it. Failing here first
// puts the objection in front of the person while they are still writing Go.
func TestRecordStructHasExactlyTheDisclosedFields(t *testing.T) {
	fieldToColumn := map[string]string{
		"ID":                "id",
		"UserID":            "user_id",
		"Event":             "event",
		"IngestID":          "ingest_id",
		"ReceivedAt":        "received_at",
		"SenderDomain":      "sender_domain",
		"DKIMResult":        "dkim_result",
		"ARCResult":         "arc_result",
		"InnerOriginDomain": "inner_origin_domain",
		"TemplateID":        "template_id",
		"TemplateVersion":   "template_version",
		"NormalizerVersion": "normalizer_version",
		"Matched":           "matched",
		"EmptyGroups":       "empty_groups",
		"Tier":              "tier",
		"BodySizeBucket":    "body_size_bucket",
		"StructureSig":      "structure_sig",
		"Outcome":           "outcome",
		"RejectReason":      "reject_reason",
	}
	rt := reflect.TypeOf(Record{})
	seen := map[string]bool{}
	for i := 0; i < rt.NumField(); i++ {
		name := rt.Field(i).Name
		col, ok := fieldToColumn[name]
		if !ok {
			t.Errorf("Record.%s is not a disclosed field. Adding one is a change to "+
				"what spec §2 tells users a breach yields — see disclosedColumns.", name)
			continue
		}
		seen[col] = true
	}
	for _, col := range disclosedColumns {
		if !seen[col] {
			t.Errorf("no Record field carries the disclosed column %s", col)
		}
	}
}

// specSection2 returns the text of spec §2, the breach inventory that is
// adopted verbatim into the privacy page.
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

// The second half of the tripwire. The literal list above can be edited to
// silence the first test; this one cannot be silenced without editing the
// document that users are shown.
//
// The match is on a BACKTICKED code span, not a bare substring. A bare
// substring search passes by accident: a column named `subject` "appears" in §2
// because the prose already says "subject to offline guessing", and `event`,
// `matched`, `tier` and `outcome` are all ordinary English words that could
// drift into the section at any time. Requiring `col` in backticks requires a
// deliberate act of naming the field. Measured, not assumed: adding a `subject`
// column and listing it above passed this test until the backticks were
// required, which is the exact false pass this whole pair of tests exists to
// prevent.
func TestEveryDisclosedColumnIsNamedInSpecSection2(t *testing.T) {
	sec := specSection2(t)
	for _, col := range disclosedColumns {
		if col == "id" {
			continue // row identity; a breach of it yields nothing to disclose
		}
		if !strings.Contains(sec, "`"+col+"`") {
			t.Errorf("spec §2 does not name parse_diagnostics.%s as `%s` — §2 is the "+
				"privacy page, so an unnamed column is an undisclosed one", col, col)
		}
	}
	if !strings.Contains(sec, "`smtp_rejections`") {
		t.Error("spec §2 does not name the `smtp_rejections` aggregate table")
	}
}

// §2 stated the padding ladder as 1/4/16/64 KB while blob.Buckets has seven
// rungs (Decision 7). body_size_bucket publishes the ladder into the
// diagnostics table, so an understated ladder in §2 understates the breach.
func TestSpecSection2NamesTheWholeSizeBucketLadder(t *testing.T) {
	sec := specSection2(t)
	for _, b := range blob.Buckets {
		kb := fmt.Sprintf("%d", b/1024)
		if !strings.Contains(sec, kb) {
			t.Errorf("spec §2 does not name the %s KB size bucket", kb)
		}
	}
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

func newDiag(t *testing.T, pool *pgxpool.Pool) (*Diag, *time.Time) {
	t.Helper()
	// Postgres stores timestamptz at microsecond precision; a clock carrying
	// nanoseconds makes window boundaries unrepresentable in the database.
	now := time.Now().UTC().Truncate(time.Microsecond)
	d := &Diag{Pool: pool, Now: func() time.Time { return now }}
	return d, &now
}

func insertUser(t *testing.T, pool *pgxpool.Pool) uuid.UUID {
	t.Helper()
	u, err := auth.UpsertUser(bg, pool, auth.Identity{
		IdP: auth.IdPApple, Subject: "sub-" + uuid.NewString(),
	})
	if err != nil {
		t.Fatal(err)
	}
	return u
}

func ingestID(b byte) []byte {
	id := make([]byte, 32)
	for i := range id {
		id[i] = b
	}
	return id
}

// validRecord is a realistic arrival: DIB mail, forwarded through Gmail, its
// template matched, one capture group empty.
func validRecord(user uuid.UUID, at time.Time) Record {
	return Record{
		UserID:            uuid.NullUUID{UUID: user, Valid: true},
		Event:             EventArrival,
		IngestID:          ingestID(0x11),
		ReceivedAt:        at,
		SenderDomain:      "gmail.com",
		DKIMResult:        ResultPass,
		ARCResult:         ResultPass,
		InnerOriginDomain: "dib.ae",
		TemplateID:        "dib-debit",
		TemplateVersion:   3,
		NormalizerVersion: 1,
		Matched:           true,
		EmptyGroups:       []string{"balance"},
		Tier:              TierTemplate,
		BodySizeBucket:    4096,
		StructureSig:      StructureSig("Amount:\nAED 250.00"),
		Outcome:           OutcomeAppended,
	}
}

// allTextOf renders every column of every parse_diagnostics row as text, which
// is what the no-content assertions search.
func allTextOf(t *testing.T, pool *pgxpool.Pool) string {
	t.Helper()
	cols := make([]string, 0, len(disclosedColumns))
	for _, c := range disclosedColumns {
		cols = append(cols, fmt.Sprintf("coalesce(%s::text,'')", c))
	}
	q := "SELECT " + strings.Join(cols, " || ' ' || ") + " FROM parse_diagnostics"
	rows, err := pool.Query(bg, q)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var s string
		if err := rows.Scan(&s); err != nil {
			t.Fatal(err)
		}
		out = append(out, s)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return strings.Join(out, "\n")
}

// ---------------------------------------------------------------------------
// No content, ever
// ---------------------------------------------------------------------------

func TestRecordStoresNoContent(t *testing.T) {
	pool := pgtest.New(t)
	d, now := newDiag(t, pool)
	user := insertUser(t, pool)

	body := "Dear SALEH,\nAED 250.00 was spent at CARREFOUR MALL OF THE EMIRATES\n" +
		"Card ending 4567\nBalance: AED 12,345.67"
	r := validRecord(user, *now)
	r.StructureSig = StructureSig(body)
	if err := d.Record(bg, r); err != nil {
		t.Fatal(err)
	}

	stored := allTextOf(t, pool)
	if stored == "" {
		t.Fatal("nothing was stored")
	}
	for _, secret := range []string{
		"CARREFOUR", "SALEH", "250.00", "250", "4567", "12,345.67",
		"EMIRATES", "MALL", "Balance", "Dear",
	} {
		if strings.Contains(stored, secret) {
			t.Errorf("stored row contains %q from the message body:\n%s", secret, stored)
		}
	}
}

// Per-field content-safety. Each case is a value a careless caller could
// plausibly pass — a subject line, an amount, a merchant, an error string, an
// exact byte count — and Record must refuse it rather than store it.
func TestEveryFieldThatCouldCarryContentRefusesIt(t *testing.T) {
	pool := pgtest.New(t)
	d, now := newDiag(t, pool)
	user := insertUser(t, pool)

	cases := []struct {
		field  string
		poison string
		mutate func(*Record, string)
	}{
		{"sender_domain", "AED 250.00 spent at CARREFOUR",
			func(r *Record, v string) { r.SenderDomain = v }},
		{"sender_domain/space", "dib ae",
			func(r *Record, v string) { r.SenderDomain = v }},
		{"inner_origin_domain", "Purchase at SPINNEYS",
			func(r *Record, v string) { r.InnerOriginDomain = v }},
		{"template_id", "AED 250.00",
			func(r *Record, v string) { r.TemplateID = v }},
		{"empty_groups/amount", "250.00",
			func(r *Record, v string) { r.EmptyGroups = []string{v} }},
		{"empty_groups/merchant phrase", "CARREFOUR MALL OF THE EMIRATES",
			func(r *Record, v string) { r.EmptyGroups = []string{v} }},
		{"empty_groups/long", strings.Repeat("x", 64),
			func(r *Record, v string) { r.EmptyGroups = []string{v} }},
		{"structure_sig", "Dear SALEH, you spent AED 250.00",
			func(r *Record, v string) { r.StructureSig = v }},
		{"outcome", "failed: could not parse \"AED 250.00\"",
			func(r *Record, v string) { r.Outcome = v }},
		{"event", "arrival of AED 250.00",
			func(r *Record, v string) { r.Event = v }},
		{"tier", "template dib-debit on CARREFOUR",
			func(r *Record, v string) { r.Tier = v }},
		{"dkim_result", "fail: body hash did not verify for CARREFOUR",
			func(r *Record, v string) { r.DKIMResult = v }},
		{"arc_result", "fail: cv=fail at i=2 (spinneys.ae)",
			func(r *Record, v string) { r.ARCResult = v }},
		{"reject_reason", "normalize error: no text part in \"Your CARREFOUR receipt\"",
			func(r *Record, v string) { r.RejectReason = v }},
	}

	for _, tc := range cases {
		t.Run(tc.field, func(t *testing.T) {
			r := validRecord(user, *now)
			tc.mutate(&r, tc.poison)
			err := d.Record(bg, r)
			if err == nil {
				t.Fatalf("%s accepted %q", tc.field, tc.poison)
			}
			if !errors.Is(err, ErrInvalidRecord) {
				t.Errorf("want ErrInvalidRecord, got %v", err)
			}
		})
	}

	if n := countRows(t, pool); n != 0 {
		t.Fatalf("rejected records still wrote %d rows", n)
	}
}

// The exact byte count of a body is a content signal (it tracks the merchant
// name's length and the amount's digit count). Only a rung of the padding
// ladder may be stored.
func TestBodySizeBucketMustBeARungOfTheLadder(t *testing.T) {
	pool := pgtest.New(t)
	d, now := newDiag(t, pool)
	user := insertUser(t, pool)

	for _, bad := range []int{1, 3000, 4095, 4097, 1<<20 + 1, -1} {
		r := validRecord(user, *now)
		r.BodySizeBucket = bad
		if err := d.Record(bg, r); err == nil {
			t.Errorf("stored an exact size %d instead of a bucket", bad)
		}
	}
	for _, good := range append([]int{0}, blob.Buckets...) {
		r := validRecord(user, *now)
		r.IngestID = ingestID(byte(good % 251))
		r.BodySizeBucket = good
		if err := d.Record(bg, r); err != nil {
			t.Errorf("bucket %d rejected: %v", good, err)
		}
	}
}

// The mistake this package exists downstream of: a prior task's error text was
// found capable of carrying a token fragment into the operator log. A
// validation error that echoes the value it rejected turns every refusal into
// the leak the refusal was meant to prevent.
func TestValidationErrorsNameTheFieldButNeverTheValue(t *testing.T) {
	pool := pgtest.New(t)
	d, now := newDiag(t, pool)
	user := insertUser(t, pool)

	poison := "CARREFOUR MALL AED 250.00 card 4567"
	mutations := map[string]func(*Record){
		"sender_domain":       func(r *Record) { r.SenderDomain = poison },
		"inner_origin_domain": func(r *Record) { r.InnerOriginDomain = poison },
		"template_id":         func(r *Record) { r.TemplateID = poison },
		"empty_groups":        func(r *Record) { r.EmptyGroups = []string{poison} },
		"structure_sig":       func(r *Record) { r.StructureSig = poison },
		"outcome":             func(r *Record) { r.Outcome = poison },
		"event":               func(r *Record) { r.Event = poison },
		"tier":                func(r *Record) { r.Tier = poison },
		"dkim_result":         func(r *Record) { r.DKIMResult = poison },
		"arc_result":          func(r *Record) { r.ARCResult = poison },
		"reject_reason":       func(r *Record) { r.RejectReason = poison },
	}
	for field, mutate := range mutations {
		r := validRecord(user, *now)
		mutate(&r)
		err := d.Record(bg, r)
		if err == nil {
			t.Fatalf("%s: no error", field)
		}
		msg := err.Error()
		for _, frag := range []string{"CARREFOUR", "MALL", "250.00", "4567"} {
			if strings.Contains(msg, frag) {
				t.Errorf("%s: error text leaks %q from the rejected value: %s", field, frag, msg)
			}
		}
		if !strings.Contains(msg, field) {
			t.Errorf("%s: error does not name the offending field: %s", field, msg)
		}
	}
}

// Postgres's own constraint violations carry the ENTIRE failing row in
// PgError.Detail ("Failing row contains (...)"). Returning a raw pgx error
// from Record would therefore hand the operator log exactly the content this
// table promises never to hold.
func TestConstraintViolationsDoNotLeakTheFailingRow(t *testing.T) {
	pool := pgtest.New(t)
	d, now := newDiag(t, pool)
	user := insertUser(t, pool)

	// Drop the Go-side guard's SQL twin's partner: make a record Go accepts but
	// the database refuses, by removing the row from users after validation is
	// impossible — instead use a foreign key violation with a live-looking id.
	r := validRecord(user, *now)
	r.UserID = uuid.NullUUID{UUID: uuid.New(), Valid: true} // no such user
	err := d.Record(bg, r)
	if err == nil {
		t.Fatal("a diagnostics row for a nonexistent user was accepted")
	}
	if strings.Contains(err.Error(), "Failing row contains") {
		t.Errorf("error carries the failing row: %v", err)
	}
	for _, frag := range []string{r.StructureSig, "dib.ae", "dib-debit", "balance"} {
		if strings.Contains(err.Error(), frag) {
			t.Errorf("error leaks stored field %q: %v", frag, err)
		}
	}
	// ...and it went down the sanitizing path rather than merely happening not
	// to contain those strings: the constraint that failed is still named, so
	// the error is actionable without being a leak.
	if !strings.Contains(err.Error(), "constraint") {
		t.Errorf("error does not name the failing constraint, so sanitize did not "+
			"recognize it as a database error: %v", err)
	}
}

// A CHECK violation's PgError.Detail is the string "Failing row contains
// (...)" — every column of the row, in plain text.
//
// Measured, not assumed: pgx's Error() method does NOT render Detail, so the
// leak is not in the error's text. It is in the error VALUE, which any caller
// can reach with errors.As and which a structured logger that reflects over
// error fields will happily serialize. So the property that matters is not
// "the message looks clean" but "the PgError is no longer reachable from what
// Record returned" — a message-only assertion would have passed against a
// sanitize that returned the raw error wrapped with %w.
func TestSanitizeStripsTheFailingRowFromACheckViolation(t *testing.T) {
	pool := pgtest.New(t)
	user := insertUser(t, pool)

	_, raw := pool.Exec(bg, `INSERT INTO parse_diagnostics
	  (user_id,event,ingest_id,received_at,sender_domain,dkim_result,arc_result,
	   normalizer_version,matched,tier,body_size_bucket,structure_sig,outcome,empty_groups)
	  VALUES ($1,'arrival',$2,now(),'gmail.com','pass','none',1,false,'none',1024,$3,'quarantined',$4)`,
		user, ingestID(0x66), StructureSig("x"), []string{"CARREFOUR MALL"})
	if raw == nil {
		t.Fatal("the raw insert was supposed to violate a CHECK")
	}
	// Precondition: the row content really is carried in the error value, so
	// this test is not passing because there was nothing to strip.
	var pgErr *pgconn.PgError
	if !errors.As(raw, &pgErr) {
		t.Fatalf("precondition failed: not a PgError: %v", raw)
	}
	if !strings.Contains(pgErr.Detail, "CARREFOUR") {
		t.Fatalf("precondition failed: PgError.Detail does not carry the failing row, "+
			"so this test proves nothing: %q", pgErr.Detail)
	}

	clean := sanitize("record", raw)
	var leaked *pgconn.PgError
	if errors.As(clean, &leaked) {
		t.Errorf("the PgError is still reachable from the sanitized error, so its "+
			"Detail (%q) travels with it", leaked.Detail)
	}
	if strings.Contains(clean.Error(), "CARREFOUR") || strings.Contains(clean.Error(), "Failing row") {
		t.Errorf("sanitize let the failing row through: %v", clean)
	}
	if !strings.Contains(clean.Error(), "parse_diagnostics_empty_groups_are_identifiers") {
		t.Errorf("sanitize dropped the constraint name, leaving an unactionable error: %v", clean)
	}
}

// body_size_bucket's CHECK spells the ladder out as literals because a CHECK
// cannot call into Go. That makes it a second copy of blob.Buckets, and a
// second copy is a thing that drifts.
func TestTheSQLBucketLadderMatchesBlobBuckets(t *testing.T) {
	pool := pgtest.New(t)
	user := insertUser(t, pool)
	ins := `INSERT INTO parse_diagnostics
	  (user_id,event,ingest_id,received_at,sender_domain,dkim_result,arc_result,
	   normalizer_version,matched,tier,body_size_bucket,structure_sig,outcome)
	  VALUES ($1,'arrival',$2,now(),'gmail.com','pass','none',1,false,'none',$3,'','quarantined')`
	for i, b := range blob.Buckets {
		if _, err := pool.Exec(bg, ins, user, ingestID(byte(i)), b); err != nil {
			t.Errorf("the SQL ladder rejects blob.Buckets rung %d: %v", b, err)
		}
	}
	// Anything between two rungs must be refused, or an exact size could ride
	// in as a "bucket".
	for i, b := range blob.Buckets {
		if _, err := pool.Exec(bg, ins, user, ingestID(byte(100+i)), b-1); err == nil {
			t.Errorf("the SQL ladder accepted %d, which is not a rung", b-1)
		}
	}
}

// The Go validation is a guard, not the guarantee. A repair script, a future
// caller, or a bug that bypasses Record must still be unable to put free text
// into this table.
func TestTheDatabaseRefusesFreeTextWhenGoIsBypassed(t *testing.T) {
	pool := pgtest.New(t)
	user := insertUser(t, pool)

	base := `INSERT INTO parse_diagnostics
	  (user_id, event, ingest_id, received_at, sender_domain, dkim_result, arc_result,
	   inner_origin_domain, template_id, template_version, normalizer_version, matched,
	   empty_groups, tier, body_size_bucket, structure_sig, outcome, reject_reason)
	  VALUES ($1,$2,$3,now(),$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`

	type args struct {
		name string
		a    []any
	}
	ok := []any{
		user, "arrival", ingestID(0x22), "gmail.com", "pass", "pass",
		"dib.ae", "dib-debit", 3, 1, true, []string{"balance"}, "template",
		4096, StructureSig("x"), "appended", nil,
	}
	set := func(i int, v any) []any {
		c := append([]any(nil), ok...)
		c[i] = v
		return c
	}
	bad := []args{
		{"event", set(1, "AED 250.00 arrived")},
		{"ingest_id short", set(2, []byte("CARREFOUR"))},
		{"sender_domain", set(3, "Your CARREFOUR receipt")},
		{"dkim_result", set(4, "fail: CARREFOUR")},
		{"arc_result", set(5, "fail: CARREFOUR")},
		{"inner_origin_domain", set(6, "CARREFOUR MALL")},
		{"template_id", set(7, "AED 250.00")},
		{"empty_groups value", set(11, []string{"CARREFOUR MALL"})},
		{"empty_groups amount", set(11, []string{"250.00"})},
		{"tier", set(12, "template on CARREFOUR")},
		{"body_size_bucket exact", set(13, 3071)},
		{"structure_sig free text", set(14, "spent at CARREFOUR")},
		{"outcome", set(15, "failed on CARREFOUR")},
		{"reject_reason", set(16, "no text part in CARREFOUR receipt")},
	}
	for _, b := range bad {
		if _, err := pool.Exec(bg, base, b.a...); err == nil {
			t.Errorf("database accepted free text in %s", b.name)
		}
	}
	if _, err := pool.Exec(bg, base, ok...); err != nil {
		t.Fatalf("the well-formed control row was rejected: %v", err)
	}
}

// inner_origin_domain names WHICH BANK is behind a forwarder. The only
// content-derived source for it is the forwarded body's own From line, which
// norm.Result documents as "CONTENT ONLY, never trust". A row with no passing
// attestation therefore has no legitimate way to know an inner origin, so the
// unattested case is made unstorable rather than merely discouraged.
func TestInnerOriginDomainRequiresAnAttestation(t *testing.T) {
	pool := pgtest.New(t)
	d, now := newDiag(t, pool)
	user := insertUser(t, pool)

	r := validRecord(user, *now)
	r.DKIMResult = ResultNone
	r.ARCResult = ResultNone
	r.InnerOriginDomain = "dib.ae"
	if err := d.Record(bg, r); err == nil {
		t.Fatal("an unattested inner origin was accepted")
	}

	// Either attestation alone is enough.
	for _, att := range []struct{ dkim, arc string }{
		{ResultPass, ResultNone},
		{ResultNone, ResultPass},
	} {
		r := validRecord(user, *now)
		r.IngestID = ingestID(byte(len(att.dkim)))
		r.DKIMResult, r.ARCResult = att.dkim, att.arc
		r.InnerOriginDomain = "dib.ae"
		if err := d.Record(bg, r); err != nil {
			t.Errorf("dkim=%s arc=%s: %v", att.dkim, att.arc, err)
		}
	}

	// And the database enforces it independently of Go.
	_, err := pool.Exec(bg, `INSERT INTO parse_diagnostics
	  (user_id,event,ingest_id,received_at,sender_domain,dkim_result,arc_result,
	   inner_origin_domain,normalizer_version,matched,tier,body_size_bucket,structure_sig,outcome)
	  VALUES ($1,'arrival',$2,now(),'gmail.com','none','none','dib.ae',1,false,'none',1024,$3,'quarantined')`,
		user, ingestID(0x77), StructureSig("x"))
	if err == nil {
		t.Fatal("the database accepted an unattested inner origin")
	}
}

// An unverified sender domain must be visibly marked, because the difference
// between "DKIM says dib.ae signed this" and "the envelope claimed dib.ae" is
// the difference between evidence and an attacker's assertion.
func TestUnverifiedSenderDomainsAreMarkedAndStillBoundedToAHostname(t *testing.T) {
	pool := pgtest.New(t)
	d, now := newDiag(t, pool)
	user := insertUser(t, pool)

	r := validRecord(user, *now)
	r.SenderDomain = "unverified:sketchy.example"
	if err := d.Record(bg, r); err != nil {
		t.Fatalf("a marked unverified domain must be storable: %v", err)
	}
	for _, bad := range []string{
		"unverified:Your CARREFOUR receipt",
		"unverified:",
		"unverified:unverified:dib.ae",
	} {
		r := validRecord(user, *now)
		r.IngestID = ingestID(byte(len(bad)))
		r.SenderDomain = bad
		if err := d.Record(bg, r); err == nil {
			t.Errorf("accepted %q as a sender domain", bad)
		}
	}
}

// Group NAMES are an identifier grammar; a captured VALUE almost never is.
// This is the field whose safety is weakest (a single-token merchant is
// identifier-shaped), so the grammar, the length cap and the count cap all
// have to hold.
func TestEmptyGroupsAreBoundedIdentifierNames(t *testing.T) {
	pool := pgtest.New(t)
	d, now := newDiag(t, pool)
	user := insertUser(t, pool)

	r := validRecord(user, *now)
	r.EmptyGroups = make([]string, 64)
	for i := range r.EmptyGroups {
		r.EmptyGroups[i] = fmt.Sprintf("g%d", i)
	}
	if err := d.Record(bg, r); err == nil {
		t.Error("accepted an unbounded number of group names")
	}

	// Canonical form: deduplicated and sorted, so the ORDER the parser
	// happened to evaluate groups in is not itself a stored signal.
	r = validRecord(user, *now)
	r.EmptyGroups = []string{"merchant", "amount", "merchant", "amount"}
	if err := d.Record(bg, r); err != nil {
		t.Fatal(err)
	}
	var got []string
	if err := pool.QueryRow(bg, `SELECT empty_groups FROM parse_diagnostics`).Scan(&got); err != nil {
		t.Fatal(err)
	}
	if strings.Join(got, ",") != "amount,merchant" {
		t.Errorf("empty_groups = %v, want deduplicated and sorted", got)
	}
}

// ---------------------------------------------------------------------------
// Aggregated protocol-level rejections
// ---------------------------------------------------------------------------

func TestUnknownRcptIsCountedWithoutAUserScopedRow(t *testing.T) {
	pool := pgtest.New(t)
	d, _ := newDiag(t, pool)

	for i := 0; i < 2; i++ {
		if err := d.CountRejection(bg, RejectUnknownRcpt); err != nil {
			t.Fatal(err)
		}
	}
	var n int64
	if err := pool.QueryRow(bg,
		`SELECT count FROM smtp_rejections WHERE reason='unknown_rcpt'`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 2 {
		t.Errorf("smtp_rejections count = %d, want 2", n)
	}
	if got := countRows(t, pool); got != 0 {
		t.Errorf("parse_diagnostics has %d rows; an unknown recipient has no user to scope one to", got)
	}
}

func TestCountRejectionRefusesReasonsOutsideTheClosedEnum(t *testing.T) {
	pool := pgtest.New(t)
	d, _ := newDiag(t, pool)
	for _, bad := range []string{
		"unknown recipient <u-abc@in.sirdab.ae>",
		"550 5.1.1 no such user CARREFOUR",
		"",
	} {
		if err := d.CountRejection(bg, bad); err == nil {
			t.Errorf("CountRejection accepted %q", bad)
		} else if strings.Contains(err.Error(), "CARREFOUR") || strings.Contains(err.Error(), "u-abc") {
			t.Errorf("CountRejection error echoes its argument: %v", err)
		}
	}
}

// The counter is the only defence against a flood from the open :25, so a lost
// increment under concurrency is a lost drop record.
func TestCountRejectionIsAtomicUnderConcurrency(t *testing.T) {
	pool := pgtest.New(t)
	d, _ := newDiag(t, pool)

	// Warm the pool: pgxpool opens connections lazily, so goroutines that all
	// block on the first connect serialize and a read-modify-write bug still
	// passes. Acquire every connection at once first.
	const n = 16
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

	var wg sync.WaitGroup
	errs := make(chan error, n)
	start := make(chan struct{})
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			errs <- d.CountRejection(bg, RejectTooLarge)
		}()
	}
	close(start)
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	var got int64
	if err := pool.QueryRow(bg,
		`SELECT count FROM smtp_rejections WHERE reason='too_large'`).Scan(&got); err != nil {
		t.Fatal(err)
	}
	if got != n {
		t.Errorf("count = %d, want %d — increments were lost", got, n)
	}
}

// The accounting REPORT that reads these counters lives in internal/v2/verify,
// with the structural verifier and the parse-rate instrument, and its tests
// live there too. This package's job is to WRITE the ledger honestly; deciding
// whether the ledger adds up is a separate question with a separate answer, and
// two implementations of that arithmetic would be two places for it to drift.

// ---------------------------------------------------------------------------
// Scoping, purge, and the protocol-layer NULL
// ---------------------------------------------------------------------------

func TestDiagnosticsArePurgedWithTheirUser(t *testing.T) {
	pool := pgtest.New(t)
	d, now := newDiag(t, pool)
	user := insertUser(t, pool)

	if err := d.Record(bg, validRecord(user, *now)); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(bg, `DELETE FROM users WHERE id=$1`, user); err != nil {
		t.Fatal(err)
	}
	if n := countRows(t, pool); n != 0 {
		t.Fatalf("%d diagnostics rows survived the user's deletion", n)
	}
}

// user_id is NULL only for protocol-layer events with no resolved recipient.
// A record that HAS an event needing a user must not quietly become unscoped —
// an unscoped row is a row that survives account deletion.
func TestUserIDIsOnlyNullForProtocolLayerEvents(t *testing.T) {
	pool := pgtest.New(t)
	d, now := newDiag(t, pool)

	r := validRecord(uuid.Nil, *now)
	r.UserID = uuid.NullUUID{} // not valid: no resolved recipient
	r.Outcome = OutcomeRejected
	r.RejectReason = RejectUnknownRcpt
	r.InnerOriginDomain = ""
	r.TemplateID, r.TemplateVersion = "", 0
	r.Matched, r.Tier = false, TierNone
	if err := d.Record(bg, r); err != nil {
		t.Fatalf("a protocol-layer rejection must be recordable without a user: %v", err)
	}

	// An appended op always belongs to somebody; without a user_id it could
	// never be purged and could never be reconciled against that user's log.
	r2 := validRecord(uuid.Nil, *now)
	r2.IngestID = ingestID(0x55)
	r2.UserID = uuid.NullUUID{}
	if err := d.Record(bg, r2); err == nil {
		t.Error("an appended arrival was accepted with no user to scope it to")
	}
}

func TestOutcomeMustBelongToItsEvent(t *testing.T) {
	pool := pgtest.New(t)
	d, now := newDiag(t, pool)
	user := insertUser(t, pool)

	r := validRecord(user, *now)
	r.Event = EventArrival
	r.Outcome = OutcomeSuperseded // a reprocess outcome
	if err := d.Record(bg, r); err == nil {
		t.Error("an arrival accepted a reprocess-only outcome")
	}
	r = validRecord(user, *now)
	r.Event = EventReprocess
	r.Outcome = OutcomeQuarantined // an arrival outcome
	if err := d.Record(bg, r); err == nil {
		t.Error("a reprocess accepted an arrival-only outcome")
	}
}

func TestIngestIDMustBeAFullDigest(t *testing.T) {
	pool := pgtest.New(t)
	d, now := newDiag(t, pool)
	user := insertUser(t, pool)

	for _, bad := range [][]byte{nil, {}, []byte("short"), make([]byte, 31), make([]byte, 33)} {
		r := validRecord(user, *now)
		r.IngestID = bad
		if err := d.Record(bg, r); err == nil {
			t.Errorf("accepted a %d-byte ingest_id", len(bad))
		}
	}
}

func TestRecordRequiresATimestampAndANormalizerVersion(t *testing.T) {
	pool := pgtest.New(t)
	d, now := newDiag(t, pool)
	user := insertUser(t, pool)

	r := validRecord(user, *now)
	r.ReceivedAt = time.Time{}
	if err := d.Record(bg, r); err == nil {
		t.Error("accepted a record with no received_at")
	}
	r = validRecord(user, *now)
	r.NormalizerVersion = -1
	if err := d.Record(bg, r); err == nil {
		t.Error("accepted a negative normalizer_version")
	}
}

// A template version without a template ID is a version of nothing; an ID
// without a version cannot be traced back to the published template that
// produced the diagnostic.
func TestTemplateIDAndVersionAreStoredTogetherOrNotAtAll(t *testing.T) {
	pool := pgtest.New(t)
	d, now := newDiag(t, pool)
	user := insertUser(t, pool)

	r := validRecord(user, *now)
	r.TemplateID, r.TemplateVersion = "", 3
	if err := d.Record(bg, r); err == nil {
		t.Error("accepted a template_version with no template_id")
	}
	r = validRecord(user, *now)
	r.TemplateID, r.TemplateVersion = "dib-debit", 0
	if err := d.Record(bg, r); err == nil {
		t.Error("accepted a template_id with no template_version")
	}
	// Neither: a message that reached no template at all.
	r = validRecord(user, *now)
	r.TemplateID, r.TemplateVersion = "", 0
	r.Matched, r.Tier = false, TierNone
	if err := d.Record(bg, r); err != nil {
		t.Errorf("a record that attempted no template must be storable: %v", err)
	}
}

func TestMatchedAndTierCannotContradictTheTemplateFields(t *testing.T) {
	pool := pgtest.New(t)
	d, now := newDiag(t, pool)
	user := insertUser(t, pool)

	r := validRecord(user, *now)
	r.TemplateID, r.TemplateVersion = "", 0
	r.Matched = true
	if err := d.Record(bg, r); err == nil {
		t.Error("a template that was never attempted was recorded as matched")
	}
	r = validRecord(user, *now)
	r.Tier = TierTemplate
	r.Matched = false
	if err := d.Record(bg, r); err == nil {
		t.Error("tier=template was recorded for a template that did not match")
	}
}

func TestRecordAssignsAnIDWhenTheCallerDoesNot(t *testing.T) {
	pool := pgtest.New(t)
	d, now := newDiag(t, pool)
	user := insertUser(t, pool)

	if err := d.Record(bg, validRecord(user, *now)); err != nil {
		t.Fatal(err)
	}
	var id uuid.UUID
	if err := pool.QueryRow(bg, `SELECT id FROM parse_diagnostics`).Scan(&id); err != nil {
		t.Fatal(err)
	}
	if id == uuid.Nil {
		t.Fatal("no id was assigned")
	}
}

func countRows(t *testing.T, pool *pgxpool.Pool) int {
	t.Helper()
	var n int
	if err := pool.QueryRow(bg, `SELECT count(*) FROM parse_diagnostics`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}
