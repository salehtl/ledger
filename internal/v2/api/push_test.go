package api

import (
	"net/http"
	"net/url"
	"strings"
	"testing"

	"github.com/google/uuid"
)

func tokensOf(t *testing.T, h *harness, u uuid.UUID) []string {
	t.Helper()
	rows, err := h.pool.Query(bg,
		`SELECT token FROM push_tokens WHERE user_id = $1 ORDER BY token`, u)
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
	return out
}

// TestTokenRegistrationIsScopedToTheSession is the property the whole endpoint
// exists to have: the user comes from the bearer token and from nowhere else.
// A push token is an opaque string a device hands out; if a request could name
// its own user, anyone holding any session could redirect another account's
// notifications to their own phone — or, by deleting, end them.
func TestTokenRegistrationIsScopedToTheSession(t *testing.T) {
	h := newHarness(t)
	a, b := h.user("a"), h.user("b")
	sa, sb := h.session(a), h.session(b)
	const shared = "ExponentPushToken[shared0000shared0000sh]"

	for _, s := range []string{sa, sb} {
		if rec := h.req(http.MethodPost, "/api/v1/push/tokens", s,
			PushTokenRequest{Token: shared, Platform: "ios"}); rec.Code != http.StatusNoContent {
			t.Fatalf("register: %d %s", rec.Code, rec.Body.String())
		}
	}
	if got := tokensOf(t, h, a); len(got) != 1 {
		t.Fatalf("user a has %v", got)
	}
	if got := tokensOf(t, h, b); len(got) != 1 {
		t.Fatalf("user b has %v", got)
	}

	// A deletes. B's row must survive: the table is keyed by (user_id, token)
	// exactly so that one string is two independent registrations.
	path := "/api/v1/push/tokens/" + url.PathEscape(shared)
	if rec := h.req(http.MethodDelete, path, sa, nil); rec.Code != http.StatusNoContent {
		t.Fatalf("delete: %d %s", rec.Code, rec.Body.String())
	}
	if got := tokensOf(t, h, a); len(got) != 0 {
		t.Fatalf("user a still holds %v after deleting", got)
	}
	if got := tokensOf(t, h, b); len(got) != 1 {
		t.Fatalf("user a's delete removed user b's token: %v", got)
	}
}

func TestPushTokenRoutesNeedASession(t *testing.T) {
	h := newHarness(t)
	if rec := h.req(http.MethodPost, "/api/v1/push/tokens", "",
		PushTokenRequest{Token: "ExponentPushToken[x]", Platform: "ios"}); rec.Code != http.StatusUnauthorized {
		t.Fatalf("POST without a session: %d", rec.Code)
	}
	if rec := h.req(http.MethodDelete, "/api/v1/push/tokens/abc", "", nil); rec.Code != http.StatusUnauthorized {
		t.Fatalf("DELETE without a session: %d", rec.Code)
	}
}

// TestReRegisteringIsANoOp: a client registers on every launch, and Expo
// re-issues the same token for the same install.
func TestReRegisteringIsANoOp(t *testing.T) {
	h := newHarness(t)
	u := h.user("a")
	s := h.session(u)
	body := PushTokenRequest{Token: "ExponentPushToken[repeat00repeat00repeat]", Platform: "ios"}
	for i := 0; i < 3; i++ {
		if rec := h.req(http.MethodPost, "/api/v1/push/tokens", s, body); rec.Code != http.StatusNoContent {
			t.Fatalf("register %d: %d %s", i, rec.Code, rec.Body.String())
		}
	}
	if got := tokensOf(t, h, u); len(got) != 1 {
		t.Fatalf("tokens = %v, want one", got)
	}
}

// TestDeletingAnUnknownTokenSucceeds: a 404 would be an oracle for "is this
// token string registered to me", and a client retrying a delete is normal.
func TestDeletingAnUnknownTokenSucceeds(t *testing.T) {
	h := newHarness(t)
	s := h.session(h.user("a"))
	if rec := h.req(http.MethodDelete, "/api/v1/push/tokens/never-registered", s, nil); rec.Code != http.StatusNoContent {
		t.Fatalf("delete: %d %s", rec.Code, rec.Body.String())
	}
}

// TestAMalformedTokenIsRefusedByTheHandler: the CHECK constraint is the
// guarantee, and this is what turns a violation of it into a 400 the client can
// act on rather than a 500 nobody can.
func TestAMalformedTokenIsRefusedByTheHandler(t *testing.T) {
	h := newHarness(t)
	s := h.session(h.user("a"))
	cases := []struct {
		name string
		req  PushTokenRequest
		code string
	}{
		{"empty", PushTokenRequest{Token: "", Platform: "ios"}, "invalid_token"},
		{"space", PushTokenRequest{Token: "has a space", Platform: "ios"}, "invalid_token"},
		{"newline", PushTokenRequest{Token: "line\nbreak", Platform: "ios"}, "invalid_token"},
		{"too long", PushTokenRequest{Token: strings.Repeat("x", 513), Platform: "ios"}, "invalid_token"},
		{"non-ascii", PushTokenRequest{Token: "tokén", Platform: "ios"}, "invalid_token"},
		{"no platform", PushTokenRequest{Token: "ExponentPushToken[x]", Platform: ""}, "invalid_platform"},
		{"bad platform", PushTokenRequest{Token: "ExponentPushToken[x]", Platform: "windows"}, "invalid_platform"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			rec := h.req(http.MethodPost, "/api/v1/push/tokens", s, c.req)
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("code = %d %s, want 400", rec.Code, rec.Body.String())
			}
			if got := decodeJSON[errorBody](t, rec); got.Error != c.code {
				t.Fatalf("error = %q, want %q", got.Error, c.code)
			}
		})
	}
	if got := tokensOf(t, h, h.user("a")); len(got) != 0 {
		t.Fatalf("a refused registration was stored anyway: %v", got)
	}
}
