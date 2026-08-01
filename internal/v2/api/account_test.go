package api

import (
	"crypto/ed25519"
	"encoding/base64"
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"

	"ledger/internal/v2/auth"
	"ledger/internal/v2/purge"
)

// deletable is an account set up the way a real one is: a session, an enrolled
// device writer, and some history worth losing.
type deletable struct {
	u    uuid.UUID
	tok  string
	priv ed25519.PrivateKey
}

func (h *harness) deletable(t *testing.T, sub string) deletable {
	t.Helper()
	u := h.user(sub)
	priv := h.writer(u, "device-1")
	h.seedIngest(u, 2)
	return deletable{u: u, tok: h.session(u), priv: priv}
}

func (h *harness) deleteChallenge(t *testing.T, token string) []byte {
	t.Helper()
	w := h.req("POST", "/api/v1/account/challenge", token, struct{}{})
	wantStatus(t, w, http.StatusOK)
	nonce, err := base64.StdEncoding.DecodeString(decodeJSON[ChallengeResponse](t, w).Nonce)
	if err != nil {
		t.Fatal(err)
	}
	return nonce
}

// idTokenAged arms the fake verifier to answer with `sub`, minted `age` ago,
// and returns the opaque token string to send. Age 0 is a token issued this
// instant — what a client that just re-authenticated would hold.
func (h *harness) idTokenAged(sub string, age time.Duration) string {
	h.apple.mu.Lock()
	defer h.apple.mu.Unlock()
	h.apple.identity = auth.Identity{IdP: auth.IdPApple, Subject: sub, IssuedAt: time.Now().Add(-age)}
	return "reauth-token"
}

func (h *harness) countUsers(t *testing.T) int {
	t.Helper()
	var n int
	if err := h.pool.QueryRow(bg, `SELECT count(*) FROM users`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func (h *harness) accountExists(t *testing.T, u uuid.UUID) bool {
	t.Helper()
	var n int
	if err := h.pool.QueryRow(bg, `SELECT count(*) FROM users WHERE id = $1`, u).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n == 1
}

type deleteBody struct {
	IdP     string `json:"idp"`
	IDToken string `json:"id_token"`
	Nonce   string `json:"nonce"`
	Sig     string `json:"sig"`
}

// ---------------------------------------------------------------------------
// The three factors
// ---------------------------------------------------------------------------

// Spec §3.4: a stolen session token must not be able to destroy a life's
// financial history. This is the whole reason the endpoint takes a body at all.
func TestDeleteAccountRefusesASessionTokenAlone(t *testing.T) {
	h := newHarness(t)
	acc := h.deletable(t, "sub-alice")

	w := h.req("DELETE", "/api/v1/account", acc.tok, deleteBody{})
	wantStatus(t, w, http.StatusForbidden)
	if !h.accountExists(t, acc.u) {
		t.Fatal("a session token alone deleted the account")
	}
	// The op log is untouched, not partly gone.
	var n int
	if err := h.pool.QueryRow(bg, `SELECT count(*) FROM op_log WHERE user_id = $1`, acc.u).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 4 {
		t.Fatalf("op_log holds %d rows, want the 4 that were seeded", n)
	}
}

// The session plus a valid signature, and no re-authentication at all. Malware
// on an unlocked device has exactly this much.
func TestDeleteAccountRefusesKeyPossessionWithoutReauthentication(t *testing.T) {
	h := newHarness(t)
	acc := h.deletable(t, "sub-alice")
	nonce := h.deleteChallenge(t, acc.tok)
	sig := ed25519.Sign(acc.priv, purge.DeletionMessage(nonce, acc.u))

	w := h.req("DELETE", "/api/v1/account", acc.tok, deleteBody{
		IdP:   auth.IdPApple,
		Nonce: base64.StdEncoding.EncodeToString(nonce),
		Sig:   base64.StdEncoding.EncodeToString(sig),
	})
	wantStatus(t, w, http.StatusForbidden)
	if !h.accountExists(t, acc.u) {
		t.Fatal("the account was deleted with no re-authentication")
	}
}

// An ID token that is still valid but was minted an hour ago proves the user
// signed in AT SOME POINT, which is what a session already proved.
func TestDeleteAccountRefusesAStaleIDToken(t *testing.T) {
	h := newHarness(t)
	acc := h.deletable(t, "sub-alice")
	nonce := h.deleteChallenge(t, acc.tok)
	sig := ed25519.Sign(acc.priv, purge.DeletionMessage(nonce, acc.u))
	token := h.idTokenAged("sub-alice", time.Hour)

	w := h.req("DELETE", "/api/v1/account", acc.tok, deleteBody{
		IdP:     auth.IdPApple,
		IDToken: token,
		Nonce:   base64.StdEncoding.EncodeToString(nonce),
		Sig:     base64.StdEncoding.EncodeToString(sig),
	})
	wantStatus(t, w, http.StatusForbidden)
	if !h.accountExists(t, acc.u) {
		t.Fatal("a stale ID token deleted the account")
	}
}

// The freshness requirement is stated to the verifier as well, not only
// re-checked here: a real verifier enforces it against the AUTHENTICATED
// payload, which is the check that decides.
func TestDeleteAccountRequiresFreshnessOfTheVerifierToo(t *testing.T) {
	h := newHarness(t)
	acc := h.deletable(t, "sub-alice")
	nonce := h.deleteChallenge(t, acc.tok)
	sig := ed25519.Sign(acc.priv, purge.DeletionMessage(nonce, acc.u))
	token := h.idTokenAged("sub-alice", 0)

	h.req("DELETE", "/api/v1/account", acc.tok, deleteBody{
		IdP:     auth.IdPApple,
		IDToken: token,
		Nonce:   base64.StdEncoding.EncodeToString(nonce),
		Sig:     base64.StdEncoding.EncodeToString(sig),
	})
	h.apple.mu.Lock()
	defer h.apple.mu.Unlock()
	if h.apple.lastOpts.MaxAge != reauthMaxAge {
		t.Fatalf("verifier was asked for MaxAge %v, want %v", h.apple.lastOpts.MaxAge, reauthMaxAge)
	}
}

// A genuine, fresh token for a DIFFERENT account is not re-authentication for
// this one. Without the binding, any valid Apple token from anybody satisfies
// the factor.
func TestDeleteAccountRefusesAnIDTokenNamingAnotherAccount(t *testing.T) {
	h := newHarness(t)
	acc := h.deletable(t, "sub-alice")
	h.user("sub-mallory")
	nonce := h.deleteChallenge(t, acc.tok)
	sig := ed25519.Sign(acc.priv, purge.DeletionMessage(nonce, acc.u))
	token := h.idTokenAged("sub-mallory", 0)

	w := h.req("DELETE", "/api/v1/account", acc.tok, deleteBody{
		IdP:     auth.IdPApple,
		IDToken: token,
		Nonce:   base64.StdEncoding.EncodeToString(nonce),
		Sig:     base64.StdEncoding.EncodeToString(sig),
	})
	wantStatus(t, w, http.StatusForbidden)
	if !h.accountExists(t, acc.u) {
		t.Fatal("another account's ID token deleted this one")
	}
}

// A rejected delete must WRITE NOTHING.
//
// Resolving the re-authenticated identity with auth.UpsertUser — which this
// handler did until the review caught it — CREATES a users row for an unknown
// subject, on the path that then answers 403. That turns the endpoint whose
// whole purpose is destruction into a row-creation primitive for anyone holding
// one valid session plus arbitrary IdP tokens, and every stray account lands in
// the retention sweep's WithoutConsentRecord list for ever.
func TestDeleteAccountCreatesNoAccountWhenItRefuses(t *testing.T) {
	h := newHarness(t)
	acc := h.deletable(t, "sub-alice")
	nonce := h.deleteChallenge(t, acc.tok)
	sig := ed25519.Sign(acc.priv, purge.DeletionMessage(nonce, acc.u))
	before := h.countUsers(t)

	// A subject this deployment has never seen, presented with a fresh token.
	token := h.idTokenAged("sub-nobody-has-ever-signed-in-as-this", 0)
	w := h.req("DELETE", "/api/v1/account", acc.tok, deleteBody{
		IdP:     auth.IdPApple,
		IDToken: token,
		Nonce:   base64.StdEncoding.EncodeToString(nonce),
		Sig:     base64.StdEncoding.EncodeToString(sig),
	})
	wantStatus(t, w, http.StatusForbidden)
	if after := h.countUsers(t); after != before {
		t.Fatalf("a rejected delete changed the account count from %d to %d", before, after)
	}
	if !h.accountExists(t, acc.u) {
		t.Fatal("the caller's own account was deleted")
	}
}

func TestDeleteAccountRefusesASignatureFromAnUnenrolledKey(t *testing.T) {
	h := newHarness(t)
	acc := h.deletable(t, "sub-alice")
	nonce := h.deleteChallenge(t, acc.tok)
	_, stranger, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	sig := ed25519.Sign(stranger, purge.DeletionMessage(nonce, acc.u))
	token := h.idTokenAged("sub-alice", 0)

	w := h.req("DELETE", "/api/v1/account", acc.tok, deleteBody{
		IdP:     auth.IdPApple,
		IDToken: token,
		Nonce:   base64.StdEncoding.EncodeToString(nonce),
		Sig:     base64.StdEncoding.EncodeToString(sig),
	})
	wantStatus(t, w, http.StatusForbidden)
	if !h.accountExists(t, acc.u) {
		t.Fatal("a signature from an unenrolled key deleted the account")
	}
}

// ---------------------------------------------------------------------------
// The happy path
// ---------------------------------------------------------------------------

func TestDeleteAccountWithAllThreeFactorsPurgesTheAccount(t *testing.T) {
	h := newHarness(t)
	acc := h.deletable(t, "sub-alice")
	bystander := h.deletable(t, "sub-bob")
	nonce := h.deleteChallenge(t, acc.tok)
	sig := ed25519.Sign(acc.priv, purge.DeletionMessage(nonce, acc.u))
	token := h.idTokenAged("sub-alice", 0)

	w := h.req("DELETE", "/api/v1/account", acc.tok, deleteBody{
		IdP:     auth.IdPApple,
		IDToken: token,
		Nonce:   base64.StdEncoding.EncodeToString(nonce),
		Sig:     base64.StdEncoding.EncodeToString(sig),
	})
	wantStatus(t, w, http.StatusNoContent)

	if h.accountExists(t, acc.u) {
		t.Fatal("the account survived its own deletion")
	}
	rels, err := purge.UserScopedTables(bg, h.pool)
	if err != nil {
		t.Fatal(err)
	}
	for _, r := range rels {
		var n int
		// r.SQL() quotes schema and name separately; discovery now reaches
		// relations outside `public`, so the name may be two parts.
		if err := h.pool.QueryRow(bg, `SELECT count(*) FROM `+r.SQL()+` WHERE user_id = $1`, acc.u).Scan(&n); err != nil {
			t.Fatal(err)
		}
		if n != 0 {
			t.Fatalf("%s still holds %d rows for the deleted account", r, n)
		}
	}
	if !h.accountExists(t, bystander.u) {
		t.Fatal("the other account went with it")
	}

	// The session died with the account, so the credential that reached this
	// endpoint is worth nothing afterwards.
	wantStatus(t, h.req("GET", "/api/v1/sync?stream=hot", acc.tok, nil), http.StatusUnauthorized)
}

func TestDeleteAccountChallengeIsSingleUse(t *testing.T) {
	h := newHarness(t)
	acc := h.deletable(t, "sub-alice")
	nonce := h.deleteChallenge(t, acc.tok)
	sig := ed25519.Sign(acc.priv, purge.DeletionMessage(nonce, acc.u))

	body := deleteBody{
		IdP:     auth.IdPApple,
		IDToken: h.idTokenAged("sub-alice", 0),
		Nonce:   base64.StdEncoding.EncodeToString(nonce),
		Sig:     base64.StdEncoding.EncodeToString(sig),
	}
	// A first attempt that fails for an unrelated reason still SPENDS the
	// nonce: one challenge buys one attempt, or it buys unlimited guesses.
	bad := body
	bad.Sig = base64.StdEncoding.EncodeToString(make([]byte, ed25519.SignatureSize))
	wantStatus(t, h.req("DELETE", "/api/v1/account", acc.tok, bad), http.StatusForbidden)
	wantStatus(t, h.req("DELETE", "/api/v1/account", acc.tok, body), http.StatusForbidden)
	if !h.accountExists(t, acc.u) {
		t.Fatal("a replayed challenge deleted the account")
	}
}

// A nonce minted for one account must be worthless against another, even when
// the second account signs it correctly.
func TestDeleteAccountRefusesAnotherAccountsChallenge(t *testing.T) {
	h := newHarness(t)
	acc := h.deletable(t, "sub-alice")
	other := h.deletable(t, "sub-bob")
	nonce := h.deleteChallenge(t, other.tok)
	sig := ed25519.Sign(acc.priv, purge.DeletionMessage(nonce, acc.u))

	w := h.req("DELETE", "/api/v1/account", acc.tok, deleteBody{
		IdP:     auth.IdPApple,
		IDToken: h.idTokenAged("sub-alice", 0),
		Nonce:   base64.StdEncoding.EncodeToString(nonce),
		Sig:     base64.StdEncoding.EncodeToString(sig),
	})
	wantStatus(t, w, http.StatusForbidden)
	if !h.accountExists(t, acc.u) {
		t.Fatal("another account's challenge deleted this one")
	}
}

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

// The two factors are collected in one user gesture. A design where one expires
// while the other is still good produces a flow that fails halfway, for a reason
// the user cannot see and a developer would chase in the wrong layer.
func TestTheReauthWindowAndTheChallengeTTLAgree(t *testing.T) {
	if reauthMaxAge != purge.ChallengeTTL {
		t.Fatalf("reauthMaxAge %v != purge.ChallengeTTL %v", reauthMaxAge, purge.ChallengeTTL)
	}
}

func TestDeleteAccountRoutesNeedASession(t *testing.T) {
	h := newHarness(t)
	wantStatus(t, h.req("POST", "/api/v1/account/challenge", "", struct{}{}), http.StatusUnauthorized)
	wantStatus(t, h.req("DELETE", "/api/v1/account", "", deleteBody{}), http.StatusUnauthorized)
}

// Malformed input describes the CALLER's own submission and reveals nothing
// about the account, so it is a 400. A client with a coding bug must not be
// sent into an endless re-authentication loop.
func TestDeleteAccountAnswers400ForMalformedInput(t *testing.T) {
	h := newHarness(t)
	acc := h.deletable(t, "sub-alice")
	for _, tc := range []struct {
		name string
		body deleteBody
	}{
		{name: "unknown idp", body: deleteBody{IdP: "myspace", IDToken: "x", Nonce: "AA==", Sig: "AA=="}},
		{name: "nonce is not base64", body: deleteBody{IdP: auth.IdPApple, IDToken: "x", Nonce: "!!", Sig: "AA=="}},
		{name: "sig is not base64", body: deleteBody{IdP: auth.IdPApple, IDToken: "x", Nonce: "AA==", Sig: "!!"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			wantStatus(t, h.req("DELETE", "/api/v1/account", acc.tok, tc.body), http.StatusBadRequest)
		})
	}
	if !h.accountExists(t, acc.u) {
		t.Fatal("a malformed request deleted the account")
	}
}
