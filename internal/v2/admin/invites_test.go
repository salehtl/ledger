package admin

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"ledger/internal/v2/diag"
	"ledger/internal/v2/tmpl"
)

// fakeInvites stands in for the cmd/ledgerd adapter. The handlers touch nothing
// else, so the whole surface runs without Postgres; the adapter's own SQL —
// which is where the revoke predicate actually lives — is pinned against a real
// cluster by cmd/ledgerd's TestRevokingAnInviteCode.
type fakeInvites struct {
	rows   []Invite
	code   string
	minted []string // the notes Mint was called with, in order
	err    error
}

func (f *fakeInvites) Mint(_ context.Context, note string, now time.Time) (Minted, error) {
	if f.err != nil {
		return Minted{}, f.err
	}
	f.minted = append(f.minted, note)
	return Minted{Code: f.code, Hash: "aabbccddeeff", CreatedAt: now}, nil
}

func (f *fakeInvites) List(context.Context) ([]Invite, error) {
	if f.err != nil {
		return nil, f.err
	}
	return f.rows, nil
}

func (f *fakeInvites) Revoke(_ context.Context, hashPrefix string) error {
	for _, r := range f.rows {
		if r.Hash != hashPrefix {
			continue
		}
		if r.RedeemedAt != nil {
			return ErrInviteRedeemed
		}
		return nil
	}
	return ErrInviteNotFound
}

func inviteConsole(t *testing.T, inv Invites) http.Handler {
	t.Helper()
	h := &Handler{
		Templates: &tmpl.Store{},
		Diag:      &diag.Diag{},
		Waitlist:  &Waitlist{},
		Invites:   inv,
		Token:     testToken,
		Logf:      func(string, ...any) {},
	}
	mux := http.NewServeMux()
	if err := h.Routes(mux); err != nil {
		t.Fatalf("Routes: %v", err)
	}
	return mux
}

// asOperator is a token-authenticated request with a JSON body, since that is
// how the panel and `curl` both reach these routes.
func asOperator(method, path, body string) *http.Request {
	var r *http.Request
	if body == "" {
		r = httptest.NewRequest(method, path, nil)
	} else {
		r = httptest.NewRequest(method, path, strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
	}
	r.Header.Set("Authorization", "Bearer "+testToken)
	return r
}

// The code comes back exactly once, from the mint, and the operator's note goes
// through to the store.
func TestMintingReturnsTheCodeOnce(t *testing.T) {
	f := &fakeInvites{code: "ABCDEFGHIJKLMNOPQRSTUVWX"}
	h := inviteConsole(t, f)

	rec := do(h, asOperator(http.MethodPost, "/admin/invites", `{"note":"saleh's brother"}`))
	if rec.Code != http.StatusCreated {
		t.Fatalf("mint answered %d, want 201: %s", rec.Code, rec.Body)
	}
	var got map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("mint response is not JSON: %v", err)
	}
	if got["code"] != f.code {
		t.Fatalf("mint returned %v, want the code the store made", got["code"])
	}
	if got["hash"] != "aabbccddeeff" {
		t.Fatalf("mint returned hash %v; the panel needs the row prefix to point at", got["hash"])
	}
	if len(f.minted) != 1 || f.minted[0] != "saleh's brother" {
		t.Fatalf("the note reached the store as %q", f.minted)
	}
}

// A mint with no body at all is a mint with no note, not a 400. A code minted in
// a hurry with no note is better than a code not minted.
func TestMintingWithoutANoteWorks(t *testing.T) {
	f := &fakeInvites{code: "ABCDEFGHIJKLMNOPQRSTUVWX"}
	h := inviteConsole(t, f)
	if rec := do(h, asOperator(http.MethodPost, "/admin/invites", "")); rec.Code != http.StatusCreated {
		t.Fatalf("answered %d, want 201: %s", rec.Code, rec.Body)
	}
	if len(f.minted) != 1 || f.minted[0] != "" {
		t.Fatalf("note reached the store as %q, want empty", f.minted)
	}
}

// THE property of this whole surface: nothing but the mint can produce a code.
//
// It is checked at the response, because that is where a leak would actually
// happen, and the structural half is in invites.go — [Invites] has no method
// that returns one, so there is no plumbing a future handler could reach for.
func TestNoInviteRouteReturnsACodeExceptTheMint(t *testing.T) {
	const code = "ABCDEFGHIJKLMNOPQRSTUVWX"
	redeemed := time.Now().UTC().Add(-time.Hour)
	who := uuid.New()
	f := &fakeInvites{
		code: code,
		rows: []Invite{
			{Hash: "aabbccddeeff", Note: "outstanding one", CreatedAt: time.Now().UTC()},
			{Hash: "112233445566", Note: "spent one", CreatedAt: time.Now().UTC(),
				RedeemedAt: &redeemed, RedeemedBy: &who},
		},
	}
	h := inviteConsole(t, f)

	rec := do(h, asOperator(http.MethodGet, "/admin/invites", ""))
	if rec.Code != http.StatusOK {
		t.Fatalf("list answered %d, want 200", rec.Code)
	}
	body := rec.Body.String()
	if strings.Contains(body, code) {
		t.Fatalf("the listing carried a live code: %s", body)
	}
	if strings.Contains(body, `"code"`) {
		t.Fatalf("the listing has a code field; only its hash is stored: %s", body)
	}
	// It does carry what the operator needs to act: the hash and the note.
	for _, want := range []string{"aabbccddeeff", "outstanding one", "112233445566"} {
		if !strings.Contains(body, want) {
			t.Fatalf("the listing is missing %q: %s", want, body)
		}
	}
}

// Revoking an outstanding code destroys it; revoking a spent one is refused,
// because that row is the only record of where an account came from.
func TestRevokeRefusesARedeemedCode(t *testing.T) {
	redeemed := time.Now().UTC()
	f := &fakeInvites{rows: []Invite{
		{Hash: "aabbccddeeff"},
		{Hash: "112233445566", RedeemedAt: &redeemed},
	}}
	h := inviteConsole(t, f)

	if rec := do(h, asOperator(http.MethodDelete, "/admin/invites/aabbccddeeff", "")); rec.Code != http.StatusNoContent {
		t.Fatalf("revoking an outstanding code answered %d, want 204: %s", rec.Code, rec.Body)
	}
	rec := do(h, asOperator(http.MethodDelete, "/admin/invites/112233445566", ""))
	if rec.Code != http.StatusConflict {
		t.Fatalf("revoking a REDEEMED code answered %d, want 409: deleting it would erase the "+
			"audit trail of an account that still exists", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "already redeemed") {
		t.Fatalf("the refusal does not say why: %s", rec.Body)
	}
}

func TestRevokeRejectsAHashItCannotHaveMinted(t *testing.T) {
	h := inviteConsole(t, &fakeInvites{})
	for path, want := range map[string]int{
		"/admin/invites/not-hex":      http.StatusBadRequest,
		"/admin/invites/abc":          http.StatusBadRequest, // odd length
		"/admin/invites/aabbccddeeff": http.StatusNotFound,
	} {
		if rec := do(h, asOperator(http.MethodDelete, path, "")); rec.Code != want {
			t.Errorf("DELETE %s answered %d, want %d", path, rec.Code, want)
		}
	}
}

// The routes are not mounted when there is no store behind them, matching every
// other optional surface on this console.
func TestTheInviteRoutesAreAbsentWithoutAStore(t *testing.T) {
	h := uiOnly(t) // Invites is nil there
	// It falls to the GUARDED catch-all, so an unauthenticated caller sees the
	// same 401 a real route gives and cannot map what is mounted...
	if rec := get(t, h, "/admin/invites"); rec.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated: %d, want 401", rec.Code)
	}
	// ...and an authenticated one gets a 404 rather than a handler.
	if rec := do(h, asOperator(http.MethodGet, "/admin/invites", "")); rec.Code != http.StatusNotFound {
		t.Fatalf("authenticated: %d, want 404", rec.Code)
	}
}

// The operator log is this console's only audit trail, so a mint has to be in
// it — and the code must not be, or every log file becomes a bag of live
// invitations.
func TestTheMintIsLoggedWithoutTheCode(t *testing.T) {
	const code = "ABCDEFGHIJKLMNOPQRSTUVWX"
	var lines []string
	h := &Handler{
		Templates: &tmpl.Store{},
		Diag:      &diag.Diag{},
		Waitlist:  &Waitlist{},
		Invites:   &fakeInvites{code: code},
		Token:     testToken,
		Logf: func(format string, args ...any) {
			lines = append(lines, fmt.Sprintf(format, args...))
		},
	}
	mux := http.NewServeMux()
	if err := h.Routes(mux); err != nil {
		t.Fatalf("Routes: %v", err)
	}
	if rec := do(mux, asOperator(http.MethodPost, "/admin/invites", `{"note":"a beta tester"}`)); rec.Code != http.StatusCreated {
		t.Fatalf("mint answered %d", rec.Code)
	}
	joined := strings.Join(lines, "\n")
	if strings.Contains(joined, code) {
		t.Fatalf("the operator log carries the live code: %s", joined)
	}
	if !strings.Contains(joined, "MINTED") || !strings.Contains(joined, "a beta tester") {
		t.Fatalf("the mint is not on the record: %s", joined)
	}
}

// The panel has a tab for it, and the tab's view exists. A tab wired to a view
// that does not exist renders as an empty page with no error.
func TestThePanelCarriesTheInviteSurface(t *testing.T) {
	if !strings.Contains(string(uiIndexHTML), `data-view="invites"`) {
		t.Error("index.html has no Invites tab")
	}
	if !strings.Contains(string(uiConsoleJS), "VIEWS.invites") {
		t.Error("console.js has no invites view")
	}
	// The one-time warning is the property the whole surface exists to protect.
	if !strings.Contains(string(uiConsoleJS), "will not be shown again") {
		t.Error("the panel does not tell the operator the code is shown once")
	}
}
