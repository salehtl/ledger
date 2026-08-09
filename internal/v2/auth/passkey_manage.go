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
// # Sessions: what this does, and what it cannot do
//
// Removing a passkey must end the access that passkey bought. Otherwise
// "remove my lost phone" leaves the lost phone signed in, which is the exact
// thing the user was trying to stop.
//
// `sessions` DOES NOT RECORD WHICH CREDENTIAL AUTHENTICATED IT. The table is
// (token_hash, user_id, created_at, expires_at, revoked_at) — 00001, unchanged
// since — and Sessions.Issue is handed a user id and nothing else. So there is
// no way to end exactly the removed credential's sessions, and there is no
// honest way to answer "which credential is this session?" either.
//
// What this does instead is the closest correct behaviour available without a
// schema change: it revokes EVERY session of the account except the one making
// the request. That is a superset of the right answer.
//
//   - It achieves the security goal completely. Whatever sessions the removed
//     credential created are among the revoked ones, so the lost phone is signed
//     out, and its push tokens are deleted with it (forgetPushTokens, the same
//     sweep Revoke and RevokeAllForUser run — a device that stops being able to
//     write but keeps receiving lock-screen notifications has not been removed).
//   - It over-reaches. The user's OTHER devices, signed in with credentials
//     nobody asked to remove, are signed out too and have to re-authenticate
//     with a passkey they still hold. Annoying; not a lockout, because removing
//     the last credential is refused.
//   - The caller's own session survives, so the screen that issued the DELETE
//     keeps working. It is identified by its token hash, which the API layer
//     already computes for push registration (SessionHash).
//
// The fix is a migration adding a nullable sessions.credential_id referencing
// webauthn_credentials ON DELETE CASCADE, written at Issue time from the
// ceremony that minted the session. That would make this precise AND make the
// "this device" marker in the list real. It is deliberately NOT done here.

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

// DeleteCredential removes one of userID's credentials and ends the account's
// other sessions. It reports how many sessions it revoked.
//
// keepSessionHash is the SessionHash of the caller's own bearer token, which is
// spared. Pass nil to spare nothing — that is the honest degenerate case (no
// caller session means no session to keep), not a silent no-op.
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
		// be told a lost device can no longer sign in.
		return 0, fmt.Errorf("auth: passkey: delete credential: removed %d rows, want 1", tag.RowsAffected())
	}

	revoked, err := revokeOtherSessionsTx(ctx, tx, userID, keepSessionHash, p.now())
	if err != nil {
		return 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, fmt.Errorf("auth: passkey: delete credential: commit: %w", err)
	}
	return revoked, nil
}

// revokeOtherSessionsTx marks every session of userID revoked except the one
// named by keepHash, and deletes the push registrations of the ones it revoked.
//
// It runs in the CALLER'S transaction, so the credential's removal and the loss
// of the access it granted commit together. A sweep issued afterwards would
// leave a window in which the passkey is gone and its sessions are not, and a
// process that died in that window would leave it open for ever — the same
// argument forgetPushTokens' own doc makes about push tokens and revocation.
//
// `IS DISTINCT FROM` rather than `<>` so that a nil keepHash (no session to
// spare) revokes everything rather than nothing, which is what `<> NULL` would
// have quietly done.
func revokeOtherSessionsTx(ctx context.Context, tx pgx.Tx, userID uuid.UUID, keepHash []byte, now time.Time) (int64, error) {
	tag, err := tx.Exec(ctx,
		`UPDATE sessions SET revoked_at = $3
		  WHERE user_id = $1 AND revoked_at IS NULL AND token_hash IS DISTINCT FROM $2::bytea`,
		userID, keepHash, now)
	if err != nil {
		return 0, fmt.Errorf("auth: revoke other sessions for %s: %w", userID, err)
	}
	if err := forgetPushTokens(ctx, tx,
		`user_id = $1 AND session_hash IS DISTINCT FROM $2::bytea`, userID, keepHash); err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}
