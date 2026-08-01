package verify

// The parse-rate instrument: spec §5's "≥95% of transaction emails parse" exit
// criterion, made measurable.
//
// # Why this needs a human
//
// The numerator is a query. The denominator is not, and it is worth being exact
// about why, because the first draft of the plan asserted this criterion with no
// instrument at all: it said the rate was "counted from parse_diagnostics,
// excluding non-transactional mail". parse_diagnostics deliberately stores no
// content, so it cannot distinguish a bank alert whose template broke from a
// newsletter that was never going to parse. The denominator is not a field that
// was forgotten; it is a judgement nothing in the schema is in a position to
// make.
//
//	numerator   = arrivals with tier ∈ {template, heuristic}
//	denominator = numerator + arrivals with tier = 'none' that an operator has
//	              adjudicated as genuine transaction mail
//
// # What this measures, and what it does NOT
//
// See [ParseRateCaveat]. It measures parse COVERAGE — did we extract a
// transaction from mail that carried one. A template that matches and extracts
// the wrong amount is a success here. Correctness is the template regression
// gate (Task 21's corpus replay) plus alpha reports, and the exit record has to
// say so rather than letting "95% parses" be read as "95% correct".
//
// ⚠ The ADJUDICATION path ([ColdTexts]) is PHASE 1 ONLY — item 4 of
// docs/superpowers/specs/v2-phase1-only-inventory.md. Everything else in this
// file reads counts and verdicts, never a body.

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"math"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"ledger/internal/v2/blob"
	"ledger/internal/v2/diag"
	"ledger/internal/v2/norm"
	"ledger/internal/v2/oplog"
)

// The three verdicts. They mirror the CHECK constraint in 00016_parse_rate.sql.
const (
	// VerdictTransaction: this message carried a transaction we failed to
	// extract. It stays in the denominator and drags the rate down.
	VerdictTransaction = "transaction"
	// VerdictNonTransactional: a newsletter, a statement notice, an OTP. It
	// leaves the denominator entirely; failing to parse it is not a failure.
	VerdictNonTransactional = "non_transactional"
	// VerdictUnreadable: the body could not be read at all. Counted AGAINST the
	// rate — it might have been a transaction, and a metric that quietly dropped
	// these would improve every time the cold stream got harder to read.
	VerdictUnreadable = "unreadable"
)

// Verdicts is the closed set, for a caller validating operator input.
var Verdicts = []string{VerdictTransaction, VerdictNonTransactional, VerdictUnreadable}

// ParseRateCaveat is the sentence that must travel with the number. It is a
// constant rather than prose in a report because the misreading it prevents —
// "95% parses" heard as "95% correct" — is the one way this metric actively
// misleads, and a constant can be printed by every caller and pinned by a test.
const ParseRateCaveat = "this is parse COVERAGE, not correctness: a template that matches and " +
	"extracts the wrong amount counts as a success here. Correctness is the template " +
	"regression gate plus alpha reports."

// DefaultSample is the population size above which the tool samples instead of
// adjudicating everything.
//
// At alpha scale — 3-5 users, single-digit bank alerts a day, plus whatever else
// lands — two weeks of tier='none' arrivals is low hundreds at most, so the
// normal outcome is that everything is adjudicated and the reported rate has no
// sampling error at all. The sampling path exists so the tool does not become
// unusable if that estimate is wrong.
const DefaultSample = 200

// ErrUnadjudicated means the rate cannot be reported yet. The returned report
// still carries the counts and the Pending list, because "how much work is left"
// is the question an operator asks next.
var ErrUnadjudicated = errors.New("verify: the parse rate needs adjudication first")

// Pending is one unparsed arrival awaiting a verdict. It carries no content —
// the operator reads the body through [ColdTexts], which is the Phase-1-only
// path and is deliberately a separate call.
type Pending struct {
	UserID       uuid.UUID `json:"user_id"`
	IngestID     []byte    `json:"ingest_id"`
	ReceivedAt   time.Time `json:"received_at"`
	SenderDomain string    `json:"sender_domain"`
	StructureSig string    `json:"structure_sig,omitempty"`
}

// ParseRateOptions selects the window and the sampling policy.
type ParseRateOptions struct {
	From, To time.Time
	// User scopes the report to one account. Nil means every account.
	User uuid.UUID
	// Sample is the population size above which a uniform sample is drawn
	// instead of adjudicating everything. Zero means [DefaultSample]; a negative
	// value means "never sample, adjudicate the lot".
	Sample int
}

func (o ParseRateOptions) sample() int {
	if o.Sample == 0 {
		return DefaultSample
	}
	return o.Sample
}

// ParseRateReport is the measurement.
type ParseRateReport struct {
	From time.Time `json:"from"`
	To   time.Time `json:"to"`

	// Parsed is the numerator: arrivals that produced a transaction.
	Parsed int64            `json:"parsed"`
	ByTier map[string]int64 `json:"by_tier"`

	// Unparsed is the population needing judgement: appended arrivals at
	// tier='none'.
	Unparsed int64 `json:"unparsed"`
	// Excluded records the arrivals deliberately left out of the population and
	// why, keyed by outcome. Reporting it is what makes the denominator
	// auditable rather than a choice buried in a WHERE clause.
	Excluded map[string]int64 `json:"excluded"`

	Adjudicated      int64 `json:"adjudicated"`
	Transaction      int64 `json:"transaction"`
	NonTransactional int64 `json:"non_transactional"`
	Unreadable       int64 `json:"unreadable"`

	// Pending is what still needs a verdict: everything when the population is
	// adjudicated whole, or the undrawn remainder of the sample when it is not.
	Pending []Pending `json:"pending,omitempty"`

	// HasRate is false while Pending is non-empty. A rate reported over a
	// partly-judged population is a number somebody made up.
	HasRate bool    `json:"has_rate"`
	Rate    float64 `json:"rate"`
	// Sampled says whether Rate is an estimate. When it is, LowerBound is
	// strictly below Rate and LowerBound is the gate.
	Sampled bool `json:"sampled"`
	// LowerBound is the Wilson 95% lower bound on the rate, and equals Rate
	// exactly when the whole population was adjudicated (no sampling error).
	LowerBound float64 `json:"lower_bound"`

	Caveat string `json:"caveat"`
}

// GateThreshold is spec §5's exit criterion.
const GateThreshold = 0.95

// MeetsGate reports whether the exit criterion is met. It tests the LOWER BOUND,
// never the point estimate: a point estimate from a sample is not a gate.
//
// An EMPTY window fails it. [ratio] answers 1.0 for a zero denominator, which is
// the right answer to "what fraction of nothing parsed" and the wrong answer to
// "has the alpha met its exit criterion" — a two-week window with no mail in it
// would otherwise report a green gate, which is the single most misleading thing
// this instrument could do.
func (r ParseRateReport) MeetsGate() bool {
	return r.HasRate && r.Parsed+r.Unparsed > 0 && r.LowerBound >= GateThreshold
}

// populationSQL selects the unparsed arrivals that are candidates for
// adjudication.
//
// outcome = 'appended' is the whole population definition and it is the
// load-bearing line. Refused mail (too_large, over_quota, unknown_rcpt) never
// reached the cascade; a duplicate was parsed the first time; quarantined mail
// has not been parsed YET and is held pending a trust decision, so counting any
// of them as a parse failure would measure the SMTP layer and call it a parser.
//
// Ordered by ingest_id, which is SHA-256 of the body. That ordering is
// independent of sender, time, size and parse outcome, so the first N rows ARE a
// uniform random sample — and, unlike an RNG, a stable one, so an operator can
// stop adjudicating and come back to the same sample tomorrow.
const populationSQL = `
SELECT user_id, ingest_id, min(received_at), min(sender_domain), min(structure_sig)
  FROM parse_diagnostics
 WHERE event = 'arrival' AND outcome = 'appended' AND tier = 'none'
   AND user_id IS NOT NULL
   AND received_at >= $1 AND received_at < $2
   AND ($3::uuid IS NULL OR user_id = $3)
 GROUP BY user_id, ingest_id
 ORDER BY ingest_id`

// ParseRate measures the window. It reads no content.
func ParseRate(ctx context.Context, pool *pgxpool.Pool, opts ParseRateOptions) (ParseRateReport, error) {
	if pool == nil {
		return ParseRateReport{}, errors.New("verify: pool is nil")
	}
	rep := ParseRateReport{
		From: opts.From, To: opts.To,
		ByTier:   map[string]int64{diag.TierTemplate: 0, diag.TierHeuristic: 0},
		Excluded: map[string]int64{},
		Caveat:   ParseRateCaveat,
	}
	var user any
	if opts.User != uuid.Nil {
		user = opts.User
	}

	// --- numerator ----------------------------------------------------------
	rows, err := pool.Query(ctx, `SELECT tier, outcome, count(*) FROM parse_diagnostics
	  WHERE event = 'arrival' AND received_at >= $1 AND received_at < $2
	    AND ($3::uuid IS NULL OR user_id = $3)
	  GROUP BY tier, outcome`, opts.From, opts.To, user)
	if err != nil {
		return ParseRateReport{}, fmt.Errorf("verify: parse rate: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var tier, outcome string
		var n int64
		if err := rows.Scan(&tier, &outcome, &n); err != nil {
			return ParseRateReport{}, fmt.Errorf("verify: parse rate: %w", err)
		}
		switch {
		// outcome='appended' on BOTH sides, so the numerator and the
		// denominator's population are the same class of mail: what the cascade
		// saw and what we then stored. Today the pipeline only assigns a tier on
		// the path that appends, so this filter changes nothing; it is here so
		// that a future path which parses and then refuses cannot inflate the
		// numerator without also showing up in Excluded.
		case outcome == diag.OutcomeAppended && (tier == diag.TierTemplate || tier == diag.TierHeuristic):
			rep.Parsed += n
			rep.ByTier[clip(tier)] += n
		case outcome == diag.OutcomeAppended:
			// The population; counted from the row list below so the two
			// cannot disagree.
		default:
			rep.Excluded[clip(outcome)] += n
		}
	}
	if err := rows.Err(); err != nil {
		return ParseRateReport{}, fmt.Errorf("verify: parse rate: %w", err)
	}

	// --- the population needing judgement ------------------------------------
	pop, err := population(ctx, pool, opts, user)
	if err != nil {
		return ParseRateReport{}, err
	}
	rep.Unparsed = int64(len(pop))

	verdicts, err := adjudications(ctx, pool, opts, user)
	if err != nil {
		return ParseRateReport{}, err
	}

	// The sample, drawn deterministically: the first N of an ingest-id ordering.
	want := pop
	limit := opts.sample()
	sampling := limit > 0 && len(pop) > limit
	if sampling {
		want = pop[:limit]
	}
	for _, p := range want {
		v, ok := verdicts[key(p.UserID, p.IngestID)]
		if !ok {
			rep.Pending = append(rep.Pending, p)
			continue
		}
		rep.Adjudicated++
		switch v {
		case VerdictTransaction:
			rep.Transaction++
		case VerdictNonTransactional:
			rep.NonTransactional++
		default:
			rep.Unreadable++
		}
	}
	if len(rep.Pending) > 0 {
		return rep, fmt.Errorf("%w: %d of %d unparsed message(s) still need a verdict",
			ErrUnadjudicated, len(rep.Pending), len(want))
	}

	// --- the rate ------------------------------------------------------------
	//
	// misses = the unparsed arrivals that WERE transactions. Under full
	// adjudication that is a count. Under sampling it is an estimate, and the
	// bound below propagates the sampling error through to the rate.
	hits := rep.Transaction + rep.Unreadable
	rep.HasRate = true
	rep.Sampled = sampling
	if !sampling {
		rep.Rate = ratio(rep.Parsed, hits)
		rep.LowerBound = rep.Rate
		return rep, nil
	}
	n := rep.Adjudicated
	rep.Rate = ratio(rep.Parsed, int64(math.Round(float64(rep.Unparsed)*float64(hits)/float64(n))))
	// The rate falls as the number of missed transactions rises, so a LOWER
	// bound on the rate comes from an UPPER bound on the proportion of unparsed
	// mail that was a transaction. Wilson's interval is used because the normal
	// approximation is badly wrong exactly where this lands: a handful of hits
	// out of a small sample.
	_, qHi := Wilson(hits, n)
	rep.LowerBound = float64(rep.Parsed) / (float64(rep.Parsed) + float64(rep.Unparsed)*qHi)
	return rep, nil
}

func ratio(parsed, misses int64) float64 {
	den := parsed + misses
	if den == 0 {
		// No mail at all is not a 0% parse rate; it is no measurement. Reporting
		// 1.0 with Unparsed == 0 and Parsed == 0 is honest in the only way that
		// matters: MeetsGate on an empty window is meaningless, and the operator
		// sees Parsed == 0 right beside it.
		return 1
	}
	return float64(parsed) / float64(den)
}

func population(ctx context.Context, pool *pgxpool.Pool, opts ParseRateOptions, user any) ([]Pending, error) {
	rows, err := pool.Query(ctx, populationSQL, opts.From, opts.To, user)
	if err != nil {
		return nil, fmt.Errorf("verify: parse rate: population: %w", err)
	}
	defer rows.Close()
	var out []Pending
	for rows.Next() {
		var p Pending
		var sig *string
		if err := rows.Scan(&p.UserID, &p.IngestID, &p.ReceivedAt, &p.SenderDomain, &sig); err != nil {
			return nil, fmt.Errorf("verify: parse rate: population: %w", err)
		}
		if sig != nil {
			p.StructureSig = *sig
		}
		out = append(out, p)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("verify: parse rate: population: %w", err)
	}
	return out, nil
}

func adjudications(ctx context.Context, pool *pgxpool.Pool, opts ParseRateOptions, user any) (map[string]string, error) {
	rows, err := pool.Query(ctx,
		`SELECT user_id, ingest_id, verdict FROM parse_rate_adjudications
		  WHERE ($1::uuid IS NULL OR user_id = $1)`, user)
	if err != nil {
		return nil, fmt.Errorf("verify: parse rate: adjudications: %w", err)
	}
	defer rows.Close()
	out := map[string]string{}
	for rows.Next() {
		var u uuid.UUID
		var id []byte
		var v string
		if err := rows.Scan(&u, &id, &v); err != nil {
			return nil, fmt.Errorf("verify: parse rate: adjudications: %w", err)
		}
		out[key(u, id)] = v
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("verify: parse rate: adjudications: %w", err)
	}
	return out, nil
}

func key(u uuid.UUID, id []byte) string { return u.String() + "/" + string(id) }

// Wilson returns the 95% Wilson score interval for k successes in n trials,
// clamped to [0, 1].
//
// Wilson rather than the normal approximation because this instrument lives
// exactly where the normal approximation breaks: a handful of hits out of a
// small sample, where p̂ ± z·√(p̂(1-p̂)/n) can produce a negative lower bound or a
// zero-width interval at k = 0, and would quietly hand the exit gate a number
// with no coverage.
//
// z is 1.959964 — the two-sided 95% interval, whose endpoints are one-sided
// 97.5% bounds. That is the conservative reading of "the 95% lower bound", and
// it is the one the exit record should be held to.
func Wilson(k, n int64) (lo, hi float64) {
	if n <= 0 {
		// No information. Refusing to narrow is the only honest answer, and it
		// keeps a caller from reading an empty sample as a perfect one.
		return 0, 1
	}
	const z = 1.959964
	nf, p := float64(n), float64(k)/float64(n)
	den := 1 + z*z/nf
	centre := (p + z*z/(2*nf)) / den
	margin := (z / den) * math.Sqrt(p*(1-p)/nf+z*z/(4*nf*nf))
	return clamp01(centre - margin), clamp01(centre + margin)
}

func clamp01(v float64) float64 {
	switch {
	case v < 0:
		return 0
	case v > 1:
		return 1
	default:
		return v
	}
}

// RecordVerdict writes one adjudication, overwriting an earlier one for the same
// message. Re-adjudication is allowed on purpose: the first pass over an
// unfamiliar bank's mail is exactly where a mistake is made, and a verdict that
// could not be corrected would be a permanent error in the exit measurement.
func RecordVerdict(ctx context.Context, pool *pgxpool.Pool, userID uuid.UUID, ingestID []byte, verdict string) error {
	if pool == nil {
		return errors.New("verify: pool is nil")
	}
	if len(ingestID) != 32 {
		return fmt.Errorf("verify: record verdict: ingest id is %d bytes, want 32", len(ingestID))
	}
	found := false
	for _, v := range Verdicts {
		if v == verdict {
			found = true
			break
		}
	}
	if !found {
		// The argument is not echoed: the caller that got this wrong is the one
		// that might have passed a line of somebody's mail.
		return fmt.Errorf("verify: record verdict: verdict is not one of %v", Verdicts)
	}
	_, err := pool.Exec(ctx, `INSERT INTO parse_rate_adjudications (ingest_id, user_id, verdict, adjudicated_at)
	  VALUES ($1, $2, $3, now())
	  ON CONFLICT (ingest_id, user_id) DO UPDATE SET verdict = EXCLUDED.verdict, adjudicated_at = now()`,
		ingestID, userID, verdict)
	if err != nil {
		return fmt.Errorf("verify: record verdict: %w", err)
	}
	return nil
}

// ---------------------------------------------------------------------------
// ⚠ PHASE 1 ONLY BELOW THIS LINE
// ---------------------------------------------------------------------------

// ColdTexts reads the raw bodies of the named messages out of one user's cold
// stream and returns each one NORMALIZED, keyed by ingest id.
//
// ⚠ PHASE 1 ONLY — item 4 of docs/superpowers/specs/v2-phase1-only-inventory.md,
// and this is the exact line. Cold blobs are plaintext in Phase 1 and
// HPKE-sealed to the user's public key from Phase 3, where the server holds no
// private key. There is no version of this function that works then, and the
// metric it feeds becomes whatever the content-free diagnostics ledger can
// support.
//
// It is deliberately NOT called by [ParseRate]. The reporting half of this
// instrument reads no content at all; only the operator sitting in front of
// `ledgerd parse-rate --adjudicate` does, one message at a time, on purpose.
//
// Normalized rather than raw because an operator answering "was this a
// transaction?" needs the text a parser would have seen, not a MIME tree — and
// because the normalizer strips the attachments and the HTML scaffolding that
// make a terminal unusable. A body that will not normalize returns no entry;
// the caller records [VerdictUnreadable] for it, which is a fact worth storing.
//
// One pass over the cold stream per call, so adjudicating a batch is one scan
// and not one scan per message.
func ColdTexts(ctx context.Context, pool *pgxpool.Pool, sealer blob.Sealer,
	userID uuid.UUID, ingestIDs [][]byte) (map[string]string, error) {
	if pool == nil {
		return nil, errors.New("verify: pool is nil")
	}
	if sealer == nil {
		sealer = blob.PlaintextSealer{}
	}
	want := make(map[string]bool, len(ingestIDs))
	for _, id := range ingestIDs {
		want[fmt.Sprintf("%x", id)] = true
	}
	out := make(map[string]string, len(want))
	after := int64(0)
	for len(want) > 0 {
		rows, err := oplog.Read(ctx, pool, userID, blob.StreamCold, after, pageRows, pageBytes)
		if err != nil {
			return nil, fmt.Errorf("verify: parse rate: read the cold stream: %w", err)
		}
		if len(rows) == 0 {
			return out, nil
		}
		for _, row := range rows {
			after = row.Seq
			pt, err := sealer.Open(blob.Envelope{
				UserID: userID, Stream: row.Stream, WriterID: row.WriterID, WriterCounter: row.WriterCounter,
			}, blob.Sealed{Bytes: row.Blob, SizeBucket: row.SizeBucket})
			if err != nil {
				// One unopenable blob must not stop the pass: the operator can
				// still adjudicate the rest, and this one is 'unreadable'.
				continue
			}
			rb, err := oplog.DecodeRawBody(pt)
			if err != nil || !want[rb.IngestID] {
				continue
			}
			delete(want, rb.IngestID)
			raw, err := base64.StdEncoding.DecodeString(rb.RawBase64)
			if err != nil {
				continue
			}
			res, err := norm.Normalize(norm.CurrentVersion, raw, rb.ReceivedAt)
			if err != nil {
				continue
			}
			out[rb.IngestID] = res.Text
		}
	}
	return out, nil
}
