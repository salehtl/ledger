package diag

import (
	"bytes"
	"testing"
	"time"

	"github.com/google/uuid"

	"ledger/internal/v2/pgtest"
)

// row builds an arrival with the fields this file's tests vary and leaves the
// rest at validRecord's realistic values.
func row(t *testing.T, d *Diag, u uuid.UUID, at time.Time, id byte, mutate func(*Record)) Record {
	t.Helper()
	r := validRecord(u, at)
	r.ID = uuid.New()
	r.IngestID = ingestID(id)
	if mutate != nil {
		mutate(&r)
	}
	if err := d.Record(bg, r); err != nil {
		t.Fatalf("Record: %v", err)
	}
	return r
}

func TestQueryFiltersByWindowUserAndOutcome(t *testing.T) {
	pool := pgtest.New(t)
	d, now := newDiag(t, pool)
	alice, bob := insertUser(t, pool), insertUser(t, pool)
	t0 := *now

	row(t, d, alice, t0.Add(-2*time.Hour), 0x01, nil)                                   // outside the window
	row(t, d, alice, t0, 0x02, nil)                                                     // appended
	row(t, d, alice, t0.Add(time.Minute), 0x03, func(r *Record) { markQuarantined(r) }) // quarantined
	row(t, d, bob, t0.Add(2*time.Minute), 0x04, nil)                                    // bob's

	all, err := d.Query(bg, Filter{From: t0.Add(-time.Minute), To: t0.Add(time.Hour)})
	if err != nil {
		t.Fatalf("Query: %v", err)
	}
	if len(all) != 3 {
		t.Fatalf("window returned %d rows, want 3", len(all))
	}

	mine, err := d.Query(bg, Filter{
		From:   t0.Add(-time.Minute),
		To:     t0.Add(time.Hour),
		UserID: uuid.NullUUID{UUID: alice, Valid: true},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(mine) != 2 {
		t.Fatalf("user filter returned %d rows, want 2", len(mine))
	}
	for _, r := range mine {
		if r.UserID.UUID != alice {
			t.Fatalf("user filter leaked another user's row")
		}
	}

	held, err := d.Query(bg, Filter{
		From: t0.Add(-time.Minute), To: t0.Add(time.Hour), Outcome: OutcomeQuarantined,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(held) != 1 || held[0].Outcome != OutcomeQuarantined {
		t.Fatalf("outcome filter returned %d rows: %+v", len(held), held)
	}
}

// The outcome filter is a CLOSED ENUM, not a string the caller chooses. Every
// text column in this table is a closed set precisely so no caller-authored
// content can reach it; a filter that accepted free text would make the query
// the one path that does — and an operator console is still a place a
// copy-pasted merchant name can end up in a URL.
func TestQueryRefusesAnOutcomeOutsideTheClosedSet(t *testing.T) {
	d, _ := newDiag(t, pgtest.New(t))
	for _, bad := range []string{"appended'; DROP TABLE parse_diagnostics --", "STARBUCKS DUBAI", "APPENDED"} {
		if _, err := d.Query(bg, Filter{Outcome: bad}); err == nil {
			t.Errorf("Query accepted outcome %q", bad)
		}
	}
	// And every legitimate one is accepted.
	for _, ok := range append(append([]string{}, arrivalOutcomes...), reprocessOutcomes...) {
		if _, err := d.Query(bg, Filter{Outcome: ok}); err != nil {
			t.Errorf("Query refused outcome %q: %v", ok, err)
		}
	}
}

// received_at is the arrival instant, and a burst of forwarded mail lands with
// identical timestamps routinely. A cursor on received_at alone either loops
// forever or skips the rest of the tie; the key has to carry the id.
func TestQueryPagesThroughRowsThatShareAReceivedAt(t *testing.T) {
	pool := pgtest.New(t)
	d, now := newDiag(t, pool)
	u := insertUser(t, pool)
	t0 := *now

	const n = 7
	for i := 0; i < n; i++ {
		row(t, d, u, t0, byte(0x20+i), nil) // ALL at the same instant
	}

	seen := map[uuid.UUID]bool{}
	var cur Cursor
	for page := 0; page < n+2; page++ {
		got, err := d.Query(bg, Filter{From: t0.Add(-time.Minute), To: t0.Add(time.Minute), Limit: 2, After: cur})
		if err != nil {
			t.Fatalf("Query: %v", err)
		}
		if len(got) == 0 {
			break
		}
		for _, r := range got {
			if seen[r.ID] {
				t.Fatalf("row %s served twice", r.ID)
			}
			seen[r.ID] = true
		}
		cur = Cursor{ReceivedAt: got[len(got)-1].ReceivedAt, ID: got[len(got)-1].ID}
	}
	if len(seen) != n {
		t.Fatalf("paged over %d of %d rows", len(seen), n)
	}
}

func TestQueryCapsTheLimit(t *testing.T) {
	d, now := newDiag(t, pgtest.New(t))
	if _, err := d.Query(bg, Filter{Limit: -1}); err == nil {
		t.Fatal("Query accepted a negative limit")
	}
	got, err := d.Query(bg, Filter{From: now.Add(-time.Hour), To: *now, Limit: MaxQueryLimit + 1000})
	if err != nil {
		t.Fatalf("an over-large limit must be capped, not refused: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("unexpected rows")
	}
}

// ---------------------------------------------------------------------------
// the reprocess target set
// ---------------------------------------------------------------------------

// A template fix has two kinds of victim: mail the old version parsed (or tried
// and failed on, which is the drift signal), and mail from the same bank that
// no template touched at all. The second is the usual reason a new version
// exists, so a target set that only covered the first would reprocess exactly
// the messages the operator was not worried about.
func TestAffectedCoversTheTemplatesOwnRowsAndUnparsedMailFromItsSenders(t *testing.T) {
	pool := pgtest.New(t)
	d, now := newDiag(t, pool)
	u := insertUser(t, pool)
	t0 := *now

	// (a) parsed by this template
	row(t, d, u, t0, 0x31, func(r *Record) { r.TemplateID = "dib.card"; r.TemplateVersion = 1 })
	// (b) this template was tried and could not fill the message in
	row(t, d, u, t0, 0x32, func(r *Record) {
		r.TemplateID = "dib.card"
		r.TemplateVersion = 1
		r.Matched = false
		r.Tier = TierNone
	})
	// (c) nothing parsed it, and it came from this template's bank
	row(t, d, u, t0, 0x33, func(r *Record) {
		r.TemplateID = ""
		r.TemplateVersion = 0
		r.Matched = false
		r.Tier = TierNone
		r.InnerOriginDomain = ""
		r.SenderDomain = "dib.ae"
	})
	// (d) another bank's unparsed mail — NOT affected
	row(t, d, u, t0, 0x34, func(r *Record) {
		r.TemplateID = ""
		r.TemplateVersion = 0
		r.Matched = false
		r.Tier = TierNone
		r.InnerOriginDomain = ""
		r.SenderDomain = "enbd.com"
	})
	// (e) a different template's successful parse — NOT affected
	row(t, d, u, t0, 0x35, func(r *Record) { r.TemplateID = "enbd.alert"; r.TemplateVersion = 2 })

	got, err := d.Affected(bg, AffectedFilter{
		TemplateID:    "dib.card",
		SenderDomains: []string{"dib.ae"},
		From:          t0.Add(-time.Hour),
		To:            t0.Add(time.Hour),
	})
	if err != nil {
		t.Fatalf("Affected: %v", err)
	}
	want := map[byte]bool{0x31: true, 0x32: true, 0x33: true}
	if len(got) != len(want) {
		t.Fatalf("Affected returned %d rows, want %d: %+v", len(got), len(want), got)
	}
	for _, a := range got {
		if a.UserID != u {
			t.Fatalf("row attributed to %s, want %s", a.UserID, u)
		}
		if !want[a.IngestID[0]] {
			t.Fatalf("unexpected ingest id %x", a.IngestID[0])
		}
	}
}

// Reprocess is keyed by (user, ingest id). A protocol-layer row — an unknown
// RCPT, a message refused before a recipient resolved — has no user, so there
// is no cold stream to re-read and nothing to reprocess. Including it would
// hand Task 30 a nil user id.
func TestAffectedSkipsRowsWithNoUser(t *testing.T) {
	pool := pgtest.New(t)
	d, now := newDiag(t, pool)
	t0 := *now

	// The one row shape the table permits with no user: a protocol-layer refusal
	// that never resolved a recipient.
	r := validRecord(uuid.Nil, t0)
	r.UserID = uuid.NullUUID{}
	r.IngestID = ingestID(0x41)
	r.TemplateID = "dib.card"
	r.TemplateVersion = 1
	r.Outcome = OutcomeRejected
	r.RejectReason = RejectTooLarge
	if err := d.Record(bg, r); err != nil {
		t.Fatalf("Record: %v", err)
	}

	got, err := d.Affected(bg, AffectedFilter{
		TemplateID: "dib.card", From: t0.Add(-time.Hour), To: t0.Add(time.Hour),
	})
	if err != nil {
		t.Fatalf("Affected: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("Affected returned a row with no user: %+v", got)
	}
}

// The same message can produce several diagnostics rows over its life — an
// arrival, then a reprocess. Reprocessing it twice in one run is wasted work at
// best and a second supersede op at worst.
func TestAffectedDeduplicatesByIngestID(t *testing.T) {
	pool := pgtest.New(t)
	d, now := newDiag(t, pool)
	u := insertUser(t, pool)
	t0 := *now

	for i := 0; i < 3; i++ {
		row(t, d, u, t0.Add(time.Duration(i)*time.Minute), 0x51, func(r *Record) {
			r.TemplateID = "dib.card"
			r.TemplateVersion = 1
		})
	}
	got, err := d.Affected(bg, AffectedFilter{
		TemplateID: "dib.card", From: t0.Add(-time.Hour), To: t0.Add(time.Hour),
	})
	if err != nil {
		t.Fatalf("Affected: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("Affected returned %d rows for one ingest id", len(got))
	}
	if !bytes.Equal(got[0].IngestID, ingestID(0x51)) {
		t.Fatalf("wrong ingest id")
	}
}

// The domain expansion the admin console needs: the set of verified signing
// domains that actually appear, which it then filters through
// tmpl.MatchesSenderDomain rather than re-expressing the label-boundary rule in
// SQL.
func TestSenderDomainsAreDistinctAndBounded(t *testing.T) {
	pool := pgtest.New(t)
	d, now := newDiag(t, pool)
	u := insertUser(t, pool)
	t0 := *now

	for i, dom := range []string{"dib.ae", "dib.ae", "alerts.dib.ae", "enbd.com"} {
		row(t, d, u, t0, byte(0x61+i), func(r *Record) {
			r.SenderDomain = dom
			r.InnerOriginDomain = ""
		})
	}
	got, err := d.SenderDomains(bg, t0.Add(-time.Hour), t0.Add(time.Hour))
	if err != nil {
		t.Fatalf("SenderDomains: %v", err)
	}
	want := []string{"alerts.dib.ae", "dib.ae", "enbd.com"}
	if len(got) != len(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("got %v, want %v (sorted)", got, want)
		}
	}
}

func markQuarantined(r *Record) {
	r.Outcome = OutcomeQuarantined
	r.Matched = false
	r.Tier = TierNone
	r.TemplateID = ""
	r.TemplateVersion = 0
}
