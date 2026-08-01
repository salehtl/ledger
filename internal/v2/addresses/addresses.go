// Package addresses owns the per-user inbound mail slot: `u-<token>@in.<domain>`
// (spec §3.2). It issues one, rotates it under a 7-day grace window, and
// resolves an SMTP recipient back to the account it belongs to.
//
// # What the token is defending
//
// The address is the ONLY thing standing between an attacker and injecting
// bank-shaped mail into a stranger's ledger. There is no shared secret with the
// bank, no allowlist a user configures up front, and in Phase 1 no trusted-lane
// verification yet — so an attacker who learns or guesses an address can post
// transactions into someone else's budget. The token is therefore 16 bytes from
// crypto/rand (2^128), rendered as 26 lower-case RFC 4648 base32 characters.
//
// Guessing it offline is hopeless; the online path is closed separately, by
// Task 24's receiver, which refuses an unknown recipient at RCPT time with
// per-IP rate limiting and a tarpit delay. The two halves are load bearing
// together: entropy stops the search, and rate limiting stops the sweep.
//
// # Resolve must not be an enumeration oracle
//
// Every rejection Resolve produces — off-domain, malformed, never issued,
// lapsed grace — is the SAME sentinel with the SAME text (ErrUnknownRecipient),
// so a caller has nothing to switch on and cannot rebuild the distinction one
// layer up.
//
// What is achieved on timing, stated exactly, because overclaiming here is
// worse than not claiming:
//
//   - A recipient inside our domain costs exactly ONE query, by primary key,
//     whether or not the address exists, and the SQL is byte-identical either
//     way. Expiry is evaluated in Go AFTER that query, so "lapsed" and "never
//     existed" do the same database work.
//     TestResolveDoesTheSameDatabaseWorkForKnownAndUnknownRecipients pins it.
//   - This is NOT constant time and is not claimed to be. Postgres returning a
//     row differs measurably from returning none, and no amount of care in this
//     package changes that. Constant-time comparison would not help either: the
//     lookup is a b-tree probe on a primary key, not a byte comparison.
//   - A recipient OUTSIDE our domain is refused without touching the database,
//     so it is faster. That is deliberate. The only fact it leaks is which
//     domain this server accepts mail for, which its MX record publishes; and
//     the alternative — a database round trip for every piece of misdirected
//     junk — hands anyone a free amplifier against the one shared resource the
//     SMTP path depends on.
//
// # Rotation is not something a session can do
//
// Spec §3.4 puts address rotation in the same class as writer registration and
// account deletion: "a stolen session token cannot inject a writer whose ops
// other devices would replay", and rotation "requires fresh IdP
// re-authentication plus an on-device confirmation backed by key possession".
// The stakes are concrete: a rotation the user did not ask for silently ends
// every bank forward they have set up, and the failure is invisible until they
// notice transactions have stopped arriving.
//
// So RotateAuthorized — not Rotate — is what the HTTP layer calls, and it
// demands an Ed25519 signature by an enrolled, non-revoked device key over a
// single-use nonce from this package's own challenge table. The API handler
// adds the fresh-IdP half. Rotate itself is the unauthorized store primitive:
// it is exported for tests and for an operator path, and MUST NOT be reached
// from a request handler.
package addresses

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base32"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"

	"filippo.io/edwards25519"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"ledger/internal/v2/auth"
)

const (
	// TokenBytes is the entropy behind one address: 16 bytes = 128 bits, the
	// floor spec §3.2:46 sets. It is not a length to tune — see the package doc
	// for what the token is the only defence against.
	TokenBytes = 16
	// TokenChars is what TokenBytes encodes to in unpadded base32: ceil(16*8/5).
	TokenChars = 26
	// LocalPartPrefix makes an inbound address recognizable as one at a glance,
	// in a log line and in a bounce, without having to know the token format.
	LocalPartPrefix = "u-"
	// DefaultGrace is spec §3.2:46's window: the old address keeps accepting
	// for 7 days after a rotation, because the user has to redo a Gmail forward
	// rule and any bank-side registration by hand, and a cutover with no
	// overlap loses every message sent in between.
	DefaultGrace = 7 * 24 * time.Hour

	// ChallengeNonceBytes is 32 (256 bits) from crypto/rand, matching
	// auth.ChallengeNonceBytes. The requirement is unguessable and
	// unreplayable; 128 bits is the floor and this is double it.
	ChallengeNonceBytes = 32
	// ChallengeTTL bounds how long a captured rotation challenge is worth
	// anything. The legitimate flow signs the nonce it just asked for.
	ChallengeTTL = 5 * time.Minute
	// challengeRetention is how long a spent or expired challenge is kept
	// before the opportunistic sweep removes it. While the row exists a replay
	// is refused as "already used", which is a more useful operator log line
	// than "unknown nonce".
	challengeRetention = 24 * time.Hour

	// issueAttempts bounds the retry on a local-part collision. A collision at
	// 128 bits will not happen; the loop exists so that if one somehow does, it
	// is the server's problem for a microsecond rather than the user's forever.
	issueAttempts = 3
)

// rotationDomain separates a rotation signature from every other statement a
// device identity key makes. Without it, a signature collected to enroll or
// retire a writer would also authorize handing the account a new mail slot. It
// ends in a NUL that cannot appear in the ASCII domain label, so the prefix can
// never be confused with the start of the payload — same construction as
// auth's registration and revocation domains.
const rotationDomain = "ledger-v2-address-rotation\x00"

// tokenEncoding is RFC 4648 base32 without padding. Lower-cased on output:
// mail systems fold case unpredictably and the local part travels through
// forwarders, so emitting exactly one case means the address a user copies out
// of the app is the address stored here.
var tokenEncoding = base32.StdEncoding.WithPadding(base32.NoPadding)

// ErrUnknownRecipient is the ONE rejection Resolve produces. It carries no
// reason on purpose: see the package doc.
var ErrUnknownRecipient = errors.New("addresses: unknown recipient")

// Issue/Rotate preconditions. Unlike the rejections above these describe the
// CALLER's own account and are safe to distinguish.
var (
	ErrActiveAddressExists = errors.New("addresses: this user already has an active address")
	ErrNoActiveAddress     = errors.New("addresses: this user has no active address")
)

// Rotation rejection reasons. All wrap ErrRotationRejected so the HTTP layer
// can answer every one of them identically: which check failed tells a caller
// who could not prove key possession whether a nonce exists and whether a key
// is enrolled, neither of which is theirs to learn.
var (
	ErrRotationRejected = errors.New("addresses: address rotation rejected")
	ErrChallengeUnknown = fmt.Errorf("%w: no such challenge for this user", ErrRotationRejected)
	ErrChallengeUsed    = fmt.Errorf("%w: challenge already used", ErrRotationRejected)
	ErrChallengeExpired = fmt.Errorf("%w: challenge expired", ErrRotationRejected)
	// ErrNotAuthorized carries the capability rule itself: nothing signed this
	// under a key that is allowed to authorize it.
	ErrNotAuthorized = fmt.Errorf("%w: no enrolled key authorized this", ErrRotationRejected)
)

// NewToken returns a fresh address token: 26 lower-case base32 characters over
// 16 bytes from crypto/rand.
//
// The reader is crypto/rand and nothing else. NewTokenFrom exists so tests can
// inject one; this function must never grow a parameter, a seed, or a fallback,
// because every one of those is a way for the address space to quietly stop
// being 2^128. TestNewTokenDrawsFromCryptoRand asserts that against the source.
func NewToken() (string, error) {
	return NewTokenFrom(rand.Reader)
}

// NewTokenFrom is NewToken with an injectable entropy source. A short read is
// an error, never a short token.
func NewTokenFrom(r io.Reader) (string, error) {
	var b [TokenBytes]byte
	// ReadFull, not Read: a reader is permitted to return fewer bytes than
	// asked for, and a token built from a partial fill would be silently weaker
	// than the type says it is.
	if _, err := io.ReadFull(r, b[:]); err != nil {
		return "", fmt.Errorf("addresses: read %d bytes of entropy: %w", TokenBytes, err)
	}
	return strings.ToLower(tokenEncoding.EncodeToString(b[:])), nil
}

// Address is one row of a user's address history.
type Address struct {
	LocalPart string
	UserID    uuid.UUID
	CreatedAt time.Time
	// ExpiresAt is the zero time while the address is active; otherwise it is
	// the instant it stops accepting mail (exclusive — see Resolve).
	ExpiresAt time.Time
	// RotatedAt is the zero time while the address is active; otherwise the
	// cutover instant.
	RotatedAt time.Time
	// RotatedFrom is the address this one replaced, or "" for a first issue.
	RotatedFrom string
}

// Active reports whether this is the address the user should be handing out.
func (a Address) Active() bool { return a.ExpiresAt.IsZero() }

// InGraceAt reports whether a retired address still accepts mail at t.
func (a Address) InGraceAt(t time.Time) bool {
	return !a.ExpiresAt.IsZero() && stillAccepting(a.ExpiresAt, t)
}

// stillAccepting is the ONE definition of the grace boundary, and both the
// SMTP path (Resolve) and the app-facing path (Address.InGraceAt, which drives
// the countdown the user is shown) go through it.
//
// It is a function rather than two comparisons because the two paths having
// their own copy is exactly the drift that matters: the UI would promise mail
// will still arrive for a microsecond after the receiver had already begun
// rejecting it, or the reverse. Found by mutation testing — flipping the
// comparison in one of two copies passed the whole suite.
//
// The deadline is EXCLUSIVE: at exactly expires the window is over. Both ends
// matter — closing early drops mail the user was promised would arrive, and
// never closing makes rotation meaningless.
func stillAccepting(expires, at time.Time) bool { return at.Before(expires) }

// Addresses issues, rotates and resolves inbound addresses.
//
// It holds no state beyond its dependencies, so constructing one per request is
// correct and free.
type Addresses struct {
	Pool *pgxpool.Pool
	// Suffix is "@in.<domain>", from config.InboundSuffix(). It is never
	// defaulted here: config refuses to start without mail.domain precisely so
	// no layer invents one, and an address minted under a guessed domain is an
	// address that silently receives nothing.
	Suffix string
	// Now defaults to time.Now. Every grace-window and challenge-expiry
	// decision is made against THIS clock and never against Postgres's now(),
	// so one clock decides both when a window opens and when it closes.
	Now func() time.Time
	// Grace defaults to DefaultGrace.
	Grace time.Duration
	// NewToken defaults to the package-level NewToken. It is injectable so a
	// test can force a collision and prove the rotation is atomic; production
	// must leave it nil.
	NewToken func() (string, error)
}

func (a *Addresses) now() time.Time {
	if a.Now != nil {
		return a.Now()
	}
	return time.Now()
}

// GraceWindow is the effective grace duration, defaulted. Exported because the
// HTTP layer has to be able to state the deadline it is enforcing, and reading
// the raw field would report 0 for a store that is using the default.
func (a *Addresses) GraceWindow() time.Duration {
	if a.Grace > 0 {
		return a.Grace
	}
	return DefaultGrace
}

func (a *Addresses) newToken() (string, error) {
	if a.NewToken != nil {
		return a.NewToken()
	}
	return NewToken()
}

func (a *Addresses) check() error {
	if a.Pool == nil {
		return errors.New("addresses: Pool is nil")
	}
	if a.Suffix == "" {
		return errors.New("addresses: Suffix is empty (config.InboundSuffix)")
	}
	return nil
}

// Address renders a local part as the full inbound address.
func (a *Addresses) Address(localPart string) string { return localPart + a.Suffix }

// ---------------------------------------------------------------------------
// Issue
// ---------------------------------------------------------------------------

// Issue mints this user's first (or next) active address and returns its local
// part. It returns ErrActiveAddressExists if one is already live — replacing an
// address is Rotate's job, and doing it silently here would retire a bank's
// registered forward with no grace window and no record of the cutover.
func (a *Addresses) Issue(ctx context.Context, userID uuid.UUID) (string, error) {
	if err := a.check(); err != nil {
		return "", err
	}
	if userID == uuid.Nil {
		return "", errors.New("addresses: issue: user id is zero")
	}
	now := a.now()
	var lastErr error
	for i := 0; i < issueAttempts; i++ {
		local, err := a.mintLocalPart()
		if err != nil {
			return "", err
		}
		_, err = a.Pool.Exec(ctx,
			`INSERT INTO inbound_addresses (local_part, user_id, created_at) VALUES ($1,$2,$3)`,
			local, userID, now)
		if err == nil {
			return local, nil
		}
		switch constraintOf(err) {
		case "inbound_addresses_one_active":
			return "", ErrActiveAddressExists
		case "inbound_addresses_pkey":
			// A token collision. Astronomically unlikely, and the server's
			// problem rather than the caller's: mint another and try again.
			lastErr = err
			continue
		default:
			return "", fmt.Errorf("addresses: issue for user %s: %w", userID, err)
		}
	}
	return "", fmt.Errorf("addresses: issue for user %s: %d local-part collisions in a row: %w",
		userID, issueAttempts, lastErr)
}

// Ensure returns the user's active address, minting one if there is none. It is
// what GET /api/v1/address calls, and it converges under concurrency: two
// devices opening the app at the same moment on a fresh account both come back
// with the SAME address rather than one of them seeing an error.
func (a *Addresses) Ensure(ctx context.Context, userID uuid.UUID) (Address, error) {
	cur, err := a.Current(ctx, userID)
	if err == nil || !errors.Is(err, ErrNoActiveAddress) {
		return cur, err
	}
	if _, err := a.Issue(ctx, userID); err != nil && !errors.Is(err, ErrActiveAddressExists) {
		// ErrActiveAddressExists here means a concurrent caller won the race and
		// already minted one, which is exactly the outcome Ensure wants.
		return Address{}, err
	}
	return a.Current(ctx, userID)
}

func (a *Addresses) mintLocalPart() (string, error) {
	tok, err := a.newToken()
	if err != nil {
		return "", err
	}
	return LocalPartPrefix + tok, nil
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

const addressColumns = `local_part, user_id, created_at, expires_at, rotated_at, rotated_from`

// Current returns the user's active address, or ErrNoActiveAddress.
func (a *Addresses) Current(ctx context.Context, userID uuid.UUID) (Address, error) {
	if err := a.check(); err != nil {
		return Address{}, err
	}
	row := a.Pool.QueryRow(ctx,
		`SELECT `+addressColumns+` FROM inbound_addresses
		  WHERE user_id = $1 AND expires_at IS NULL`, userID)
	addr, err := scanAddress(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return Address{}, ErrNoActiveAddress
	}
	if err != nil {
		return Address{}, fmt.Errorf("addresses: current for user %s: %w", userID, err)
	}
	return addr, nil
}

// Lookup returns one address row by local part, whatever its state. It is for
// the app-facing paths (rendering the grace countdown, operator inspection),
// NOT for the SMTP path — Resolve is the one that must not be an oracle.
func (a *Addresses) Lookup(ctx context.Context, localPart string) (Address, error) {
	if err := a.check(); err != nil {
		return Address{}, err
	}
	row := a.Pool.QueryRow(ctx, `SELECT `+addressColumns+` FROM inbound_addresses WHERE local_part = $1`, localPart)
	addr, err := scanAddress(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return Address{}, ErrUnknownRecipient
	}
	if err != nil {
		return Address{}, fmt.Errorf("addresses: lookup %q: %w", localPart, err)
	}
	return addr, nil
}

// Predecessor returns the address addr replaced, and whether it is STILL
// ACCEPTING mail. ok is false when addr is a first issue, when the predecessor
// row has gone, or when its grace window has already closed.
//
// The window is judged against THIS store's clock, which is the only reason
// this is a method rather than something the caller assembles from Lookup and a
// time comparison: the HTTP layer has its own clock for rate limiting, and a
// countdown rendered against one clock while the SMTP path enforces another is
// a UI that promises mail will arrive after it has stopped arriving.
func (a *Addresses) Predecessor(ctx context.Context, addr Address) (Address, bool, error) {
	if addr.RotatedFrom == "" {
		return Address{}, false, nil
	}
	prev, err := a.Lookup(ctx, addr.RotatedFrom)
	if errors.Is(err, ErrUnknownRecipient) {
		return Address{}, false, nil
	}
	if err != nil {
		return Address{}, false, err
	}
	return prev, prev.InGraceAt(a.now()), nil
}

func scanAddress(row pgx.Row) (Address, error) {
	var (
		addr    Address
		expires *time.Time
		rotated *time.Time
		from    *string
	)
	if err := row.Scan(&addr.LocalPart, &addr.UserID, &addr.CreatedAt, &expires, &rotated, &from); err != nil {
		return Address{}, err
	}
	if expires != nil {
		addr.ExpiresAt = *expires
	}
	if rotated != nil {
		addr.RotatedAt = *rotated
	}
	if from != nil {
		addr.RotatedFrom = *from
	}
	return addr, nil
}

// ---------------------------------------------------------------------------
// Resolve
// ---------------------------------------------------------------------------

// resolveSQL is pulled out as a constant so that the single query Resolve makes
// is visibly the same one on every path. See the package doc for what is and is
// not claimed about timing.
const resolveSQL = `SELECT user_id, expires_at FROM inbound_addresses WHERE local_part = $1`

// Resolve maps an SMTP recipient to the account that owns it. isGrace is true
// when the address has been rotated away from but is still inside its window —
// which is what lets the trust lane honour the allowlist built against the old
// address (spec §3.2:46).
//
// Every failure is ErrUnknownRecipient, with identical text. The caller must
// turn it into ONE rejection.
func (a *Addresses) Resolve(ctx context.Context, rcpt string) (uuid.UUID, bool, error) {
	if err := a.check(); err != nil {
		return uuid.Nil, false, err
	}
	local, ok := a.localPartOf(rcpt)
	if !ok {
		return uuid.Nil, false, ErrUnknownRecipient
	}
	var (
		userID  uuid.UUID
		expires *time.Time
	)
	err := a.Pool.QueryRow(ctx, resolveSQL, local).Scan(&userID, &expires)
	if errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, false, ErrUnknownRecipient
	}
	if err != nil {
		// An infrastructure failure is NOT a rejection. Returning
		// ErrUnknownRecipient here would make a database outage look like every
		// user's address ceasing to exist, and the receiver would answer a
		// permanent 5xx to mail it should have deferred.
		return uuid.Nil, false, fmt.Errorf("addresses: resolve: %w", err)
	}
	if expires == nil {
		return userID, false, nil
	}
	// Checked in Go, after the same query the miss path ran, against the
	// injected clock, and through the SAME predicate the app-facing countdown
	// uses. Doing it in the WHERE clause would both split the hit and miss
	// paths apart and hand expiry to the database's clock.
	if !stillAccepting(*expires, a.now()) {
		return uuid.Nil, false, ErrUnknownRecipient
	}
	return userID, true, nil
}

// localPartOf extracts and normalizes the local part of a recipient this server
// is willing to consider, or reports false.
//
// It is deliberately strict. The only things folded are the ones that are the
// SAME mailbox by any reading — surrounding whitespace, the angle brackets an
// SMTP path may still be wrapped in, and case, since a forwarder may upper-case
// anything and the token alphabet has no upper-case members to collide with.
// Everything else is refused: no plus-tagging, no comments, no quoted local
// parts, no second '@'. Each of those is a way to write more than one string
// that reaches one mailbox, and a receiver that accepts them gives a per-address
// quota (Task 24) more keys than it has mailboxes.
func (a *Addresses) localPartOf(rcpt string) (string, bool) {
	s := strings.TrimSpace(rcpt)
	if strings.HasPrefix(s, "<") && strings.HasSuffix(s, ">") {
		s = strings.TrimSpace(s[1 : len(s)-1])
	}
	s = strings.ToLower(s)
	suffix := strings.ToLower(a.Suffix)
	if !strings.HasSuffix(s, suffix) {
		return "", false
	}
	local := s[:len(s)-len(suffix)]
	if !validLocalPart(local) {
		return "", false
	}
	return local, true
}

// validLocalPart mirrors the inbound_addresses_local_part_shape CHECK
// constraint. It runs here as well so that a malformed recipient is refused
// before it is ever used as a query parameter — and so the two definitions of
// "what an address looks like" are visibly the same one.
func validLocalPart(s string) bool {
	if len(s) != len(LocalPartPrefix)+TokenChars || !strings.HasPrefix(s, LocalPartPrefix) {
		return false
	}
	for i := len(LocalPartPrefix); i < len(s); i++ {
		c := s[i]
		if (c < 'a' || c > 'z') && (c < '2' || c > '7') {
			return false
		}
	}
	return true
}

// ---------------------------------------------------------------------------
// Rotation
// ---------------------------------------------------------------------------

// Rotate retires the user's active address and mints a replacement, returning
// the new local part and the instant the old one stops accepting mail.
//
// NOT AUTHORIZED. This is the store primitive: it checks nothing about who is
// asking. A request handler must call RotateAuthorized instead — spec §3.4 puts
// rotation out of reach of a session token, and a handler wired to this
// function would put it right back.
//
// The whole cutover is one transaction. A reader must never see a moment where
// the user has no active address: mail arriving in that window would be
// rejected at RCPT with nothing to route it to, and the user would have no way
// to know it happened.
func (a *Addresses) Rotate(ctx context.Context, userID uuid.UUID) (string, time.Time, error) {
	return a.rotate(ctx, userID, "")
}

// rotate is Rotate with an optional expectation about WHICH address is being
// retired. expect == "" rotates whatever is active.
//
// The expectation is what closes a TOCTOU gap on the authorized path: the
// signature RotateAuthorized verified was made over a specific local part read
// moments earlier, and without pinning it here a second rotation landing in
// between would mean the signature authorized retiring address X while the
// transaction actually retired address Y. Narrow, and only reachable by a user
// racing themselves — but the whole point of binding the address into the
// signed message is that a signature authorizes exactly one cutover, and a
// check that stops one instruction short of enforcing it is decoration.
func (a *Addresses) rotate(ctx context.Context, userID uuid.UUID, expect string) (string, time.Time, error) {
	if err := a.check(); err != nil {
		return "", time.Time{}, err
	}
	if userID == uuid.Nil {
		return "", time.Time{}, errors.New("addresses: rotate: user id is zero")
	}
	var lastErr error
	for i := 0; i < issueAttempts; i++ {
		local, until, err := a.rotateOnce(ctx, userID, expect)
		if err == nil {
			return local, until, nil
		}
		if constraintOf(err) == "inbound_addresses_pkey" {
			lastErr = err
			continue // token collision; the transaction rolled back untouched
		}
		return "", time.Time{}, err
	}
	return "", time.Time{}, fmt.Errorf("addresses: rotate for user %s: %d local-part collisions in a row: %w",
		userID, issueAttempts, lastErr)
}

func (a *Addresses) rotateOnce(ctx context.Context, userID uuid.UUID, expect string) (string, time.Time, error) {
	tx, err := a.begin(ctx)
	if err != nil {
		return "", time.Time{}, err
	}
	defer a.rollback(ctx, tx)

	// Lock the user row for the duration, the same way auth.Writers does. Two
	// concurrent rotations must not both read the same active address and race
	// to expire it; serialising them here makes each one a clean cutover from
	// whatever the previous one left behind.
	var locked uuid.UUID
	if err := tx.QueryRow(ctx, `SELECT id FROM users WHERE id = $1 FOR UPDATE`, userID).Scan(&locked); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", time.Time{}, ErrNoActiveAddress
		}
		return "", time.Time{}, fmt.Errorf("addresses: lock user %s: %w", userID, err)
	}

	now := a.now()
	until := now.Add(a.GraceWindow())
	var old string
	err = tx.QueryRow(ctx,
		`UPDATE inbound_addresses SET expires_at = $2, rotated_at = $3
		  WHERE user_id = $1 AND expires_at IS NULL
		    AND ($4 = '' OR local_part = $4)
		 RETURNING local_part`, userID, until, now, expect).Scan(&old)
	if errors.Is(err, pgx.ErrNoRows) {
		if expect != "" {
			// The active address is not the one the caller was authorized to
			// retire — something rotated in between. Reported as a failed
			// authorization rather than "no address", because that is what it
			// is: this signature does not authorize this cutover.
			return "", time.Time{}, ErrNotAuthorized
		}
		return "", time.Time{}, ErrNoActiveAddress
	}
	if err != nil {
		return "", time.Time{}, fmt.Errorf("addresses: retire address for user %s: %w", userID, err)
	}

	local, err := a.mintLocalPart()
	if err != nil {
		return "", time.Time{}, err
	}
	if _, err := tx.Exec(ctx,
		`INSERT INTO inbound_addresses (local_part, user_id, created_at, rotated_from)
		 VALUES ($1,$2,$3,$4)`, local, userID, now, old); err != nil {
		return "", time.Time{}, fmt.Errorf("addresses: mint replacement for user %s: %w", userID, err)
	}
	if err := tx.Commit(ctx); err != nil {
		return "", time.Time{}, fmt.Errorf("addresses: rotate: commit: %w", err)
	}
	return local, until, nil
}

// RotationMessage returns the exact bytes a device signs to authorize a
// rotation. The client reimplements this, so it is exported to stop the two
// drifting silently.
//
//	"ledger-v2-address-rotation\x00" || nonce || 0x00 || userID || 0x00 || currentLocalPart
//
// It binds three things, and each one closes a specific replay:
//
//   - the nonce, so the signature is single use;
//   - the user id, so a signature captured on one account is worthless on
//     another;
//   - the address being retired, so a captured signature authorizes exactly the
//     cutover it was produced for and cannot be re-aimed at a later one.
//
// The encoding is unambiguous: nonce is always ChallengeNonceBytes,
// userID.String() is always 36 characters, and neither can contain 0x00, so the
// trailing local part's extent is determined regardless of its contents.
func RotationMessage(nonce []byte, userID uuid.UUID, currentLocalPart string) []byte {
	msg := make([]byte, 0, len(rotationDomain)+len(nonce)+1+36+1+len(currentLocalPart))
	msg = append(msg, rotationDomain...)
	msg = append(msg, nonce...)
	msg = append(msg, 0x00)
	msg = append(msg, userID.String()...)
	msg = append(msg, 0x00)
	msg = append(msg, currentLocalPart...)
	return msg
}

// RotationChallenge mints a single-use nonce for an address rotation.
//
// Obtaining one is exactly what a session token authorizes and nothing more:
// the nonce is worthless without a signature from an enrolled device key.
func (a *Addresses) RotationChallenge(ctx context.Context, userID uuid.UUID) ([]byte, error) {
	if err := a.check(); err != nil {
		return nil, err
	}
	if userID == uuid.Nil {
		return nil, errors.New("addresses: rotation challenge: user id is zero")
	}
	nonce := make([]byte, ChallengeNonceBytes)
	if _, err := rand.Read(nonce); err != nil {
		return nil, fmt.Errorf("addresses: rotation challenge: read random: %w", err)
	}
	now := a.now()
	if _, err := a.Pool.Exec(ctx,
		`INSERT INTO address_rotation_challenges (nonce, user_id, issued_at, expires_at)
		 VALUES ($1,$2,$3,$4)`, nonce, userID, now, now.Add(ChallengeTTL)); err != nil {
		return nil, fmt.Errorf("addresses: rotation challenge for user %s: %w", userID, err)
	}
	// Opportunistic sweep, on the same terms as auth.Writers.Challenge: the
	// cutoff is a full retention period past expiry, so it can only remove a
	// row that is already worthless, and a failed sweep is a housekeeping miss
	// rather than a security event — what refuses a replay is used_at on the
	// row, not the row's absence.
	_, _ = a.Pool.Exec(ctx,
		`DELETE FROM address_rotation_challenges WHERE expires_at < $1`, now.Add(-challengeRetention))
	return nonce, nil
}

// RotateAuthorized is Rotate behind spec §3.4's capability rule: sig must be an
// Ed25519 signature over RotationMessage(nonce, userID, <current local part>)
// by an enrolled, non-revoked device key of this user.
//
// A session token is a precondition for obtaining the nonce and is not an input
// here, so by construction holding one cannot rotate anything. The HTTP layer
// adds the other half of §3.4 — fresh IdP re-authentication — before calling.
//
// There is deliberately no bootstrap path. Unlike a first writer registration,
// which has nothing to sign under and is accepted once as trust-on-first-use, a
// rotation is only ever reachable by an account that already has an address and
// therefore already had a device. An account with no live device key cannot
// rotate; that is a locked door, not a bug, and the alternative is that a
// stolen session can end the user's mail flow.
func (a *Addresses) RotateAuthorized(ctx context.Context, userID uuid.UUID, nonce, sig []byte) (string, time.Time, error) {
	if err := a.check(); err != nil {
		return "", time.Time{}, err
	}
	switch {
	case userID == uuid.Nil:
		return "", time.Time{}, fmt.Errorf("%w: user id is zero", ErrRotationRejected)
	case len(nonce) != ChallengeNonceBytes:
		// Also what makes RotationMessage's encoding unambiguous: the nonce
		// length is fixed here, before any message is built.
		return "", time.Time{}, fmt.Errorf("%w: nonce is %d bytes, want %d",
			ErrRotationRejected, len(nonce), ChallengeNonceBytes)
	case len(sig) != ed25519.SignatureSize:
		return "", time.Time{}, fmt.Errorf("%w: signature is %d bytes, want %d",
			ErrRotationRejected, len(sig), ed25519.SignatureSize)
	}

	// Read the address being retired BEFORE the challenge is spent: a user with
	// no address has nothing to rotate, and burning their challenge for it
	// would be a client bug turned into a dead end.
	cur, err := a.Current(ctx, userID)
	if err != nil {
		return "", time.Time{}, err
	}

	// Spent before anything else can fail, so one challenge buys exactly one
	// attempt. Outside any transaction the rotation itself opens: a challenge is
	// spent by the ATTEMPT, not by the success — rolling it back with a failed
	// rotation would make one challenge worth unlimited signature guesses.
	if err := a.consumeChallenge(ctx, userID, nonce); err != nil {
		return "", time.Time{}, err
	}

	keys, err := a.liveDeviceKeys(ctx, userID)
	if err != nil {
		return "", time.Time{}, err
	}
	if !verifiedByAny(keys, RotationMessage(nonce, userID, cur.LocalPart), sig) {
		return "", time.Time{}, ErrNotAuthorized
	}
	// Pinned to the address the signature named, not merely "whatever is active
	// now" — see rotate.
	return a.rotate(ctx, userID, cur.LocalPart)
}

// consumeChallenge spends a rotation challenge, atomically and exactly once.
//
// The single UPDATE is the whole concurrency argument, and it is the same one
// auth.Writers.consumeChallenge makes: a test-and-set on one row identified by
// primary key. Two concurrent attempts on the same nonce serialize on that
// row's lock, and under READ COMMITTED the loser re-evaluates `used_at IS NULL`
// against the version the winner committed, finds no match, and returns zero
// rows. There is no window between a read and a write because there is no
// separate read.
func (a *Addresses) consumeChallenge(ctx context.Context, userID uuid.UUID, nonce []byte) error {
	var expires time.Time
	err := a.Pool.QueryRow(ctx,
		`UPDATE address_rotation_challenges SET used_at = $3
		  WHERE nonce = $1 AND user_id = $2 AND used_at IS NULL
		 RETURNING expires_at`, nonce, userID, a.now()).Scan(&expires)
	if errors.Is(err, pgx.ErrNoRows) {
		// Separate "already spent" from "never existed, or belongs to another
		// user" for the operator log only. Both are the same rejection to the
		// caller, and this query is scoped to userID so it cannot be used to
		// probe another account's challenges.
		var used *time.Time
		if e := a.Pool.QueryRow(ctx,
			`SELECT used_at FROM address_rotation_challenges WHERE nonce = $1 AND user_id = $2`,
			nonce, userID).Scan(&used); e == nil && used != nil {
			return ErrChallengeUsed
		}
		return ErrChallengeUnknown
	}
	if err != nil {
		return fmt.Errorf("addresses: consume rotation challenge: %w", err)
	}
	// Expiry in Go against the injected clock, so one clock decides both
	// minting and expiry — and so an expired challenge is still CONSUMED,
	// rather than left on the table for an unlimited number of retries.
	if !a.now().Before(expires) {
		return ErrChallengeExpired
	}
	return nil
}

// liveDeviceKeys returns the keys that may authorize a rotation today: enrolled
// device writers that have not been revoked. A revoked device must not be able
// to rotate the mail slot, or revocation would mean nothing.
func (a *Addresses) liveDeviceKeys(ctx context.Context, userID uuid.UUID) ([]ed25519.PublicKey, error) {
	roster, err := (&auth.Writers{Pool: a.Pool}).Roster(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("addresses: read writer roster for user %s: %w", userID, err)
	}
	var keys []ed25519.PublicKey
	for _, w := range roster {
		if w.Kind == auth.KindDevice && w.Live() && w.PubKey != nil {
			keys = append(keys, w.PubKey)
		}
	}
	return keys, nil
}

// usableKey rejects a public key that cannot carry the property this package
// depends on: that a valid signature under it proves possession of a private
// key.
//
// A 32-byte length check is not enough. The Ed25519 identity point and the
// other small-order points are valid encodings under which crypto/ed25519
// accepts a fixed 64-byte forgery for EVERY message — nobody needs a private
// key to write those bytes down. A writer enrolled with such a key would be one
// that any session holder could sign a rotation for.
//
// auth.checkPublicKey makes exactly this check and screens keys at enrollment,
// so a roster key reaching here has already passed it. It is repeated because
// the helper is unexported there, and because a key read back OUT of the roster
// — planted by a repair script, or enrolled before that screen existed — must
// not be able to authorize anything either. The test is a fixed mathematical
// fact rather than a policy, so the duplication cannot drift into disagreement:
// multiply by the cofactor, reject the identity.
func usableKey(pub ed25519.PublicKey) bool {
	if len(pub) != ed25519.PublicKeySize {
		return false
	}
	p, err := new(edwards25519.Point).SetBytes(pub)
	if err != nil {
		return false
	}
	return new(edwards25519.Point).MultByCofactor(p).Equal(edwards25519.NewIdentityPoint()) != 1
}

// verifiedByAny reports whether the signature verifies under any live key.
// ed25519.Verify is constant time in the key material; the loop leaks only how
// many device keys a user has enrolled, which the roster endpoint already
// returns to that same session.
func verifiedByAny(keys []ed25519.PublicKey, msg, sig []byte) bool {
	for _, k := range keys {
		if usableKey(k) && ed25519.Verify(k, msg, sig) {
			return true
		}
	}
	return false
}

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

// constraintOf returns the name of the constraint or index a Postgres error
// names, or "". Matching on the NAME rather than on the SQLSTATE alone is what
// lets Issue tell "this user already has an address" (the caller's problem)
// from "two random 128-bit tokens collided" (ours to retry), which are both
// 23505.
func constraintOf(err error) string {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		return pgErr.ConstraintName
	}
	return ""
}

// begin pins READ COMMITTED rather than inheriting it, for the same reason
// auth.Writers and oplog.Appender do: default_transaction_isolation is settable
// per database, per role and by a pooler. Under REPEATABLE READ the
// `SELECT ... FOR UPDATE` that serializes concurrent rotations would raise a
// serialization failure instead of blocking, turning a routine concurrent
// rotation into an error whose text says nothing about what happened.
func (a *Addresses) begin(ctx context.Context) (pgx.Tx, error) {
	tx, err := a.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return nil, fmt.Errorf("addresses: begin: %w", err)
	}
	return tx, nil
}

// rollback runs on a context detached from the caller's, so a cancelled request
// still releases the user row lock cleanly instead of leaving pgx to destroy
// the connection.
func (a *Addresses) rollback(ctx context.Context, tx pgx.Tx) {
	rbCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	_ = tx.Rollback(rbCtx)
}
