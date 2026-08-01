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
// The HTTP layer must return the SAME 401 for all of them. "Expired" and
// "revoked" both confirm that the token was once real, which "no such session"
// does not; telling them apart is an oracle in a response and a useful detail
// only in a log.
var (
	ErrSessionInvalid = errors.New("auth: session token is not valid")
	ErrSessionUnknown = fmt.Errorf("%w: no such session", ErrSessionInvalid)
	ErrSessionExpired = fmt.Errorf("%w: session expired", ErrSessionInvalid)
	ErrSessionRevoked = fmt.Errorf("%w: session revoked", ErrSessionInvalid)
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
		return uuid.Nil, ErrSessionUnknown
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

// Revoke kills one session. It is idempotent: revoking an already-revoked
// session leaves the original revoked_at in place (the guard in the WHERE
// clause), and revoking a token that was never issued is a no-op rather than
// an error — the caller presenting it cannot be told whether it existed.
func (s *Sessions) Revoke(ctx context.Context, token string) error {
	if s.Pool == nil {
		return errors.New("auth: Sessions.Pool is nil")
	}
	if token == "" {
		return nil
	}
	_, err := s.Pool.Exec(ctx,
		`UPDATE sessions SET revoked_at = $2 WHERE token_hash = $1 AND revoked_at IS NULL`,
		tokenHash(token), s.now())
	if err != nil {
		return fmt.Errorf("auth: revoke session: %w", err)
	}
	return nil
}

// RevokeAllForUser is "sign out everywhere". Rows are marked rather than
// deleted so that a token presented after revocation resolves to
// ErrSessionRevoked instead of ErrSessionUnknown, which is the difference
// between a log line that says "someone is using a revoked credential" and one
// that says "someone typed garbage".
func (s *Sessions) RevokeAllForUser(ctx context.Context, userID uuid.UUID) error {
	if s.Pool == nil {
		return errors.New("auth: Sessions.Pool is nil")
	}
	if userID == uuid.Nil {
		return errors.New("auth: revoke all: user id is zero")
	}
	_, err := s.Pool.Exec(ctx,
		`UPDATE sessions SET revoked_at = $2 WHERE user_id = $1 AND revoked_at IS NULL`,
		userID, s.now())
	if err != nil {
		return fmt.Errorf("auth: revoke all sessions for user %s: %w", userID, err)
	}
	return nil
}

// UpsertUser returns the user id for a verified Identity, creating the user on
// first sign-in.
//
// The user row and its oplog_seq counter row are created in ONE transaction.
// That is a requirement, not tidiness: oplog.Append documents its
// `INSERT ... ON CONFLICT DO NOTHING` on oplog_seq as dead code in steady
// state precisely because the counter row already exists by the time a user
// can append anything. A user committed without its counter row would make
// that claim false and put a live race on the append path.
//
// Only a VERIFIED Identity may be passed here — one that came out of a
// Verifier. Nothing in this function can tell a verified subject from an
// attacker-supplied string.
func UpsertUser(ctx context.Context, pool *pgxpool.Pool, id Identity) (uuid.UUID, error) {
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

	// Pinned rather than inherited, for the same reason oplog.Append pins it:
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
	err = tx.QueryRow(ctx,
		`INSERT INTO users (idp, idp_sub_hash) VALUES ($1, $2)
		 ON CONFLICT (idp, idp_sub_hash) DO NOTHING
		 RETURNING id`, id.IdP, hash).Scan(&userID)
	if errors.Is(err, pgx.ErrNoRows) {
		err = tx.QueryRow(ctx,
			`SELECT id FROM users WHERE idp = $1 AND idp_sub_hash = $2`, id.IdP, hash).Scan(&userID)
	}
	if err != nil {
		return uuid.Nil, fmt.Errorf("auth: UpsertUser: %w", err)
	}

	// Idempotent (ON CONFLICT DO NOTHING inside), so running it for a
	// returning user is a no-op and never resets next_seq.
	if err := oplog.EnsureSeqRow(ctx, tx, userID); err != nil {
		return uuid.Nil, fmt.Errorf("auth: UpsertUser: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return uuid.Nil, fmt.Errorf("auth: UpsertUser: commit: %w", err)
	}
	return userID, nil
}
