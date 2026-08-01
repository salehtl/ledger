package auth

// Single-use invite codes: the closed beta's gate on account CREATION.
//
// # What this gates, and what it deliberately does not
//
// It gates the creation of a `users` row and nothing else. An account that
// already exists signs in with no code, for ever, and a code presented by a
// returning user is ignored rather than spent — a beta gate that logged people
// out of their own ledger the day the operator stopped minting codes would be a
// worse failure than an open sign-up.
//
// # Why a code and not an allowlist
//
// See 00020_invite_codes.sql: an IdP `subject` is not knowable until the first
// sign-in, which is the event being gated, so there is no moment at which an
// operator could put it on a list. The secret has to be one the operator
// invents, which means it has to be handed over out of band. That is the whole
// design.
//
// # The one distinguishable rejection in the whole auth surface
//
// Every other authentication failure in this system collapses to a byte-
// identical 401, because telling a caller WHICH check failed is an oracle. This
// one is different on purpose: `not_invited` is a fact about the deployment's
// policy, not about the credential, and it tells the person holding the phone
// the one thing they need to know — that re-entering their Apple password will
// never help. It reveals nothing an attacker could not learn by trying a code.

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base32"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// ErrNotInvited means account creation was required and no unredeemed code
// authorized it. It is returned INSTEAD of a user id, so a caller that ignores
// it cannot end up holding a session for an account that was never made.
var ErrNotInvited = errors.New("auth: account creation needs an unredeemed invite code")

// inviteCodeBytes is the entropy behind a code: 15 bytes is 120 bits, which is
// not guessable and encodes to exactly 24 base32 characters with no padding.
// The padding matters more than it sounds — a code ending in "=" is a code a
// human retypes wrongly and a URL escapes.
const inviteCodeBytes = 15

// inviteAlphabet is RFC 4648 base32: A-Z and 2-7, no 0/1/8/9. Chosen over
// base64 because the code is READ ALOUD and RETYPED: base32 has no case
// distinction to lose, no `+` or `/` to escape, and no characters that a
// messaging app will linkify.
var inviteAlphabet = base32.StdEncoding.WithPadding(base32.NoPadding)

// NormalizeInviteCode is the single definition of "the same code", applied
// identically at mint and at redemption so the two cannot drift.
//
// It upper-cases, and it drops the separators a person adds while transcribing:
// spaces, tabs, newlines and dashes. Nothing else is stripped — a code
// containing a character that is not in the alphabet is simply a code that
// matches no row, which is the correct answer and not something to repair.
func NormalizeInviteCode(raw string) string {
	var b strings.Builder
	b.Grow(len(raw))
	for _, r := range raw {
		switch r {
		case ' ', '\t', '\r', '\n', '-', '_':
			continue
		}
		b.WriteRune(r)
	}
	return strings.ToUpper(b.String())
}

// inviteCodeHash is the only representation of a code that is ever persisted.
// Unsalted SHA-256, on the same terms as sessions.token_hash: the input is 120
// bits from crypto/rand, so there is no dictionary to attack.
func inviteCodeHash(code string) []byte {
	sum := sha256.Sum256([]byte(NormalizeInviteCode(code)))
	return sum[:]
}

// MintInvite creates one code and returns it. The plaintext is returned exactly
// once, to exactly one caller, and is not recoverable from the database
// afterwards — an operator who loses it mints another.
//
// note is the operator's own words about who it is for. It may be empty.
func MintInvite(ctx context.Context, pool *pgxpool.Pool, note string, now time.Time) (string, error) {
	if pool == nil {
		return "", errors.New("auth: MintInvite: pool is nil")
	}
	raw := make([]byte, inviteCodeBytes)
	if _, err := rand.Read(raw); err != nil {
		// Unreachable on Go 1.25 (crypto/rand panics rather than failing), but a
		// silently short code is a guessable one, so it is checked.
		return "", fmt.Errorf("auth: MintInvite: read random: %w", err)
	}
	code := inviteAlphabet.EncodeToString(raw)
	var noteArg any
	if note != "" {
		noteArg = note
	}
	if _, err := pool.Exec(ctx,
		`INSERT INTO invite_codes (code_hash, note, created_at) VALUES ($1, $2, $3)`,
		inviteCodeHash(code), noteArg, now); err != nil {
		return "", fmt.Errorf("auth: MintInvite: %w", err)
	}
	return code, nil
}

// InviteSummary is one row of the operator's listing. The code is absent
// because it is not stored; Hash is its short prefix, which is enough to tell
// two rows apart in a terminal and useless as a credential.
type InviteSummary struct {
	Hash       string
	Note       string
	CreatedAt  time.Time
	RedeemedAt *time.Time
	RedeemedBy *uuid.UUID
}

// ListInvites reports every code, newest first, for `ledgerd mint-invite
// --show`. It exists for the same reason api's push-token listing does: a
// capability an operator cannot enumerate is one they cannot manage.
func ListInvites(ctx context.Context, pool *pgxpool.Pool) ([]InviteSummary, error) {
	if pool == nil {
		return nil, errors.New("auth: ListInvites: pool is nil")
	}
	rows, err := pool.Query(ctx,
		`SELECT code_hash, coalesce(note, ''), created_at, redeemed_at, redeemed_by
		   FROM invite_codes ORDER BY created_at DESC, code_hash`)
	if err != nil {
		return nil, fmt.Errorf("auth: ListInvites: %w", err)
	}
	defer rows.Close()
	var out []InviteSummary
	for rows.Next() {
		var (
			hash []byte
			s    InviteSummary
		)
		if err := rows.Scan(&hash, &s.Note, &s.CreatedAt, &s.RedeemedAt, &s.RedeemedBy); err != nil {
			return nil, fmt.Errorf("auth: ListInvites: %w", err)
		}
		s.Hash = fmt.Sprintf("%x", hash[:6])
		out = append(out, s)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("auth: ListInvites: %w", err)
	}
	return out, nil
}

// redeemInviteTx spends one code inside the caller's transaction, which MUST be
// the transaction that creates the account.
//
// The single-use guarantee is the `redeemed_at IS NULL` predicate, not
// anything in Go: two transactions presenting the same code serialize on that
// row, and the second re-evaluates the predicate after the first commits (the
// caller pins READ COMMITTED for exactly this reason) and matches zero rows.
// A check-then-update in application code would let both through.
func redeemInviteTx(ctx context.Context, tx pgx.Tx, code string, userID uuid.UUID, now time.Time) error {
	// An empty code is refused here rather than treated as "no code offered".
	// The caller decides whether a code is REQUIRED; once it is, an empty
	// string is a failed attempt like any other and must not normalize into a
	// hash that could ever match a row.
	if NormalizeInviteCode(code) == "" {
		return ErrNotInvited
	}
	tag, err := tx.Exec(ctx,
		`UPDATE invite_codes SET redeemed_at = $1, redeemed_by = $2
		  WHERE code_hash = $3 AND redeemed_at IS NULL`,
		now, userID, inviteCodeHash(code))
	if err != nil {
		return fmt.Errorf("auth: redeem invite: %w", err)
	}
	if tag.RowsAffected() != 1 {
		return ErrNotInvited
	}
	return nil
}
