package api

// waitlist_test.go covers POST /api/v1/waitlist, which had no test at all: not
// that it is mounted, not that requireSession wraps it, not that it refuses a
// pasted transaction line, and -- the one the whole "aggregate only" claim
// rests on -- not that ON CONFLICT groups per bank.
//
// The grouping fixture uses TWO banks and TWO users on purpose. The nearest
// prior coverage (admin.TestWaitlistRoundTrip) submits one bank twice, and a
// one-bank fixture cannot tell correct per-bank grouping apart from no
// grouping at all: both leave a single row.

import (
	"net/http"
	"testing"

	"ledger/internal/v2/admin"
)

type waitlistRow struct {
	bank   string
	demand int64
}

func (h *harness) waitlistRows(t *testing.T) []waitlistRow {
	t.Helper()
	rows, err := h.pool.Query(bg, `SELECT bank, demand FROM waitlist ORDER BY bank`)
	if err != nil {
		t.Fatalf("read waitlist: %v", err)
	}
	defer rows.Close()
	out := []waitlistRow{}
	for rows.Next() {
		var r waitlistRow
		if err := rows.Scan(&r.bank, &r.demand); err != nil {
			t.Fatalf("scan waitlist: %v", err)
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("read waitlist: %v", err)
	}
	return out
}

func TestWaitlistRequiresASession(t *testing.T) {
	h := newHarness(t)
	rec := h.req(http.MethodPost, "/api/v1/waitlist", "", map[string]any{"bank": "Mashreq"})
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated POST = %d, want 401: %s", rec.Code, rec.Body.String())
	}
	if rec := h.req(http.MethodPost, "/api/v1/waitlist", "not-a-session", map[string]any{"bank": "Mashreq"}); rec.Code != http.StatusUnauthorized {
		t.Fatalf("bogus token POST = %d, want 401", rec.Code)
	}
	if got := h.waitlistRows(t); len(got) != 0 {
		t.Fatalf("an unauthenticated request stored %v", got)
	}
}

// TestWaitlistGroupsPerBankAcrossUsers is the fan-out test: two users, two
// banks, three submissions. Correct grouping is two rows carrying 2 and 1. No
// grouping would be three rows; grouping on the wrong key would be one row
// carrying 3. The assertion distinguishes all three.
func TestWaitlistGroupsPerBankAcrossUsers(t *testing.T) {
	h := newHarness(t)
	alice := h.session(h.user("alice"))
	bob := h.session(h.user("bob"))

	for _, sub := range []struct {
		token string
		bank  string
	}{
		{alice, "Mashreq"},
		{bob, "mashreq"},
		{bob, "ADCB"},
	} {
		if rec := h.req(http.MethodPost, "/api/v1/waitlist", sub.token, map[string]any{"bank": sub.bank}); rec.Code != http.StatusNoContent {
			t.Fatalf("POST %q = %d: %s", sub.bank, rec.Code, rec.Body.String())
		}
	}

	got := h.waitlistRows(t)
	want := []waitlistRow{{bank: "adcb", demand: 1}, {bank: "mashreq", demand: 2}}
	if len(got) != len(want) {
		t.Fatalf("waitlist = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("waitlist = %v, want %v", got, want)
		}
	}
}

// TestWaitlistStoresNoIdentity checks the property structurally rather than by
// looking at one inserted row: there is no column a user id could be written
// to. A row-value assertion would pass on a schema that gained a user column
// tomorrow and a handler that filled it.
func TestWaitlistStoresNoIdentity(t *testing.T) {
	h := newHarness(t)
	if rec := h.req(http.MethodPost, "/api/v1/waitlist", h.session(h.user("alice")), map[string]any{"bank": "Mashreq"}); rec.Code != http.StatusNoContent {
		t.Fatalf("POST = %d: %s", rec.Code, rec.Body.String())
	}
	rows, err := h.pool.Query(bg,
		`SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'waitlist'`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			t.Fatal(err)
		}
		switch name {
		case "bank", "demand", "first_seen", "last_seen":
		default:
			t.Fatalf("waitlist has an unexpected column %q -- if it is attributable, this route must not write it", name)
		}
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
}

// TestWaitlistRefusesAPastedTransactionLine is the regression this route
// shipped with. The public handler used to carry its own copy of the shape
// grammar with admin's amountRe dropped, so this exact string was a 400 on the
// tailnet-only admin route and a stored row here.
func TestWaitlistRefusesAPastedTransactionLine(t *testing.T) {
	h := newHarness(t)
	token := h.session(h.user("alice"))
	rec := h.req(http.MethodPost, "/api/v1/waitlist", token, map[string]any{"bank": "AED 25.00 STARBUCKS"})
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("pasted transaction line = %d, want 400: %s", rec.Code, rec.Body.String())
	}
	if got := h.waitlistRows(t); len(got) != 0 {
		t.Fatalf("a refused submission was stored: %v", got)
	}
}

// TestWaitlistAcceptsExactlyWhatNormalizeBankAccepts walks a table of inputs
// through the HTTP route and compares the outcome against admin.NormalizeBank
// directly, including the STORED form. If the handler ever grows a second copy
// of the rule again, an entry here diverges.
func TestWaitlistAcceptsExactlyWhatNormalizeBankAccepts(t *testing.T) {
	inputs := []string{
		"Mashreq",
		"  MaShReQ   BaNk  ",
		"M&S Bank",
		"St. George's Bank",
		"Al-Rajhi",
		"AED 25.00 STARBUCKS",
		"aed 25.00 starbucks",
		"",
		"   ",
		"Bank\tOf\tBaroda",
		"بنك دبي الإسلامي",
		"a very long bank name that goes on and on and on past the sixty-four character bound",
	}
	h := newHarness(t)
	token := h.session(h.user("alice"))
	for _, raw := range inputs {
		if _, err := h.pool.Exec(bg, "TRUNCATE waitlist"); err != nil {
			t.Fatal(err)
		}
		rec := h.req(http.MethodPost, "/api/v1/waitlist", token, map[string]any{"bank": raw})
		want, err := admin.NormalizeBank(raw)
		if err != nil {
			if rec.Code != http.StatusBadRequest {
				t.Errorf("POST %q = %d, want 400 (NormalizeBank: %v)", raw, rec.Code, err)
			}
			if got := h.waitlistRows(t); len(got) != 0 {
				t.Errorf("POST %q stored %v though NormalizeBank refused it", raw, got)
			}
			continue
		}
		if rec.Code != http.StatusNoContent {
			t.Errorf("POST %q = %d, want 204: %s", raw, rec.Code, rec.Body.String())
			continue
		}
		got := h.waitlistRows(t)
		if len(got) != 1 || got[0].bank != want {
			t.Errorf("POST %q stored %v, want the single row %q", raw, got, want)
		}
	}
}
