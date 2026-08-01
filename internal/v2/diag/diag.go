// Package diag owns the bounded, deliberately unencrypted parse-diagnostics
// ledger (spec §3.5) and the aggregated protocol-rejection counter beside it.
//
// # Why an unencrypted table exists in an encrypted-at-rest design
//
// v1 promised "nothing is ever silently dropped" and could keep that promise
// because it retained every raw body. v2 cannot: bodies are sealed to the
// user's public key at the moment of arrival and the server can never read them
// again. Without something, "my transactions stopped appearing" would be
// unanswerable — the operator could not tell a broken template from a bank that
// changed its mail from a user who simply stopped spending.
//
// So this package stores NON-CONTENT FACTS about each ingest: which template
// was attempted, whether it matched, which of its named groups came back empty,
// which padding bucket the body fell in, who signed it, and what happened. That
// turns "unparsed, cause unknown" into a fixable bug report.
//
// # The privacy contract, stated as a promise that can be broken
//
// Spec §2 lists this table in the breach inventory and §3.5 calls it a
// "deliberate, bounded privacy concession". §2 is adopted VERBATIM into the
// user-facing privacy page. That makes the field list a published claim rather
// than an implementation detail: a column that exists here and not in §2 is a
// false statement to users about what a breach of this server yields.
//
// Two tests keep that from drifting. TestDiagnosticsTableHasExactlyTheDisclosed
// Columns fails on any new column, and TestEveryDisclosedColumnIsNamedInSpec
// Section2 keeps failing until §2 names it too — so the inventory cannot be
// updated in a later commit, or forgotten.
//
// What a breach of this table yields, plainly: which bank each user uses, when
// each of their transactions occurred, what shape their bank's mail has, and
// which parts of it we failed to read. What it does NOT yield: any amount, any
// merchant, any subject, any From display name, any header value, any capture
// group VALUE, any fragment of a body.
//
// # How "no content" is actually enforced
//
// Not by convention. Every text field is one of four bounded grammars — a
// closed enum, a hostname, an identifier, or a fixed-width hex digest — checked
// in Go by [Diag.Record] AND independently by a CHECK constraint in
// 00006_diagnostics.sql. The Go check is the guard; the constraint is the
// guarantee, because a guarantee that only holds when callers behave is not
// one. A repair script cannot put a subject line in this table.
//
// Two subtler leaks are closed explicitly:
//
//   - VALIDATION ERRORS NEVER ECHO THE VALUE THEY REJECTED. A prior task's
//     error text was found capable of carrying a token fragment into the
//     operator log; an error here saying `sender_domain %q is invalid` would
//     route the exact content this table refuses to store straight into the
//     logs instead. Errors name the FIELD and nothing else.
//   - POSTGRES ERRORS ARE STRIPPED. A constraint violation's PgError.Detail
//     contains "Failing row contains (...)" — every column of the row, in plain
//     text. pgx's Error() method does not render Detail, so this is not a leak
//     you would see by printing the error; it rides in the error VALUE, where
//     errors.As reaches it and a structured logger that reflects over fields
//     will serialize it. [Diag.Record] therefore returns an error that does not
//     WRAP the PgError at all, keeping only the constraint name.
package diag

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"ledger/internal/v2/blob"
)

// ErrInvalidRecord is returned by [Diag.Record] and [Diag.CountRejection] for
// anything that does not fit the disclosed field list. It is wrapped by every
// validation failure so a caller can distinguish "this record was malformed"
// from "the database was unreachable" — the first is a bug in the caller, the
// second is worth retrying.
var ErrInvalidRecord = errors.New("diag: invalid record")

// Event kinds. Arrivals and reprocessing are counted separately and never
// folded together: reprocessing is reported BESIDE inbound_total, because a
// re-ingest that silently incremented the inbound count would make the
// "nothing was dropped" arithmetic work for the wrong reason.
const (
	EventArrival   = "arrival"
	EventReprocess = "reprocess"
)

// Outcomes for EventArrival.
const (
	OutcomeAppended    = "appended"
	OutcomeQuarantined = "quarantined"
	OutcomeRejected    = "rejected"
	OutcomeOverQuota   = "over_quota"
	OutcomeDuplicate   = "duplicate"
)

// Outcomes for EventReprocess. OutcomeAppended is shared with arrivals.
const (
	OutcomeSuperseded = "superseded"
	OutcomeUnchanged  = "unchanged"
)

// Which tier produced the result.
const (
	TierTemplate  = "template"
	TierHeuristic = "heuristic"
	TierNone      = "none"
)

// Authentication results. ResultTempError is DKIM-only: an ARC chain either
// validates, fails, or is absent.
const (
	ResultPass      = "pass"
	ResultFail      = "fail"
	ResultNone      = "none"
	ResultTempError = "temperror"
)

// Rejection reasons. A CLOSED SET, never an error string — see the package doc.
const (
	RejectTooLarge       = "too_large"
	RejectUnknownRcpt    = "unknown_rcpt"
	RejectOverQuota      = "over_quota"
	RejectNoTextPart     = "no_text_part"
	RejectNormalizeError = "normalize_error"
)

// UnverifiedPrefix marks a sender domain taken from the envelope rather than
// from a verified signature. The distinction is between evidence and an
// attacker's assertion, and a column that rendered them identically would
// launder the second into the first.
const UnverifiedPrefix = "unverified:"

var (
	arrivalOutcomes = []string{
		OutcomeAppended, OutcomeQuarantined, OutcomeRejected, OutcomeOverQuota, OutcomeDuplicate,
	}
	reprocessOutcomes = []string{OutcomeAppended, OutcomeSuperseded, OutcomeUnchanged}
	tiers             = []string{TierTemplate, TierHeuristic, TierNone}
	dkimResults       = []string{ResultPass, ResultFail, ResultNone, ResultTempError}
	arcResults        = []string{ResultPass, ResultFail, ResultNone}
	rejectReasons     = []string{
		RejectTooLarge, RejectUnknownRcpt, RejectOverQuota, RejectNoTextPart, RejectNormalizeError,
	}
	// refusalOutcomes are the outcomes that have a reject_reason. Every other
	// outcome must not, so reject_reason cannot drift into a note field.
	refusalOutcomes = []string{OutcomeRejected, OutcomeOverQuota}
)

// The four grammars. Anything storable in a text column of parse_diagnostics
// matches one of these, which is what makes "no content" checkable rather than
// aspirational.
var (
	reHostname   = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$`)
	reTemplateID = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,63}$`)
	reGroupName  = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]{0,31}$`)
	reDigest     = regexp.MustCompile(`^[0-9a-f]{32}$`)
)

// maxEmptyGroups bounds how many group names one row can carry. A template with
// more than 32 named groups is not a thing this system produces, and an
// unbounded array is an unbounded amount of caller-supplied text.
const maxEmptyGroups = 32

// Record is one diagnostic. Its fields are EXACTLY the disclosed column list
// and no others; see the package doc for why adding one is a change to a
// published claim rather than a refactor.
//
// The zero value of a string field means "absent" and is stored as SQL NULL for
// the nullable columns (InnerOriginDomain, TemplateID, RejectReason).
type Record struct {
	// ID is generated when zero.
	ID uuid.UUID
	// UserID is invalid ONLY for protocol-layer events with no resolved
	// recipient. It is a NullUUID rather than a bare uuid.UUID so that an
	// accidentally-zero value cannot quietly become an unscoped row — an
	// unscoped row is one that survives its user's account deletion.
	UserID uuid.NullUUID

	Event      string
	IngestID   []byte // SHA-256 of the raw body, exactly 32 bytes
	ReceivedAt time.Time

	// SenderDomain is the verified signing domain, or the envelope domain
	// prefixed with UnverifiedPrefix. "" means no domain at all.
	SenderDomain string
	DKIMResult   string
	ARCResult    string
	// InnerOriginDomain may be set ONLY when an attestation passed. See
	// validate: the body's own From line is not an attestation.
	InnerOriginDomain string

	TemplateID        string
	TemplateVersion   int
	NormalizerVersion int
	Matched           bool
	// EmptyGroups holds NAMES ONLY of named capture groups that captured
	// nothing. Stored deduplicated and sorted.
	EmptyGroups []string

	Tier string
	// BodySizeBucket must be a rung of blob.Buckets, or 0 for "no bucket
	// applies". Never an exact size.
	BodySizeBucket int
	// StructureSig comes from [StructureSig], or is "" when no normalized text
	// existed.
	StructureSig string

	Outcome      string
	RejectReason string
}

// Diag writes diagnostics. It holds no state beyond its pool and clock.
type Diag struct {
	Pool *pgxpool.Pool
	// Now defaults to time.Now. Only CountRejection uses it, to pick the day a
	// rejection is aggregated into; Record uses the caller's ReceivedAt, which
	// is the arrival instant the rest of the pipeline already agreed on.
	Now func() time.Time
}

func (d *Diag) now() time.Time {
	if d.Now != nil {
		return d.Now()
	}
	return time.Now()
}

func (d *Diag) check() error {
	if d == nil || d.Pool == nil {
		return errors.New("diag: no pool")
	}
	return nil
}

const insertSQL = `INSERT INTO parse_diagnostics
 (id, user_id, event, ingest_id, received_at, sender_domain, dkim_result, arc_result,
  inner_origin_domain, template_id, template_version, normalizer_version, matched,
  empty_groups, tier, body_size_bucket, structure_sig, outcome, reject_reason)
 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`

// Record validates and stores one diagnostic. A record that does not fit the
// disclosed field list is refused with ErrInvalidRecord and NOTHING is written:
// there is no partial or best-effort path, because a diagnostics row that
// bypassed validation is exactly the row this package promises cannot exist.
func (d *Diag) Record(ctx context.Context, r Record) error {
	if err := d.check(); err != nil {
		return err
	}
	r, err := r.validate()
	if err != nil {
		return err
	}
	_, err = d.Pool.Exec(ctx, insertSQL,
		r.ID,
		nullUUID(r.UserID),
		r.Event,
		r.IngestID,
		r.ReceivedAt,
		r.SenderDomain,
		r.DKIMResult,
		r.ARCResult,
		nullText(r.InnerOriginDomain),
		nullText(r.TemplateID),
		nullInt(r.TemplateVersion),
		r.NormalizerVersion,
		r.Matched,
		r.EmptyGroups,
		r.Tier,
		r.BodySizeBucket,
		r.StructureSig,
		r.Outcome,
		nullText(r.RejectReason),
	)
	if err != nil {
		return sanitize("record", err)
	}
	return nil
}

// validate returns a canonicalized copy or an error naming the offending FIELD.
// It never includes the offending VALUE — see the package doc.
func (r Record) validate() (Record, error) {
	if r.ID == uuid.Nil {
		r.ID = uuid.New()
	}
	if r.Event != EventArrival && r.Event != EventReprocess {
		return r, badf("event is not one of %v", []string{EventArrival, EventReprocess})
	}
	if len(r.IngestID) != 32 {
		return r, badf("ingest_id must be a 32-byte sha256, got %d bytes", len(r.IngestID))
	}
	if r.ReceivedAt.IsZero() {
		return r, badf("received_at is required")
	}

	// Sender domain: hostname grammar, optionally marked unverified.
	if r.SenderDomain != "" {
		host := strings.ToLower(r.SenderDomain)
		bare := strings.TrimPrefix(host, UnverifiedPrefix)
		if !reHostname.MatchString(bare) || len(host) > 264 {
			return r, badf("sender_domain is not a bounded hostname")
		}
		r.SenderDomain = host
	}

	if !slices.Contains(dkimResults, r.DKIMResult) {
		return r, badf("dkim_result is not one of %v", dkimResults)
	}
	if !slices.Contains(arcResults, r.ARCResult) {
		return r, badf("arc_result is not one of %v", arcResults)
	}

	// The most content-adjacent field in the table. An inner origin is only
	// knowable from an attestation; without one, the sole available source is
	// the forwarded body's own From line, which is content and is untrusted.
	if r.InnerOriginDomain != "" {
		host := strings.ToLower(r.InnerOriginDomain)
		if !reHostname.MatchString(host) || len(host) > 253 {
			return r, badf("inner_origin_domain is not a bounded hostname")
		}
		if r.DKIMResult != ResultPass && r.ARCResult != ResultPass {
			return r, badf("inner_origin_domain requires a passing dkim_result or arc_result; " +
				"without one its only possible source is untrusted body text")
		}
		r.InnerOriginDomain = host
	}

	// Template id and version travel together or not at all.
	switch {
	case r.TemplateID == "" && r.TemplateVersion != 0:
		return r, badf("template_version was set without a template_id")
	case r.TemplateID != "" && r.TemplateVersion == 0:
		return r, badf("template_id was set without a template_version")
	case r.TemplateID != "":
		if !reTemplateID.MatchString(r.TemplateID) {
			return r, badf("template_id is not a bounded identifier")
		}
		if r.TemplateVersion < 1 || r.TemplateVersion > 1000000 {
			return r, badf("template_version is out of range")
		}
	}

	if r.NormalizerVersion < 0 || r.NormalizerVersion > 1000 {
		return r, badf("normalizer_version is out of range")
	}
	if r.Matched && r.TemplateID == "" {
		return r, badf("matched is set but no template_id was attempted")
	}

	// Group NAMES only, bounded, deduplicated and sorted. Sorting matters: the
	// order a parser happened to evaluate its groups in is not a fact worth
	// storing, and storing it would make two identical failures look different.
	if len(r.EmptyGroups) > maxEmptyGroups {
		return r, badf("empty_groups holds more than %d names", maxEmptyGroups)
	}
	if len(r.EmptyGroups) > 0 {
		groups := make([]string, 0, len(r.EmptyGroups))
		for _, g := range r.EmptyGroups {
			if !reGroupName.MatchString(g) {
				return r, badf("empty_groups must hold capture-group names, " +
					"which are bounded identifiers")
			}
			groups = append(groups, g)
		}
		slices.Sort(groups)
		r.EmptyGroups = slices.Compact(groups)
	} else {
		r.EmptyGroups = []string{}
	}

	if !slices.Contains(tiers, r.Tier) {
		return r, badf("tier is not one of %v", tiers)
	}
	if r.Tier == TierTemplate && !r.Matched {
		return r, badf("tier is template but matched is false")
	}

	if r.BodySizeBucket != 0 && !slices.Contains(blob.Buckets, r.BodySizeBucket) {
		return r, badf("body_size_bucket is not a rung of the padding ladder %v", blob.Buckets)
	}

	if r.StructureSig != "" && !reDigest.MatchString(r.StructureSig) {
		return r, badf("structure_sig is not a 32-character hex digest")
	}

	// Each event kind has its own outcome vocabulary.
	allowed := arrivalOutcomes
	if r.Event == EventReprocess {
		allowed = reprocessOutcomes
	}
	if !slices.Contains(allowed, r.Outcome) {
		return r, badf("outcome is not one of %v for this event", allowed)
	}

	// Only a refusal has a reason, and every refusal has one.
	isRefusal := slices.Contains(refusalOutcomes, r.Outcome)
	if r.RejectReason != "" && !slices.Contains(rejectReasons, r.RejectReason) {
		return r, badf("reject_reason is not one of %v", rejectReasons)
	}
	if isRefusal && r.RejectReason == "" {
		return r, badf("reject_reason is required for a refusal outcome")
	}
	if !isRefusal && r.RejectReason != "" {
		return r, badf("reject_reason was set for a non-refusal outcome")
	}

	// An unscoped row survives its user's account deletion, so only the
	// protocol-layer refusals that genuinely have no recipient may be unscoped.
	if !r.UserID.Valid && !(r.Event == EventArrival && r.Outcome == OutcomeRejected) {
		return r, badf("user_id is required except for a rejected arrival")
	}
	if r.UserID.Valid && r.UserID.UUID == uuid.Nil {
		return r, badf("user_id is the nil uuid")
	}
	return r, nil
}

// CountRejection increments the aggregated daily count for a protocol-level
// rejection.
//
// Rejections that never resolve a recipient — an unknown RCPT — have no user to
// scope a diagnostics row to, and one row per attempt would let anyone flood
// the table from the open :25. Aggregating closes the "nothing is dropped
// without notice" hole without opening a storage-amplification one.
// [Diag.Accounting] reports the counts beside inbound_total.
func (d *Diag) CountRejection(ctx context.Context, reason string) error {
	return d.CountRejections(ctx, reason, 1)
}

// CountRejections adds n to the aggregated daily count in one statement.
//
// It exists for a caller that batches. Every row here is an upsert on a SINGLE
// row per (day, reason), so one write per refusal makes that row the hottest
// thing in the database under exactly the traffic this counter is meant to
// survive — an unauthenticated flood on the open port. A caller that aggregates
// in memory and flushes periodically turns thousands of contended upserts into
// one, and needs a way to add more than 1 to do it.
//
// n <= 0 is a no-op rather than an error: a flush of an empty bucket is a
// normal thing to ask for, and a decrement is not.
func (d *Diag) CountRejections(ctx context.Context, reason string, n int64) error {
	if err := d.check(); err != nil {
		return err
	}
	if !slices.Contains(rejectReasons, reason) {
		// Note the absence of %q: the argument is not echoed, because the
		// caller that got this wrong is exactly the caller that might have
		// passed an SMTP response line containing a recipient address.
		return badf("reason is not one of %v", rejectReasons)
	}
	if n <= 0 {
		return nil
	}
	_, err := d.Pool.Exec(ctx, `INSERT INTO smtp_rejections (day, reason, count)
	  VALUES ($1::date, $2, $3)
	  ON CONFLICT (day, reason) DO UPDATE SET count = smtp_rejections.count + $3`,
		d.now().UTC().Format("2006-01-02"), reason, n)
	if err != nil {
		return sanitize("count rejection", err)
	}
	return nil
}

// badf builds a validation error. Callers pass a format string and CONSTANTS
// only — never a field value. Every message names the offending column so an
// operator can act on it without the value ever being written down.
func badf(format string, args ...any) error {
	return fmt.Errorf("%w: %s", ErrInvalidRecord, fmt.Sprintf(format, args...))
}

// sanitize strips a database error down to the constraint that failed.
//
// pgconn.PgError.Detail carries "Failing row contains (...)" — the ENTIRE row,
// every column, in plain text. That would hand the operator log exactly the
// content the constraints exist to keep out of the database, and the log is not
// encrypted, not scoped to a user, and not purged with the account.
//
// Note precisely where the hazard is, because it is not where it looks: pgx's
// Error() does NOT print Detail, so the raw error's TEXT is already clean and a
// message-only test would pass against a sanitize that did nothing. The Detail
// travels in the error value. So this returns an error that deliberately does
// not %w-wrap the PgError — after this, errors.As cannot recover it.
// TestSanitizeStripsTheFailingRowFromACheckViolation asserts exactly that, and
// asserts the precondition too, so it cannot pass by there being nothing there.
func sanitize(op string, err error) error {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		if pgErr.ConstraintName != "" {
			return fmt.Errorf("diag: %s: database rejected the row (constraint %s)",
				op, pgErr.ConstraintName)
		}
		return fmt.Errorf("diag: %s: database error %s", op, pgErr.Code)
	}
	return fmt.Errorf("diag: %s: %w", op, err)
}

func nullUUID(u uuid.NullUUID) any {
	if !u.Valid {
		return nil
	}
	return u.UUID
}

func nullText(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func nullInt(n int) any {
	if n == 0 {
		return nil
	}
	return n
}
