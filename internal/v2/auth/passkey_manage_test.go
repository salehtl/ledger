package auth

// Tests for passkey_manage.go. The properties with teeth are not "it lists" and
// "it deletes". They are:
//
//   - the LAST credential cannot be removed, even by two callers racing;
//   - removing a credential takes its PRF key wrap with it, which is the
//     SCHEMA's cascade and therefore worth asserting rather than assuming;
//   - removing a credential ends the account's other sessions and spares the
//     caller's own;
//   - one account cannot see or touch another's credentials.

import (
	"bytes"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"ledger/internal/v2/authtest"
	"ledger/internal/v2/pgtest"
)

// addPasskey enrols a second (third, ...) credential through the real add
// ceremony, so the rows under test are the ones production writes.
func addPasskey(t *testing.T, p *Passkeys, userID uuid.UUID) *authtest.Authenticator {
	t.Helper()
	id, opts, err := p.BeginAdd(bgctx, userID)
	if err != nil {
		t.Fatalf("BeginAdd: %v", err)
	}
	a := authtest.New(t)
	if _, err := p.FinishAdd(bgctx, id, userID, a.Create(t, opts)); err != nil {
		t.Fatalf("FinishAdd: %v", err)
	}
	return a
}

func countCredentials(t *testing.T, pool *pgxpool.Pool, userID uuid.UUID) int {
	t.Helper()
	var n int
	if err := pool.QueryRow(bgctx,
		`SELECT count(*) FROM webauthn_credentials WHERE user_id = $1`, userID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

// putWrap stores a PRF wrap for one credential, exactly as
// api.handlePutKeyWrap does. Its survival is what the cascade test measures.
func putWrap(t *testing.T, pool *pgxpool.Pool, userID uuid.UUID, credID []byte) {
	t.Helper()
	wrapped := bytes.Repeat([]byte{7}, 159)
	if _, err := pool.Exec(bgctx,
		`INSERT INTO user_key_wraps (user_id, credential_id, wrapped, wrap_version, created_at)
		 VALUES ($1, $2, $3, 1, $4)`, userID, credID, wrapped, time.Now().UTC()); err != nil {
		t.Fatalf("insert wrap: %v", err)
	}
}

func countWraps(t *testing.T, pool *pgxpool.Pool, userID uuid.UUID) int {
	t.Helper()
	var n int
	if err := pool.QueryRow(bgctx,
		`SELECT count(*) FROM user_key_wraps WHERE user_id = $1`, userID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

// ---------------------------------------------------------------------------
// Attribution: which credential minted a session (00034)
// ---------------------------------------------------------------------------

// TestIssueRecordsTheCredentialThatAuthenticated pins the write half of 00034,
// including that plain Issue records NOTHING rather than a placeholder — the
// ID-token exchange authenticates no credential and must not appear to have.
func TestIssueRecordsTheCredentialThatAuthenticated(t *testing.T) {
	pool := pgtest.New(t)
	p := newPasskeys(t, pool)
	sessions := &Sessions{Pool: pool, TTL: time.Hour}
	userID, cred := enroll(t, p, mustMint(t, pool, "attribution"))

	attributed, err := sessions.IssueForCredential(bgctx, userID, cred.CredID)
	if err != nil {
		t.Fatalf("IssueForCredential: %v", err)
	}
	var got []byte
	if err := pool.QueryRow(bgctx, `SELECT credential_id FROM sessions WHERE token_hash = $1`,
		SessionHash(attributed)).Scan(&got); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, cred.CredID) {
		t.Fatalf("sessions.credential_id is %x, want %x", got, cred.CredID)
	}

	plain, err := sessions.Issue(bgctx, userID)
	if err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(bgctx, `SELECT credential_id FROM sessions WHERE token_hash = $1`,
		SessionHash(plain)).Scan(&got); err != nil {
		t.Fatal(err)
	}
	if got != nil {
		t.Fatalf("Issue recorded credential %x; a session no credential authenticated must record NULL", got)
	}

	// An EMPTY credential id is "unknown", not a credential named by zero bytes.
	// Stored as a zero-length bytea it would satisfy no foreign key and would
	// read as attributed, so it is normalized to NULL.
	empty, err := sessions.IssueForCredential(bgctx, userID, []byte{})
	if err != nil {
		t.Fatalf("IssueForCredential with an empty id: %v", err)
	}
	if err := pool.QueryRow(bgctx, `SELECT credential_id FROM sessions WHERE token_hash = $1`,
		SessionHash(empty)).Scan(&got); err != nil {
		t.Fatal(err)
	}
	if got != nil {
		t.Fatalf("an empty credential id was stored as %#v, want NULL", got)
	}

	// The foreign key is real: a credential this deployment never enrolled
	// cannot be recorded as having authenticated anything.
	if _, err := sessions.IssueForCredential(bgctx, userID, []byte("no such credential")); err == nil {
		t.Fatal("issued a session attributed to a credential that does not exist")
	}
}

// TestCredentialForSessionAnswersOnlyWhatItKnows is the read half — the source
// of the listing's "this device" marker. Three states, one answer each, and the
// two ignorant ones must be indistinguishable from each other.
func TestCredentialForSessionAnswersOnlyWhatItKnows(t *testing.T) {
	pool := pgtest.New(t)
	p := newPasskeys(t, pool)
	sessions := &Sessions{Pool: pool, TTL: time.Hour}
	userID, cred := enroll(t, p, mustMint(t, pool, "marker"))

	attributed, err := sessions.IssueForCredential(bgctx, userID, cred.CredID)
	if err != nil {
		t.Fatal(err)
	}
	got, err := sessions.CredentialForSession(bgctx, attributed)
	if err != nil {
		t.Fatalf("CredentialForSession: %v", err)
	}
	if !bytes.Equal(got, cred.CredID) {
		t.Fatalf("credential for the session is %x, want %x", got, cred.CredID)
	}

	legacy, err := sessions.Issue(bgctx, userID)
	if err != nil {
		t.Fatal(err)
	}
	if got, err := sessions.CredentialForSession(bgctx, legacy); err != nil || got != nil {
		t.Fatalf("an unattributed session answered (%x, %v), want (nil, nil) — the marker must be absent, not wrong", got, err)
	}
	if got, err := sessions.CredentialForSession(bgctx, "not a session token"); err != nil || got != nil {
		t.Fatalf("an unknown token answered (%x, %v), want (nil, nil)", got, err)
	}
}

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

func TestListCredentialsReturnsTheAccountsOwnCredentialsOldestFirst(t *testing.T) {
	pool := pgtest.New(t)
	p := newPasskeys(t, pool)
	userID, first := enroll(t, p, mustMint(t, pool, "two devices"))
	second := addPasskey(t, p, userID)

	got, err := p.ListCredentials(bgctx, userID)
	if err != nil {
		t.Fatalf("ListCredentials: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("%d credentials, want 2", len(got))
	}
	if !bytes.Equal(got[0].ID, first.CredID) || !bytes.Equal(got[1].ID, second.CredID) {
		t.Fatalf("credentials came back in the wrong order or with the wrong ids")
	}
	if got[0].CreatedAt.IsZero() {
		t.Fatal("created_at is zero")
	}
	// Neither has signed in yet: registration and the add ceremony both leave
	// last_used_at NULL, and a fabricated timestamp here would be the server
	// claiming a device was used when it was not.
	if got[0].LastUsedAt != nil || got[1].LastUsedAt != nil {
		t.Fatalf("last_used_at = %v/%v, want nil for credentials that have never asserted",
			got[0].LastUsedAt, got[1].LastUsedAt)
	}

	// A sign-in moves it, which is what makes the field worth showing.
	lid, lopts, err := p.BeginLogin(bgctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := p.FinishLogin(bgctx, lid, first.Assert(t, lopts, first.Counter+1)); err != nil {
		t.Fatalf("FinishLogin: %v", err)
	}
	got, err = p.ListCredentials(bgctx, userID)
	if err != nil {
		t.Fatal(err)
	}
	if got[0].LastUsedAt == nil {
		t.Fatal("last_used_at is still nil after a sign-in with that credential")
	}
	if got[1].LastUsedAt != nil {
		t.Fatal("signing in with one credential moved another's last_used_at")
	}
}

func TestListCredentialsNeverShowsAnotherAccountsCredentials(t *testing.T) {
	pool := pgtest.New(t)
	p := newPasskeys(t, pool)
	mine, myCred := enroll(t, p, mustMint(t, pool, "mine"))
	theirs, theirCred := enroll(t, p, mustMint(t, pool, "theirs"))

	got, err := p.ListCredentials(bgctx, mine)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || !bytes.Equal(got[0].ID, myCred.CredID) {
		t.Fatalf("listing for %s did not return exactly its own credential", mine)
	}
	got, err = p.ListCredentials(bgctx, theirs)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || !bytes.Equal(got[0].ID, theirCred.CredID) {
		t.Fatalf("listing for %s did not return exactly its own credential", theirs)
	}
}

// ---------------------------------------------------------------------------
// The refusal
// ---------------------------------------------------------------------------

func TestDeleteCredentialRefusesTheAccountsLastPasskey(t *testing.T) {
	pool := pgtest.New(t)
	p := newPasskeys(t, pool)
	userID, only := enroll(t, p, mustMint(t, pool, "one device"))

	if _, err := p.DeleteCredential(bgctx, userID, only.CredID, nil); !errors.Is(err, ErrLastPasskey) {
		t.Fatalf("DeleteCredential on the last passkey: %v, want ErrLastPasskey", err)
	}
	if n := countCredentials(t, pool, userID); n != 1 {
		t.Fatalf("%d credentials survive, want 1 — the refusal did not protect the row", n)
	}
	// And it is still a working sign-in, which is the fact the refusal exists to
	// preserve: a refusal that left an unusable credential would be worthless.
	lid, lopts, err := p.BeginLogin(bgctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := p.FinishLogin(bgctx, lid, only.Assert(t, lopts, only.Counter+1)); err != nil {
		t.Fatalf("the refused credential can no longer sign in: %v", err)
	}
}

func TestDeleteCredentialRefusesTheLastOneEvenAfterOthersWereRemoved(t *testing.T) {
	pool := pgtest.New(t)
	p := newPasskeys(t, pool)
	userID, first := enroll(t, p, mustMint(t, pool, "down to one"))
	second := addPasskey(t, p, userID)

	if _, err := p.DeleteCredential(bgctx, userID, first.CredID, nil); err != nil {
		t.Fatalf("DeleteCredential with two enrolled: %v", err)
	}
	if _, err := p.DeleteCredential(bgctx, userID, second.CredID, nil); !errors.Is(err, ErrLastPasskey) {
		t.Fatalf("DeleteCredential on the remaining passkey: %v, want ErrLastPasskey", err)
	}
	if n := countCredentials(t, pool, userID); n != 1 {
		t.Fatalf("%d credentials, want 1", n)
	}
}

// TestConcurrentDeletesCannotEmptyAnAccount is the check-then-act this code
// takes a row lock to prevent: two callers, two different credentials, an
// account holding exactly two. Unlocked, both see two, both delete one, and the
// account is left with nothing to sign in with.
//
// It MEASURES rather than asserts a mechanism: whatever the locking does, the
// account must end with a credential and exactly one caller must be refused.
func TestConcurrentDeletesCannotEmptyAnAccount(t *testing.T) {
	pool := pgtest.New(t)
	p := newPasskeys(t, pool)
	userID, first := enroll(t, p, mustMint(t, pool, "a race"))
	second := addPasskey(t, p, userID)

	var (
		wg   sync.WaitGroup
		mu   sync.Mutex
		errs []error
	)
	for _, cred := range [][]byte{first.CredID, second.CredID} {
		wg.Add(1)
		go func(id []byte) {
			defer wg.Done()
			_, err := p.DeleteCredential(bgctx, userID, id, nil)
			mu.Lock()
			errs = append(errs, err)
			mu.Unlock()
		}(cred)
	}
	wg.Wait()

	var refused, removed int
	for _, err := range errs {
		switch {
		case err == nil:
			removed++
		case errors.Is(err, ErrLastPasskey):
			refused++
		default:
			t.Fatalf("unexpected error from a concurrent delete: %v", err)
		}
	}
	if n := countCredentials(t, pool, userID); n != 1 {
		t.Fatalf("%d credentials left after two concurrent deletes, want 1 (removed=%d refused=%d)",
			n, removed, refused)
	}
	if removed != 1 || refused != 1 {
		t.Fatalf("removed=%d refused=%d, want exactly one of each", removed, refused)
	}
}

// ---------------------------------------------------------------------------
// Somebody else's credential
// ---------------------------------------------------------------------------

func TestDeleteCredentialCannotTouchAnotherAccountsPasskey(t *testing.T) {
	pool := pgtest.New(t)
	p := newPasskeys(t, pool)
	attacker, _ := enroll(t, p, mustMint(t, pool, "attacker"))
	addPasskey(t, p, attacker) // so the attacker is not stopped by the last-passkey rule
	victim, victimCred := enroll(t, p, mustMint(t, pool, "victim"))

	_, err := p.DeleteCredential(bgctx, attacker, victimCred.CredID, nil)
	if !errors.Is(err, ErrCredentialUnknown) {
		t.Fatalf("deleting another account's credential: %v, want ErrCredentialUnknown", err)
	}
	if n := countCredentials(t, pool, victim); n != 1 {
		t.Fatalf("the victim has %d credentials, want 1", n)
	}
	if _, err := p.DeleteCredential(bgctx, attacker, []byte("no such credential"), nil); !errors.Is(err, ErrCredentialUnknown) {
		t.Fatalf("deleting an id that exists nowhere: %v, want the SAME ErrCredentialUnknown", err)
	}
}

// ---------------------------------------------------------------------------
// The two consequences
// ---------------------------------------------------------------------------

// TestDeletingACredentialTakesItsKeyWrapWithIt asserts 00028's ON DELETE
// CASCADE. It is the schema and not this package that enforces it, which is
// exactly why it is measured: a wrap that outlived its credential is a row
// nothing can ever open, left behind by the operation the user believed removed
// that authenticator.
func TestDeletingACredentialTakesItsKeyWrapWithIt(t *testing.T) {
	pool := pgtest.New(t)
	p := newPasskeys(t, pool)
	userID, first := enroll(t, p, mustMint(t, pool, "prf"))
	second := addPasskey(t, p, userID)
	putWrap(t, pool, userID, first.CredID)
	putWrap(t, pool, userID, second.CredID)
	if n := countWraps(t, pool, userID); n != 2 {
		t.Fatalf("%d wraps before the delete, want 2", n)
	}

	if _, err := p.DeleteCredential(bgctx, userID, first.CredID, nil); err != nil {
		t.Fatalf("DeleteCredential: %v", err)
	}

	if n := countWraps(t, pool, userID); n != 1 {
		t.Fatalf("%d wraps after removing one credential, want 1", n)
	}
	var left []byte
	if err := pool.QueryRow(bgctx,
		`SELECT credential_id FROM user_key_wraps WHERE user_id = $1`, userID).Scan(&left); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(left, second.CredID) {
		t.Fatal("the surviving wrap belongs to the credential that was removed")
	}
}

// TestDeletingACredentialEndsOnlyThatCredentialsSessions is the point of the
// feature AND the narrowing 00034 bought: "remove my lost phone" has to end the
// lost phone's access and must NOT end the laptop's.
//
// Four sessions, one of each population the file header enumerates.
func TestDeletingACredentialEndsOnlyThatCredentialsSessions(t *testing.T) {
	pool := pgtest.New(t)
	p := newPasskeys(t, pool)
	sessions := &Sessions{Pool: pool, TTL: time.Hour}
	userID, lost := enroll(t, p, mustMint(t, pool, "lost phone"))
	laptop := addPasskey(t, p, userID)

	// The caller is standing on the laptop's credential and is removing the
	// phone's, which is the ordinary shape of this operation.
	caller, err := sessions.IssueForCredential(bgctx, userID, laptop.CredID)
	if err != nil {
		t.Fatal(err)
	}
	lostPhone, err := sessions.IssueForCredential(bgctx, userID, lost.CredID)
	if err != nil {
		t.Fatal(err)
	}
	// A second laptop session, same surviving credential: it must live.
	otherLaptop, err := sessions.IssueForCredential(bgctx, userID, laptop.CredID)
	if err != nil {
		t.Fatal(err)
	}
	// A session this server cannot attribute — pre-00034, or the ID-token
	// exchange. It goes, because it might be the phone.
	legacy, err := sessions.Issue(bgctx, userID)
	if err != nil {
		t.Fatal(err)
	}
	other, _ := enroll(t, p, mustMint(t, pool, "a different account"))
	bystander, err := sessions.Issue(bgctx, other)
	if err != nil {
		t.Fatal(err)
	}

	revoked, err := p.DeleteCredential(bgctx, userID, lost.CredID, SessionHash(caller))
	if err != nil {
		t.Fatalf("DeleteCredential: %v", err)
	}
	if revoked != 2 {
		t.Fatalf("revoked %d sessions, want 2 (the removed credential's, and the unattributed one)", revoked)
	}

	if _, err := sessions.Resolve(bgctx, lostPhone); !errors.Is(err, ErrSessionRevoked) {
		t.Fatalf("the removed credential's session resolves as %v, want ErrSessionRevoked — the lost phone is still signed in", err)
	}
	if _, err := sessions.Resolve(bgctx, legacy); !errors.Is(err, ErrSessionRevoked) {
		t.Fatalf("an unattributed session resolves as %v, want ErrSessionRevoked — it might have been the lost phone's", err)
	}
	if got, err := sessions.Resolve(bgctx, otherLaptop); err != nil || got != userID {
		t.Fatalf("a session belonging to a DIFFERENT credential was revoked: %v", err)
	}
	if got, err := sessions.Resolve(bgctx, caller); err != nil || got != userID {
		t.Fatalf("the caller's own session was revoked by its own request: %v", err)
	}
	if got, err := sessions.Resolve(bgctx, bystander); err != nil || got != other {
		t.Fatalf("another account's session was revoked: %v", err)
	}
}

// TestRemovingTheCredentialYourOwnSessionUsesSignsYouOut pins the answer to the
// one case keepSessionHash does NOT cover. The caller is spared from the
// unattributed sweep, never from the credential's own: they removed the thing
// that let them in, so they sign in again with a passkey they still hold.
func TestRemovingTheCredentialYourOwnSessionUsesSignsYouOut(t *testing.T) {
	pool := pgtest.New(t)
	p := newPasskeys(t, pool)
	sessions := &Sessions{Pool: pool, TTL: time.Hour}
	userID, thisDevice := enroll(t, p, mustMint(t, pool, "retiring this device"))
	spare := addPasskey(t, p, userID)

	caller, err := sessions.IssueForCredential(bgctx, userID, thisDevice.CredID)
	if err != nil {
		t.Fatal(err)
	}
	survivor, err := sessions.IssueForCredential(bgctx, userID, spare.CredID)
	if err != nil {
		t.Fatal(err)
	}

	if _, err := p.DeleteCredential(bgctx, userID, thisDevice.CredID, SessionHash(caller)); err != nil {
		t.Fatalf("DeleteCredential: %v", err)
	}
	if _, err := sessions.Resolve(bgctx, caller); !errors.Is(err, ErrSessionRevoked) {
		t.Fatalf("the caller's session resolves as %v after removing the credential that minted it, "+
			"want ErrSessionRevoked — its passkey is gone", err)
	}
	if got, err := sessions.Resolve(bgctx, survivor); err != nil || got != userID {
		t.Fatalf("the session on the remaining passkey was revoked too: %v", err)
	}
}

// TestRemovingACredentialDoesNotDeleteItsSessionRows is the CASCADE-versus-SET
// NULL decision, asserted rather than trusted to a schema nobody re-reads.
//
// A cascade would remove the session row outright. Resolve would then answer
// ErrSessionUnknown ("someone typed garbage") instead of ErrSessionRevoked
// ("someone is using a revoked credential"), and — the reason that matters —
// 00021's BEFORE DELETE trigger on users would find no row to tombstone, so
// that device could never be told 410 and would never wipe its local ledger.
func TestRemovingACredentialDoesNotDeleteItsSessionRows(t *testing.T) {
	pool := pgtest.New(t)
	p := newPasskeys(t, pool)
	sessions := &Sessions{Pool: pool, TTL: time.Hour}
	userID, first := enroll(t, p, mustMint(t, pool, "cascade or set null"))
	addPasskey(t, p, userID)

	tok, err := sessions.IssueForCredential(bgctx, userID, first.CredID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := p.DeleteCredential(bgctx, userID, first.CredID, nil); err != nil {
		t.Fatalf("DeleteCredential: %v", err)
	}

	var (
		revoked *time.Time
		cred    []byte
	)
	if err := pool.QueryRow(bgctx,
		`SELECT revoked_at, credential_id FROM sessions WHERE token_hash = $1`,
		SessionHash(tok)).Scan(&revoked, &cred); err != nil {
		t.Fatalf("the session row is gone after its credential was removed — the FK cascades "+
			"where it must SET NULL: %v", err)
	}
	if revoked == nil {
		t.Fatal("the session row survived but was not revoked")
	}
	if cred != nil {
		t.Fatalf("credential_id is %x, want NULL: the FK did not SET NULL", cred)
	}
	// And the token still answers the useful 401 rather than the useless one.
	if _, err := sessions.Resolve(bgctx, tok); !errors.Is(err, ErrSessionRevoked) {
		t.Fatalf("Resolve says %v, want ErrSessionRevoked", err)
	}
}
