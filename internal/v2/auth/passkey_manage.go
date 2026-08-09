package auth

// Managing enrolled passkeys: listing them, and removing one.
//
// It is a separate file from passkey.go for the same reason reauth.go is —
// nothing here is a ceremony. There is no challenge, no webauthn_ceremonies
// row, no begin step and no signature to verify: the caller already holds a
// session, and a session is exactly the authority these two operations need,
// because neither of them can be used to GAIN access. One reads a list of
// opaque ids; the other takes access away.
//
// # The refusal that matters
//
// [Passkeys.DeleteCredential] refuses to remove an account's LAST credential,
// and that refusal is here rather than in the API layer or in the screen. A
// passkey is the only way into a v2 account: there is no password, no reset
// mail, and the recovery phrase unlocks DATA — it does not restore ACCESS.
// Removing the last one is therefore an unrecoverable lockout, and a rule that
// lives in a client is a rule the next client forgets.
//
// The count and the delete run in ONE transaction, over rows locked FOR UPDATE,
// because the naive version is a check-then-act with a real window in it: two
// concurrent deletes against an account holding exactly two credentials would
// each see two, each delete one, and leave an account nobody can sign into.
// Locking every credential row of the account makes the second one wait and
// then see the truth.
//
// # Removing a credential takes its PRF key wrap with it
//
// user_key_wraps.credential_id references webauthn_credentials(credential_id)
// ON DELETE CASCADE (00028), so the DELETE below removes the wrap as well. That
// is the intended lifecycle — a wrap that outlived the only authenticator that
// could open it is a row nothing can ever use — and losing it costs nothing,
// because the recovery phrase still opens the account. It is asserted in a test
// rather than trusted, since it is the schema and not this code that enforces
// it.
//
// # Sessions: exactly the removed credential's, and what "exactly" cannot cover
//
// Removing a passkey must end the access that passkey bought. Otherwise
// "remove my lost phone" leaves the lost phone signed in, which is the exact
// thing the user was trying to stop. It must NOT end anything else: signing a
// user's laptop out because they retired a phone is a superset of the right
// answer, and it was the shipped behaviour until 00034 added
// sessions.credential_id.
//
// With the column, this revokes three populations and leaves one alone:
//
//   - REVOKED: sessions attributed to the credential being removed. This is the
//     feature. Their push registrations go with them (forgetPushTokens, the same
//     sweep Revoke and RevokeAllForUser run — a device that stops being able to
//     write but keeps receiving lock-screen notifications has not been removed).
//   - REVOKED: sessions attributed to NO credential, other than the caller's
//     own. NULL means this server cannot say which credential minted the
//     session — it predates 00034, or it came from the ID-token exchange — and
//     "might be the phone we are removing" is the one case where erring towards
//     signing a device out is the safe direction. It is a shrinking population:
//     every passkey session minted from now on is attributed, and every session
//     expires.
//   - REVOKED, if it is the removed credential's: the caller's own session. A
//     user who removes the credential they are standing on has removed the thing
//     that let them in, and the honest consequence is that they sign in again
//     with one of the passkeys they still hold — guaranteed to exist, because
//     removing the last one is refused. The listing marks this row "current"
//     precisely so it is a decision and not an accident.
//   - UNTOUCHED: sessions attributed to the account's OTHER credentials, and the
//     caller's own session when it is not the removed credential's. That is the
//     narrowing 00034 bought.
//
// Ordering matters and is not incidental: the revocation runs BEFORE the
// credential row is deleted. sessions.credential_id is ON DELETE SET NULL
// (00034 says why it is not CASCADE), so the DELETE erases the attribution —
// a sweep issued afterwards would match nothing at all.
//
// It all runs in ONE transaction, so the credential's removal and the loss of
// the access it granted commit together.

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// ErrLastPasskey is the refusal above. It does NOT wrap ErrPasskeyRejected:
// nothing about the credential was rejected, the operation was — the HTTP layer
// answers it 409 with its own code rather than collapsing it into the package's
// one 401.
var ErrLastPasskey = errors.New("auth: refusing to remove the account's last passkey")

// Credential is one enrolled authenticator, in the only shape anything outside
// this package is allowed to see it.
//
// There is NO public key here and there must not be one. A caller listing their
// own credentials has no use for the key bytes, and a list endpoint that
// returns key material is a liability with no offsetting benefit. AAGUID is a
// model identifier, not key material — it is here so the API layer can name an
// authenticator if it ever ships a way to resolve one.
type Credential struct {
	// ID is the raw credential id: the bytes the browser calls rawId, and the
	// key the DELETE path takes.
	ID []byte
	// AAGUID identifies the authenticator MODEL, or is empty when the
	// authenticator supplied none (attestation is not requested, so many do
	// not).
	AAGUID []byte
	// CreatedAt is when the credential was enrolled.
	CreatedAt time.Time
	// LastUsedAt is nil for a credential that has never completed an assertion.
	// It moves on every sign-in and on every re-authentication — see
	// touchCredential, which advances it even when the signature counter cannot.
	LastUsedAt *time.Time
}

// ListCredentials returns the credentials enrolled by userID, oldest first.
//
// The account comes from the caller's session and is the ONLY filter: there is
// no parameter by which a caller could ask about somebody else's credentials,
// which is what makes cross-account listing impossible rather than merely
// refused.
func (p *Passkeys) ListCredentials(ctx context.Context, userID uuid.UUID) ([]Credential, error) {
	if p == nil || p.Pool == nil {
		return nil, errors.New("auth: Passkeys is not configured")
	}
	if userID == uuid.Nil {
		return nil, errors.New("auth: passkey: ListCredentials: user id is zero")
	}
	rows, err := p.Pool.Query(ctx,
		`SELECT credential_id, aaguid, created_at, last_used_at
		   FROM webauthn_credentials WHERE user_id = $1 ORDER BY created_at, credential_id`,
		userID)
	if err != nil {
		return nil, fmt.Errorf("auth: passkey: list credentials for %s: %w", userID, err)
	}
	defer rows.Close()
	var out []Credential
	for rows.Next() {
		var c Credential
		if err := rows.Scan(&c.ID, &c.AAGUID, &c.CreatedAt, &c.LastUsedAt); err != nil {
			return nil, fmt.Errorf("auth: passkey: list credentials for %s: %w", userID, err)
		}
		out = append(out, c)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("auth: passkey: list credentials for %s: %w", userID, err)
	}
	return out, nil
}

// DeleteCredential removes one of userID's credentials and ends the sessions
// that credential created. It reports how many sessions it revoked.
//
// keepSessionHash is the SessionHash of the caller's own bearer token. It
// spares that session from the UNATTRIBUTED sweep only — a session this server
// cannot attribute is revoked on suspicion, and the one it is answering right
// now is the one session it has no reason to suspect. It does NOT spare a
// caller whose session was minted by the credential being removed; see the file
// header. Pass nil to spare nothing, which is the honest degenerate case (no
// caller session means no session to keep) rather than a silent no-op.
//
// Two rejections, and they are different kinds of fact:
//
//   - ErrCredentialUnknown: no credential with that id belongs to userID. It is
//     deliberately the same answer for "no such credential anywhere" and "that
//     credential is somebody else's" — telling them apart says whether an id
//     exists and whose it is.
//   - ErrLastPasskey: it is theirs, and it is the only one. See the file header.
func (p *Passkeys) DeleteCredential(ctx context.Context, userID uuid.UUID, credentialID, keepSessionHash []byte) (int64, error) {
	if p == nil || p.Pool == nil {
		return 0, errors.New("auth: Passkeys is not configured")
	}
	if userID == uuid.Nil {
		return 0, errors.New("auth: passkey: DeleteCredential: user id is zero")
	}
	if len(credentialID) == 0 {
		return 0, ErrCredentialUnknown
	}

	// READ COMMITTED pinned rather than inherited, for the reason upsertUser
	// pins it: default_transaction_isolation is settable per database, per role
	// and by a pooler, and the lock-then-count below relies on a waiter taking a
	// FRESH snapshot when the lock is released. Under REPEATABLE READ the second
	// transaction would wake up and still see the row the first one deleted,
	// which is precisely the miscount this lock exists to prevent.
	tx, err := p.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return 0, fmt.Errorf("auth: passkey: delete credential: begin: %w", err)
	}
	defer func() {
		rbCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		_ = tx.Rollback(rbCtx)
	}()

	// Every credential row of this account, locked. The lock is what makes the
	// count below a fact rather than a guess: a concurrent delete against the
	// same account blocks here and re-reads afterwards.
	rows, err := tx.Query(ctx,
		`SELECT credential_id FROM webauthn_credentials WHERE user_id = $1 ORDER BY credential_id FOR UPDATE`,
		userID)
	if err != nil {
		return 0, fmt.Errorf("auth: passkey: delete credential: lock credentials: %w", err)
	}
	var (
		total int
		found bool
	)
	for rows.Next() {
		var id []byte
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return 0, fmt.Errorf("auth: passkey: delete credential: %w", err)
		}
		total++
		if bytes.Equal(id, credentialID) {
			found = true
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, fmt.Errorf("auth: passkey: delete credential: %w", err)
	}
	if !found {
		return 0, ErrCredentialUnknown
	}
	if total <= 1 {
		return 0, ErrLastPasskey
	}

	// BEFORE the DELETE, not after, and the two orders are NOT equivalent.
	// sessions.credential_id is ON DELETE SET NULL, so the DELETE erases every
	// session's record of having been minted by this credential; run afterwards,
	// the first half of the predicate would match nothing and those sessions
	// would fall into the unattributed half — where the CALLER'S OWN is spared.
	// A user removing the credential their own session was minted with would
	// keep a session no passkey backs any more. Proved by mutation:
	// TestRemovingTheCredentialYourOwnSessionUsesSignsYouOut fails on this
	// swap.
	revoked, err := revokeCredentialSessionsTx(ctx, tx, userID, credentialID, keepSessionHash, p.now())
	if err != nil {
		return 0, err
	}

	// user_id is in the WHERE clause as well as the id, so this statement is
	// correct on its own terms and not only because of the check above.
	tag, err := tx.Exec(ctx,
		`DELETE FROM webauthn_credentials WHERE credential_id = $1 AND user_id = $2`,
		credentialID, userID)
	if err != nil {
		return 0, fmt.Errorf("auth: passkey: delete credential: %w", err)
	}
	if tag.RowsAffected() != 1 {
		// Unreachable behind the lock, and checked anyway: a delete that removed
		// nothing must not be reported as a removal, because the user is about to
		// be told a lost device can no longer sign in. The revocation above rolls
		// back with it.
		return 0, fmt.Errorf("auth: passkey: delete credential: removed %d rows, want 1", tag.RowsAffected())
	}

	if err := tx.Commit(ctx); err != nil {
		return 0, fmt.Errorf("auth: passkey: delete credential: commit: %w", err)
	}
	return revoked, nil
}

// revokeCredentialSessionsTx marks revoked every session of userID that the
// credential credID minted, plus every session this server cannot attribute
// except the one named by keepHash, and deletes those sessions' push
// registrations.
//
// The predicate is written once, here, and both statements take it, because the
// failure mode of two nearly-identical WHERE clauses is a session that is
// revoked while its notifications keep arriving — the hole 00019 was written to
// close.
//
//	credential_id = $2                                  the feature
//	OR (credential_id IS NULL AND <not the caller>)      the unattributable
//
// It runs in the CALLER'S transaction, so the credential's removal and the loss
// of the access it granted commit together. A sweep issued afterwards would
// leave a window in which the passkey is gone and its sessions are not, and a
// process that died in that window would leave it open for ever — the same
// argument forgetPushTokens' own doc makes about push tokens and revocation.
//
// `IS DISTINCT FROM` rather than `<>` so that a nil keepHash (no session to
// spare) sweeps the unattributed rows rather than none of them, which is what
// `<> NULL` would have quietly done.
//
// Note keepHash does NOT protect the caller from the first clause. A caller
// removing the credential their own session was minted with is signed out; see
// the file header for why that is the honest answer rather than an oversight.
func revokeCredentialSessionsTx(ctx context.Context, tx pgx.Tx, userID uuid.UUID,
	credID, keepHash []byte, now time.Time) (int64, error) {
	// The one predicate, in the one place. $1 user, $2 credential, $3 the
	// caller's own token hash.
	const doomed = `user_id = $1
	                  AND (credential_id = $2::bytea
	                       OR (credential_id IS NULL AND token_hash IS DISTINCT FROM $3::bytea))`

	tag, err := tx.Exec(ctx,
		`UPDATE sessions SET revoked_at = $4 WHERE revoked_at IS NULL AND `+doomed,
		userID, credID, keepHash, now)
	if err != nil {
		return 0, fmt.Errorf("auth: revoke sessions of credential for %s: %w", userID, err)
	}
	// push_tokens and push_subscriptions carry session_hash (NOT NULL, foreign
	// key into sessions.token_hash — 00019, 00029) and no credential of their
	// own. So the same population is named by selecting it back out of
	// `sessions` rather than by writing a second, nearly-identical guess: a
	// registration is doomed exactly when the session that made it is.
	//
	// Not restricted to `revoked_at IS NULL`: an already-revoked session's
	// registration must still go, for the reason Revoke's doc gives — the
	// failure being closed is a device that keeps receiving after the user
	// believes they stopped it.
	if err := forgetPushTokens(ctx, tx,
		`user_id = $1 AND session_hash IN (SELECT token_hash FROM sessions WHERE `+doomed+`)`,
		userID, credID, keepHash); err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}
