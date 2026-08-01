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
	"regexp"
	"sort"
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

// Loss reasons: mail that ARRIVED for a real user in the window and never became
// a transaction. Each is user-scoped, so each is attributable alpha mail.
//
// These used to leave through Excluded, which the gate never read — so a
// normalizer that broke on one bank and cost the alpha 40 of 100 messages
// reported a rate of 1.0000 and a green gate. They are now in the DENOMINATOR,
// counted against the rate exactly as VerdictUnreadable is and for the same
// reason: we cannot know whether a message we never read carried a transaction,
// and the conservative reading is the only one that cannot flatter us.
const (
	// LossHeldUnconfirmed: still sitting in quarantine at the end of the
	// window. Trust-on-first-use means this is normal for a new sender and a
	// silent loss for one the user never confirms.
	LossHeldUnconfirmed = "held_unconfirmed"
	// LossHeldExpired: the hold expired and the body is gone. Announced (the
	// user was warned) but still mail that produced no transaction.
	LossHeldExpired = "held_expired"
	// LossDiscardedDuplicate: refused as a redelivery of something this server
	// does not have. verify.Accounting's A3_duplicate_of_nothing is the same
	// fact from the accounting side; it is a loss here too, because the message
	// arrived and produced no transaction.
	//
	// Note this is the ONLY way a duplicate reaches the report at all: a
	// redelivery of a message we DO hold shares its ingest id, so it merges into
	// that message's identity and is neither counted twice nor excluded by a
	// rule. The exclusion is structural.
	LossDiscardedDuplicate = "discarded_duplicate"
	// LossUnresolved: an arrival that reached none of the terminal states this
	// build knows. Should be unreachable; counted rather than dropped.
	LossUnresolved = "unresolved"
)

// GateThreshold is spec §5's exit criterion. MinimumMessages and MinimumWindow
// are what stop a green gate from being printed off nothing.
const (
	// MinimumWindow is the "two consecutive weeks" of the criterion, as a
	// duration. Below it the criterion is not assertable at all — the exit
	// record's own worked example was a TWO MINUTE window printing a green gate.
	MinimumWindow = 14 * 24 * time.Hour
	// MinimumMessages is the volume below which the number is not stable enough
	// to ship on: at 100 messages a single one moves the rate by a point, and
	// below about 20 one message cannot even move it across the 5% margin the
	// threshold is expressed in.
	MinimumMessages = 100
	// MinimumUserMessages is the per-account volume at which a per-user rate is
	// judged rather than merely reported. Below it a single failure would fail
	// the whole gate on noise; above it, a broken account can no longer hide
	// inside a healthy aggregate.
	MinimumUserMessages = 20
)

// Gate is the ship decision and, when it is no, every reason it is no.
//
// Reasons are plural on purpose: an operator fixing one and re-running should
// not discover the next one at the same cost, and an exit record should carry
// the whole list.
type Gate struct {
	Passed  bool     `json:"passed"`
	Reasons []string `json:"reasons,omitempty"`
}

// UserRate is one account's own number. Without these a single completely broken
// alpha hides inside a healthy aggregate: four accounts at 130 clean messages
// plus one at 27 failures and zero parses averages to 0.9506 and passed.
type UserRate struct {
	UserID uuid.UUID `json:"user_id"`
	Parsed int64     `json:"parsed"`
	Total  int64     `json:"total"`
	Rate   float64   `json:"rate"`
	// Judged is false for an account below MinimumUserMessages: reported, but
	// not allowed to fail the gate on its own.
	Judged bool `json:"judged"`
}

// WeekRate is one whole week of the window. The criterion is "two CONSECUTIVE
// weeks", which a mean over the whole span does not express: 0.90 followed by
// 1.00 averages to a pass and is not two weeks above the line.
type WeekRate struct {
	From   time.Time `json:"from"`
	To     time.Time `json:"to"`
	Parsed int64     `json:"parsed"`
	Total  int64     `json:"total"`
	Rate   float64   `json:"rate"`
}

// ParseRateBlindSpots is what this number cannot see, carried on every report
// for the same reason verify.Report carries [BlindSpots]: a bare percentage
// overclaims, and this one is the sole evidence that will ever exist for §5's
// ship gate.
var ParseRateBlindSpots = []BlindSpot{
	{
		ID: "prediagnostic_refusals_are_not_in_the_denominator", Direction: Overcount,
		Reason: "the tarpit, the connection caps, over-long lines, malformed paths and a " +
			"declared SIZE over the cap are all refused before a recipient is resolved, so " +
			"they leave NO user-scoped row and cannot reach Lost. Mail an alpha sent that was " +
			"refused that way is invisible here, and its absence raises the rate. " +
			"verify.Accounting's protocol_rejections is the only place it is counted at all, " +
			"and that counter cannot say which account it belonged to.",
	},
	{
		ID: "relay_spool_is_not_in_the_denominator", Direction: Overcount,
		Reason: "mail sitting in an undrained backup-MX spool has no diagnostics row anywhere, " +
			"so it is neither parsed nor lost here. Drain the relay before measuring.",
	},
	{
		ID: "deleted_accounts_shrink_a_past_window", Direction: Overcount,
		Reason: "parse_diagnostics cascades away with the account, and a purged account takes " +
			"its FAILURES out of every past window with it. Two runs of the same window " +
			"across a deletion are not comparable, and the later one reads better.",
	},
	{
		ID: "heuristic_hits_count_as_parses", Direction: Overcount,
		Reason: "the heuristic tier is always routed to review (Decision 16), so a heuristic " +
			"hit is a GUESS the user must confirm, not a finished transaction. It is in the " +
			"numerator because the criterion is about extraction coverage; ByTier prints the " +
			"split so a reader can discount it.",
	},
	{
		ID: "verdicts_are_interested_judgement", Direction: Overcount,
		Reason: "the denominator rests on an operator deciding which unparsed messages were " +
			"genuine transaction mail, and that operator wants the beta to ship. The table is " +
			"append-only with the operator recorded (00018) so revisions are visible and " +
			"countable, which bounds the problem without removing it. Revisions belongs in " +
			"the exit record.",
	},
}

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

	// Unparsed is the population needing judgement: stored messages whose body
	// we still hold and which no tier extracted a transaction from.
	Unparsed int64 `json:"unparsed"`

	// Lost is mail that arrived for a real account in the window and never
	// became a transaction, keyed by why — the reject_reason where there is one,
	// so no_text_part and normalize_error (our failures) are never collapsed
	// into the sender's "rejected" bucket. Every one of these counts AGAINST the
	// rate; see the loss constants.
	Lost      map[string]int64 `json:"lost"`
	LostTotal int64            `json:"lost_total"`

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

	// Gate is the ship decision. It is a FIELD and not only a method so that
	// --json carries it: a consumer reading this report picks the obvious field,
	// and until this existed the obvious field was `rate` — the point estimate,
	// the one number that must never be the gate.
	Gate Gate `json:"gate"`

	// PerUser and Weeks are the two decompositions the criterion needs and an
	// aggregate cannot express.
	PerUser []UserRate `json:"per_user"`
	Weeks   []WeekRate `json:"weeks,omitempty"`

	// BlindSpots is what this number cannot see, carried on the report exactly
	// as verify.Report carries its own.
	BlindSpots []BlindSpot `json:"blind_spots"`

	Caveat string `json:"caveat"`
}

// GateThreshold is spec §5's exit criterion.
const GateThreshold = 0.95

// MeetsGate reports the ship decision. It reads the precomputed [Gate] so that
// the method and the JSON field can never disagree.
func (r ParseRateReport) MeetsGate() bool { return r.Gate.Passed }

// decideGate is spec §5's criterion, in full, as a list of things that must all
// hold. Each failure appends its own reason: an operator who fixes one and
// re-runs should not pay the same round trip to discover the next.
func (r *ParseRateReport) decideGate() {
	var why []string
	if !r.HasRate {
		why = append(why, fmt.Sprintf("%d message(s) still need a verdict", len(r.Pending)))
	}
	if span := r.To.Sub(r.From); span < MinimumWindow {
		why = append(why, fmt.Sprintf(
			"the window is %s; the criterion is two consecutive weeks (%s)",
			span.Round(time.Minute), MinimumWindow))
	}
	if total := r.Denominator(); total < MinimumMessages {
		why = append(why, fmt.Sprintf(
			"%d message(s) in the window is below the %d needed for the number to be stable",
			total, MinimumMessages))
	}
	if r.HasRate && r.LowerBound < GateThreshold {
		why = append(why, fmt.Sprintf("the 95%% lower bound is %.4f, below %.2f",
			r.LowerBound, GateThreshold))
	}
	for _, pu := range r.PerUser {
		if pu.Judged && pu.Rate < GateThreshold {
			why = append(why, fmt.Sprintf("account %s parsed %.4f of its %d message(s)",
				pu.UserID, pu.Rate, pu.Total))
		}
	}
	for _, w := range r.Weeks {
		if w.Rate < GateThreshold {
			why = append(why, fmt.Sprintf("the week from %s parsed %.4f of its %d message(s)",
				w.From.UTC().Format("2006-01-02"), w.Rate, w.Total))
		}
	}
	r.Gate = Gate{Passed: len(why) == 0, Reasons: why}
}

// Denominator is every message the rate is computed over: what parsed, what an
// operator judged a genuine miss, what could not be read, and what was lost
// before the parser ever saw it.
func (r ParseRateReport) Denominator() int64 {
	return r.Parsed + r.Transaction + r.Unreadable + r.LostTotal
}

// messagesSQL folds every diagnostics row about one message into one row about
// that MESSAGE.
//
// # Why the unit is an identity and not a row
//
// The numerator used to count rows while the population counted distinct
// (user, ingest_id) identities, and the two disagree exactly where it hurts:
// ingest.alreadyHandled is a read followed by an append with no lock between
// them, and its own doc measures the window at eight appends for one message.
// Every one of those races added one to the numerator and nothing to the
// denominator, so concurrent delivery inflated the number the exit gate is read
// off, in the direction that passes the gate.
//
// # Why the window anchors on ARRIVALS but the facts do not
//
// `win` is the set of messages that ARRIVED in the window — that is what the
// criterion is about. `stored` and `best_tier` are then computed over EVERY row
// about those messages, whenever it was written, because the fact that matters
// is what finally became of the message, not what was known on day one.
//
// That is what brings promoted quarantine mail back into the measurement.
// Trust-on-first-use means every sender's FIRST batch is quarantined, and the
// promote that later parses it writes event='reprocess' with a fresh timestamp
// (ingest.reprocessRecord uses now(), not the received time). Measuring
// event='arrival' alone therefore dropped every one of those messages out
// through Excluded['quarantined'] and never let them back in — so the rate was
// computed over mail from senders that were ALREADY trusted, which is the mail
// most likely to parse. The bias was invisible and in the flattering direction.
//
// # Why the fold-in is restricted, and a past window cannot improve
//
// The first version folded in EVERY row for the identity, unfiltered. That made
// an already-measured window rise later: publish a template six weeks on,
// reprocess, re-run the same --from/--to, and a 0.5000 week became 1.0000 — so
// "two consecutive weeks above 95%" could be manufactured retroactively by
// fixing parsers afterwards. Two filters close it, and they are exactly the
// difference between the two kinds of reprocessing:
//
//   - outcome = 'appended' is a PROMOTION out of quarantine (reprocess.go's
//     promoteHeld), the message entering the log for the first time. A later
//     template fix writes 'superseded' or 'unchanged', which is a correction to
//     a message that was already counted, and is excluded.
//   - received_at < $2 keeps every input to the number inside the window being
//     reported on, so re-running the same window is stable by construction
//     rather than by luck about what has happened since.
//
// # The ORDER BY is load bearing
//
// ORDER BY ingest_id, which is SHA-256 of the body: independent of sender, time,
// size and outcome, so the first N rows are a uniform random sample AND a stable
// one. Ordering by received_at instead would draw the EARLIEST N, a
// chronological sample the Wilson interval does not apply to. That mutation
// survived the first test suite; TestParseRateSamplesUniformlyByIngestIDNot
// Chronologically now pins it.
const messagesSQL = `
WITH win AS (
  SELECT DISTINCT user_id, ingest_id
    FROM parse_diagnostics
   WHERE event = 'arrival' AND user_id IS NOT NULL
     AND received_at >= $1 AND received_at < $2
     AND ($3::uuid IS NULL OR user_id = $3)
), agg AS (
  SELECT d.user_id, d.ingest_id,
         bool_or(d.outcome IN ('appended','superseded'))                          AS stored,
         -- The fold-in, restricted. See the doc above.
         max(CASE WHEN d.event = 'arrival'
                    OR (d.event = 'reprocess' AND d.outcome = 'appended'
                        AND d.received_at < $2)
                  THEN CASE d.tier WHEN 'template' THEN 2 WHEN 'heuristic' THEN 1 ELSE 0 END
                  ELSE 0 END)                                                     AS best_tier,
         min(d.received_at)                                                       AS first_seen,
         min(d.sender_domain)                                                     AS sender_domain,
         min(d.structure_sig)                                                     AS structure_sig,
         (array_agg(d.outcome ORDER BY d.received_at, d.id)
            FILTER (WHERE d.event = 'arrival'))[1]                                AS arrival_outcome,
         (array_agg(coalesce(d.reject_reason, '') ORDER BY d.received_at, d.id)
            FILTER (WHERE d.event = 'arrival'))[1]                                AS reject_reason
    FROM parse_diagnostics d JOIN win w ON w.user_id = d.user_id AND w.ingest_id = d.ingest_id
   GROUP BY d.user_id, d.ingest_id
)
SELECT a.user_id, a.ingest_id, a.stored, a.best_tier, a.first_seen,
       a.sender_domain, a.structure_sig, a.arrival_outcome, a.reject_reason,
       EXISTS (SELECT 1 FROM quarantine q
                WHERE q.user_id = a.user_id AND q.ingest_id = a.ingest_id)        AS held_now,
       EXISTS (SELECT 1 FROM quarantine_removals r
                WHERE r.user_id = a.user_id AND r.ingest_id = a.ingest_id
                  AND r.reason = 'expired')                                       AS expired
  FROM agg a
 ORDER BY a.ingest_id`

// message is one email, however many rows it produced.
type message struct {
	pending  Pending
	stored   bool
	bestTier int
	outcome  string
	reason   string
	heldNow  bool
	expired  bool
}

// loss classifies a message that never became a transaction, or "" when it is
// not a loss at all.
//
// Order matters: the CURRENT state of the quarantine tables beats the arrival
// outcome, because a message recorded as 'quarantined' in January may have been
// promoted, expired or still be sitting there, and only the store knows which.
func (m message) loss() string {
	switch {
	case m.stored:
		return "" // in the log: parsed, or awaiting a verdict
	case m.heldNow:
		return LossHeldUnconfirmed
	case m.expired:
		return LossHeldExpired
	case m.outcome == diag.OutcomeDuplicate:
		// A duplicate of something stored never gets here: it shares the
		// original's ingest id and merged into it. Reaching this line means the
		// referent is in no store at all.
		return LossDiscardedDuplicate
	case m.reason != "":
		// no_text_part and normalize_error are OUR failures and too_large is the
		// sender's; keying by reason is what stops the three being reported as
		// one anonymous "rejected".
		return m.reason
	case m.outcome == diag.OutcomeRejected || m.outcome == diag.OutcomeOverQuota:
		return m.outcome
	default:
		return LossUnresolved
	}
}

func messages(ctx context.Context, pool *pgxpool.Pool, opts ParseRateOptions, user any) ([]message, error) {
	rows, err := pool.Query(ctx, messagesSQL, opts.From, opts.To, user)
	if err != nil {
		return nil, fmt.Errorf("verify: parse rate: %w", err)
	}
	defer rows.Close()
	var out []message
	for rows.Next() {
		var (
			m       message
			sig     *string
			outcome *string
			reason  *string
		)
		if err := rows.Scan(&m.pending.UserID, &m.pending.IngestID, &m.stored, &m.bestTier,
			&m.pending.ReceivedAt, &m.pending.SenderDomain, &sig, &outcome, &reason,
			&m.heldNow, &m.expired); err != nil {
			return nil, fmt.Errorf("verify: parse rate: %w", err)
		}
		if sig != nil {
			m.pending.StructureSig = *sig
		}
		if outcome != nil {
			m.outcome = *outcome
		}
		if reason != nil {
			m.reason = *reason
		}
		out = append(out, m)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("verify: parse rate: %w", err)
	}
	return out, nil
}

// ParseRate measures the window. It reads no content.
func ParseRate(ctx context.Context, pool *pgxpool.Pool, opts ParseRateOptions) (ParseRateReport, error) {
	if pool == nil {
		return ParseRateReport{}, errors.New("verify: pool is nil")
	}
	rep := ParseRateReport{
		From: opts.From, To: opts.To,
		ByTier:     map[string]int64{diag.TierTemplate: 0, diag.TierHeuristic: 0},
		Lost:       map[string]int64{},
		BlindSpots: ParseRateBlindSpots,
		Caveat:     ParseRateCaveat,
	}
	var user any
	if opts.User != uuid.Nil {
		user = opts.User
	}

	msgs, err := messages(ctx, pool, opts, user)
	if err != nil {
		return ParseRateReport{}, err
	}

	// --- one pass over messages, not rows -----------------------------------
	var pop []Pending
	type bucket struct{ parsed, total int64 }
	perUser := map[uuid.UUID]*bucket{}
	perWeek := make([]bucket, weekCount(opts.From, opts.To))
	// count attributes one message to the aggregate, to its account and to the
	// week it arrived in, so the three decompositions cannot disagree.
	count := func(m message, parsed bool) {
		b, ok := perUser[m.pending.UserID]
		if !ok {
			b = &bucket{}
			perUser[m.pending.UserID] = b
		}
		b.total++
		if i := weekIndex(opts.From, m.pending.ReceivedAt, len(perWeek)); i >= 0 {
			perWeek[i].total++
			if parsed {
				perWeek[i].parsed++
			}
		}
		if parsed {
			b.parsed++
		}
	}
	for _, m := range msgs {
		switch {
		case m.stored && m.bestTier > 0:
			rep.Parsed++
			rep.ByTier[tierName(m.bestTier)]++
			count(m, true)
		case m.stored:
			// In the log, no tier extracted anything: the adjudicable
			// population. Its body is still readable, so an operator can judge
			// whether it was transaction mail at all.
			pop = append(pop, m.pending)
		default:
			rep.Lost[clip(m.loss())]++
			rep.LostTotal++
			count(m, false)
		}
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
	// Judged messages are attributed after the verdict is known, since a
	// non-transactional one leaves the denominator entirely.
	byID := map[string]message{}
	for _, m := range msgs {
		byID[key(m.pending.UserID, m.pending.IngestID)] = m
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
			count(byID[key(p.UserID, p.IngestID)], false)
		case VerdictNonTransactional:
			rep.NonTransactional++
		default:
			rep.Unreadable++
			count(byID[key(p.UserID, p.IngestID)], false)
		}
	}

	for u, b := range perUser {
		rep.PerUser = append(rep.PerUser, UserRate{
			UserID: u, Parsed: b.parsed, Total: b.total,
			Rate:   ratio(b.parsed, b.total-b.parsed),
			Judged: b.total >= MinimumUserMessages,
		})
	}
	sort.Slice(rep.PerUser, func(i, j int) bool {
		return rep.PerUser[i].UserID.String() < rep.PerUser[j].UserID.String()
	})
	// Weeks are only meaningful once the window is long enough for the
	// criterion to be about them.
	if opts.To.Sub(opts.From) >= MinimumWindow {
		for i, b := range perWeek {
			start := opts.From.Add(time.Duration(i) * 7 * 24 * time.Hour)
			end := start.Add(7 * 24 * time.Hour)
			if end.After(opts.To) {
				end = opts.To
			}
			rep.Weeks = append(rep.Weeks, WeekRate{
				From: start, To: end, Parsed: b.parsed, Total: b.total,
				Rate: ratio(b.parsed, b.total-b.parsed),
			})
		}
	}

	if len(rep.Pending) > 0 {
		rep.decideGate()
		return rep, fmt.Errorf("%w: %d of %d unparsed message(s) still need a verdict",
			ErrUnadjudicated, len(rep.Pending), len(want))
	}

	// --- the rate ------------------------------------------------------------
	//
	// misses are every message that arrived and produced no transaction: the
	// adjudicated genuine ones, the unreadable ones, and everything lost before
	// the parser saw it.
	hits := rep.Transaction + rep.Unreadable
	rep.HasRate = true
	rep.Sampled = sampling
	if !sampling {
		rep.Rate = ratio(rep.Parsed, hits+rep.LostTotal)
		rep.LowerBound = rep.Rate
		rep.decideGate()
		return rep, nil
	}
	n := rep.Adjudicated
	est := int64(math.Round(float64(rep.Unparsed) * float64(hits) / float64(n)))
	rep.Rate = ratio(rep.Parsed, est+rep.LostTotal)
	// The rate falls as the number of missed transactions rises, so a LOWER
	// bound on the rate comes from an UPPER bound on the proportion of unparsed
	// mail that was a transaction. Wilson because the normal approximation is
	// badly wrong exactly where this lands: a handful of hits in a small sample.
	// Losses are not estimated — they are counted — so they enter the bound
	// as a certainty.
	_, qHi := Wilson(hits, n)
	rep.LowerBound = float64(rep.Parsed) /
		(float64(rep.Parsed) + float64(rep.Unparsed)*qHi + float64(rep.LostTotal))
	rep.decideGate()
	return rep, nil
}

// weekCount is how many whole-week buckets the window is divided into.
func weekCount(from, to time.Time) int {
	span := to.Sub(from)
	if span <= 0 {
		return 0
	}
	n := int(span / (7 * 24 * time.Hour))
	if span%(7*24*time.Hour) != 0 {
		n++
	}
	return n
}

// weekIndex is which bucket an instant falls in, or -1 when it is outside.
func weekIndex(from, at time.Time, n int) int {
	if n == 0 {
		return -1
	}
	i := int(at.Sub(from) / (7 * 24 * time.Hour))
	if i < 0 || i >= n {
		return -1
	}
	return i
}

// ratio is parsed / (parsed + misses), and 0 over an empty denominator.
//
// It used to answer 1.0 for "no mail at all", defended as the right answer to
// "what fraction of nothing parsed". It is not the right answer to anything an
// operator reads off this tool: an empty window printed `rate 100.00%` beside
// `gate false`, and the number is what gets copied into a report. Zero over
// nothing is equally arbitrary and cannot be mistaken for success; the gate's
// volume floor is what actually decides the case.
func ratio(parsed, misses int64) float64 {
	den := parsed + misses
	if den == 0 {
		return 0
	}
	return float64(parsed) / float64(den)
}

func adjudications(ctx context.Context, pool *pgxpool.Pool, opts ParseRateOptions, user any) (map[string]string, error) {
	// DISTINCT ON takes the newest row per message: the table is append-only, so
	// a revision is a new row and the live verdict is the highest id.
	rows, err := pool.Query(ctx,
		`SELECT DISTINCT ON (user_id, ingest_id) user_id, ingest_id, verdict
		   FROM parse_rate_adjudications
		  WHERE ($1::uuid IS NULL OR user_id = $1)
		  ORDER BY user_id, ingest_id, id DESC`, user)
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

// tierName maps the SQL ranking back to the tier that earned it.
func tierName(rank int) string {
	if rank >= 2 {
		return diag.TierTemplate
	}
	return diag.TierHeuristic
}

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

// RecordVerdict appends one adjudication. Re-adjudicating a message is allowed
// and appends a SUPERSEDING row rather than overwriting: the first pass over an
// unfamiliar bank's mail is exactly where a mistake is made, so a verdict that
// could not be corrected would be a permanent error in the exit measurement —
// but a verdict that could be corrected invisibly is worse. Flipping six of ten
// verdicts was measured to move the reported rate from 0.9000 (fail) to 0.9574
// (pass) leaving ten rows and no trace, and the person adjudicating is the
// person who wants the beta to ship. See 00018_parse_rate_audit.sql.
//
// operator is recorded so the exit record can say who judged and how much was
// revised. Empty is accepted — an unattributed verdict is a fact worth being
// able to count rather than a reason to refuse the write.
func RecordVerdict(ctx context.Context, pool *pgxpool.Pool, userID uuid.UUID, ingestID []byte,
	verdict, operator string) error {
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
	if !operatorRe.MatchString(operator) {
		// Not echoed: the caller that got this wrong is the one that might have
		// passed something read out of a message.
		return errors.New("verify: record verdict: operator must be an identifier of at most 64 characters")
	}
	_, err := pool.Exec(ctx,
		`INSERT INTO parse_rate_adjudications (ingest_id, user_id, verdict, operator, adjudicated_at)
		 VALUES ($1, $2, $3, $4, now())`,
		ingestID, userID, verdict, operator)
	if err != nil {
		return fmt.Errorf("verify: record verdict: %w", err)
	}
	return nil
}

// operatorRe mirrors the CHECK in 00018. Empty is allowed and means the operator
// did not identify themselves, which the exit record should then say.
var operatorRe = regexp.MustCompile(`^([a-z0-9][a-z0-9._@-]{0,63})?$`)

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

// Revisions counts adjudications that superseded an earlier verdict for the same
// message, and how many of those changed the answer.
//
// This is the number the exit record needs in order to be read honestly: the
// denominator rests on operator judgement, the operator is interested in the
// outcome, and the append-only table makes revisions countable rather than
// invisible. It is not an accusation — a first pass over an unfamiliar bank
// SHOULD be revised — it is the context a reader needs to weigh the rate.
func Revisions(ctx context.Context, pool *pgxpool.Pool) (superseded, changed int64, err error) {
	if pool == nil {
		return 0, 0, errors.New("verify: pool is nil")
	}
	err = pool.QueryRow(ctx, `
		WITH ordered AS (
		  SELECT user_id, ingest_id, verdict,
		         lag(verdict) OVER (PARTITION BY user_id, ingest_id ORDER BY id) AS prev
		    FROM parse_rate_adjudications)
		SELECT count(*) FILTER (WHERE prev IS NOT NULL),
		       count(*) FILTER (WHERE prev IS NOT NULL AND prev <> verdict)
		  FROM ordered`).Scan(&superseded, &changed)
	if err != nil {
		return 0, 0, fmt.Errorf("verify: adjudication revisions: %w", err)
	}
	return superseded, changed, nil
}
