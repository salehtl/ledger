package admin

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/google/uuid"

	"ledger/internal/v2/diag"
)

func TestTheRosterIsBehindTheToken(t *testing.T) {
	c := newConsole(t)
	if rec := c.do(http.MethodGet, "/admin/accounts", "", nil); rec.Code != http.StatusUnauthorized {
		t.Fatalf("GET /admin/accounts without a token: %d, want 401", rec.Code)
	}
}

// The roster reports the operational state of each account: its address, its
// key publication, whether mail is arriving and how much of it parses.
func TestTheRosterReportsForwardingHealth(t *testing.T) {
	c := newConsole(t)

	quiet := insertUser(t, c.pool)
	active := insertUser(t, c.pool)

	// Only `active` has an address, a published key and mail.
	if _, err := c.pool.Exec(bg,
		`INSERT INTO inbound_addresses (local_part, user_id, created_at)
		 VALUES ('u-aaaaaaaaaaaaaaaaaaaaaaaaaa', $1, now())`, active); err != nil {
		t.Fatalf("insert address: %v", err)
	}
	if _, err := c.pool.Exec(bg,
		`INSERT INTO user_keys
		   (user_id, ingest_pubkey, recovery_pubkey, wrapped_keys, key_version, created_at, updated_at)
		 VALUES ($1, decode(repeat('aa', 32), 'hex'), decode(repeat('cc', 32), 'hex'),
		         decode(repeat('bb', 64), 'hex'), 1, now(), now())`,
		active); err != nil {
		t.Fatalf("insert keys: %v", err)
	}
	for i, r := range []diag.Record{
		diagRow(active, c.now, 0x21, nil),
		diagRow(active, c.now, 0x22, func(r *diag.Record) {
			r.TemplateID, r.TemplateVersion = "", 0
			r.Matched, r.Tier = false, diag.TierNone
		}),
	} {
		if err := c.diag.Record(bg, r); err != nil {
			t.Fatalf("record %d: %v", i, err)
		}
	}

	res := c.do(http.MethodGet, "/admin/accounts", testToken, nil)
	if res.Code != http.StatusOK {
		t.Fatalf("GET /admin/accounts: %d %s", res.Code, res.Body)
	}
	var body struct {
		Accounts []accountRow `json:"accounts"`
	}
	if err := json.Unmarshal(res.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	byID := map[uuid.UUID]accountRow{}
	for _, a := range body.Accounts {
		byID[a.UserID] = a
	}

	got, ok := byID[active]
	if !ok {
		t.Fatal("the account with mail is missing from the roster")
	}
	if got.LocalPart != "u-aaaaaaaaaaaaaaaaaaaaaaaaaa" {
		t.Errorf("active account's address is %q", got.LocalPart)
	}
	if !got.KeysPublished || got.KeyVersion != 1 {
		t.Errorf("active account reads as keys_published=%v version=%d", got.KeysPublished, got.KeyVersion)
	}
	if got.Arrivals != 2 || got.Parsed != 1 {
		t.Errorf("active account: %d arrivals, %d parsed; want 2 and 1", got.Arrivals, got.Parsed)
	}
	if got.LastMailAt == nil {
		t.Error("active account has no last_mail_at, so the panel cannot show forwarding health")
	}

	// The quiet account is the one an operator most has to be able to SEE:
	// signed up, no address, no key, no mail. An inner join anywhere in that
	// query would hide exactly the account that needs help, which is what this
	// half of the test is for.
	q, ok := byID[quiet]
	if !ok {
		t.Fatal("the account with no address is missing from the roster")
	}
	if q.LocalPart != "" || q.KeysPublished || q.Arrivals != 0 || q.LastMailAt != nil {
		t.Errorf("the quiet account reads as active: %+v", q)
	}
}

// The roster is scoped to the request window for its counts, and NOT for the
// structural facts. An arrival older than the window must not be counted, and
// the account must still appear.
func TestTheRosterCountsOnlyTheWindow(t *testing.T) {
	c := newConsole(t)
	u := insertUser(t, c.pool)
	old := diagRow(u, c.now.AddDate(0, 0, -30), 0x31, nil)
	if err := c.diag.Record(bg, old); err != nil {
		t.Fatalf("record: %v", err)
	}

	res := c.do(http.MethodGet, "/admin/accounts", testToken, nil)
	if res.Code != http.StatusOK {
		t.Fatalf("GET /admin/accounts: %d %s", res.Code, res.Body)
	}
	var body struct {
		Accounts []accountRow `json:"accounts"`
	}
	if err := json.Unmarshal(res.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if len(body.Accounts) != 1 {
		t.Fatalf("roster has %d accounts, want 1", len(body.Accounts))
	}
	a := body.Accounts[0]
	if a.Arrivals != 0 {
		t.Errorf("a 30-day-old arrival was counted in the 7-day window: %d", a.Arrivals)
	}
	if a.LastMailAt == nil {
		t.Error("last_mail_at is time-scoped; it must report the most recent arrival ever, " +
			"or an account that went quiet reads the same as one that never received anything")
	}
}
