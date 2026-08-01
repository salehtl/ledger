package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"ledger/internal/v2/oplog"
)

// sessionTokenBytes is the entropy in a session token, before encoding. 32
// bytes from crypto/rand is not guessable, not enumerable, and not shortenable
// for prettiness: this is the whole secret behind every authenticated request.
const sessionTokenBytes = 32

// Session rejection reasons. All of them wrap ErrSessionInvalid so a caller
// can ask the single question it actually cares about.
//
// The HTTP layer must return the SAME 401 for all of them EXCEPT the last.
// "Expired" and "revoked" both confirm that the token was once real, which "no
// such session" does not; telling them apart is an oracle in a response and a
// useful detail only in a log.
//
// ErrSessionAccountDeleted is the deliberate exception, and it is not an
// oracle: it is a fact about an account that no longer exists, offered to the
// one party that already holds that account's session token. It exists because
// the device has to be able to tell "sign in again" from "there is nothing to
// sign in to", and only the second one may make it wipe local data. See
// 00021_deleted_account_sessions.sql for why this cannot be detected by looking
// for a session whose user row is missing.
var (
	ErrSessionInvalid        = errors.New("auth: session token is not valid")
	ErrSessionUnknown        = fmt.Errorf("%w: no such session", ErrSessionInvalid)
	ErrSessionExpired        = fmt.Errorf("%w: session expired", ErrSessionInvalid)
	ErrSessionRevoked        = fmt.Errorf("%w: session revoked", ErrSessionInvalid)
	ErrSessionAccountDeleted = fmt.Errorf("%w: the account this session belonged to was deleted", ErrSessionInvalid)
)

// Sessions issues and resolves opaque server-side session tokens.
//
// Read the package doc before wiring Resolve into anything: a live session is
// a deliberately weak capability (spec §3.4) and is NOT sufficient authority
// for writer registration, account deletion, or inbound-address rotation.
type Sessions struct {
	Pool *pgxpool.Pool
	// TTL is how long an issued session stays valid. It must be positive;
	// Issue refuses otherwise rather than minting a session that is already
	// dead, which would present as an unexplained sign-in loop.
	TTL time.Duration
	// Now defaults to time.Now. Expiry is evaluated against THIS clock and
	// never against Postgres's now(), so a test can advance time and so that
	// one clock decides both when a session was minted and when it dies.
	Now func() time.Time
}

func (s *Sessions) now() time.Time {
	if s.Now != nil {
		return s.Now()
	}
	return time.Now()
}

// tokenHash is the only representation of a session token that is ever
// persisted. The database column is named token_hash for the same reason.
func tokenHash(token string) []byte {
	sum := sha256.Sum256([]byte(token))
	return sum[:]
}

// SessionHash is tokenHash, exported for the one caller outside this package
// that legitimately needs it: api's push-token registration stores which
// session registered a device, so that signing that session out also stops its
// notifications (00019_push_token_device_link.sql).
//
// It is a hash and not the token, which is the point — the API layer never
// holds a persistable form of a credential, and a push_tokens row leaked to a
// log or a backup names a session without being usable as one.
func SessionHash(token string) []byte { return tokenHash(token) }

// forgetPushTokens is the sweep both revocation paths in this file share.
//
// # Why auth writes a table that belongs to pushv2
//
// It is deliberate and it is not layering sloppiness: a revocation that stops a
// device from WRITING but leaves it receiving a real-time "New transaction" on
// its lock screen is not a revocation. Before 00019 that was exactly the
// behaviour — a stolen phone kept the notification feed for the life of the
// account and neither the user nor the operator had any way to stop it.
//
// It runs inside the caller's transaction so that the two facts commit
// together. A sweep issued afterwards, as a second statement, would leave a
// window where the key is retired and the notifications are not, and — worse —
// a process that died in that window would leave it open permanently, with
// nothing in the system that would ever notice.
func forgetPushTokens(ctx context.Context, tx pgx.Tx, where string, args ...any) error {
	if _, err := tx.Exec(ctx, `DELETE FROM push_tokens WHERE `+where, args...); err != nil {
		return fmt.Errorf("auth: forget push tokens: %w", err)
	}
	return nil
}

// Issue mints a session for userID and returns the bearer token. The token is
// returned exactly once, to exactly one caller, and is never recoverable from
// the database afterwards.
func (s *Sessions) Issue(ctx context.Context, userID uuid.UUID) (string, error) {
	if s.Pool == nil {
		return "", errors.New("auth: Sessions.Pool is nil")
	}
	if userID == uuid.Nil {
		return "", errors.New("auth: issue session: user id is zero")
	}
	if s.TTL <= 0 {
		return "", fmt.Errorf("auth: issue session: TTL is %v, want a positive duration", s.TTL)
	}
	raw := make([]byte, sessionTokenBytes)
	if _, err := rand.Read(raw); err != nil {
		// Unreachable on Go 1.25 (crypto/rand panics rather than failing), but
		// a silently short token would be catastrophic, so this is checked
		// rather than assumed.
		return "", fmt.Errorf("auth: issue session: read random: %w", err)
	}
	// RawURLEncoding: no padding, and no characters needing escaping in an
	// Authorization header, which is the ONLY place this token may travel. It
	// must never be put in a URL — query strings land in access logs, browser
	// history and Referer headers, none of which should ever hold a live
	// credential. The token is hashed in its ENCODED form, the form that
	// arrives on the wire, so Resolve never has to decode attacker-supplied
	// base64 to look a session up.
	token := base64.RawURLEncoding.EncodeToString(raw)
	now := s.now()
	_, err := s.Pool.Exec(ctx,
		`INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES ($1, $2, $3, $4)`,
		tokenHash(token), userID, now, now.Add(s.TTL))
	if err != nil {
		return "", fmt.Errorf("auth: issue session for user %s: %w", userID, err)
	}
	return token, nil
}

// Resolve returns the user a live session belongs to, or an error wrapping
// ErrSessionInvalid.
//
// # On constant time
//
// The lookup is by primary key on SHA-256(token), and a B-tree probe is not
// constant time — that cannot be fixed at this layer and does not need to be:
// the value whose comparison leaks timing is a preimage-resistant digest, so
// an attacker who could read that timing perfectly would learn about the
// digest, not the token, and would still have to invert SHA-256 to produce a
// bearer credential.
//
// The subtle.ConstantTimeCompare below is therefore not what makes this safe;
// the hashing is. It is here as a structural guard: it makes the byte-wise
// equality of the secret-derived value explicit at the one place a future
// refactor might reintroduce a variable-time comparison (say, by resolving on
// a non-secret column and comparing tokens in Go).
func (s *Sessions) Resolve(ctx context.Context, token string) (uuid.UUID, error) {
	if s.Pool == nil {
		return uuid.Nil, errors.New("auth: Sessions.Pool is nil")
	}
	if token == "" {
		return uuid.Nil, ErrSessionUnknown
	}
	want := tokenHash(token)
	var (
		stored  []byte
		userID  uuid.UUID
		expires time.Time
		revoked *time.Time
	)
	err := s.Pool.QueryRow(ctx,
		`SELECT token_hash, user_id, expires_at, revoked_at FROM sessions WHERE token_hash = $1`,
		want).Scan(&stored, &userID, &expires, &revoked)
	if errors.Is(err, pgx.ErrNoRows) {
		// The session row is GONE, which is the only state a deleted account
		// leaves behind: sessions.user_id cascades from users, so the deletion
		// took every row with it. The tombstone is the one place that remembers,
		// and it is consulted only here — on a token this server does not
		// recognize — so the common path pays nothing.
		return uuid.Nil, s.deletedOrUnknown(ctx, want)
	}
	if err != nil {
		return uuid.Nil, fmt.Errorf("auth: resolve session: %w", err)
	}
	if subtle.ConstantTimeCompare(stored, want) != 1 {
		return uuid.Nil, ErrSessionUnknown
	}
	if revoked != nil {
		return uuid.Nil, ErrSessionRevoked
	}
	if !expires.After(s.now()) {
		return uuid.Nil, ErrSessionExpired
	}
	return userID, nil
}

// deletedOrUnknown answers the one question an unrecognized token can still be
// asked: did this token belong to an account that was deleted?
//
// It reads the tombstone 00021 fills in from a BEFORE DELETE trigger on users.
// A row past its own recorded expiry answers nothing — a session that would
// have died anyway gets the ordinary "unknown", because at that point "expired"
// is a true and sufficient statement and 410 would be claiming knowledge about
// a credential that is dead either way.
//
// Any error reading the tombstone degrades to ErrSessionUnknown rather than
// propagating: the caller is about to reject this token no matter what, and
// turning a rejected credential into a 500 because a supplementary lookup
// failed would be a worse answer than the 401 that was already correct.
func (s *Sessions) deletedOrUnknown(ctx context.Context, tokenHash []byte) error {
	var expires time.Time
	err := s.Pool.QueryRow(ctx,
		`SELECT expires_at FROM deleted_account_sessions WHERE token_hash = $1`,
		tokenHash).Scan(&expires)
	if err != nil || !expires.After(s.now()) {
		return ErrSessionUnknown
	}
	return ErrSessionAccountDeleted
}

// Revoke kills one session. It is idempotent: revoking an already-revoked
// session leaves the original revoked_at in place (the guard in the WHERE
// clause), and revoking a token that was never issued is a no-op rather than
// an error — the caller presenting it cannot be told whether it existed.
//
// It ALSO deletes every push token registered by that session, in the same
// transaction. Signing a device out is one of the two ways a user disowns a
// phone, and the notification feed has to end with the access — see
// forgetPushTokens. Note the sweep is NOT guarded by `revoked_at IS NULL`:
// re-revoking an already-revoked session must still clear any token that
// somehow survived, because the failure this closes is a device that keeps
// receiving after the user believes they stopped it.
func (s *Sessions) Revoke(ctx context.Context, token string) error {
	if s.Pool == nil {
		return errors.New("auth: Sessions.Pool is nil")
	}
	if token == "" {
		return nil
	}
	hash := tokenHash(token)
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("auth: revoke session: begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx,
		`UPDATE sessions SET revoked_at = $2 WHERE token_hash = $1 AND revoked_at IS NULL`,
		hash, s.now()); err != nil {
		return fmt.Errorf("auth: revoke session: %w", err)
	}
	if err := forgetPushTokens(ctx, tx, `session_hash = $1`, hash); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("auth: revoke session: commit: %w", err)
	}
	return nil
}

// RevokeAllForUser is "sign out everywhere". Rows are marked rather than
// deleted so that a token presented after revocation resolves to
// ErrSessionRevoked instead of ErrSessionUnknown, which is the difference
// between a log line that says "someone is using a revoked credential" and one
// that says "someone typed garbage".
//
// Push tokens ARE deleted, not marked: "everywhere" has to include the
// notifications, and there is no equivalent diagnostic value in keeping a
// tombstone for a device that must stop being POSTed to.
func (s *Sessions) RevokeAllForUser(ctx context.Context, userID uuid.UUID) error {
	if s.Pool == nil {
		return errors.New("auth: Sessions.Pool is nil")
	}
	if userID == uuid.Nil {
		return errors.New("auth: revoke all: user id is zero")
	}
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("auth: revoke all sessions for user %s: begin: %w", userID, err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx,
		`UPDATE sessions SET revoked_at = $2 WHERE user_id = $1 AND revoked_at IS NULL`,
		userID, s.now()); err != nil {
		return fmt.Errorf("auth: revoke all sessions for user %s: %w", userID, err)
	}
	if err := forgetPushTokens(ctx, tx, `user_id = $1`, userID); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("auth: revoke all sessions for user %s: commit: %w", userID, err)
	}
	return nil
}

// UpsertUser returns the user id for a verified Identity, creating the user on
// first sign-in — WITH NO INVITE GATE.
//
// # Read this before calling it
//
// This is the ungated creation path. It exists for test and operator seeding,
// and after Phase 2's Task 6 no production request path calls it: the sign-in
// exchange calls UpsertUserInvited, and the address-rotation path (which used
// to call this to "resolve" a re-authenticating identity, and thereby minted a
// users row on every rejected attempt) now calls IdentityMatchesUser instead
// and creates nothing. A new caller here is a new way past the closed beta's
// only gate, so add one deliberately or not at all.
//
// The user row and its oplog_seq counter row are created in ONE transaction.
// That is a requirement, not tidiness: oplog.Appender documents its
// `INSERT ... ON CONFLICT DO NOTHING` on oplog_seq as dead code in steady
// state precisely because the counter row already exists by the time a user
// can append anything. A user committed without its counter row would make
// that claim false and put a live race on the append path.
//
// Only a VERIFIED Identity may be passed here — one that came out of a
// Verifier. Nothing in this function can tell a verified subject from an
// attacker-supplied string.
func UpsertUser(ctx context.Context, pool *pgxpool.Pool, id Identity) (uuid.UUID, error) {
	return upsertUser(ctx, pool, id, nil)
}

// UpsertUserInvited is UpsertUser behind the closed beta's gate: an identity
// that already has an account signs in and the code is IGNORED ENTIRELY, while
// an identity that does not gets an account only if code redeems an unredeemed
// invite. It returns ErrNotInvited otherwise, and creates nothing.
//
// The redemption happens in the SAME transaction as the account, which is what
// makes "single use" true rather than nearly true. Every failure mode a
// two-statement version would have — a code marked spent for an account that
// was never created, an account created against a code someone else spent a
// millisecond earlier — is a rollback here instead.
func UpsertUserInvited(ctx context.Context, pool *pgxpool.Pool, id Identity, code string) (uuid.UUID, error) {
	return upsertUser(ctx, pool, id, &code)
}

// upsertUser is the body both entry points share. invite is nil when creation
// is unconditional and non-nil (possibly empty) when it must be paid for.
func upsertUser(ctx context.Context, pool *pgxpool.Pool, id Identity, invite *string) (uuid.UUID, error) {
	if pool == nil {
		return uuid.Nil, errors.New("auth: UpsertUser: pool is nil")
	}
	if !validIdP(id.IdP) {
		return uuid.Nil, fmt.Errorf("auth: UpsertUser: idp is %q, want %q or %q", id.IdP, IdPApple, IdPGoogle)
	}
	if id.Subject == "" {
		return uuid.Nil, errors.New("auth: UpsertUser: identity has no subject")
	}
	hash := SubjectHash(id.IdP, id.Subject)

	// Pinned rather than inherited, for the same reason the oplog appender pins it:
	// default_transaction_isolation is settable per database, per role and by
	// a pooler, and the insert-then-select below relies on READ COMMITTED
	// taking a fresh snapshot for the second statement. Under REPEATABLE READ
	// the SELECT would run against the snapshot from before the concurrent
	// inserter committed, find nothing, and turn a routine concurrent
	// first-login into an error.
	tx, err := pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return uuid.Nil, fmt.Errorf("auth: UpsertUser: begin: %w", err)
	}
	defer func() {
		rbCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		_ = tx.Rollback(rbCtx)
	}()

	// Two statements, not one ON CONFLICT DO UPDATE: DO NOTHING suppresses
	// RETURNING on the conflict path (so the returning-only form fails with
	// ErrNoRows for every sign-in after the first), and DO UPDATE would write
	// to a row it had no reason to touch on every single sign-in.
	//
	// The concurrent case is safe: on a conflict with an in-flight insert,
	// Postgres waits for that transaction and then takes the DO NOTHING path
	// only if it COMMITTED, so the SELECT that follows — a new READ COMMITTED
	// snapshot — always sees the winner's row. If the other transaction rolled
	// back instead, our insert proceeds normally.
	var userID uuid.UUID
	created := true
	err = tx.QueryRow(ctx,
		`INSERT INTO users (idp, idp_sub_hash) VALUES ($1, $2)
		 ON CONFLICT (idp, idp_sub_hash) DO NOTHING
		 RETURNING id`, id.IdP, hash).Scan(&userID)
	if errors.Is(err, pgx.ErrNoRows) {
		// The conflict path: this identity already had an account, either from
		// an earlier sign-in or from a concurrent one that committed while we
		// waited. Either way nothing was created here, so nothing is owed.
		created = false
		err = tx.QueryRow(ctx,
			`SELECT id FROM users WHERE idp = $1 AND idp_sub_hash = $2`, id.IdP, hash).Scan(&userID)
	}
	if err != nil {
		return uuid.Nil, fmt.Errorf("auth: UpsertUser: %w", err)
	}

	// The gate, and it is keyed on `created` — a value that came back from the
	// INSERT itself rather than from a SELECT this function ran beforehand.
	// The difference is the whole guarantee: a pre-flight "does this user
	// exist?" is a check-then-act with a window in it, and the window is
	// exactly a concurrent first sign-in.
	//
	// Placed before the counter row and the writer so that a refusal does the
	// least work possible before rolling back.
	if invite != nil && created {
		if err := redeemInviteTx(ctx, tx, *invite, userID, time.Now().UTC()); err != nil {
			return uuid.Nil, err
		}
	}

	// Idempotent (ON CONFLICT DO NOTHING inside), so running it for a
	// returning user is a no-op and never resets next_seq.
	if err := oplog.EnsureSeqRow(ctx, tx, userID); err != nil {
		return uuid.Nil, fmt.Errorf("auth: UpsertUser: %w", err)
	}
	// The server's own writer, in the SAME transaction and for the same reason
	// the counter row is: a roster that is missing a writer whose chain exists
	// is a roster nothing can be checked against.
	//
	// Specifically — and this is the defect it fixes rather than a nicety — a
	// device's `writer_checkpoint` names one head per ROSTER writer, so while
	// `ingest` was absent from the roster no checkpoint said anything about the
	// chain the user's MAIL lands on. That is the one chain a user cannot
	// re-derive from any device they hold and the one written by the party the
	// threat model declines to trust, and a server that dropped the last N
	// emails left a chain still dense from 1: row contiguity and the hash chain
	// both verify, and nothing contradicted it. With the writer on the roster,
	// I11 covers `ingest` like any other and a truncation behind a signed
	// checkpoint is a `chain_withheld` hard stop on the next device to sync.
	//
	// Here rather than on the ingest path because the EMPTY chain is the common
	// case: an account exists long before its first email, and its first
	// checkpoint has to be able to name `ingest` at counter 0 with the genesis
	// hash. Creating it on first delivery instead would make every account's
	// first email an I11 coverage hard stop until some device checkpointed
	// again. Idempotent, so a returning user's sign-in writes nothing.
	if err := ensureIngestWriterTx(ctx, tx, userID, time.Now().UTC()); err != nil {
		return uuid.Nil, fmt.Errorf("auth: UpsertUser: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return uuid.Nil, fmt.Errorf("auth: UpsertUser: commit: %w", err)
	}
	return userID, nil
}

// IdentityMatchesUser reports whether a verified Identity names the account
// userID, and CREATES NOTHING.
//
// It is what a re-authentication check needs, and it is deliberately not
// UpsertUser. Resolving a re-auth identity by upserting it means the endpoint
// mints a `users` row whenever the token names someone else — a row-creation
// primitive on the path that answers 403, reachable by anyone holding one valid
// session plus any Apple or Google token, and (since Phase 2) a way straight
// past the invite gate. account.go found and fixed that on the deletion path;
// this is the same fix, extracted so the rotation path cannot drift back.
//
// The comparison is constant-time so that the endpoint is not an oracle for
// which subject hashes exist.
func IdentityMatchesUser(ctx context.Context, pool *pgxpool.Pool, userID uuid.UUID, id Identity) (bool, error) {
	if pool == nil {
		return false, errors.New("auth: IdentityMatchesUser: pool is nil")
	}
	var want []byte
	err := pool.QueryRow(ctx,
		`SELECT idp_sub_hash FROM users WHERE id = $1 AND idp = $2`, userID, id.IdP).Scan(&want)
	if errors.Is(err, pgx.ErrNoRows) {
		// This account has no identity under that provider: a token from the
		// other IdP, or an account that is already gone.
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("auth: IdentityMatchesUser: %w", err)
	}
	return subtle.ConstantTimeCompare(want, SubjectHash(id.IdP, id.Subject)) == 1, nil
}
