package api

// keywraps_test.go covers GET/POST/DELETE /api/v1/keys/wraps — the per-credential
// PRF wraps that let a passkey unlock the account keys instead of the recovery
// phrase.
//
// The properties with teeth are not "it round-trips". They are: a wrap is bound
// to a credential of the CALLER'S OWN account, it dies with that credential, it
// dies with the account, and — unlike published key material — it can be
// deleted, because losing one loses nothing.

import (
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"
)

// A PRF wrap in the envelope client/src/crypto/prf.ts writes: 46 header bytes +
// 97 body + 16 tag. The server never parses it; the length is what the CHECK
// constraint cares about.
func prfWrap(fill byte) []byte {
	b := make([]byte, 46+97+16)
	for i := range b {
		b[i] = fill
	}
	b[0] = 1 // envelope version
	b[1] = 2 // HKDF-SHA-256
	return b
}

// credential enrols a WebAuthn credential the way the passkey store does, so a
// wrap has something real to reference.
func (h *harness) credential(u uuid.UUID, id []byte) []byte {
	h.t.Helper()
	if _, err := h.pool.Exec(bg, `INSERT INTO webauthn_credentials
	  (credential_id, user_id, user_handle, public_key, sign_count, backup_eligible, backup_state, created_at)
	  VALUES ($1, $2, $3, $4, 0, true, true, $5)`,
		id, u, make([]byte, 32), make([]byte, 77), time.Now()); err != nil {
		h.t.Fatalf("insert credential: %v", err)
	}
	return id
}

func (h *harness) countWraps(u uuid.UUID) int {
	h.t.Helper()
	var n int
	if err := h.pool.QueryRow(bg, `SELECT count(*) FROM user_key_wraps WHERE user_id = $1`, u).Scan(&n); err != nil {
		h.t.Fatalf("count wraps: %v", err)
	}
	return n
}

func TestKeyWrapsRequireASession(t *testing.T) {
	h := newHarness(t)
	body := map[string]any{"credential_id": b64([]byte("cred-1")), "wrapped": b64(prfWrap(2)), "wrap_version": 1}
	wantStatus(t, h.req(http.MethodGet, "/api/v1/keys/wraps", "", nil), http.StatusUnauthorized)
	wantStatus(t, h.req(http.MethodPost, "/api/v1/keys/wraps", "", body), http.StatusUnauthorized)
	wantStatus(t, h.req(http.MethodDelete, "/api/v1/keys/wraps", "", body), http.StatusUnauthorized)
	wantStatus(t, h.req(http.MethodPost, "/api/v1/keys/wraps", "not-a-session", body), http.StatusUnauthorized)
}

// No wraps is a normal state — every account is in it until somebody enrols one
// — so it is an empty list and not a 404.
func TestKeyWrapsAreEmptyUntilEnrolled(t *testing.T) {
	h := newHarness(t)
	tok := h.session(h.user("alice"))
	rec := h.req(http.MethodGet, "/api/v1/keys/wraps", tok, nil)
	wantStatus(t, rec, http.StatusOK)
	if got := decodeJSON[KeyWrapsResponse](t, rec); len(got.Wraps) != 0 {
		t.Fatalf("a fresh account reports %d wraps, want 0", len(got.Wraps))
	}
}

func TestKeyWrapRoundTrips(t *testing.T) {
	h := newHarness(t)
	u := h.user("alice")
	tok := h.session(u)
	cred := h.credential(u, []byte("cred-alice"))

	wantStatus(t, h.req(http.MethodPost, "/api/v1/keys/wraps", tok, map[string]any{
		"credential_id": b64(cred), "wrapped": b64(prfWrap(0x22)), "wrap_version": 1,
	}), http.StatusNoContent)

	got := decodeJSON[KeyWrapsResponse](t, h.req(http.MethodGet, "/api/v1/keys/wraps", tok, nil))
	if len(got.Wraps) != 1 {
		t.Fatalf("got %d wraps, want 1", len(got.Wraps))
	}
	if got.Wraps[0].CredentialID != b64(cred) {
		t.Fatalf("credential_id = %q, want %q", got.Wraps[0].CredentialID, b64(cred))
	}
	if got.Wraps[0].Wrapped != b64(prfWrap(0x22)) {
		t.Fatal("the wrap did not round-trip byte for byte")
	}
	if got.Wraps[0].WrapVersion != 1 || got.Wraps[0].CreatedAt.IsZero() {
		t.Fatalf("wrap_version = %d, created_at = %v", got.Wraps[0].WrapVersion, got.Wraps[0].CreatedAt)
	}
}

// The opposite of handlePublishKeys's 409, and deliberately: re-enrolling after
// an authenticator rotated its PRF secret must succeed, or the user is left
// with a row that opens nothing and no way to replace it.
func TestKeyWrapIsReplaceable(t *testing.T) {
	h := newHarness(t)
	u := h.user("alice")
	tok := h.session(u)
	cred := h.credential(u, []byte("cred-alice"))

	for _, fill := range []byte{0x11, 0x22} {
		wantStatus(t, h.req(http.MethodPost, "/api/v1/keys/wraps", tok, map[string]any{
			"credential_id": b64(cred), "wrapped": b64(prfWrap(fill)), "wrap_version": 1,
		}), http.StatusNoContent)
	}
	got := decodeJSON[KeyWrapsResponse](t, h.req(http.MethodGet, "/api/v1/keys/wraps", tok, nil))
	if len(got.Wraps) != 1 || got.Wraps[0].Wrapped != b64(prfWrap(0x22)) {
		t.Fatalf("re-enrolling left %d wraps and did not replace the blob", len(got.Wraps))
	}
}

// Deleting a wrap is correct here and would not be for user_keys: the phrase
// still opens the account, so a removed wrap costs convenience and nothing else.
func TestKeyWrapCanBeDeleted(t *testing.T) {
	h := newHarness(t)
	u := h.user("alice")
	tok := h.session(u)
	cred := h.credential(u, []byte("cred-alice"))
	wantStatus(t, h.req(http.MethodPost, "/api/v1/keys/wraps", tok, map[string]any{
		"credential_id": b64(cred), "wrapped": b64(prfWrap(1)), "wrap_version": 1,
	}), http.StatusNoContent)

	wantStatus(t, h.req(http.MethodDelete, "/api/v1/keys/wraps", tok, map[string]any{
		"credential_id": b64(cred),
	}), http.StatusNoContent)
	if n := h.countWraps(u); n != 0 {
		t.Fatalf("%d wraps survived the delete", n)
	}
	// And deleting one that is not there is the same answer: the caller's goal
	// is met, and this is the orphan cleanup path.
	wantStatus(t, h.req(http.MethodDelete, "/api/v1/keys/wraps", tok, map[string]any{
		"credential_id": b64([]byte("never-existed")),
	}), http.StatusNoContent)
}

// The scoping test. The user id comes from the SESSION and never from the
// request — there is no user field in the request shape at all.
func TestKeyWrapsAreScopedToTheCallersAccount(t *testing.T) {
	h := newHarness(t)
	alice, bob := h.user("alice"), h.user("bob")
	aliceTok, bobTok := h.session(alice), h.session(bob)
	aliceCred := h.credential(alice, []byte("cred-alice"))
	h.credential(bob, []byte("cred-bob"))

	wantStatus(t, h.req(http.MethodPost, "/api/v1/keys/wraps", aliceTok, map[string]any{
		"credential_id": b64(aliceCred), "wrapped": b64(prfWrap(0xa1)), "wrap_version": 1,
	}), http.StatusNoContent)

	if got := decodeJSON[KeyWrapsResponse](t, h.req(http.MethodGet, "/api/v1/keys/wraps", bobTok, nil)); len(got.Wraps) != 0 {
		t.Fatal("bob can see alice's wraps")
	}
	// Bob naming alice's credential is the same answer as naming one that does
	// not exist, so the route cannot be used to ask whether a credential id is
	// registered elsewhere.
	rec := h.req(http.MethodPost, "/api/v1/keys/wraps", bobTok, map[string]any{
		"credential_id": b64(aliceCred), "wrapped": b64(prfWrap(0xb1)), "wrap_version": 1,
	})
	wantStatus(t, rec, http.StatusNotFound)
	if got := decodeJSON[map[string]any](t, rec)["error"]; got != "unknown_credential" {
		t.Fatalf("error = %v, want unknown_credential", got)
	}
	if n := h.countWraps(bob); n != 0 {
		t.Fatalf("bob's refused POST stored %d rows", n)
	}
	// Alice's wrap is untouched by any of it.
	if n := h.countWraps(alice); n != 1 {
		t.Fatalf("alice holds %d wraps, want 1", n)
	}
	// And bob deleting by alice's credential id deletes nothing of hers.
	wantStatus(t, h.req(http.MethodDelete, "/api/v1/keys/wraps", bobTok, map[string]any{
		"credential_id": b64(aliceCred),
	}), http.StatusNoContent)
	if n := h.countWraps(alice); n != 1 {
		t.Fatal("bob deleted alice's wrap")
	}
}

func TestKeyWrapUnknownCredentialIsRefused(t *testing.T) {
	h := newHarness(t)
	u := h.user("alice")
	tok := h.session(u)
	wantStatus(t, h.req(http.MethodPost, "/api/v1/keys/wraps", tok, map[string]any{
		"credential_id": b64([]byte("no-such-credential")), "wrapped": b64(prfWrap(1)), "wrap_version": 1,
	}), http.StatusNotFound)
	if n := h.countWraps(u); n != 0 {
		t.Fatalf("a refused POST stored %d rows", n)
	}
}

func TestKeyWrapsRefuseMalformedSubmissions(t *testing.T) {
	h := newHarness(t)
	u := h.user("alice")
	tok := h.session(u)
	cred := h.credential(u, []byte("cred-alice"))

	for name, body := range map[string]map[string]any{
		"no credential id":     {"credential_id": "", "wrapped": b64(prfWrap(1)), "wrap_version": 1},
		"credential not b64":   {"credential_id": "!!!!", "wrapped": b64(prfWrap(1)), "wrap_version": 1},
		"wrap not b64":         {"credential_id": b64(cred), "wrapped": "!!!!", "wrap_version": 1},
		"no wrap":              {"credential_id": b64(cred), "wrapped": "", "wrap_version": 1},
		"a wrap far too short": {"credential_id": b64(cred), "wrapped": b64([]byte("short")), "wrap_version": 1},
		"a wrap far too long": {
			"credential_id": b64(cred), "wrapped": b64(make([]byte, maxKeyWrapBytes+1)), "wrap_version": 1,
		},
		"no version":        {"credential_id": b64(cred), "wrapped": b64(prfWrap(1)), "wrap_version": 0},
		"a bogus version":   {"credential_id": b64(cred), "wrapped": b64(prfWrap(1)), "wrap_version": -3},
		"nothing to delete": {"credential_id": ""},
	} {
		method := http.MethodPost
		if _, only := body["wrapped"]; !only {
			method = http.MethodDelete
		}
		rec := h.req(method, "/api/v1/keys/wraps", tok, body)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("%s %s = %d, want 400: %s", method, name, rec.Code, rec.Body.String())
		}
	}
	if n := h.countWraps(u); n != 0 {
		t.Fatalf("a rejected submission stored %d rows", n)
	}
}

// The handler's bound and the column's CHECK are two numbers that must be one:
// a handler that admitted more than the column does would turn a user-visible
// refusal into a 500 in production only.
func TestKeyWrapBoundMatchesTheColumn(t *testing.T) {
	h := newHarness(t)
	u := h.user("alice")
	tok := h.session(u)
	cred := h.credential(u, []byte("cred-alice"))
	wantStatus(t, h.req(http.MethodPost, "/api/v1/keys/wraps", tok, map[string]any{
		"credential_id": b64(cred), "wrapped": b64(make([]byte, maxKeyWrapBytes)), "wrap_version": 1,
	}), http.StatusNoContent)
	wantStatus(t, h.req(http.MethodPost, "/api/v1/keys/wraps", tok, map[string]any{
		"credential_id": b64(cred), "wrapped": b64(make([]byte, minKeyWrapBytes)), "wrap_version": 1,
	}), http.StatusNoContent)
}

// A wrap that outlived the credential that opens it would be an unopenable blob
// kept forever, and — worse — a row that could be handed to a re-registered
// credential id. The cascade is the lifecycle.
func TestKeyWrapDiesWithItsCredential(t *testing.T) {
	h := newHarness(t)
	u := h.user("alice")
	tok := h.session(u)
	cred := h.credential(u, []byte("cred-alice"))
	other := h.credential(u, []byte("cred-alice-2"))
	for _, c := range [][]byte{cred, other} {
		wantStatus(t, h.req(http.MethodPost, "/api/v1/keys/wraps", tok, map[string]any{
			"credential_id": b64(c), "wrapped": b64(prfWrap(1)), "wrap_version": 1,
		}), http.StatusNoContent)
	}

	if _, err := h.pool.Exec(bg, `DELETE FROM webauthn_credentials WHERE credential_id = $1`, cred); err != nil {
		t.Fatalf("delete credential: %v", err)
	}
	got := decodeJSON[KeyWrapsResponse](t, h.req(http.MethodGet, "/api/v1/keys/wraps", tok, nil))
	if len(got.Wraps) != 1 || got.Wraps[0].CredentialID != b64(other) {
		t.Fatalf("removing a passkey left %d wraps, want only the other credential's", len(got.Wraps))
	}
}

// The same fact for the account: a wrap that survived its user would be key
// material kept after somebody asked to be forgotten.
func TestKeyWrapDiesWithTheAccount(t *testing.T) {
	h := newHarness(t)
	u := h.user("alice")
	tok := h.session(u)
	cred := h.credential(u, []byte("cred-alice"))
	wantStatus(t, h.req(http.MethodPost, "/api/v1/keys/wraps", tok, map[string]any{
		"credential_id": b64(cred), "wrapped": b64(prfWrap(1)), "wrap_version": 1,
	}), http.StatusNoContent)

	if _, err := h.pool.Exec(bg, `DELETE FROM users WHERE id = $1`, u); err != nil {
		t.Fatalf("delete user: %v", err)
	}
	var n int
	if err := h.pool.QueryRow(bg, `SELECT count(*) FROM user_key_wraps WHERE user_id = $1`, u).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatalf("%d wraps survived the account", n)
	}
}
