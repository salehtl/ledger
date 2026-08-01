package diag

// query.go is the READ side of the diagnostics ledger: the operator console's
// paged view, and the target set a template republish reprocesses.
//
// diag.go writes; nothing read this table until the admin console (Task 32)
// existed. The two halves are split by file rather than by package because the
// safety property they share is one property: every text column here is a
// closed enum, a hostname, an identifier or a hex digest, and that is only
// checkable if one package owns both the INSERT and the WHERE. A console that
// assembled its own SQL against this table would be a second place the closed
// sets have to be honoured, and the first place they would drift.
//
// # Filters are enumerated, never interpolated
//
// [Filter.Outcome] is validated against the same closed set [Record.validate]
// enforces on write, and every other filter is a typed value bound as a
// parameter. That is stricter than injection safety requires — pgx would bind
// a free-text outcome perfectly safely — and it is deliberate: an operator
// pastes things into URLs, a URL ends up in a log or a bug report, and the
// claim spec §2 makes to users is about what this system RETAINS, which
// includes what it logs. A filter that only accepts words from a fixed list
// cannot carry a merchant name into any of that.

import (
	"context"
	"slices"
	"time"

	"github.com/google/uuid"
)

// Paging bounds. The console reads this table by hand, one screen at a time.
const (
	DefaultQueryLimit = 100
	MaxQueryLimit     = 500

	// MaxSenderDomains bounds [Diag.SenderDomains]. The real answer is the
	// number of banks the beta's users receive mail from — single digits — and
	// the bound exists so a table polluted by a misconfiguration cannot turn one
	// console request into an unbounded read.
	MaxSenderDomains = 1000

	// MaxAffected bounds one reprocess target set. Reprocessing re-reads a cold
	// blob and re-runs the parse for every id in it, so this is the number that
	// decides how much work one button press is worth; the operator repeats the
	// call to continue.
	MaxAffected = 5000
)

// Cursor is a keyset position in the diagnostics ledger.
//
// It carries the ID as well as the instant because received_at is NOT unique
// and routinely ties: a user who forwards a month of bank mail in one action
// produces a burst that arrives inside the same microsecond bucket. A cursor on
// the timestamp alone either serves the rest of that tie twice (>=) or skips it
// (>), and both failures are invisible until someone counts.
type Cursor struct {
	ReceivedAt time.Time
	ID         uuid.UUID
}

// Filter bounds a diagnostics read. A zero From or To means unbounded in that
// direction; the window is half-open, [From, To).
type Filter struct {
	From, To time.Time
	// UserID scopes to one account. Invalid means every account, which is the
	// operator's view and one no user-facing surface may ever reach.
	UserID uuid.NullUUID
	// Event and Outcome are members of the closed sets in diag.go. "" means no
	// filter; anything else is refused.
	Event   string
	Outcome string
	Limit   int
	After   Cursor
}

const queryColumns = `id, user_id, event, ingest_id, received_at, sender_domain, dkim_result,
 arc_result, inner_origin_domain, template_id, template_version, normalizer_version, matched,
 empty_groups, tier, body_size_bucket, structure_sig, outcome, reject_reason`

// Query returns one page of diagnostics, oldest first.
//
// Oldest-first, and not the newest-first a console usually wants, because this
// ledger is read as an ACCOUNTING record: the question it answers is "what
// happened to every message in this window", and a forward cursor over a
// half-open window is the only ordering under which a caller that pages to the
// end has provably seen each row exactly once. A console showing the newest
// page first can ask for a short window and read it forward.
func (d *Diag) Query(ctx context.Context, f Filter) ([]Record, error) {
	if err := d.check(); err != nil {
		return nil, err
	}
	if f.Limit < 0 {
		return nil, badf("limit must not be negative")
	}
	if f.Limit == 0 {
		f.Limit = DefaultQueryLimit
	}
	if f.Limit > MaxQueryLimit {
		f.Limit = MaxQueryLimit
	}
	if f.Event != "" && f.Event != EventArrival && f.Event != EventReprocess {
		return nil, badf("event is not one of %v", []string{EventArrival, EventReprocess})
	}
	if f.Outcome != "" {
		// The union of both vocabularies, because the caller may not have
		// filtered by event. An outcome that belongs to the other event simply
		// matches nothing, which is the correct answer and not an error.
		if !slices.Contains(arrivalOutcomes, f.Outcome) && !slices.Contains(reprocessOutcomes, f.Outcome) {
			return nil, badf("outcome is not one of %v", append(slices.Clone(arrivalOutcomes), reprocessOutcomes...))
		}
	}

	const q = `
SELECT ` + queryColumns + `
FROM parse_diagnostics
WHERE ($1::timestamptz IS NULL OR received_at >= $1)
  AND ($2::timestamptz IS NULL OR received_at <  $2)
  AND ($3::uuid IS NULL OR user_id = $3)
  AND ($4::text IS NULL OR event = $4)
  AND ($5::text IS NULL OR outcome = $5)
  AND ($6::timestamptz IS NULL OR (received_at, id) > ($6, $7))
ORDER BY received_at, id
LIMIT $8`

	rows, err := d.Pool.Query(ctx, q,
		nullTime(f.From), nullTime(f.To), nullUUID(f.UserID),
		nullText(f.Event), nullText(f.Outcome),
		nullTime(f.After.ReceivedAt), f.After.ID, f.Limit)
	if err != nil {
		return nil, sanitize("query", err)
	}
	defer rows.Close()

	out := make([]Record, 0, f.Limit)
	for rows.Next() {
		var (
			r        Record
			inner    *string
			template *string
			version  *int
			reason   *string
		)
		if err := rows.Scan(&r.ID, &r.UserID, &r.Event, &r.IngestID, &r.ReceivedAt,
			&r.SenderDomain, &r.DKIMResult, &r.ARCResult, &inner, &template, &version,
			&r.NormalizerVersion, &r.Matched, &r.EmptyGroups, &r.Tier, &r.BodySizeBucket,
			&r.StructureSig, &r.Outcome, &reason); err != nil {
			return nil, sanitize("query", err)
		}
		r.InnerOriginDomain = deref(inner)
		r.TemplateID = deref(template)
		if version != nil {
			r.TemplateVersion = *version
		}
		r.RejectReason = deref(reason)
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, sanitize("query", err)
	}
	return out, nil
}

// SenderDomains returns the distinct verified signing domains seen in a window,
// sorted.
//
// It exists so the admin console can decide which domains a template covers by
// calling tmpl.MatchesSenderDomain over a small list, instead of expressing the
// label-boundary rule a second time in SQL. That rule — "dib.ae covers
// notifications.dib.ae and does not cover evildib.ae" — has exactly one
// implementation by design, and a LIKE '%.'||domain here would be the second
// one, in a language where the first mistake is silent.
func (d *Diag) SenderDomains(ctx context.Context, from, to time.Time) ([]string, error) {
	if err := d.check(); err != nil {
		return nil, err
	}
	const q = `
SELECT DISTINCT sender_domain
FROM parse_diagnostics
WHERE sender_domain <> ''
  AND ($1::timestamptz IS NULL OR received_at >= $1)
  AND ($2::timestamptz IS NULL OR received_at <  $2)
ORDER BY sender_domain
LIMIT $3`
	rows, err := d.Pool.Query(ctx, q, nullTime(from), nullTime(to), MaxSenderDomains)
	if err != nil {
		return nil, sanitize("sender domains", err)
	}
	defer rows.Close()

	var out []string
	for rows.Next() {
		var s string
		if err := rows.Scan(&s); err != nil {
			return nil, sanitize("sender domains", err)
		}
		out = append(out, s)
	}
	if err := rows.Err(); err != nil {
		return nil, sanitize("sender domains", err)
	}
	return out, nil
}

// ArrivalTally is a SECOND, independent count of the arrival rows in a window.
//
// It exists to be disagreed with. verify.Accounting derives inbound_total and
// the per-outcome split from ONE grouped scan, so `arrival_sum + unaccounted ==
// inbound_total` holds by construction there — both sides increment in the same
// branch — and the console published that identity as a health check called
// "balanced". An equation that cannot be false is worse than no equation: an
// operator reads it as independent corroboration and it is not one. This is the
// other measurement to check it against.
//
// It is deliberately NOT computed the same way: a plain count with the outcome
// test in SQL, over this package's own copy of the arrival vocabulary. The two
// share the diag.Outcome* constants and nothing else, so a defect in either
// classifier — a missed branch, a mis-ordered case, an outcome added to one
// list and not the other — shows up as Rows != Named or as a disagreement with
// the report, instead of cancelling out.
type ArrivalTally struct {
	// Rows is every event='arrival' row in [from, to).
	Rows int64
	// Named is those whose outcome is one this build can place. Rows > Named
	// means the ledger holds an arrival nobody can classify, which is exactly
	// what "unaccounted" is supposed to report.
	Named int64
}

// ArrivalTally counts the arrivals in [from, to) two ways. A zero From or To
// means unbounded in that direction, like [Filter].
func (d *Diag) ArrivalTally(ctx context.Context, from, to time.Time) (ArrivalTally, error) {
	if err := d.check(); err != nil {
		return ArrivalTally{}, err
	}
	const q = `
SELECT count(*), count(*) FILTER (WHERE outcome = ANY($3::text[]))
FROM parse_diagnostics
WHERE event = $4
  AND ($1::timestamptz IS NULL OR received_at >= $1)
  AND ($2::timestamptz IS NULL OR received_at <  $2)`
	var t ArrivalTally
	if err := d.Pool.QueryRow(ctx, q,
		nullTime(from), nullTime(to), arrivalOutcomes, EventArrival,
	).Scan(&t.Rows, &t.Named); err != nil {
		return ArrivalTally{}, sanitize("arrival tally", err)
	}
	return t, nil
}

// AffectedFilter names the mail a template change could change the meaning of.
type AffectedFilter struct {
	// TemplateID matches every row that names this template in ANY version:
	// both the messages it parsed and the ones it was tried on and could not
	// fill in (ingest records the attempted template on a missing-field
	// failure, which is the drift signal).
	TemplateID string
	// SenderDomains are EXACT verified domains, already expanded by the caller
	// through tmpl.MatchesSenderDomain. Rows from these domains that no tier
	// resolved are affected, because "the bank changed its format and nothing
	// parses any more" is the usual reason a new template version exists.
	SenderDomains []string
	From, To      time.Time
	Limit         int
}

// Affected is one message a reprocess would re-read.
type Affected struct {
	UserID   uuid.UUID
	IngestID []byte
}

// Affected returns the (user, ingest id) pairs a template change may alter,
// deduplicated.
//
// Rows with no user are excluded rather than reported: a protocol-layer refusal
// never resolved a recipient, so there is no cold stream to re-read and nothing
// a reprocess could do with it. Including them would hand the reprocessor a nil
// user id and turn "this message was refused at RCPT" into an error report.
func (d *Diag) Affected(ctx context.Context, f AffectedFilter) ([]Affected, error) {
	if err := d.check(); err != nil {
		return nil, err
	}
	if f.TemplateID == "" && len(f.SenderDomains) == 0 {
		return nil, badf("affected needs a template_id or at least one sender domain")
	}
	if f.TemplateID != "" && !reTemplateID.MatchString(f.TemplateID) {
		return nil, badf("template_id is not a bounded identifier")
	}
	for _, dom := range f.SenderDomains {
		bare := trimUnverified(dom)
		if !reHostname.MatchString(bare) || len(dom) > 264 {
			return nil, badf("sender domain is not a bounded hostname")
		}
	}
	if f.Limit <= 0 || f.Limit > MaxAffected {
		f.Limit = MaxAffected
	}

	const q = `
SELECT DISTINCT user_id, ingest_id
FROM parse_diagnostics
WHERE user_id IS NOT NULL
  AND ($1::timestamptz IS NULL OR received_at >= $1)
  AND ($2::timestamptz IS NULL OR received_at <  $2)
  AND (
        ($3::text IS NOT NULL AND template_id = $3)
     OR (tier = $4 AND sender_domain = ANY($5::text[]))
      )
ORDER BY user_id, ingest_id
LIMIT $6`

	domains := f.SenderDomains
	if domains == nil {
		domains = []string{}
	}
	rows, err := d.Pool.Query(ctx, q,
		nullTime(f.From), nullTime(f.To), nullText(f.TemplateID), TierNone, domains, f.Limit)
	if err != nil {
		return nil, sanitize("affected", err)
	}
	defer rows.Close()

	var out []Affected
	for rows.Next() {
		var a Affected
		if err := rows.Scan(&a.UserID, &a.IngestID); err != nil {
			return nil, sanitize("affected", err)
		}
		out = append(out, a)
	}
	if err := rows.Err(); err != nil {
		return nil, sanitize("affected", err)
	}
	return out, nil
}

// nullTime maps the zero time to SQL NULL, which every predicate above reads as
// "no bound". A zero time bound literally would exclude every row.
func nullTime(t time.Time) any {
	if t.IsZero() {
		return nil
	}
	return t
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

func trimUnverified(s string) string {
	if len(s) > len(UnverifiedPrefix) && s[:len(UnverifiedPrefix)] == UnverifiedPrefix {
		return s[len(UnverifiedPrefix):]
	}
	return s
}
