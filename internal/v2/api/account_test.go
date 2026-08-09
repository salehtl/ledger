package api

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/go-webauthn/webauthn/protocol"
	"github.com/google/uuid"

	"ledger/internal/v2/auth"
	"ledger/internal/v2/authtest"
	"ledger/internal/v2/purge"
)

// deletable is an account set up the way a real one is: a passkey (which is
// the only way v2 accounts are created), a session, an enrolled device writer,
// and some history worth losing.
type deletable struct {
	u    uuid.UUID
	tok  string
	priv ed25519.PrivateKey
	// pk is the authenticator holding this account's only credential.
	pk *authtest.Authenticator
	// counter is where its signature counter has got to. It only ever goes up,
	// because a counter that does not is the cloned-authenticator signal.
	counter uint32
}

func (h *harness) deletable(t *testing.T, note string) *deletable {
	t.Helper()
	pk, out := h.register(h.invite(note))
	u, err := uuid.Parse(out.UserID)
	if err != nil {
		t.Fatal(err)
	}
	priv := h.writer(u, "device-1")
	h.seedIngest(u, 2)
	return &deletable{u: u, tok: out.SessionToken, priv: priv, pk: pk, counter: 1}
}

// assertOver is the client half of factor 2: a passkey assertion over the raw
// challenge this server minted, with no ceremony id and no second round trip.
//
// The options are built here rather than fetched, because the server issues
// none: the deletion nonce IS the challenge, and the RP id is the origin the
// page is served from. That is the whole point of the design — anything the
// server had to hand out first would be a second piece of expiring state.
func assertOver(t *testing.T, a *authtest.Authenticator, challenge []byte, counter uint32) json.RawMessage {
	t.Helper()
	return a.Assert(t, &protocol.CredentialAssertion{
		Response: protocol.PublicKeyCredentialRequestOptions{
			Challenge:      protocol.URLEncodedBase64(challenge),
			RelyingPartyID: authtest.RPID,
		},
	}, counter)
}

// assert answers a challenge at a fresh counter.
func (d *deletable) assert(t *testing.T, challenge []byte) json.RawMessage {
	t.Helper()
	d.counter++
	return assertOver(t, d.pk, challenge, d.counter)
}

// body is a complete, valid three-factor request. Every refusal test takes this
// and breaks exactly one thing, so a test that stops proving what it says can
// only be one that stopped breaking anything.
func (d *deletable) body(t *testing.T, nonce []byte) deleteBody {
	t.Helper()
	return deleteBody{
		Assertion: d.assert(t, nonce),
		Nonce:     base64.StdEncoding.EncodeToString(nonce),
		Sig:       base64.StdEncoding.EncodeToString(ed25519.Sign(d.priv, purge.DeletionMessage(nonce, d.u))),
	}
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

// expireChallenge ages a minted nonce out of its window without moving anyone's
// clock, so one test's staleness cannot leak into another's timing.
func (h *harness) expireChallenge(t *testing.T, nonce []byte) {
	t.Helper()
	tag, err := h.pool.Exec(bg,
		`UPDATE account_deletion_challenges SET expires_at = issued_at WHERE nonce = $1`, nonce)
	if err != nil {
		t.Fatal(err)
	}
	if tag.RowsAffected() != 1 {
		t.Fatalf("expireChallenge matched %d rows, want 1", tag.RowsAffected())
	}
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

// revokeWriter retires a device writer through the real capability path, which
// is the only way it can happen: a session token cannot revoke anything, and a
// row edited by hand would not prove the deletion path consults the roster the
// same way the rest of the system does.
func (h *harness) revokeWriter(t *testing.T, u uuid.UUID, writerID string, priv ed25519.PrivateKey) {
	t.Helper()
	nonce, err := h.srv.Writers.Challenge(bg, u)
	if err != nil {
		t.Fatal(err)
	}
	sig := ed25519.Sign(priv, auth.RevocationMessage(nonce, writerID))
	if err := h.srv.Writers.Revoke(bg, u, writerID, nonce, sig); err != nil {
		t.Fatalf("revoke %s: %v", writerID, err)
	}
}

type deleteBody struct {
	Assertion json.RawMessage `json:"assertion,omitempty"`
	Nonce     string          `json:"nonce"`
	Sig       string          `json:"sig"`
}

// ---------------------------------------------------------------------------
// The three factors
// ---------------------------------------------------------------------------

// Spec §3.4: a stolen session token must not be able to destroy a life's
// financial history. This is the whole reason the endpoint takes a body at all.
func TestDeleteAccountRefusesASessionTokenAlone(t *testing.T) {
	h := newHarness(t).passkeys()
	acc := h.deletable(t, "alice")

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
// on an unlocked device that can drive the writer key has exactly this much.
func TestDeleteAccountRefusesKeyPossessionWithoutAnAssertion(t *testing.T) {
	h := newHarness(t).passkeys()
	acc := h.deletable(t, "alice")
	nonce := h.deleteChallenge(t, acc.tok)

	body := acc.body(t, nonce)
	body.Assertion = nil
	wantStatus(t, h.req("DELETE", "/api/v1/account", acc.tok, body), http.StatusForbidden)
	if !h.accountExists(t, acc.u) {
		t.Fatal("the account was deleted with no re-authentication")
	}
}

// An assertion over a challenge that has aged out. This is the whole freshness
// story: there is no second window to check, so if the nonce's own expiry did
// not bite, nothing would.
func TestDeleteAccountRefusesAnAssertionOverAStaleChallenge(t *testing.T) {
	h := newHarness(t).passkeys()
	acc := h.deletable(t, "alice")
	nonce := h.deleteChallenge(t, acc.tok)
	body := acc.body(t, nonce)
	h.expireChallenge(t, nonce)

	wantStatus(t, h.req("DELETE", "/api/v1/account", acc.tok, body), http.StatusForbidden)
	if !h.accountExists(t, acc.u) {
		t.Fatal("an assertion over an expired challenge deleted the account")
	}
}

// A whole, correct request, sent twice. The assertion is bound to a nonce, the
// nonce is spent by the attempt, so the second copy has nothing left to prove
// anything with — which is what makes an intercepted request worthless.
func TestDeleteAccountRefusesAReplayedAssertion(t *testing.T) {
	h := newHarness(t).passkeys()
	acc := h.deletable(t, "alice")
	other := h.deletable(t, "bob")
	nonce := h.deleteChallenge(t, other.tok)
	body := other.body(t, nonce)

	// The first one really does work, or the second proves nothing.
	wantStatus(t, h.req("DELETE", "/api/v1/account", other.tok, body), http.StatusNoContent)
	// Replayed against a session that is still live. It is `acc`'s session
	// rather than the deleted account's, so the 403 cannot be a 410 in
	// disguise.
	wantStatus(t, h.req("DELETE", "/api/v1/account", acc.tok, body), http.StatusForbidden)
	if !h.accountExists(t, acc.u) {
		t.Fatal("a replayed request deleted a second account")
	}
}

// A genuine, fresh assertion from somebody else's passkey is not
// re-authentication for this account. Without the binding to the credential's
// OWNER, any valid assertion from anybody satisfies the factor.
func TestDeleteAccountRefusesAnAssertionFromAnotherAccountsCredential(t *testing.T) {
	h := newHarness(t).passkeys()
	acc := h.deletable(t, "alice")
	mallory := h.deletable(t, "mallory")
	nonce := h.deleteChallenge(t, acc.tok)

	body := acc.body(t, nonce)
	mallory.counter++
	body.Assertion = assertOver(t, mallory.pk, nonce, mallory.counter)

	wantStatus(t, h.req("DELETE", "/api/v1/account", acc.tok, body), http.StatusForbidden)
	if !h.accountExists(t, acc.u) {
		t.Fatal("another account's passkey deleted this one")
	}
	if !h.accountExists(t, mallory.u) {
		t.Fatal("the wrong account was deleted")
	}
}

// A credential this deployment has never enrolled is a rejection, not a first
// enrolment. The login path makes the same promise, for the same reason: a
// re-authentication that could mint an identity would be a way past the gate.
func TestDeleteAccountRefusesAnAssertionFromAnUnenrolledCredential(t *testing.T) {
	h := newHarness(t).passkeys()
	acc := h.deletable(t, "alice")
	nonce := h.deleteChallenge(t, acc.tok)

	stranger := authtest.New(t)
	stranger.Handle = authtest.RandBytes(t, 32)
	body := acc.body(t, nonce)
	body.Assertion = assertOver(t, stranger, nonce, 2)

	wantStatus(t, h.req("DELETE", "/api/v1/account", acc.tok, body), http.StatusForbidden)
	if !h.accountExists(t, acc.u) {
		t.Fatal("an unenrolled credential deleted the account")
	}
}

// A rejected delete must WRITE NOTHING.
//
// The IdP version of this handler resolved its identity with auth.UpsertUser,
// which CREATES a users row for an unknown subject — a row-creation primitive
// on the endpoint whose entire job is destruction, reached on the path that
// answers 403, and every stray account landed in the retention sweep's
// WithoutConsentRecord list for ever. An assertion cannot do that, and this is
// the test that says so.
func TestDeleteAccountCreatesNoAccountWhenItRefuses(t *testing.T) {
	h := newHarness(t).passkeys()
	acc := h.deletable(t, "alice")
	nonce := h.deleteChallenge(t, acc.tok)
	before := h.countUsers(t)

	stranger := authtest.New(t)
	stranger.Handle = authtest.RandBytes(t, 32)
	body := acc.body(t, nonce)
	body.Assertion = assertOver(t, stranger, nonce, 2)

	wantStatus(t, h.req("DELETE", "/api/v1/account", acc.tok, body), http.StatusForbidden)
	if after := h.countUsers(t); after != before {
		t.Fatalf("a rejected delete changed the account count from %d to %d", before, after)
	}
	if !h.accountExists(t, acc.u) {
		t.Fatal("the caller's own account was deleted")
	}
}

func TestDeleteAccountRefusesASignatureFromAnUnenrolledKey(t *testing.T) {
	h := newHarness(t).passkeys()
	acc := h.deletable(t, "alice")
	nonce := h.deleteChallenge(t, acc.tok)
	_, stranger, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}

	body := acc.body(t, nonce)
	body.Sig = base64.StdEncoding.EncodeToString(ed25519.Sign(stranger, purge.DeletionMessage(nonce, acc.u)))

	wantStatus(t, h.req("DELETE", "/api/v1/account", acc.tok, body), http.StatusForbidden)
	if !h.accountExists(t, acc.u) {
		t.Fatal("a signature from an unenrolled key deleted the account")
	}
}

// A revoked device must not be able to delete the account, or revocation would
// mean nothing. Note what this device still HAS: the session, and the passkey.
// Factor 3 is the only thing it lost.
func TestDeleteAccountRefusesASignatureFromARevokedKey(t *testing.T) {
	h := newHarness(t).passkeys()
	acc := h.deletable(t, "alice")
	h.revokeWriter(t, acc.u, "device-1", acc.priv)
	nonce := h.deleteChallenge(t, acc.tok)

	wantStatus(t, h.req("DELETE", "/api/v1/account", acc.tok, acc.body(t, nonce)), http.StatusForbidden)
	if !h.accountExists(t, acc.u) {
		t.Fatal("a revoked device key deleted the account")
	}
}

// The property the whole design turns on: a caller cannot learn WHICH factor
// they are missing by watching the answer change. Every refusal is one status
// and one body.
func TestEveryDeletionRefusalIsTheSameAnswer(t *testing.T) {
	// A harness per case, because the per-user attempt limiter is real: six
	// cases sharing one account exhaust its burst and the sixth would be
	// "refused" with a 429, which would make this test pass for the wrong
	// reason on the day the answers stopped agreeing.
	for _, tc := range []struct {
		name  string
		build func(t *testing.T, h *harness, acc, mallory *deletable) deleteBody
	}{
		{
			name:  "nothing at all",
			build: func(*testing.T, *harness, *deletable, *deletable) deleteBody { return deleteBody{} },
		},
		{
			name: "no assertion",
			build: func(t *testing.T, h *harness, acc, _ *deletable) deleteBody {
				b := acc.body(t, h.deleteChallenge(t, acc.tok))
				b.Assertion = nil
				return b
			},
		},
		{
			name: "no signature",
			build: func(t *testing.T, h *harness, acc, _ *deletable) deleteBody {
				b := acc.body(t, h.deleteChallenge(t, acc.tok))
				b.Sig = base64.StdEncoding.EncodeToString(make([]byte, ed25519.SignatureSize))
				return b
			},
		},
		{
			name: "another account's assertion",
			build: func(t *testing.T, h *harness, acc, mallory *deletable) deleteBody {
				nonce := h.deleteChallenge(t, acc.tok)
				b := acc.body(t, nonce)
				mallory.counter++
				b.Assertion = assertOver(t, mallory.pk, nonce, mallory.counter)
				return b
			},
		},
		{
			name: "a spent challenge",
			build: func(t *testing.T, h *harness, acc, _ *deletable) deleteBody {
				nonce := h.deleteChallenge(t, acc.tok)
				first := acc.body(t, nonce)
				first.Sig = base64.StdEncoding.EncodeToString(make([]byte, ed25519.SignatureSize))
				h.req("DELETE", "/api/v1/account", acc.tok, first)
				return acc.body(t, nonce)
			},
		},
		{
			name: "an expired challenge",
			build: func(t *testing.T, h *harness, acc, _ *deletable) deleteBody {
				nonce := h.deleteChallenge(t, acc.tok)
				b := acc.body(t, nonce)
				h.expireChallenge(t, nonce)
				return b
			},
		},
		{
			name: "a challenge minted for somebody else",
			build: func(t *testing.T, h *harness, acc, mallory *deletable) deleteBody {
				return acc.body(t, h.deleteChallenge(t, mallory.tok))
			},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := newHarness(t).passkeys()
			acc := h.deletable(t, "alice")
			mallory := h.deletable(t, "mallory")

			w := h.req("DELETE", "/api/v1/account", acc.tok, tc.build(t, h, acc, mallory))
			wantStatus(t, w, http.StatusForbidden)
			if got := w.Body.String(); got != `{"error":"deletion_rejected"}` {
				t.Fatalf("body = %s, want the one refusal every factor shares", got)
			}
			if !h.accountExists(t, acc.u) {
				t.Fatal("the refusal deleted the account anyway")
			}
		})
	}
}

// ---------------------------------------------------------------------------
// The happy path
// ---------------------------------------------------------------------------

func TestDeleteAccountWithAllThreeFactorsPurgesTheAccount(t *testing.T) {
	h := newHarness(t).passkeys()
	acc := h.deletable(t, "alice")
	bystander := h.deletable(t, "bob")
	nonce := h.deleteChallenge(t, acc.tok)

	w := h.req("DELETE", "/api/v1/account", acc.tok, acc.body(t, nonce))
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
	// The credential went with it, so the passkey that just re-authenticated
	// cannot re-authenticate anything ever again.
	var creds int
	if err := h.pool.QueryRow(bg,
		`SELECT count(*) FROM webauthn_credentials WHERE user_id = $1`, acc.u).Scan(&creds); err != nil {
		t.Fatal(err)
	}
	if creds != 0 {
		t.Fatalf("%d credentials survived the account they belong to", creds)
	}
	if !h.accountExists(t, bystander.u) {
		t.Fatal("the other account went with it")
	}

	// The session died with the account, so the credential that reached this
	// endpoint is worth nothing afterwards — and it says so DISTINGUISHABLY.
	// A 401 here would be indistinguishable from an expired session, and the
	// device that just deleted its own account has to know which of the two it
	// is looking at before it wipes anything.
	after := h.req("GET", "/api/v1/sync?stream=hot", acc.tok, nil)
	wantStatus(t, after, http.StatusGone)
	if got := after.Body.String(); got != `{"error":"account_deleted"}` {
		t.Fatalf("body = %s", got)
	}
	// And so does every other route the dead session can reach.
	wantStatus(t, h.req("POST", "/api/v1/account/challenge", acc.tok, struct{}{}), http.StatusGone)
}

func TestDeleteAccountChallengeIsSingleUse(t *testing.T) {
	h := newHarness(t).passkeys()
	acc := h.deletable(t, "alice")
	nonce := h.deleteChallenge(t, acc.tok)

	// A first attempt that fails for an unrelated reason still SPENDS the
	// nonce: one challenge buys one attempt, or it buys unlimited guesses.
	bad := acc.body(t, nonce)
	bad.Sig = base64.StdEncoding.EncodeToString(make([]byte, ed25519.SignatureSize))
	wantStatus(t, h.req("DELETE", "/api/v1/account", acc.tok, bad), http.StatusForbidden)
	wantStatus(t, h.req("DELETE", "/api/v1/account", acc.tok, acc.body(t, nonce)), http.StatusForbidden)
	if !h.accountExists(t, acc.u) {
		t.Fatal("a replayed challenge deleted the account")
	}
}

// A nonce minted for one account must be worthless against another, even when
// the second account signs it correctly.
func TestDeleteAccountRefusesAnotherAccountsChallenge(t *testing.T) {
	h := newHarness(t).passkeys()
	acc := h.deletable(t, "alice")
	other := h.deletable(t, "bob")
	nonce := h.deleteChallenge(t, other.tok)

	wantStatus(t, h.req("DELETE", "/api/v1/account", acc.tok, acc.body(t, nonce)), http.StatusForbidden)
	if !h.accountExists(t, acc.u) {
		t.Fatal("another account's challenge deleted this one")
	}
}

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

// A deployment with no relying party cannot verify factor 2 at all. That is a
// fact about the SERVER, and answering the ordinary 403 would send every user
// off to re-authenticate against a ceremony this process would refuse again —
// which is exactly how this endpoint spent months looking like a policy
// instead of a defect.
func TestDeleteAccountWithoutARelyingPartyIsUnavailableNotForbidden(t *testing.T) {
	h := newHarness(t) // deliberately NOT .passkeys()
	u := h.user("sub-alice")
	tok := h.session(u)

	w := h.req("DELETE", "/api/v1/account", tok, deleteBody{Nonce: "AA==", Sig: "AA=="})
	wantStatus(t, w, http.StatusServiceUnavailable)
	if !h.accountExists(t, u) {
		t.Fatal("the account was deleted by a server that cannot verify a re-authentication")
	}
}

// Rotation still takes an ID token and collects its two factors in one user
// gesture. A design where one expires while the other is still good produces a
// flow that fails halfway, for a reason the user cannot see.
func TestTheReauthWindowAndTheChallengeTTLAgree(t *testing.T) {
	if reauthMaxAge != purge.ChallengeTTL {
		t.Fatalf("reauthMaxAge %v != purge.ChallengeTTL %v", reauthMaxAge, purge.ChallengeTTL)
	}
}

func TestDeleteAccountRoutesNeedASession(t *testing.T) {
	h := newHarness(t).passkeys()
	wantStatus(t, h.req("POST", "/api/v1/account/challenge", "", struct{}{}), http.StatusUnauthorized)
	wantStatus(t, h.req("DELETE", "/api/v1/account", "", deleteBody{}), http.StatusUnauthorized)
}

// Malformed input describes the CALLER's own submission and reveals nothing
// about the account, so it is a 400. A client with a coding bug must not be
// sent into an endless re-authentication loop.
func TestDeleteAccountAnswers400ForMalformedInput(t *testing.T) {
	h := newHarness(t).passkeys()
	acc := h.deletable(t, "alice")
	for _, tc := range []struct {
		name string
		body deleteBody
	}{
		{name: "nonce is not base64", body: deleteBody{Nonce: "!!", Sig: "AA=="}},
		{name: "sig is not base64", body: deleteBody{Nonce: "AA==", Sig: "!!"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			wantStatus(t, h.req("DELETE", "/api/v1/account", acc.tok, tc.body), http.StatusBadRequest)
		})
	}
	if !h.accountExists(t, acc.u) {
		t.Fatal("a malformed request deleted the account")
	}
}
