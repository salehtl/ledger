package admin

import (
	"errors"
	"strings"
	"testing"
	"time"

	"ledger/internal/v2/pgtest"
)

func newWaitlist(t *testing.T) (*Waitlist, *time.Time) {
	t.Helper()
	now := time.Now().UTC().Truncate(time.Microsecond)
	return &Waitlist{Pool: pgtest.New(t), Now: func() time.Time { return now }}, &now
}

// The point of the table: demand accumulates per bank, first_seen is the FIRST
// sighting and never moves, and the console reads it most-wanted first.
func TestRecordAccumulatesDemandAndKeepsTheFirstSighting(t *testing.T) {
	w, now := newWaitlist(t)
	t0 := *now

	for i := 0; i < 3; i++ {
		if err := w.Record(bg, "Mashreq"); err != nil {
			t.Fatalf("Record: %v", err)
		}
		*now = now.Add(time.Hour)
	}
	if err := w.Record(bg, "FAB"); err != nil {
		t.Fatalf("Record: %v", err)
	}

	got, err := w.List(bg)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("List returned %d banks, want 2", len(got))
	}
	if got[0].Bank != "mashreq" || got[0].Demand != 3 {
		t.Fatalf("first entry = %+v, want mashreq/3 (most wanted first)", got[0])
	}
	if !got[0].FirstSeen.Equal(t0) {
		t.Errorf("first_seen moved: %v, want %v", got[0].FirstSeen, t0)
	}
	if !got[0].LastSeen.After(got[0].FirstSeen) {
		t.Errorf("last_seen did not advance")
	}
	if got[1].Bank != "fab" || got[1].Demand != 1 {
		t.Fatalf("second entry = %+v", got[1])
	}
}

// Spelling is not a taxonomy. "Emirates NBD", "  emirates   nbd " and
// "EMIRATES NBD" are one demand signal, not three, or the console's ranking is
// decided by how each user happened to type.
func TestRecordNormalizesSpelling(t *testing.T) {
	w, _ := newWaitlist(t)
	// A newline is whitespace like any other: it is COLLAPSED, not refused. That
	// is the same rule as the tab, and it is written down because it means a
	// two-line paste normalizes to one name rather than erroring — the grammar
	// and the 64-character bound are what actually stop content, not the line
	// structure.
	for _, s := range []string{"Emirates NBD", "  emirates   nbd ", "EMIRATES NBD",
		"Emirates\tNBD", "Emirates\nNBD"} {
		if err := w.Record(bg, s); err != nil {
			t.Fatalf("Record(%q): %v", s, err)
		}
	}
	got, err := w.List(bg)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 {
		t.Fatalf("%d entries for one bank spelled four ways: %+v", len(got), got)
	}
	if got[0].Bank != "emirates nbd" || got[0].Demand != 5 {
		t.Fatalf("entry = %+v", got[0])
	}
}

// The grammar is what stops this column becoming a suggestion box. The refusal
// cases below are the ones that matter: a transaction description, a script
// payload, an unbounded string, and the empty submission a form sends when the
// user skipped the field.
func TestRecordRefusesAnythingThatIsNotABankName(t *testing.T) {
	w, _ := newWaitlist(t)
	bad := []string{
		"",
		"   ",
		"STARBUCKS DUBAI AED 24.00 CARD ****1234",
		"<script>alert(1)</script>",
		"بنك دبي الإسلامي",
		strings.Repeat("a", 65),
		"-leading-punctuation",
		"trailing-",
		"emoji 🏦",
	}
	for _, s := range bad {
		if err := w.Record(bg, s); !errors.Is(err, ErrInvalidBank) {
			t.Errorf("Record(%q) = %v, want ErrInvalidBank", s, err)
		}
	}
	got, err := w.List(bg)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 0 {
		t.Fatalf("a refused submission was stored: %+v", got)
	}

	// And the shapes real bank names take are all accepted.
	for _, s := range []string{"FAB", "Emirates NBD", "Mashreq", "Al Maryah Community Bank",
		"HSBC", "Standard Chartered", "ADCB", "Bank of Baroda", "St. George's Bank", "M&S Bank"} {
		if err := w.Record(bg, s); err != nil {
			t.Errorf("Record(%q): %v", s, err)
		}
	}
}

// The Go grammar and the SQL CHECK are two expressions of one rule, and the
// second exists for the case where the first is bypassed — a repair script, a
// psql session, a future caller that forgets Record. Bypassing Go must not be
// a way in.
func TestTheDatabaseRefusesABankNameGoWouldRefuse(t *testing.T) {
	w, now := newWaitlist(t)
	_, err := w.Pool.Exec(bg,
		`INSERT INTO waitlist (bank, demand, first_seen, last_seen) VALUES ($1,1,$2,$2)`,
		"STARBUCKS DUBAI AED 24.00", *now)
	if err == nil {
		t.Fatal("the database accepted free text as a bank name")
	}
	if !strings.Contains(err.Error(), "waitlist_bank_is_bounded") {
		t.Fatalf("refused by something other than the grammar CHECK: %v", err)
	}
}
