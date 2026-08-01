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
	"ledger/internal/v2/origin"
)

// Store answers the trust lane's one question about a user's allowlist.
// Asserted here so the two cannot drift apart silently: origin.Decide consumes
// this store directly, with no adapter.
var _ origin.Allowlist = (*Store)(nil)

const (
	// DefaultTTL is spec §3.2:56's 30 days.
	DefaultTTL = 30 * 24 * time.Hour
	// MaxEnvelopeFrom bounds a stored return path. RFC 5321 §4.5.3.1.3 caps a
	// reverse-path at 256 octets; this leaves room for the angle brackets and a
	// long address without admitting anything body-shaped.
	MaxEnvelopeFrom = 320
	// MaxDomain is RFC 1035's 253-octet cap on a presentation-form hostname,
	// and the cap the CHECK constraints carry.
	MaxDomain = 253
	// MaxOuterDomain is MaxDomain plus room for UnverifiedPrefix, because an
	// unverified outer domain stores the marker in the same column.
	MaxOuterDomain = MaxDomain + len(UnverifiedPrefix)
	// DefaultWarnBefore is how long before expiry the client is warned. It
	// matches the address grace window for the same reason that one is 7 days:
	// it is the shortest window in which a person who checks their phone
	// occasionally will actually see the notice.
	DefaultWarnBefore = 7 * 24 * time.Hour
)

// The two allowlist scopes. Outer is the signing domain of the message as we
// received it; Inner is the bank behind a forwarder, and is only ever available
// when an attestation proved it.
//
// Aliased from origin rather than declared again: these strings are a CHECK
// constraint on one side and a trust decision on the other, and two spellings
// of "outer" would mean rows this store writes that origin.Decide never reads.
const (
	ScopeOuter = origin.ScopeOuter
	ScopeInner = origin.ScopeInner
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

// §3.2:51's refusal list lives in origin.ForwarderDomains and is not copied
// here. This package held its own for one commit, and the copy was wrong within
// the day: it listed the domains users have MAILBOXES at (gmail.com,
// icloud.com) while the value being guarded is the domain that SIGNED the
// message, which for a Gmail forward is google.com. The constraint therefore
// refused "gmail.com" and accepted "google.com" — the same bypass, spelled
// differently, and durable because it was also a CHECK.
//
// origin owns the definition because origin is what decides trust with it.
// Migration 00009's constraint mirrors that list and
// TestTheSQLForwarderListMatchesOrigin fails if the two diverge.

// reHostname mirrors the SQL grammar. It deliberately does not admit
// UnverifiedPrefix.
var reHostname = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$`)

// NormalizeDomain is the ONE spelling rule for a stored hostname: trimmed and
// lower-cased, because DNS is case-insensitive while `=` is not.
//
// It is exported because the HTTP layer has to echo back the value it stored
// rather than the one it was sent — a response that repeats "DIB.AE" while the
// row says "dib.ae" invites a client to build its next request, and its local
// state, from a string this store would not match.
func NormalizeDomain(domain string) string {
	return strings.ToLower(strings.TrimSpace(domain))
}

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

	// EnvelopeFrom is the SMTP return path exactly as it arrived at MAIL FROM,
	// "" for a null sender.
	//
	// It is stored for ONE reason: origin.ResolveWithEnvelope needs it to tell
	// a signature that is ALIGNED with the sender from a bank's signature that
	// survived a forward, and the envelope is out of band — it is nowhere in
	// Blob, so a row without it has destroyed it. When a sender is confirmed,
	// Task 30 re-resolves these messages, and a re-resolve that saw an empty
	// envelope could stop attesting an inner origin the first resolve attested:
	// mail coming back LESS trusted than it arrived, for no reason a user could
	// see.
	//
	// It is an assertion, never evidence, and nothing keys on it. The sync
	// channel does not render it: §3.2:55 says the trust sheet shows verified
	// domains, and this is text the sender wrote.
	EnvelopeFrom string

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
 (id, user_id, ingest_id, received_at, expires_at, envelope_from, outer_domain, inner_domain,
  attested, attested_by, dkim, arc, size_bucket, blob)
 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
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
		it.EnvelopeFrom, it.OuterDomain, nullText(it.InnerDomain),
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

	// Trimmed but NOT lower-cased: a local part is case-sensitive (RFC 5321
	// §2.4), and this value exists to be handed back to the resolver exactly as
	// it arrived. Control characters are refused because a return path carrying
	// a newline is a forged log line, and because nothing legitimate has one.
	it.EnvelopeFrom = strings.TrimSpace(it.EnvelopeFrom)
	if len(it.EnvelopeFrom) > MaxEnvelopeFrom {
		return it, fmt.Errorf("%w: envelope_from is %d bytes, cap is %d", ErrInvalidItem, len(it.EnvelopeFrom), MaxEnvelopeFrom)
	}
	if strings.ContainsFunc(it.EnvelopeFrom, func(r rune) bool { return r < 0x20 || r == 0x7f }) {
		return it, fmt.Errorf("%w: envelope_from contains a control character", ErrInvalidItem)
	}

	// The length caps are the CHECK constraints' own, and they are here because
	// this function claims to mirror them: without them an over-long domain —
	// which a regex anchored on LABEL length happily accepts — passed validate
	// and was refused by the database instead, which reaches the caller as a
	// 500 rather than as the ErrInvalidItem it is.
	it.OuterDomain = NormalizeDomain(it.OuterDomain)
	if it.OuterDomain != "" &&
		(len(it.OuterDomain) > MaxOuterDomain || !reHostname.MatchString(strings.TrimPrefix(it.OuterDomain, UnverifiedPrefix))) {
		return it, fmt.Errorf("%w: outer_domain is not a hostname", ErrInvalidItem)
	}
	it.InnerDomain = NormalizeDomain(it.InnerDomain)
	if it.InnerDomain != "" && (len(it.InnerDomain) > MaxDomain || !reHostname.MatchString(it.InnerDomain)) {
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
 envelope_from, outer_domain, inner_domain, attested, attested_by, dkim, arc, size_bucket`

// DefaultListBytes bounds the raw-message bytes one ?include_blob=1 page may
// carry. It is chosen against PEAK MEMORY rather than bandwidth, and it is the
// same number as oplog's pull budget for the same reason: a held blob can be a
// megabyte, so a row limit alone bounds nothing useful.
const DefaultListBytes = 4 << 20

// List returns one keyset page of a user's held mail, oldest first, under the
// default byte budget. See [Store.ListPage] for the budget and what it means
// for a caller that needs to know whether the page was complete.
func (s *Store) List(ctx context.Context, userID uuid.UUID, after Cursor, limit int, withBlob bool) ([]Item, error) {
	items, _, err := s.ListPage(ctx, userID, after, limit, withBlob, 0)
	return items, err
}

// listPageSQL is the blob-carrying page, with the byte budget applied IN THE
// DATABASE. It is oplog.readPageSQL's shape, and it is that shape for the
// reason written out there rather than for symmetry:
//
// The obvious implementation — LIMIT in SQL, budget in Go — bounds what this
// process retains and nothing else. pgx drains a result set it stops scanning,
// so Postgres still sends every row LIMIT selected, and every one of them is
// materialized into the []Item this function returns before anything can
// truncate it. At maxQuarantineLimit and this table's 1 MB rows that is 200 MB
// allocated server-side for one request, by any authenticated caller,
// concurrently.
//
// The window sum runs over size_bucket — a plain int column — so a row the
// outer WHERE discards is never detoasted and never serialized. `running` is
// monotone because (received_at, id) is unique, so `running <= $5` always
// selects a PREFIX: a page with a hole in it would be far worse than a page
// that is too big, because the cursor below is taken from the last row RETURNED.
//
// `rn = 1` is what guarantees forward progress: without it a single message
// larger than the budget would return an empty page forever and the client's
// cursor could never pass it.
const listPageSQL = `
SELECT ` + itemColumns + `, blob, selected
  FROM (
    SELECT ` + itemColumns + `, blob,
           sum(size_bucket) OVER (ORDER BY received_at, id) AS running,
           row_number()     OVER (ORDER BY received_at, id) AS rn,
           count(*)         OVER ()                         AS selected
      FROM quarantine
     WHERE user_id = $1 AND (received_at, id) > ($2, $3)
     ORDER BY received_at, id
     LIMIT $4
  ) page
 WHERE page.rn = 1 OR page.running <= $5
 ORDER BY page.received_at, page.id`

// ListPage returns one keyset page of a user's held mail, oldest first, and
// reports whether the byte budget cut it short of the rows the limit selected.
//
// withBlob is false for the ordinary listing: the client's lane renders origin
// facts, not the message, and a page of raw bodies is megabytes. It is true for
// the one Phase 1 path that needs the body — Gmail's own forward-verification
// mail quarantines like everything else, and onboarding reads the confirmation
// link out of it (§3.2:47).
//
// maxBytes applies only to that path, because the ordinary listing selects no
// blob column at all and so has nothing to bound. maxBytes <= 0 means
// [DefaultListBytes].
//
// truncated is not a nicety: a caller that reports "complete" because the page
// came back shorter than the limit would tell a client the lane is empty when
// the budget stopped it three rows in.
func (s *Store) ListPage(ctx context.Context, userID uuid.UUID, after Cursor, limit int,
	withBlob bool, maxBytes int) ([]Item, bool, error) {
	if err := s.check(); err != nil {
		return nil, false, err
	}
	if !withBlob {
		rows, err := s.Pool.Query(ctx, `SELECT `+itemColumns+` FROM quarantine
		  WHERE user_id = $1 AND (received_at, id) > ($2, $3)
		  ORDER BY received_at, id LIMIT $4`, userID, after.At, after.ID, limit)
		if err != nil {
			return nil, false, fmt.Errorf("quarantine: list: %w", err)
		}
		defer rows.Close()
		var out []Item
		for rows.Next() {
			it, err := scanItem(rows, false)
			if err != nil {
				return nil, false, fmt.Errorf("quarantine: list: %w", err)
			}
			out = append(out, it)
		}
		if err := rows.Err(); err != nil {
			return nil, false, fmt.Errorf("quarantine: list: %w", err)
		}
		return out, false, nil
	}
	if maxBytes <= 0 {
		maxBytes = DefaultListBytes
	}
	rows, err := s.Pool.Query(ctx, listPageSQL, userID, after.At, after.ID, limit, maxBytes)
	if err != nil {
		return nil, false, fmt.Errorf("quarantine: list: %w", err)
	}
	defer rows.Close()
	var (
		out      []Item
		selected int
	)
	for rows.Next() {
		// selected is the number of rows the LIMIT chose before the budget cut
		// them; anything it dropped is the difference. Read from the same rows
		// so it is one query and one instant rather than two answers.
		it, err := scanItem(rows, true, &selected)
		if err != nil {
			return nil, false, fmt.Errorf("quarantine: list: %w", err)
		}
		out = append(out, it)
	}
	if err := rows.Err(); err != nil {
		return nil, false, fmt.Errorf("quarantine: list: %w", err)
	}
	return out, selected > len(out), nil
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

// IsHeld reports whether this user is still holding the named message.
//
// It exists so the arrival path's redelivery check does not have to be a
// [Store.Held] whose result it throws away: that read SELECTs the full raw body
// — up to a megabyte, out of TOAST — purely to test existence, on EVERY inbound
// message. EXISTS answers the same question off the (user_id, ingest_id) unique
// index without touching the blob.
//
// The user id is not decoration. Two accounts can hold the SAME bytes, so an
// unscoped existence check would tell the pipeline that a stranger's copy makes
// this user's arrival a duplicate — and a duplicate is discarded.
func (s *Store) IsHeld(ctx context.Context, userID uuid.UUID, ingestID []byte) (bool, error) {
	if err := s.check(); err != nil {
		return false, err
	}
	var ok bool
	err := s.Pool.QueryRow(ctx,
		`SELECT EXISTS (SELECT 1 FROM quarantine WHERE user_id = $1 AND ingest_id = $2)`,
		userID, ingestID).Scan(&ok)
	if err != nil {
		return false, fmt.Errorf("quarantine: is held: %w", err)
	}
	return ok, nil
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

// scanItem reads one row of [itemColumns], optionally followed by the blob and
// then by any extra destinations the caller's own SELECT appended.
func scanItem(rows pgx.Rows, withBlob bool, extra ...any) (Item, error) {
	var (
		it    Item
		inner *string
	)
	dst := []any{&it.ID, &it.UserID, &it.IngestID, &it.ReceivedAt, &it.ExpiresAt, &it.WarnedAt,
		&it.EnvelopeFrom, &it.OuterDomain, &inner, &it.Attested, &it.AttestedBy, &it.DKIM, &it.ARC, &it.SizeBucket}
	if withBlob {
		dst = append(dst, &it.Blob)
	}
	dst = append(dst, extra...)
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
// It is idempotent in both directions. Confirming an already-confirmed origin
// re-reports whatever is still held and writes nothing new — and once the
// released mail has been promoted, so that nothing is held from that origin at
// all, it succeeds with an EMPTY list rather than refusing. The refusal is
// reserved for an origin this account has never proven; an origin already on
// the allowlist has been proven, and answering "there is nothing to trust yet"
// about it is reachable by a double-tap, a retry after a lost response, or one
// extra pass of the `remaining > 0` loop the API documents — on the single step
// spec §3.2 calls out as onboarding.
func (s *Store) Confirm(ctx context.Context, userID uuid.UUID, domain, scope string) ([][]byte, error) {
	if err := s.check(); err != nil {
		return nil, err
	}
	if userID == uuid.Nil {
		return nil, errors.New("quarantine: confirm: user id is zero")
	}
	domain = NormalizeDomain(domain)
	if !reHostname.MatchString(domain) {
		return nil, fmt.Errorf("%w: %q", ErrInvalidDomain, domain)
	}
	var (
		match   string
		missing error
	)
	switch scope {
	case ScopeOuter:
		// origin's predicate, not a local one, and permissive: mail.google.com
		// is as much a forwarder as google.com.
		if origin.IsForwarderDomain(domain) {
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
		// Nothing is held from this origin, which is two different situations
		// and only one of them is a refusal.
		//
		// If the entry already exists, this account has ALREADY proven the
		// origin and the mail that proved it has since been promoted into the
		// log — the state a successful confirmation leaves behind. There is
		// nothing to release and nothing to write, and the honest answer is an
		// empty list.
		//
		// If it does not, nothing this user has been shown proves the origin.
		// Refusing here rather than writing the row anyway is what keeps the
		// allowlist a record of verifications the user actually saw.
		var already bool
		if err := tx.QueryRow(ctx,
			`SELECT EXISTS (SELECT 1 FROM sender_allowlist WHERE user_id = $1 AND domain = $2 AND scope = $3)`,
			userID, domain, scope).Scan(&already); err != nil {
			return nil, fmt.Errorf("quarantine: confirm: %w", err)
		}
		if already {
			return nil, nil
		}
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
		userID, NormalizeDomain(domain), scope).Scan(&ok)
	if err != nil {
		return false, fmt.Errorf("quarantine: allowlisted: %w", err)
	}
	return ok, nil
}

// AllowlistEntry is one origin a user has vouched for. It is content-free: a
// hostname, which scope it was vouched for at, and when.
type AllowlistEntry struct {
	Domain    string
	Scope     string
	CreatedAt time.Time
}

// AllowlistedOrigins returns everything this user has confirmed, newest first.
//
// It is not a convenience, for the same reason the push-token list route is not
// one: [Store.Revoke] needs the exact (domain, scope) pair, and a user who
// confirmed a lookalike months ago has no other way to find out what their
// account currently trusts. An undo nobody can aim is not an undo.
func (s *Store) AllowlistedOrigins(ctx context.Context, userID uuid.UUID) ([]AllowlistEntry, error) {
	if err := s.check(); err != nil {
		return nil, err
	}
	rows, err := s.Pool.Query(ctx,
		`SELECT domain, scope, created_at FROM sender_allowlist
		  WHERE user_id = $1 ORDER BY created_at DESC, domain, scope`, userID)
	if err != nil {
		return nil, fmt.Errorf("quarantine: allowlisted origins: %w", err)
	}
	defer rows.Close()
	var out []AllowlistEntry
	for rows.Next() {
		var e AllowlistEntry
		if err := rows.Scan(&e.Domain, &e.Scope, &e.CreatedAt); err != nil {
			return nil, fmt.Errorf("quarantine: allowlisted origins: %w", err)
		}
		out = append(out, e)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("quarantine: allowlisted origins: %w", err)
	}
	return out, nil
}

// Revoke withdraws a user's confirmation of an origin and reports whether there
// was one to withdraw.
//
// # Why this exists
//
// Confirming is one tap and the hostname grammar admits lookalikes —
// dib-alerts.ae, or a punycode A-label that renders as the bank's own name.
// Until this existed nothing in the tree deleted a sender_allowlist row except
// `users ON DELETE CASCADE`, so the only remedy for a mistaken confirmation was
// deleting the account. A trust decision a user can make and cannot unmake is
// not a decision they were really offered.
//
// # What it does and does not undo
//
// It closes the lane going forward: the trust decision is re-read from this
// table on every arrival AND on every reprocess, so the next message from that
// origin quarantines again exactly as the first one did
// (ingest.TestReprocessOfStoredMailReChecksTheAllowlist already proved the
// reprocess half — the row simply could not be removed).
//
// It does not retract what is already in the log. Those ops are in the user's
// integrity chains and removing them is not a thing this system can do; the
// transactions are theirs to delete on the client like any other. Nor does it
// re-quarantine mail: the messages are no longer held, and a copy this store
// deleted after promoting is not recoverable from here.
func (s *Store) Revoke(ctx context.Context, userID uuid.UUID, domain, scope string) (bool, error) {
	if err := s.check(); err != nil {
		return false, err
	}
	if userID == uuid.Nil {
		return false, errors.New("quarantine: revoke: user id is zero")
	}
	// The same two refusals Confirm makes, so a client cannot discover that a
	// malformed request is treated differently by the two halves of one flow.
	if scope != ScopeOuter && scope != ScopeInner {
		return false, fmt.Errorf("%w: %q", ErrUnknownScope, scope)
	}
	domain = NormalizeDomain(domain)
	if !reHostname.MatchString(domain) {
		return false, fmt.Errorf("%w: %q", ErrInvalidDomain, domain)
	}
	ct, err := s.Pool.Exec(ctx,
		`DELETE FROM sender_allowlist WHERE user_id = $1 AND domain = $2 AND scope = $3`,
		userID, domain, scope)
	if err != nil {
		return false, fmt.Errorf("quarantine: revoke: %w", err)
	}
	return ct.RowsAffected() > 0, nil
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
