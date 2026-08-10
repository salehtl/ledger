package admin

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/jackc/pgx/v5/pgxpool"
)

func statusOf(t *testing.T, pool *pgxpool.Pool, u uuid.UUID) string {
	t.Helper()
	var s string
	if err := pool.QueryRow(bg, `SELECT status FROM users WHERE id = $1`, u).Scan(&s); err != nil {
		t.Fatalf("read status: %v", err)
	}
	return s
}

// The lever works in both directions, and the resume restores exactly the state
// the suspend took away. The API half — that a suspended account's writes are
// actually refused — is pinned in internal/v2/api; this is the half that says
// the operator can turn it on and off again.
func TestSuspendAndResumeMoveTheAccountStatus(t *testing.T) {
	c := newConsole(t)
	u := insertUser(t, c.pool)

	if got := statusOf(t, c.pool, u); got != "active" {
		t.Fatalf("a new account is %q, want active", got)
	}

	rec := c.do(http.MethodPost, "/admin/accounts/"+u.String()+"/suspend", testToken, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("suspend: %d %s", rec.Code, rec.Body)
	}
	var body struct {
		UserID string `json:"user_id"`
		Status string `json:"status"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode %s: %v", rec.Body, err)
	}
	if body.Status != "suspended" || body.UserID != u.String() {
		t.Fatalf("suspend answered %+v, want the account suspended", body)
	}
	if got := statusOf(t, c.pool, u); got != "suspended" {
		t.Fatalf("status is %q after a suspend, want suspended", got)
	}

	rec = c.do(http.MethodPost, "/admin/accounts/"+u.String()+"/resume", testToken, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("resume: %d %s", rec.Code, rec.Body)
	}
	if got := statusOf(t, c.pool, u); got != "active" {
		t.Fatalf("status is %q after a resume, want active", got)
	}
}

// Suspending twice is a 200, not a conflict. An operator reaching for this at
// 3am must not have to know whether the first click landed, and "press it
// again" must not be the failing path.
func TestSuspendIsIdempotent(t *testing.T) {
	c := newConsole(t)
	u := insertUser(t, c.pool)
	for i := 0; i < 2; i++ {
		if rec := c.do(http.MethodPost, "/admin/accounts/"+u.String()+"/suspend", testToken, nil); rec.Code != http.StatusOK {
			t.Fatalf("suspend %d: %d %s", i, rec.Code, rec.Body)
		}
	}
	if got := statusOf(t, c.pool, u); got != "suspended" {
		t.Fatalf("status is %q, want suspended", got)
	}
	// And resuming an account that was never suspended is equally uneventful.
	other := insertUser(t, c.pool)
	if rec := c.do(http.MethodPost, "/admin/accounts/"+other.String()+"/resume", testToken, nil); rec.Code != http.StatusOK {
		t.Fatalf("resume of an active account: %d %s", rec.Code, rec.Body)
	}
}

// An account that does not exist is a 404, and a malformed id is a 400. The two
// are distinguishable on purpose: this listener is the operator's own, so there
// is nothing to hide, and "you typed a uuid that nobody has" is a different
// problem from "that is not a uuid".
func TestSuspendingSomethingThatIsNotAnAccount(t *testing.T) {
	c := newConsole(t)
	if rec := c.do(http.MethodPost, "/admin/accounts/"+uuid.NewString()+"/suspend", testToken, nil); rec.Code != http.StatusNotFound {
		t.Fatalf("unknown account: %d %s, want 404", rec.Code, rec.Body)
	}
	if rec := c.do(http.MethodPost, "/admin/accounts/not-a-uuid/suspend", testToken, nil); rec.Code != http.StatusBadRequest {
		t.Fatalf("malformed id: %d %s, want 400", rec.Code, rec.Body)
	}
}

// Both levers are behind the operator token, like every other console route.
// The console has no role system — the design says outright that none is
// required — so the token and the tailnet binding ARE the authorization, and a
// route that answered without the token would be the whole of it missing.
func TestTheSuspendLeverIsBehindTheToken(t *testing.T) {
	c := newConsole(t)
	u := insertUser(t, c.pool)
	for _, p := range []string{"/suspend", "/resume"} {
		rec := c.do(http.MethodPost, "/admin/accounts/"+u.String()+p, "", nil)
		if rec.Code != http.StatusUnauthorized {
			t.Errorf("POST %s without a token: %d, want 401", p, rec.Code)
		}
	}
	if got := statusOf(t, c.pool, u); got != "active" {
		t.Fatalf("an unauthenticated call changed the status to %q", got)
	}
}

// The roster carries the status, which is what lets the panel show the state and
// offer the right button without a second request per row.
func TestTheRosterReportsTheAccountStatus(t *testing.T) {
	c := newConsole(t)
	paused := insertUser(t, c.pool)
	fine := insertUser(t, c.pool)
	if rec := c.do(http.MethodPost, "/admin/accounts/"+paused.String()+"/suspend", testToken, nil); rec.Code != http.StatusOK {
		t.Fatalf("suspend: %d %s", rec.Code, rec.Body)
	}

	rec := c.do(http.MethodGet, "/admin/accounts", testToken, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /admin/accounts: %d %s", rec.Code, rec.Body)
	}
	var body struct {
		Accounts []accountRow `json:"accounts"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	seen := map[uuid.UUID]string{}
	for _, a := range body.Accounts {
		seen[a.UserID] = a.Status
	}
	if seen[paused] != "suspended" {
		t.Errorf("the roster reports the paused account as %q", seen[paused])
	}
	if seen[fine] != "active" {
		t.Errorf("the roster reports the active account as %q", seen[fine])
	}
}

// The panel offers both halves of the lever. It is a source check rather than a
// browser one because this console has no bundler and no test runner for its
// JavaScript by design — so the thing worth pinning mechanically is that the
// buttons exist and name the routes that exist (the allowlist in ui_test.go
// pins the second half).
func TestThePanelCarriesTheSuspendControls(t *testing.T) {
	js := string(uiConsoleJS)
	for _, want := range []string{`"/suspend"`, `"/resume"`, `"/admin/accounts/"`} {
		if !strings.Contains(js, want) {
			t.Errorf("console.js does not name %s: the operator has no way to pause an account", want)
		}
	}
	// The roster's own status field, which decides which button is offered.
	if !strings.Contains(js, `a.status === "suspended"`) {
		t.Error("console.js does not read the account status, so it cannot offer the right button")
	}
}
