// Package quarantine holds mail whose origin this account has not vouched for
// (spec §3.2:55-56), until the user either trusts the sender or the message
// expires.
//
// # It is outside the op log, and that is the whole design
//
// A quarantined message has not been trusted. Nothing about it may enter the
// account's integrity chains, so this store has no seq, no chain hashes, no
// writer counter and no relationship to oplog at all — it is a flat, TTL'd
// table with its own sync channel. Confirming the sender re-runs ingest (Task
// 30) and appends the RESULT as ordinary ops; that append is the moment the
// message joins the chains, and there is no earlier one.
//
// Nothing in this package may import a pusher. §3.2:56 says quarantined blobs
// never trigger push — an unvouched-for sender with a notification channel is a
// spam channel pointed at the user's lock screen — and
// TestQuarantineHasNoPathToPush enforces that at the level the promise lives
// at: this package cannot reach one.
//
// # The drop policy is a published promise
//
// Spec §2: "nothing is dropped without a user-visible notice." Quarantine is
// the one place in v2 that deletes a user's mail, so it is the one place that
// promise can be broken. Three mechanisms hold it, and each is separately
// tested:
//
//  1. ADVANCE WARNING. [Store.ExpireDue] sets warned_at a full WarnBefore
//     (7 days) before expiry, and the sync channel carries warned_at and the
//     computed deletion instant to the client. Quarantined arrivals count as
//     "action needed" in their own right ([Store.Counts]).
//  2. NO UNWARNED DELETION, EVER. An item whose warning never went out is not
//     deleted, however overdue it is — a client that has not synced in a month
//     cannot be pruned out from under. An item warned LATE gets the full
//     warning window from the warning, not from its nominal expiry, so the
//     notice is real rather than nominal (see [Store.DeletableAt]).
//  3. A RECORD THAT OUTLIVES THE MESSAGE. Every removal — expiry or promotion
//     — writes a content-free row to quarantine_removals in the same
//     transaction, and a database trigger refuses any delete that is not
//     accounted for by one. The client reads those rows on the same channel, so
//     "what happened to the mail I never got to?" is always answerable.
//
// # One predicate, not two
//
// Every boundary here is decided by exactly one function. [Store.DeletableAt]
// is the only place a deletion instant is computed, and the SQL that picks
// sweep candidates is filtered by a cutoff that comes from the same warning
// predicate rather than from a second copy of the comparison written in SQL.
// Two copies of one comparison is how a mutated boundary passes a whole test
// suite.
package quarantine

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"ledger/internal/v2/blob"
	"ledger/internal/v2/diag"
)

const (
	// DefaultTTL is spec §3.2:56's 30 days.
	DefaultTTL = 30 * 24 * time.Hour
	// DefaultWarnBefore is how long before expiry the client is warned. It
	// matches the address grace window for the same reason that one is 7 days:
	// it is the shortest window in which a person who checks their phone
	// occasionally will actually see the notice.
	DefaultWarnBefore = 7 * 24 * time.Hour
)

// The two allowlist scopes. Outer is the signing domain of the message as we
// received it; Inner is the bank behind a forwarder, and is only ever available
// when an attestation proved it.
const (
	ScopeOuter = "outer"
	ScopeInner = "inner"
)

// Why a message left quarantine. Closed set, mirrored by a CHECK constraint.
const (
	// ReasonExpired is the TTL. It requires a warning to have gone out first.
	ReasonExpired = "expired"
	// ReasonPromoted is the good ending: the sender was confirmed and the
	// message was re-ingested into the op log (Task 30).
	ReasonPromoted = "promoted"
)

// How an inner origin was proven. These are origin.Origin.AttestedBy's values
// (Task 26); they are duplicated rather than imported because a store should
// not depend on the verifier to name what it was handed.
const (
	AttestedByDirectDKIM = "direct_dkim"
	AttestedByARC        = "arc"
)

// The authentication verdicts, aliased from diag so the closed enum this table
// stores and the closed enum the diagnostics ledger stores are the same set by
// construction.
const (
	ResultPass      = diag.ResultPass
	ResultFail      = diag.ResultFail
	ResultNone      = diag.ResultNone
	ResultTempError = diag.ResultTempError
)

// UnverifiedPrefix marks an outer domain taken from the envelope rather than
// from a verified signature. A domain carrying it can never be allowlisted:
// Confirm matches on the plain hostname, which no prefixed value equals.
const UnverifiedPrefix = diag.UnverifiedPrefix

// Errors. ErrInvalidItem describes the CALLER's own submission; the rest
// describe a confirmation the user is not entitled to make and are safe to
// distinguish in a response, because each one names something the user can
// already see in their own quarantine lane.
var (
	// ErrInvalidItem means Hold was handed something that is not a storable
	// quarantine item. It is a programming error, never a property of mail.
	ErrInvalidItem = errors.New("quarantine: invalid item")

	// ErrForwarderDomain refuses §3.2:51's foot-gun: allowlisting a mail
	// provider as an OUTER origin trusts every message that has ever passed
	// through the user's own mailbox.
	ErrForwarderDomain = errors.New("refusing to allowlist a known forwarder as an outer origin")

	ErrUnknownScope  = errors.New("quarantine: scope must be \"outer\" or \"inner\"")
	ErrInvalidDomain = errors.New("quarantine: not a hostname")

	// ErrOriginUnproven is the shared root of the two refusals below, so a
	// handler can answer both identically without caring which applied.
	ErrOriginUnproven = errors.New("quarantine: no held message proves this origin")
	// ErrNoVerifiedOrigin means nothing held for this user carries a VERIFIED
	// outer signature from that domain. §3.2:54: trusted-lane promotion
	// requires a verified signature, and mail with no verifiable signature
	// stays quarantined permanently.
	ErrNoVerifiedOrigin = fmt.Errorf("%w: no held message carries a verified signature from it", ErrOriginUnproven)
	// ErrNoAttestedOrigin means nothing held for this user names that domain as
	// an ATTESTED inner origin. The unwrapped From line of a forwarded body is
	// not an attestation; it is attacker-rendered content.
	ErrNoAttestedOrigin = fmt.Errorf("%w: no held message attests it as an inner origin", ErrOriginUnproven)
)

// forwarders is §3.2:51's closed refusal list, and it is the source of the
// sender_allowlist_no_forwarder_as_outer CHECK constraint.
// TestTheSQLForwarderListMatchesGo keeps the two from drifting.
var forwarders = []string{
	"gmail.com", "googlemail.com", "icloud.com", "me.com", "mac.com",
	"outlook.com", "hotmail.com", "live.com", "yahoo.com",
	"proton.me", "protonmail.com", "zoho.com", "fastmail.com",
}

// Forwarders returns a copy of the refusal list. It is exported so the client's
// "trust this sender" sheet can explain the refusal BEFORE the user taps, and
// so the constraint test can compare the two copies.
func Forwarders() []string { return append([]string(nil), forwarders...) }

// IsForwarder reports whether d is a known mail provider rather than a bank.
func IsForwarder(d string) bool {
	d = strings.ToLower(strings.TrimSpace(d))
	for _, f := range forwarders {
		if d == f {
			return true
		}
	}
	return false
}

// reHostname mirrors the SQL grammar. It deliberately does not admit
// UnverifiedPrefix.
var reHostname = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$`)

// Item is one held message.
//
// The origin fields are what the client's "trust this sender" sheet renders:
// the VERIFIED signing domain, the attested inner origin, and an explicit
// attestation state — never the message's own subject or display name, which
// is content an attacker wrote (§3.2:55).
type Item struct {
	// ID is generated when zero.
	ID     uuid.UUID
	UserID uuid.UUID
	// IngestID is SHA-256 of the raw body: the join key to the diagnostics row
	// and, after promotion, to the op.
	IngestID   []byte
	ReceivedAt time.Time
	// ExpiresAt defaults to ReceivedAt + Store.TTL.
	ExpiresAt time.Time
	// WarnedAt is set by ExpireDue, WarnBefore ahead of expiry. It is read-only
	// to callers of Hold.
	WarnedAt *time.Time

	// OuterDomain is the verified signing domain, or UnverifiedPrefix + the
	// envelope domain. "" means no domain at all.
	OuterDomain string
	// InnerDomain may be set ONLY when Attested.
	InnerDomain string
	Attested    bool
	AttestedBy  string
	DKIM, ARC   string

	// SizeBucket is computed from the blob when zero.
	SizeBucket int
	// Blob is the raw RFC822 message, plaintext in Phase 1. List returns it
	// only when explicitly asked for.
	Blob []byte
}

// Removal is the record that outlives a removed message. It carries no content:
// a one-way digest, timestamps, hostnames and a size rung.
type Removal struct {
	ID           uuid.UUID
	QuarantineID uuid.UUID
	UserID       uuid.UUID
	IngestID     []byte
	ReceivedAt   time.Time
	ExpiresAt    time.Time
	WarnedAt     *time.Time
	RemovedAt    time.Time
	Reason       string
	OuterDomain  string
	InnerDomain  string
	Attested     bool
	SizeBucket   int
}

// Cursor is a keyset position: an instant plus a tiebreaker id.
//
// The tiebreaker is not decoration. A cursor that is a timestamp alone loses
// every item that shares its instant with the last item of a page — and mail
// arrives in batches, so that is the common case, not the corner. A zero
// Cursor starts from the beginning; a Cursor with an instant but a zero ID
// re-delivers that instant's items rather than skipping them, because a
// duplicate is harmless and a drop is the thing this whole package exists to
// prevent.
type Cursor struct {
	At time.Time
	ID uuid.UUID
}

// Store is the quarantine table. It holds no state beyond its dependencies.
type Store struct {
	Pool *pgxpool.Pool
	// TTL defaults to DefaultTTL, WarnBefore to DefaultWarnBefore.
	TTL        time.Duration
	WarnBefore time.Duration
	// Now defaults to time.Now. Every expiry decision is made against THIS
	// clock and never against Postgres's now(), so one clock decides both when
	// a window opens and when it closes.
	Now func() time.Time
}

func (s *Store) now() time.Time {
	if s.Now != nil {
		return s.Now()
	}
	return time.Now()
}

func (s *Store) ttl() time.Duration {
	if s.TTL > 0 {
		return s.TTL
	}
	return DefaultTTL
}

func (s *Store) warnBefore() time.Duration {
	if s.WarnBefore > 0 {
		return s.WarnBefore
	}
	return DefaultWarnBefore
}

func (s *Store) check() error {
	if s == nil || s.Pool == nil {
		return errors.New("quarantine: Pool is nil")
	}
	if s.warnBefore() >= s.ttl() {
		// Every item would arrive already inside its warning window, so the
		// advance notice would be no notice at all.
		return fmt.Errorf("quarantine: WarnBefore (%s) must be shorter than TTL (%s)", s.warnBefore(), s.ttl())
	}
	return nil
}

// ---------------------------------------------------------------------------
// The two boundaries, defined once
// ---------------------------------------------------------------------------

// warnCutoff is THE warning boundary, expressed as the latest expiry that is
// due for a warning at now. It is one form of one inequality:
//
//	now >= expiresAt - WarnBefore   <=>   expiresAt <= now + WarnBefore
//
// The right-hand form is what the sweep's SQL filters on, so the database's
// candidate scan and this package's decision are the same comparison with the
// same operand rather than two copies that can be mutated apart.
func (s *Store) warnCutoff(now time.Time) time.Time { return now.Add(s.warnBefore()) }

// dueForWarning reports whether an unwarned item must be warned at now.
// Inclusive at the boundary.
func (s *Store) dueForWarning(expiresAt, now time.Time) bool {
	return !expiresAt.After(s.warnCutoff(now))
}

// DeletableAt is the ONLY definition of when a held message may be removed, and
// the instant it returns is what the sync channel shows the client.
//
// ok is false for an item that has not been warned: an unwarned item is never
// deletable, whatever its expiry says. That is what stops a client which has
// not synced in a month from being pruned out from under.
//
// For a warned item the instant is the LATER of its expiry and a full
// WarnBefore after the warning actually went out. On the normal path those are
// the same instant, because the warning is set exactly WarnBefore before
// expiry. They differ only when a sweep was late — the process was down, the
// item was backfilled — and then the warning window is measured from the
// warning, so "warned in advance" stays a fact rather than a formality.
//
// The consequence, stated because it is a promise in the other direction: a
// late-warned item lives LONGER than its stated expiry, never shorter. The
// client is shown both instants and can render either.
func (s *Store) DeletableAt(expiresAt time.Time, warnedAt *time.Time) (time.Time, bool) {
	if warnedAt == nil {
		return time.Time{}, false
	}
	at := expiresAt
	if full := warnedAt.Add(s.warnBefore()); full.After(at) {
		at = full
	}
	return at, true
}

// dueForDeletion is DeletableAt read against a clock. Inclusive at the
// boundary, matching dueForWarning.
func (s *Store) dueForDeletion(expiresAt time.Time, warnedAt *time.Time, now time.Time) bool {
	at, ok := s.DeletableAt(expiresAt, warnedAt)
	return ok && !now.Before(at)
}

// ---------------------------------------------------------------------------
// Hold
// ---------------------------------------------------------------------------

const holdSQL = `INSERT INTO quarantine
 (id, user_id, ingest_id, received_at, expires_at, outer_domain, inner_domain,
  attested, attested_by, dkim, arc, size_bucket, blob)
 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
 ON CONFLICT (user_id, ingest_id) DO NOTHING`

// Hold stores one message.
//
// It is idempotent per (user, ingest id): an SMTP retry is the same message
// arriving again, not a second one, and without that a sender that retries for
// three days fills the user's quarantine lane with copies of one email.
//
// It appends nothing to the op log, notifies nothing, and returns nothing to
// wake the user with.
func (s *Store) Hold(ctx context.Context, it Item) error {
	if err := s.check(); err != nil {
		return err
	}
	it, err := s.validate(it)
	if err != nil {
		return err
	}
	_, err = s.Pool.Exec(ctx, holdSQL,
		it.ID, it.UserID, it.IngestID, it.ReceivedAt, it.ExpiresAt,
		it.OuterDomain, nullText(it.InnerDomain),
		it.Attested, it.AttestedBy, it.DKIM, it.ARC, it.SizeBucket, it.Blob)
	if err != nil {
		return fmt.Errorf("quarantine: hold: %w", err)
	}
	return nil
}

// validate returns a canonicalized copy or ErrInvalidItem. It mirrors the CHECK
// constraints so a bad item is refused before it reaches the database, and so
// the two definitions of a storable row are visibly the same one.
func (s *Store) validate(it Item) (Item, error) {
	if it.ID == uuid.Nil {
		it.ID = uuid.New()
	}
	if it.UserID == uuid.Nil {
		return it, fmt.Errorf("%w: user id is zero", ErrInvalidItem)
	}
	if len(it.IngestID) != 32 {
		return it, fmt.Errorf("%w: ingest_id must be a 32-byte sha256, got %d bytes", ErrInvalidItem, len(it.IngestID))
	}
	if it.ReceivedAt.IsZero() {
		return it, fmt.Errorf("%w: received_at is required", ErrInvalidItem)
	}
	if it.ExpiresAt.IsZero() {
		it.ExpiresAt = it.ReceivedAt.Add(s.ttl())
	}
	if !it.ExpiresAt.After(it.ReceivedAt) {
		return it, fmt.Errorf("%w: expires_at is not after received_at", ErrInvalidItem)
	}

	it.OuterDomain = strings.ToLower(strings.TrimSpace(it.OuterDomain))
	if it.OuterDomain != "" && !reHostname.MatchString(strings.TrimPrefix(it.OuterDomain, UnverifiedPrefix)) {
		return it, fmt.Errorf("%w: outer_domain is not a hostname", ErrInvalidItem)
	}
	it.InnerDomain = strings.ToLower(strings.TrimSpace(it.InnerDomain))
	if it.InnerDomain != "" && !reHostname.MatchString(it.InnerDomain) {
		return it, fmt.Errorf("%w: inner_domain is not a hostname", ErrInvalidItem)
	}

	switch it.AttestedBy {
	case "":
	case AttestedByDirectDKIM, AttestedByARC:
	default:
		return it, fmt.Errorf("%w: attested_by is not one of %q, %q or \"\"", ErrInvalidItem, AttestedByDirectDKIM, AttestedByARC)
	}
	if (it.AttestedBy != "") != it.Attested {
		return it, fmt.Errorf("%w: attested and attested_by disagree", ErrInvalidItem)
	}
	if it.Attested && it.DKIM != ResultPass && it.ARC != ResultPass {
		return it, fmt.Errorf("%w: attested with no passing signature", ErrInvalidItem)
	}
	// The one that matters: without an attestation the only available source
	// for an inner origin is the forwarded body's own From line, which is
	// content an attacker wrote.
	if it.InnerDomain != "" && !it.Attested {
		return it, fmt.Errorf("%w: an inner origin needs an attestation", ErrInvalidItem)
	}

	if !oneOf(it.DKIM, ResultPass, ResultFail, ResultNone, ResultTempError) {
		return it, fmt.Errorf("%w: dkim is not a verdict", ErrInvalidItem)
	}
	if !oneOf(it.ARC, ResultPass, ResultFail, ResultNone) {
		return it, fmt.Errorf("%w: arc is not a verdict", ErrInvalidItem)
	}

	if len(it.Blob) == 0 {
		return it, fmt.Errorf("%w: blob is empty", ErrInvalidItem)
	}
	if it.SizeBucket == 0 {
		b, err := blob.BucketFor(len(it.Blob))
		if err != nil {
			return it, fmt.Errorf("%w: %v", ErrInvalidItem, err)
		}
		it.SizeBucket = b
	}
	if len(it.Blob) > it.SizeBucket {
		return it, fmt.Errorf("%w: %d bytes does not fit bucket %d", ErrInvalidItem, len(it.Blob), it.SizeBucket)
	}
	return it, nil
}

// ---------------------------------------------------------------------------
// Reads: the sync channel
// ---------------------------------------------------------------------------

const itemColumns = `id, user_id, ingest_id, received_at, expires_at, warned_at,
 outer_domain, inner_domain, attested, attested_by, dkim, arc, size_bucket`

// List returns one keyset page of a user's held mail, oldest first.
//
// withBlob is false for the ordinary listing: the client's lane renders origin
// facts, not the message, and a page of raw bodies is megabytes. It is true for
// the one Phase 1 path that needs the body — Gmail's own forward-verification
// mail quarantines like everything else, and onboarding reads the confirmation
// link out of it (§3.2:47).
func (s *Store) List(ctx context.Context, userID uuid.UUID, after Cursor, limit int, withBlob bool) ([]Item, error) {
	if err := s.check(); err != nil {
		return nil, err
	}
	cols := itemColumns
	if withBlob {
		cols += ", blob"
	}
	rows, err := s.Pool.Query(ctx, `SELECT `+cols+` FROM quarantine
	  WHERE user_id = $1 AND (received_at, id) > ($2, $3)
	  ORDER BY received_at, id LIMIT $4`, userID, after.At, after.ID, limit)
	if err != nil {
		return nil, fmt.Errorf("quarantine: list: %w", err)
	}
	defer rows.Close()
	var out []Item
	for rows.Next() {
		it, err := scanItem(rows, withBlob)
		if err != nil {
			return nil, fmt.Errorf("quarantine: list: %w", err)
		}
		out = append(out, it)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("quarantine: list: %w", err)
	}
	return out, nil
}

// Held returns the named messages WITH their raw bodies, for re-ingest after a
// confirmation.
//
// ⚠ PHASE 1 ONLY. From Phase 3 the blob is sealed to the user's key and the
// server cannot read it; quarantine confirmation becomes "return the ciphertext
// to the client, which re-parses locally". See the Phase-1-only inventory.
func (s *Store) Held(ctx context.Context, userID uuid.UUID, ingestIDs [][]byte) ([]Item, error) {
	if err := s.check(); err != nil {
		return nil, err
	}
	if len(ingestIDs) == 0 {
		return nil, nil
	}
	rows, err := s.Pool.Query(ctx, `SELECT `+itemColumns+`, blob FROM quarantine
	  WHERE user_id = $1 AND ingest_id = ANY($2) ORDER BY received_at, id`, userID, ingestIDs)
	if err != nil {
		return nil, fmt.Errorf("quarantine: held: %w", err)
	}
	defer rows.Close()
	var out []Item
	for rows.Next() {
		it, err := scanItem(rows, true)
		if err != nil {
			return nil, fmt.Errorf("quarantine: held: %w", err)
		}
		out = append(out, it)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("quarantine: held: %w", err)
	}
	return out, nil
}

// Counts returns how many messages this user has held and how many of those
// have been warned.
//
// Both numbers are "action needed" in the watchdog's sense (§3.2:56) — a
// quarantined arrival is a decision the user has not made — but the warned
// subset is the one with a deadline attached, and a client that shows one
// number should show that one loudest.
func (s *Store) Counts(ctx context.Context, userID uuid.UUID) (held, warned int, err error) {
	if err := s.check(); err != nil {
		return 0, 0, err
	}
	err = s.Pool.QueryRow(ctx,
		`SELECT count(*), count(*) FILTER (WHERE warned_at IS NOT NULL) FROM quarantine WHERE user_id = $1`,
		userID).Scan(&held, &warned)
	if err != nil {
		return 0, 0, fmt.Errorf("quarantine: counts: %w", err)
	}
	return held, warned, nil
}

// Removals returns one keyset page of this user's removal records, oldest
// first. This is how a client answers "what happened to the mail I never got
// to?" after the message itself is gone.
func (s *Store) Removals(ctx context.Context, userID uuid.UUID, after Cursor, limit int) ([]Removal, error) {
	if err := s.check(); err != nil {
		return nil, err
	}
	rows, err := s.Pool.Query(ctx, `SELECT id, quarantine_id, user_id, ingest_id, received_at, expires_at,
	   warned_at, removed_at, reason, outer_domain, inner_domain, attested, size_bucket
	  FROM quarantine_removals
	  WHERE user_id = $1 AND (removed_at, id) > ($2, $3)
	  ORDER BY removed_at, id LIMIT $4`, userID, after.At, after.ID, limit)
	if err != nil {
		return nil, fmt.Errorf("quarantine: removals: %w", err)
	}
	defer rows.Close()
	var out []Removal
	for rows.Next() {
		var (
			r     Removal
			inner *string
		)
		if err := rows.Scan(&r.ID, &r.QuarantineID, &r.UserID, &r.IngestID, &r.ReceivedAt, &r.ExpiresAt,
			&r.WarnedAt, &r.RemovedAt, &r.Reason, &r.OuterDomain, &inner, &r.Attested, &r.SizeBucket); err != nil {
			return nil, fmt.Errorf("quarantine: removals: %w", err)
		}
		if inner != nil {
			r.InnerDomain = *inner
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("quarantine: removals: %w", err)
	}
	return out, nil
}

func scanItem(rows pgx.Rows, withBlob bool) (Item, error) {
	var (
		it    Item
		inner *string
	)
	dst := []any{&it.ID, &it.UserID, &it.IngestID, &it.ReceivedAt, &it.ExpiresAt, &it.WarnedAt,
		&it.OuterDomain, &inner, &it.Attested, &it.AttestedBy, &it.DKIM, &it.ARC, &it.SizeBucket}
	if withBlob {
		dst = append(dst, &it.Blob)
	}
	if err := rows.Scan(dst...); err != nil {
		return Item{}, err
	}
	if inner != nil {
		it.InnerDomain = *inner
	}
	return it, nil
}

// ---------------------------------------------------------------------------
// Confirmation
// ---------------------------------------------------------------------------

// Confirm allowlists a verified origin for this user and returns the ingest ids
// of every message held from it, so Task 30 can re-run ingest over them. Those
// re-ingests append ordinary ops, and THAT is when the messages enter the
// integrity chains — nothing here touches the op log.
//
// Three things it refuses, each one a specific way the trusted lane could be
// opened by mistake:
//
//   - a known forwarder as an OUTER origin (§3.2:51). Allowlisting gmail.com
//     as an outer origin trusts anything that passes through the user's
//     mailbox, which is the entire trusted-lane design defeated by one tap. The
//     user's route to their bank behind that forwarder is the inner scope.
//   - a domain no held message carries a VERIFIED signature from (§3.2:54).
//     The stored outer domain of unsigned mail carries UnverifiedPrefix, which
//     no plain hostname equals, so this falls out of the match rather than
//     needing a separate check.
//   - an inner origin no held message ATTESTS. The unwrapped From line of a
//     forwarded body names a bank; it is not evidence, and a confirmation sheet
//     that accepted it would be trusting attacker-rendered content.
//
// It is idempotent: confirming an already-confirmed origin re-reports the held
// ids and writes nothing new.
func (s *Store) Confirm(ctx context.Context, userID uuid.UUID, domain, scope string) ([][]byte, error) {
	if err := s.check(); err != nil {
		return nil, err
	}
	if userID == uuid.Nil {
		return nil, errors.New("quarantine: confirm: user id is zero")
	}
	domain = strings.ToLower(strings.TrimSpace(domain))
	if !reHostname.MatchString(domain) {
		return nil, fmt.Errorf("%w: %q", ErrInvalidDomain, domain)
	}
	var (
		match   string
		missing error
	)
	switch scope {
	case ScopeOuter:
		if IsForwarder(domain) {
			return nil, fmt.Errorf("%w: %s", ErrForwarderDomain, domain)
		}
		match = `outer_domain = $2`
		missing = ErrNoVerifiedOrigin
	case ScopeInner:
		match = `inner_domain = $2 AND attested`
		missing = ErrNoAttestedOrigin
	default:
		return nil, fmt.Errorf("%w: %q", ErrUnknownScope, scope)
	}

	tx, err := s.begin(ctx)
	if err != nil {
		return nil, err
	}
	defer s.rollback(ctx, tx)

	rows, err := tx.Query(ctx,
		`SELECT ingest_id FROM quarantine WHERE user_id = $1 AND `+match+` ORDER BY received_at, id`,
		userID, domain)
	if err != nil {
		return nil, fmt.Errorf("quarantine: confirm: %w", err)
	}
	var ids [][]byte
	for rows.Next() {
		var id []byte
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return nil, fmt.Errorf("quarantine: confirm: %w", err)
		}
		ids = append(ids, id)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("quarantine: confirm: %w", err)
	}
	if len(ids) == 0 {
		// Nothing this user has been shown proves the origin, so there is
		// nothing for them to confirm. Refusing here rather than writing the row
		// anyway is what keeps the allowlist a record of verifications the user
		// actually saw.
		return nil, fmt.Errorf("%w: %s", missing, domain)
	}

	if _, err := tx.Exec(ctx,
		`INSERT INTO sender_allowlist (user_id, domain, scope, created_at) VALUES ($1,$2,$3,$4)
		 ON CONFLICT (user_id, domain, scope) DO NOTHING`, userID, domain, scope, s.now()); err != nil {
		return nil, fmt.Errorf("quarantine: confirm: allowlist %s: %w", scope, err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("quarantine: confirm: commit: %w", err)
	}
	return ids, nil
}

// Allowlisted reports whether this user has vouched for a domain at a scope.
//
// It is the ONE read of sender_allowlist. The trust lane (Task 26's
// origin.TrustStore) must call it rather than issue its own query: the
// carry-over rule §3.2:46 promises across an address rotation is a property of
// this table being keyed by USER, and a second query that joined through
// inbound_addresses would reintroduce exactly the one-hop chain walk that rule
// cannot survive.
func (s *Store) Allowlisted(ctx context.Context, userID uuid.UUID, domain, scope string) (bool, error) {
	if err := s.check(); err != nil {
		return false, err
	}
	var ok bool
	err := s.Pool.QueryRow(ctx,
		`SELECT EXISTS (SELECT 1 FROM sender_allowlist WHERE user_id = $1 AND domain = $2 AND scope = $3)`,
		userID, strings.ToLower(strings.TrimSpace(domain)), scope).Scan(&ok)
	if err != nil {
		return false, fmt.Errorf("quarantine: allowlisted: %w", err)
	}
	return ok, nil
}

// ---------------------------------------------------------------------------
// Removal
// ---------------------------------------------------------------------------

// recordRemovalSQL copies the removal record straight out of the row it
// accounts for, so a record can never describe a different message than the one
// that went. It runs in the same transaction as the DELETE, which is what
// satisfies the trigger that refuses an untraced removal.
const recordRemovalSQL = `INSERT INTO quarantine_removals
 (quarantine_id, user_id, ingest_id, received_at, expires_at, warned_at, removed_at,
  reason, outer_domain, inner_domain, attested, size_bucket)
 SELECT id, user_id, ingest_id, received_at, expires_at, warned_at, $2, $3,
        outer_domain, inner_domain, attested, size_bucket
   FROM quarantine WHERE id = ANY($1)`

// Promote removes messages that have been re-ingested into the op log, leaving
// a record that says so. It is the good ending, and it is still a removal: the
// trigger holds for it exactly as it does for an expiry.
//
// ⚠ PHASE 1 ONLY, with Held and Task 30's Reprocess.
func (s *Store) Promote(ctx context.Context, userID uuid.UUID, ingestIDs [][]byte) (int, error) {
	if err := s.check(); err != nil {
		return 0, err
	}
	if len(ingestIDs) == 0 {
		return 0, nil
	}
	tx, err := s.begin(ctx)
	if err != nil {
		return 0, err
	}
	defer s.rollback(ctx, tx)

	rows, err := tx.Query(ctx,
		`SELECT id FROM quarantine WHERE user_id = $1 AND ingest_id = ANY($2) FOR UPDATE`, userID, ingestIDs)
	if err != nil {
		return 0, fmt.Errorf("quarantine: promote: %w", err)
	}
	var ids []uuid.UUID
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return 0, fmt.Errorf("quarantine: promote: %w", err)
		}
		ids = append(ids, id)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, fmt.Errorf("quarantine: promote: %w", err)
	}
	if len(ids) == 0 {
		return 0, nil
	}
	n, err := s.removeLocked(ctx, tx, ids, s.now(), ReasonPromoted)
	if err != nil {
		return 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, fmt.Errorf("quarantine: promote: commit: %w", err)
	}
	return n, nil
}

// removeLocked writes the records and deletes the rows, in that order, inside
// one transaction. Both halves or neither.
func (s *Store) removeLocked(ctx context.Context, tx pgx.Tx, ids []uuid.UUID, at time.Time, reason string) (int, error) {
	if _, err := tx.Exec(ctx, recordRemovalSQL, ids, at, reason); err != nil {
		return 0, fmt.Errorf("quarantine: record %s removal: %w", reason, err)
	}
	ct, err := tx.Exec(ctx, `DELETE FROM quarantine WHERE id = ANY($1)`, ids)
	if err != nil {
		return 0, fmt.Errorf("quarantine: remove (%s): %w", reason, err)
	}
	return int(ct.RowsAffected()), nil
}

// ---------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------

const (
	// sweepBatch bounds one transaction's work, so a backlog does not hold row
	// locks across a long transaction.
	sweepBatch = 500
	// maxSweepBatches bounds one ExpireDue call. Reaching it is a bug (the
	// keyset cursor advances every batch, so the scan always terminates), and
	// it returns an error rather than looping forever.
	maxSweepBatches = 10_000
)

// ExpireDue is the hourly sweep. It warns first and deletes only what it has
// already warned about — see the package doc for the three mechanisms that make
// spec §2's drop policy hold, and DeletableAt for the one predicate that
// decides the boundary.
//
// It is safe to run concurrently with itself: candidates are locked FOR UPDATE
// SKIP LOCKED, so two processes sweeping at once divide the work rather than
// double-counting it or deadlocking.
func (s *Store) ExpireDue(ctx context.Context) (warned int, deleted int, err error) {
	if err := s.check(); err != nil {
		return 0, 0, err
	}
	now := s.now()
	cur := Cursor{}
	for i := 0; i < maxSweepBatches; i++ {
		w, d, next, n, err := s.sweepBatch(ctx, now, cur)
		warned += w
		deleted += d
		if err != nil {
			return warned, deleted, err
		}
		if n < sweepBatch {
			return warned, deleted, nil
		}
		cur = next
	}
	return warned, deleted, fmt.Errorf("quarantine: expire: %d batches did not drain the backlog", maxSweepBatches)
}

// sweepBatch handles up to sweepBatch candidates and reports how many it saw,
// so the caller knows whether to continue.
//
// The candidate filter is `expires_at <= warnCutoff(now)` — the warning
// predicate itself, which is a superset of the deletion predicate because
// nothing is deletable before it is warnable. The DECISION for each row is then
// made in Go, against the injected clock, through dueForWarning and
// dueForDeletion. That split is deliberate: it keeps the boundary in one place
// rather than putting half of it in SQL where a mutation would go unnoticed.
func (s *Store) sweepBatch(ctx context.Context, now time.Time, after Cursor) (warned, deleted int, next Cursor, seen int, err error) {
	tx, err := s.begin(ctx)
	if err != nil {
		return 0, 0, after, 0, err
	}
	defer s.rollback(ctx, tx)

	rows, err := tx.Query(ctx, `SELECT id, expires_at, warned_at FROM quarantine
	  WHERE expires_at <= $1 AND (expires_at, id) > ($2, $3)
	  ORDER BY expires_at, id LIMIT $4
	  FOR UPDATE SKIP LOCKED`, s.warnCutoff(now), after.At, after.ID, sweepBatch)
	if err != nil {
		return 0, 0, after, 0, fmt.Errorf("quarantine: expire: scan candidates: %w", err)
	}
	var toWarn, toDelete []uuid.UUID
	next = after
	for rows.Next() {
		var (
			id      uuid.UUID
			expires time.Time
			warnedA *time.Time
		)
		if err := rows.Scan(&id, &expires, &warnedA); err != nil {
			rows.Close()
			return 0, 0, after, 0, fmt.Errorf("quarantine: expire: %w", err)
		}
		seen++
		next = Cursor{At: expires, ID: id}
		switch {
		case s.dueForDeletion(expires, warnedA, now):
			toDelete = append(toDelete, id)
		case warnedA == nil && s.dueForWarning(expires, now):
			// Warned this pass, never warned and deleted in the same one: the
			// notice has to be visible to a client before it can be acted on.
			toWarn = append(toWarn, id)
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, 0, after, 0, fmt.Errorf("quarantine: expire: %w", err)
	}

	if len(toWarn) > 0 {
		ct, err := tx.Exec(ctx, `UPDATE quarantine SET warned_at = $2 WHERE id = ANY($1) AND warned_at IS NULL`, toWarn, now)
		if err != nil {
			return 0, 0, after, seen, fmt.Errorf("quarantine: expire: warn: %w", err)
		}
		warned = int(ct.RowsAffected())
	}
	if len(toDelete) > 0 {
		deleted, err = s.removeLocked(ctx, tx, toDelete, now, ReasonExpired)
		if err != nil {
			return warned, 0, after, seen, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, 0, after, seen, fmt.Errorf("quarantine: expire: commit: %w", err)
	}
	return warned, deleted, next, seen, nil
}

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

// begin pins READ COMMITTED rather than inheriting it, for the same reason
// oplog.Appender and addresses do: default_transaction_isolation is settable
// per database, per role and by a pooler, and under REPEATABLE READ the
// FOR UPDATE SKIP LOCKED that divides concurrent sweeps would raise a
// serialization failure instead of doing its job.
func (s *Store) begin(ctx context.Context) (pgx.Tx, error) {
	tx, err := s.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return nil, fmt.Errorf("quarantine: begin: %w", err)
	}
	return tx, nil
}

// rollback runs on a context detached from the caller's, so a cancelled request
// still releases its row locks cleanly instead of leaving pgx to destroy the
// connection.
func (s *Store) rollback(ctx context.Context, tx pgx.Tx) {
	rbCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	_ = tx.Rollback(rbCtx)
}

func nullText(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func oneOf(v string, allowed ...string) bool {
	for _, a := range allowed {
		if v == a {
			return true
		}
	}
	return false
}
