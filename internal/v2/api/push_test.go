package api

import (
	"crypto/ed25519"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"ledger/internal/v2/auth"
	"ledger/internal/v2/pushv2"
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

// enrolled returns u's FIRST device writer id, through the real capability
// path. Every push registration now has to name one: a token that names no
// device is a token no revocation can reach, which is the whole defect this
// closes.
func enrolled(t *testing.T, h *harness, u uuid.UUID, id string) string {
	t.Helper()
	h.writer(u, id)
	return id
}

// enrolledSecond adds another device to an account that already has one.
// Enrolment past the first REQUIRES an already-enrolled key to authorize it
// (spec §3.4), so a second phone cannot be planted with a self-signature —
// which is why these tests carry the first device's private key around.
func enrolledSecond(t *testing.T, h *harness, u uuid.UUID, id string, by ed25519.PrivateKey) string {
	t.Helper()
	pub, _, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	nonce, err := h.srv.Writers.Challenge(bg, u)
	if err != nil {
		t.Fatal(err)
	}
	if err := h.srv.Writers.Register(bg, u, id, pub, nonce,
		ed25519.Sign(by, auth.RegistrationMessage(nonce, id, pub))); err != nil {
		t.Fatalf("register second writer %s: %v", id, err)
	}
	return id
}

func register(t *testing.T, h *harness, sess, writerID, token string) *httptest.ResponseRecorder {
	t.Helper()
	return h.req(http.MethodPost, "/api/v1/push/tokens", sess,
		PushTokenRequest{Token: token, Platform: "ios", WriterID: writerID})
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
	wa, wb := enrolled(t, h, a, "phone-a"), enrolled(t, h, b, "phone-b")
	const shared = "ExponentPushToken[shared0000shared0000sh]"

	for _, c := range []struct{ sess, writer string }{{sa, wa}, {sb, wb}} {
		if rec := register(t, h, c.sess, c.writer, shared); rec.Code != http.StatusNoContent {
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
		PushTokenRequest{Token: "ExponentPushToken[x]", Platform: "ios", WriterID: "w"}); rec.Code != http.StatusUnauthorized {
		t.Fatalf("POST without a session: %d", rec.Code)
	}
	if rec := h.req(http.MethodGet, "/api/v1/push/tokens", "", nil); rec.Code != http.StatusUnauthorized {
		t.Fatalf("GET without a session: %d", rec.Code)
	}
	if rec := h.req(http.MethodDelete, "/api/v1/push/tokens", "", nil); rec.Code != http.StatusUnauthorized {
		t.Fatalf("DELETE-all without a session: %d", rec.Code)
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
	w := enrolled(t, h, u, "phone")
	for i := 0; i < 3; i++ {
		if rec := register(t, h, s, w, "ExponentPushToken[repeat00repeat00repeat]"); rec.Code != http.StatusNoContent {
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
	// Including one shaped like the OTHER handle this route accepts: a uuid
	// that is not the caller's must be a 204 too, or the route becomes an
	// existence oracle for row ids.
	if rec := h.req(http.MethodDelete, "/api/v1/push/tokens/"+uuid.NewString(), s, nil); rec.Code != http.StatusNoContent {
		t.Fatalf("delete by unknown id: %d %s", rec.Code, rec.Body.String())
	}
}

// TestAMalformedTokenIsRefusedByTheHandler: the CHECK constraint is the
// guarantee, and this is what turns a violation of it into a 400 the client can
// act on rather than a 500 nobody can.
func TestAMalformedTokenIsRefusedByTheHandler(t *testing.T) {
	h := newHarness(t)
	u := h.user("a")
	s := h.session(u)
	w := enrolled(t, h, u, "phone")
	cases := []struct {
		name string
		req  PushTokenRequest
		code string
	}{
		{"empty", PushTokenRequest{Token: "", Platform: "ios", WriterID: w}, "invalid_token"},
		{"space", PushTokenRequest{Token: "has a space", Platform: "ios", WriterID: w}, "invalid_token"},
		{"newline", PushTokenRequest{Token: "line\nbreak", Platform: "ios", WriterID: w}, "invalid_token"},
		{"too long", PushTokenRequest{Token: strings.Repeat("x", 513), Platform: "ios", WriterID: w}, "invalid_token"},
		{"non-ascii", PushTokenRequest{Token: "tokén", Platform: "ios", WriterID: w}, "invalid_token"},
		{"no platform", PushTokenRequest{Token: "ExponentPushToken[x]", Platform: "", WriterID: w}, "invalid_platform"},
		{"bad platform", PushTokenRequest{Token: "ExponentPushToken[x]", Platform: "windows", WriterID: w}, "invalid_platform"},
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
	if got := tokensOf(t, h, u); len(got) != 0 {
		t.Fatalf("a refused registration was stored anyway: %v", got)
	}
}

// TestATokenMustNameALiveDeviceOfTheCallingUser is the registration half of the
// revocation fix. Every rejected shape here is a row that, if accepted, no
// revocation could ever reach — which is exactly the state that let a stolen
// phone keep receiving transaction notifications forever.
func TestATokenMustNameALiveDeviceOfTheCallingUser(t *testing.T) {
	h := newHarness(t)
	u, other := h.user("a"), h.user("b")
	s := h.session(u)
	mineKey := h.writer(u, "phone")
	mine := "phone"
	theirs := enrolled(t, h, other, "their-phone")
	retired := enrolledSecond(t, h, u, "old-phone", mineKey)
	if _, err := h.pool.Exec(bg,
		`UPDATE writers SET revoked_at = now() WHERE user_id = $1 AND writer_id = $2`, u, retired); err != nil {
		t.Fatal(err)
	}

	cases := []struct {
		name     string
		writerID string
	}{
		{"absent", ""},
		{"unknown", "no-such-device"},
		{"another account's device", theirs},
		{"a revoked device", retired},
		// The ingest writer is the SERVER's, has no key and so has no
		// revocation ceremony. A token pinned to it would be unrevocable by
		// construction — the hole, reintroduced through a client-chosen value.
		{"the server's ingest writer", "ingest"},
		{"oversized", strings.Repeat("w", 65)},
	}
	for i, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			rec := h.req(http.MethodPost, "/api/v1/push/tokens", s, PushTokenRequest{
				Token: fmt.Sprintf("ExponentPushToken[reject%02d]", i), Platform: "ios", WriterID: c.writerID})
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("code = %d %s, want 400", rec.Code, rec.Body.String())
			}
			// One refusal for every shape: "no such writer", "not yours" and
			// "revoked" must be indistinguishable or the error enumerates a
			// roster the caller cannot otherwise see.
			if got := decodeJSON[errorBody](t, rec); got.Error != "invalid_writer" {
				t.Fatalf("error = %q, want invalid_writer", got.Error)
			}
		})
	}
	if got := tokensOf(t, h, u); len(got) != 0 {
		t.Fatalf("an unrevocable registration was stored anyway: %v", got)
	}
	// The positive control, so the test above is not passing because
	// registration is simply broken.
	if rec := register(t, h, s, mine, "ExponentPushToken[accepted0000000000]"); rec.Code != http.StatusNoContent {
		t.Fatalf("a live device was refused: %d %s", rec.Code, rec.Body.String())
	}
}

// TestARegisteredTokenNamesItsDeviceAndSession pins the two links themselves.
// They are what auth.Writers.Revoke and auth.Sessions.Revoke delete by, so a
// row that stores the wrong session or no writer is a row those sweeps miss.
func TestARegisteredTokenNamesItsDeviceAndSession(t *testing.T) {
	h := newHarness(t)
	u := h.user("a")
	s := h.session(u)
	w := enrolled(t, h, u, "phone")
	const token = "ExponentPushToken[linked00linked00linked]"
	if rec := register(t, h, s, w, token); rec.Code != http.StatusNoContent {
		t.Fatalf("register: %d %s", rec.Code, rec.Body.String())
	}
	var (
		writerID string
		matches  bool
	)
	if err := h.pool.QueryRow(bg,
		`SELECT writer_id, session_hash = $2 FROM push_tokens WHERE user_id = $1`,
		u, sessionHashFor(s)).Scan(&writerID, &matches); err != nil {
		t.Fatal(err)
	}
	if writerID != w {
		t.Fatalf("writer_id = %q, want %q", writerID, w)
	}
	if !matches {
		t.Fatal("session_hash does not name the session that registered the token")
	}

	// Re-registering from a NEW session re-links rather than leaving the row
	// pinned to a session the user has already replaced. A stale link is a row
	// the sign-out sweep no longer reaches.
	s2 := h.session(u)
	if rec := register(t, h, s2, w, token); rec.Code != http.StatusNoContent {
		t.Fatalf("re-register: %d %s", rec.Code, rec.Body.String())
	}
	if err := h.pool.QueryRow(bg,
		`SELECT session_hash = $2 FROM push_tokens WHERE user_id = $1`, u, sessionHashFor(s2)).Scan(&matches); err != nil {
		t.Fatal(err)
	}
	if !matches {
		t.Fatal("re-registering left the row pinned to the previous session")
	}
}

// TestTheDeviceListIsWhatMakesDeletionReachable. Without it the delete route
// needed a token string only the device itself knows, so the user of a stolen
// or handed-on phone had no way to stop its notifications at all.
func TestTheDeviceListIsWhatMakesDeletionReachable(t *testing.T) {
	h := newHarness(t)
	u := h.user("a")
	lost, kept := h.session(u), h.session(u)
	lostKey := h.writer(u, "lost-phone")
	wLost := "lost-phone"
	wKept := enrolledSecond(t, h, u, "current-phone", lostKey)
	const lostToken = "ExponentPushToken[lost0000lost0000lost00]"
	const keptToken = "ExponentPushToken[kept0000kept0000kept00]"
	if rec := register(t, h, lost, wLost, lostToken); rec.Code != http.StatusNoContent {
		t.Fatalf("register lost: %d", rec.Code)
	}
	if rec := register(t, h, kept, wKept, keptToken); rec.Code != http.StatusNoContent {
		t.Fatalf("register kept: %d", rec.Code)
	}

	rec := h.req(http.MethodGet, "/api/v1/push/tokens", kept, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("list: %d %s", rec.Code, rec.Body.String())
	}
	got := decodeJSON[PushTokensResponse](t, rec)
	if len(got.Tokens) != 2 {
		t.Fatalf("listed %d devices, want 2: %+v", len(got.Tokens), got.Tokens)
	}
	if got.Max != pushv2.MaxDevicesPerUser {
		t.Fatalf("max = %d, want the fan-out cap %d", got.Max, pushv2.MaxDevicesPerUser)
	}
	// Newest first: the same order the notifier uses, so a client can show the
	// truncation honestly instead of implying every row gets notified.
	if !got.Tokens[0].CreatedAt.After(got.Tokens[1].CreatedAt) &&
		!got.Tokens[0].CreatedAt.Equal(got.Tokens[1].CreatedAt) {
		t.Fatalf("listing is not newest-first: %+v", got.Tokens)
	}

	var current, lostRow *PushTokenInfo
	for i := range got.Tokens {
		info := &got.Tokens[i]
		// A listing that returned whole tokens would hand every device target
		// this user has to anything holding a session, and Expo's send endpoint
		// takes a token as its target.
		if info.TokenPrefix == lostToken || info.TokenPrefix == keptToken {
			t.Fatalf("the listing returned a whole push token: %q", info.TokenPrefix)
		}
		if info.Current {
			current = info
		}
		if info.WriterID == wLost {
			lostRow = info
		}
	}
	if current == nil || current.WriterID != wKept {
		t.Fatalf("the calling session's own device is not flagged current: %+v", got.Tokens)
	}
	if lostRow == nil {
		t.Fatalf("the lost device is not listed: %+v", got.Tokens)
	}

	// And the id from the listing is a usable delete handle — the whole point.
	if rec := h.req(http.MethodDelete, "/api/v1/push/tokens/"+lostRow.ID, kept, nil); rec.Code != http.StatusNoContent {
		t.Fatalf("delete by id: %d %s", rec.Code, rec.Body.String())
	}
	if got := tokensOf(t, h, u); len(got) != 1 || got[0] != keptToken {
		t.Fatalf("after deleting the lost device: %v", got)
	}
}

// TestOneUserCannotDeleteAnothersDeviceByID. The id is the new handle, so it
// gets the same scoping proof the token string already had.
func TestOneUserCannotDeleteAnothersDeviceByID(t *testing.T) {
	h := newHarness(t)
	a, b := h.user("a"), h.user("b")
	sa, sb := h.session(a), h.session(b)
	register(t, h, sa, enrolled(t, h, a, "a-phone"), "ExponentPushToken[aaaa1111aaaa1111aaaa1]")
	register(t, h, sb, enrolled(t, h, b, "b-phone"), "ExponentPushToken[bbbb2222bbbb2222bbbb2]")

	list := decodeJSON[PushTokensResponse](t, h.req(http.MethodGet, "/api/v1/push/tokens", sb, nil))
	if len(list.Tokens) != 1 {
		t.Fatalf("user b listed %d devices", len(list.Tokens))
	}
	if rec := h.req(http.MethodDelete, "/api/v1/push/tokens/"+list.Tokens[0].ID, sa, nil); rec.Code != http.StatusNoContent {
		t.Fatalf("delete: %d", rec.Code)
	}
	if got := tokensOf(t, h, b); len(got) != 1 {
		t.Fatalf("user a deleted user b's device by id: %v", got)
	}
}

// TestDeletingEveryDeviceIsOneCall is the panic button. The recovery a user
// needs is "make it stop", not "work out which of these rows is the stolen
// phone"; every device they still hold re-registers on its next launch.
func TestDeletingEveryDeviceIsOneCall(t *testing.T) {
	h := newHarness(t)
	a, b := h.user("a"), h.user("b")
	sa, sb := h.session(a), h.session(b)
	wa := enrolled(t, h, a, "phone")
	for i := 0; i < 3; i++ {
		register(t, h, sa, wa, fmt.Sprintf("ExponentPushToken[all%02d]", i))
	}
	register(t, h, sb, enrolled(t, h, b, "phone"), "ExponentPushToken[other0000other0000oth]")

	if rec := h.req(http.MethodDelete, "/api/v1/push/tokens", sa, nil); rec.Code != http.StatusNoContent {
		t.Fatalf("delete all: %d %s", rec.Code, rec.Body.String())
	}
	if got := tokensOf(t, h, a); len(got) != 0 {
		t.Fatalf("delete-all left %v", got)
	}
	if got := tokensOf(t, h, b); len(got) != 1 {
		t.Fatalf("one user's delete-all took another user's device: %v", got)
	}
}

// TestRegistrationEnforcesTheDeviceCapKeepingTheNewest is I2's other half.
// Capping only at fan-out let the table grow without limit while the notifier
// took the twenty OLDEST rows — so a long-lived account eventually stopped
// notifying the phone its owner was holding, silently, with registration still
// answering 204.
func TestRegistrationEnforcesTheDeviceCapKeepingTheNewest(t *testing.T) {
	h := newHarness(t)
	u := h.user("a")
	s := h.session(u)
	w := enrolled(t, h, u, "phone")
	// The cap is per user and registration is per token; the limiter would
	// otherwise stop this test before the cap does.
	h.srv.PushPerUser = NewLimiter(0, 1000, 16, time.Now)

	var first, last string
	for i := 0; i <= pushv2.MaxDevicesPerUser; i++ {
		tok := fmt.Sprintf("ExponentPushToken[dev%03d]", i)
		if rec := register(t, h, s, w, tok); rec.Code != http.StatusNoContent {
			t.Fatalf("register %d: %d %s", i, rec.Code, rec.Body.String())
		}
		if i == 0 {
			first = tok
		}
		last = tok
	}
	got := tokensOf(t, h, u)
	if len(got) != pushv2.MaxDevicesPerUser {
		t.Fatalf("stored %d tokens, want the cap of %d", len(got), pushv2.MaxDevicesPerUser)
	}
	var haveFirst, haveLast bool
	for _, g := range got {
		haveFirst = haveFirst || g == first
		haveLast = haveLast || g == last
	}
	if !haveLast {
		t.Fatalf("the newest registration was evicted; the cap dropped the device the user just registered")
	}
	if haveFirst {
		t.Fatalf("the oldest registration survived over a newer one")
	}
}

// TestPushRoutesAreRateLimited. This was the only session-authenticated write
// endpoint in the API with no limiter, which reads as a decision and was not
// one: one session could write unbounded rows, each a permanent notification
// target.
func TestPushRoutesAreRateLimited(t *testing.T) {
	h := newHarness(t)
	u := h.user("a")
	s := h.session(u)
	w := enrolled(t, h, u, "phone")
	h.srv.PushPerUser = NewLimiter(0, 2, 16, time.Now) // no refill, two tokens

	if rec := register(t, h, s, w, "ExponentPushToken[limit000limit000limit]"); rec.Code != http.StatusNoContent {
		t.Fatalf("first register: %d %s", rec.Code, rec.Body.String())
	}
	if rec := h.req(http.MethodDelete, "/api/v1/push/tokens", s, nil); rec.Code != http.StatusNoContent {
		t.Fatalf("delete all: %d", rec.Code)
	}
	// The budget is shared across all three writes, as the address and account
	// budgets are: a caller who can register without limit is not limited by a
	// bounded delete.
	if rec := register(t, h, s, w, "ExponentPushToken[limit111limit111limit]"); rec.Code != http.StatusTooManyRequests {
		t.Fatalf("third push write: %d %s, want 429", rec.Code, rec.Body.String())
	}
	// Reading the list is not on the budget: a user who has just been rate
	// limited must still be able to SEE which devices are notified.
	if rec := h.req(http.MethodGet, "/api/v1/push/tokens", s, nil); rec.Code != http.StatusOK {
		t.Fatalf("list while rate limited: %d", rec.Code)
	}
}

func sessionHashFor(token string) []byte { return auth.SessionHash(token) }
