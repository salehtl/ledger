package verify

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"math"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"ledger/internal/v2/blob"
	"ledger/internal/v2/diag"
	"ledger/internal/v2/oplog"
	"ledger/internal/v2/pgtest"
)

// adjudicate goes through the real writer, so every test exercises the
// append-only path rather than a fixture that could drift from it.
func adjudicate(t *testing.T, pool *pgxpool.Pool, u uuid.UUID, id []byte, verdict string) {
	t.Helper()
	if err := RecordVerdict(bg, pool, u, id, verdict, "tester"); err != nil {
		t.Fatalf("RecordVerdict: %v", err)
	}
}

func window() (time.Time, time.Time, time.Time) {
	now := time.Now().UTC()
	return now, now.Add(-time.Hour), now.Add(time.Hour)
}

// TestParseRateDenominatorRequiresAdjudication is the whole point of the
// instrument. Nothing in the schema knows whether an unparsed message was a
// bank alert or a newsletter — diagnostics deliberately store no content — so a
// tool that printed a rate anyway would be printing a number it made up.
func TestParseRateDenominatorRequiresAdjudication(t *testing.T) {
	pool := pgtest.New(t)
	u := insertUser(t, pool)
	now, from, to := window()

	for i := 0; i < 10; i++ {
		arrival(t, pool, u, now, diag.OutcomeAppended, diag.TierTemplate, "")
	}
	var unjudged [][]byte
	for i := 0; i < 2; i++ {
		unjudged = append(unjudged, arrival(t, pool, u, now, diag.OutcomeAppended, diag.TierNone, ""))
	}

	rep, err := ParseRate(bg, pool, ParseRateOptions{From: from, To: to})
	if !errors.Is(err, ErrUnadjudicated) {
		t.Fatalf("ParseRate err = %v, want ErrUnadjudicated", err)
	}
	if len(rep.Pending) != 2 {
		t.Fatalf("pending = %d, want 2 — the tool must NAME the work it is waiting on", len(rep.Pending))
	}
	if rep.HasRate {
		t.Fatalf("the report claims a rate of %v with 2 messages unadjudicated", rep.Rate)
	}
	seen := map[string]bool{}
	for _, p := range rep.Pending {
		seen[string(p.IngestID)] = true
		if p.UserID != u {
			t.Fatalf("pending item names user %s, want %s", p.UserID, u)
		}
	}
	for _, id := range unjudged {
		if !seen[string(id)] {
			t.Fatalf("pending list omits ingest id %x", id[:6])
		}
	}
	// The counts are still reported: an operator has to be able to see how much
	// adjudication is left without being told nothing at all.
	if rep.Parsed != 10 || rep.Unparsed != 2 {
		t.Fatalf("parsed = %d, unparsed = %d, want 10 and 2", rep.Parsed, rep.Unparsed)
	}
}

func TestParseRateExcludesNonTransactionalMail(t *testing.T) {
	cases := []struct {
		name    string
		verdict string
		want    float64
	}{
		{"a genuine transaction stays in the denominator", VerdictTransaction, 0.95},
		{"a newsletter leaves it", VerdictNonTransactional, 1.0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			pool := pgtest.New(t)
			u := insertUser(t, pool)
			now, from, to := window()

			for i := 0; i < 19; i++ {
				arrival(t, pool, u, now, diag.OutcomeAppended, diag.TierTemplate, "")
			}
			id := arrival(t, pool, u, now, diag.OutcomeAppended, diag.TierNone, "")
			adjudicate(t, pool, u, id, tc.verdict)

			rep, err := ParseRate(bg, pool, ParseRateOptions{From: from, To: to})
			if err != nil {
				t.Fatalf("ParseRate: %v", err)
			}
			if !rep.HasRate {
				t.Fatalf("no rate reported with everything adjudicated: %+v", rep.Pending)
			}
			if math.Abs(rep.Rate-tc.want) > 1e-9 {
				t.Fatalf("rate = %v, want %v", rep.Rate, tc.want)
			}
			// Full adjudication means the whole population was measured, so
			// there is no sampling error to widen the bound with.
			if rep.Sampled {
				t.Fatal("a fully adjudicated population is reported as sampled")
			}
			if math.Abs(rep.LowerBound-rep.Rate) > 1e-9 {
				t.Fatalf("lower bound %v != rate %v with no sampling error", rep.LowerBound, rep.Rate)
			}
		})
	}
}

// TestParseRateUsesTheWilsonLowerBoundWhenSampled: a point estimate from a
// sample is not a gate. The reported gate number must be the lower bound, and
// it must be strictly below the point estimate or the sampling error has been
// thrown away.
func TestParseRateUsesTheWilsonLowerBoundWhenSampled(t *testing.T) {
	pool := pgtest.New(t)
	u := insertUser(t, pool)
	now, from, to := window()

	for i := 0; i < 100; i++ {
		arrival(t, pool, u, now, diag.OutcomeAppended, diag.TierTemplate, "")
	}
	var unparsed [][]byte
	for i := 0; i < 40; i++ {
		unparsed = append(unparsed, arrival(t, pool, u, now, diag.OutcomeAppended, diag.TierNone, ""))
	}

	opts := ParseRateOptions{From: from, To: to, Sample: 10}
	rep, err := ParseRate(bg, pool, opts)
	if !errors.Is(err, ErrUnadjudicated) {
		t.Fatalf("ParseRate err = %v, want ErrUnadjudicated before the sample is judged", err)
	}
	if len(rep.Pending) != 10 {
		t.Fatalf("pending = %d, want the 10 drawn by the sample, not all 40", len(rep.Pending))
	}
	// The draw must be STABLE, or an operator who pauses adjudication comes back
	// to a different sample and the interval means nothing.
	again, _ := ParseRate(bg, pool, opts)
	for i := range rep.Pending {
		if string(again.Pending[i].IngestID) != string(rep.Pending[i].IngestID) {
			t.Fatal("the sample is not stable across calls")
		}
	}

	// Judge exactly the drawn sample: one genuine transaction in ten.
	for i, p := range rep.Pending {
		v := VerdictNonTransactional
		if i == 0 {
			v = VerdictTransaction
		}
		adjudicate(t, pool, u, p.IngestID, v)
	}
	_ = unparsed

	got, err := ParseRate(bg, pool, opts)
	if err != nil {
		t.Fatalf("ParseRate: %v", err)
	}
	if !got.Sampled {
		t.Fatal("a partially adjudicated population is not reported as sampled")
	}
	// q̂ = 1/10, so T̂ = 40*0.1 = 4 and the point estimate is 100/104.
	if want := 100.0 / 104.0; math.Abs(got.Rate-want) > 1e-9 {
		t.Fatalf("point estimate = %v, want %v", got.Rate, want)
	}
	if got.LowerBound >= got.Rate {
		t.Fatalf("lower bound %v is not below the point estimate %v: the sampling error was discarded",
			got.LowerBound, got.Rate)
	}
	// Wilson upper for 1/10 at 95% is 0.40415, so T_hi = 16.166 and the bound is
	// 100/116.166. Pinned rather than approximated: this number is the exit gate.
	if want := 100.0 / (100.0 + 40.0*0.4041500); math.Abs(got.LowerBound-want) > 1e-4 {
		t.Fatalf("lower bound = %v, want %v", got.LowerBound, want)
	}
	if got.MeetsGate() {
		t.Fatalf("lower bound %v passes the >=95%% gate", got.LowerBound)
	}
}

func TestWilsonIntervalMatchesKnownValues(t *testing.T) {
	// Textbook values for the Wilson score interval at 95% (z = 1.959964).
	for _, tc := range []struct {
		k, n   int64
		lo, hi float64
	}{
		{1, 10, 0.017878, 0.404150},
		{0, 10, 0.000000, 0.277567},
		{10, 10, 0.722461, 1.000000},
		{50, 100, 0.403831, 0.596169},
	} {
		lo, hi := Wilson(tc.k, tc.n)
		if math.Abs(lo-tc.lo) > 5e-5 || math.Abs(hi-tc.hi) > 5e-5 {
			t.Errorf("Wilson(%d,%d) = (%.6f, %.6f), want (%.6f, %.6f)", tc.k, tc.n, lo, hi, tc.lo, tc.hi)
		}
	}
	if lo, hi := Wilson(0, 0); lo != 0 || hi != 1 {
		t.Errorf("Wilson(0,0) = (%v,%v), want the uninformative (0,1)", lo, hi)
	}
}

// TestParseRateCountsUnreadableAgainstTheRate: a body the operator could not
// read might have been a transaction, and a metric that quietly dropped those
// would improve every time the cold stream got harder to read.
func TestParseRateCountsUnreadableAgainstTheRate(t *testing.T) {
	pool := pgtest.New(t)
	u := insertUser(t, pool)
	now, from, to := window()

	for i := 0; i < 19; i++ {
		arrival(t, pool, u, now, diag.OutcomeAppended, diag.TierTemplate, "")
	}
	id := arrival(t, pool, u, now, diag.OutcomeAppended, diag.TierNone, "")
	adjudicate(t, pool, u, id, VerdictUnreadable)

	rep, err := ParseRate(bg, pool, ParseRateOptions{From: from, To: to})
	if err != nil {
		t.Fatalf("ParseRate: %v", err)
	}
	if rep.Unreadable != 1 {
		t.Fatalf("unreadable = %d, want 1 reported in its own right", rep.Unreadable)
	}
	if want := 19.0 / 20.0; math.Abs(rep.Rate-want) > 1e-9 {
		t.Fatalf("rate = %v, want %v: an unreadable body counts against the rate", rep.Rate, want)
	}
}

// TestParseRatePopulationIsMailTheCascadeActuallySaw. Refused mail never
// reached the parser, held mail has not been parsed yet, and a redelivery was
// parsed the first time. Counting any of them as a parse failure would measure
// the SMTP layer and call it a parser.
func TestParseRatePopulationIsMailTheCascadeActuallySaw(t *testing.T) {
	pool := pgtest.New(t)
	u := insertUser(t, pool)
	now, from, to := window()

	stored := arrival(t, pool, u, now, diag.OutcomeAppended, diag.TierTemplate, "")
	hold(t, pool, u, arrival(t, pool, u, now, diag.OutcomeQuarantined, diag.TierNone, ""), now)
	diagRowFor(t, pool, u, stored, now.Add(time.Minute), diag.EventArrival,
		diag.OutcomeDuplicate, diag.TierNone, "")
	arrival(t, pool, u, now, diag.OutcomeRejected, diag.TierNone, diag.RejectTooLarge)
	arrival(t, pool, u, now, diag.OutcomeOverQuota, diag.TierNone, diag.RejectOverQuota)
	arrival(t, pool, uuid.Nil, now, diag.OutcomeRejected, diag.TierNone, diag.RejectUnknownRcpt)

	rep, err := ParseRate(bg, pool, ParseRateOptions{From: from, To: to})
	if err != nil {
		t.Fatalf("ParseRate: %v", err)
	}
	if rep.Unparsed != 0 {
		t.Fatalf("unparsed population = %d, want 0: %+v", rep.Unparsed, rep.Pending)
	}
	if rep.Parsed != 1 {
		t.Fatalf("parsed = %d, want 1", rep.Parsed)
	}
	// A redelivery of a stored message merged into that message's identity, so
	// it is neither counted twice nor excluded by a rule. Everything else that
	// produced no transaction is a LOSS in the denominator, keyed by what
	// actually happened rather than by one anonymous "rejected".
	if rep.Lost[diag.RejectTooLarge] != 1 || rep.Lost[diag.RejectOverQuota] != 1 {
		t.Fatalf("lost = %v, want too_large and over_quota named by their reason", rep.Lost)
	}
	if rep.Lost[LossHeldUnconfirmed] != 1 {
		t.Fatalf("lost = %v, want the still-held message under %s", rep.Lost, LossHeldUnconfirmed)
	}
	if want := 1.0 / 4.0; math.Abs(rep.Rate-want) > 1e-9 {
		t.Fatalf("rate = %v, want %v: one parsed of four messages that arrived", rep.Rate, want)
	}
}

// TestParseRateOnAnEmptyWindowDoesNotPassTheGate. "What fraction of nothing
// parsed" has no useful answer, and the tempting one — 100% — would report a
// green exit criterion for a two-week window in which no mail arrived at all.
func TestParseRateOnAnEmptyWindowDoesNotPassTheGate(t *testing.T) {
	pool := pgtest.New(t)
	_, from, to := window()

	rep, err := ParseRate(bg, pool, ParseRateOptions{From: from, To: to})
	if err != nil {
		t.Fatalf("ParseRate: %v", err)
	}
	if rep.MeetsGate() {
		t.Fatalf("an empty window passes the exit gate (rate %v, parsed %d, unparsed %d)",
			rep.Rate, rep.Parsed, rep.Unparsed)
	}
}

// A parsed message that was not stored is not evidence that parsing works, and
// counting it in the numerator while the denominator's population is restricted
// to stored mail would let a refusal path inflate the rate. Impossible today —
// the pipeline assigns a tier only on the path that appends — so this is a rail
// against a future path, and it is reported in Excluded rather than dropped.
func TestParseRateNumeratorIsRestrictedToStoredMailToo(t *testing.T) {
	pool := pgtest.New(t)
	u := insertUser(t, pool)
	now, from, to := window()

	arrival(t, pool, u, now, diag.OutcomeAppended, diag.TierTemplate, "")
	hold(t, pool, u, arrival(t, pool, u, now, diag.OutcomeQuarantined, diag.TierTemplate, ""), now)

	rep, err := ParseRate(bg, pool, ParseRateOptions{From: from, To: to})
	if err != nil {
		t.Fatalf("ParseRate: %v", err)
	}
	if rep.Parsed != 1 {
		t.Fatalf("parsed = %d, want 1: a template match that was not appended is not a parse "+
			"the numerator may claim", rep.Parsed)
	}
	if rep.Lost[LossHeldUnconfirmed] != 1 {
		t.Fatalf("lost = %v, want the held message under %s: a template match that was never "+
			"stored is not a parse the numerator may claim, and it is not free either",
			rep.Lost, LossHeldUnconfirmed)
	}
}

func TestParseRateCanBeScopedToOneUser(t *testing.T) {
	pool := pgtest.New(t)
	a, b := insertUser(t, pool), insertUser(t, pool)
	now, from, to := window()

	arrival(t, pool, a, now, diag.OutcomeAppended, diag.TierTemplate, "")
	arrival(t, pool, b, now, diag.OutcomeAppended, diag.TierHeuristic, "")
	idb := arrival(t, pool, b, now, diag.OutcomeAppended, diag.TierNone, "")
	adjudicate(t, pool, b, idb, VerdictTransaction)

	rep, err := ParseRate(bg, pool, ParseRateOptions{From: from, To: to, User: a})
	if err != nil {
		t.Fatalf("ParseRate: %v", err)
	}
	if rep.Parsed != 1 || rep.Unparsed != 0 {
		t.Fatalf("scoped report = parsed %d / unparsed %d, want 1 and 0", rep.Parsed, rep.Unparsed)
	}
	if rep.ByTier[diag.TierHeuristic] != 0 {
		t.Fatalf("the other user's heuristic parse leaked into a scoped report: %v", rep.ByTier)
	}
}

// TestParseRateMeasuresCoverageNotCorrectness pins the caveat in the type
// itself. A template that matches and extracts the wrong amount counts as a
// success here; letting "95% parses" be read as "95% correct" is the one way
// this number actively misleads.
func TestParseRateMeasuresCoverageNotCorrectness(t *testing.T) {
	if !containsAll(strings.ToLower(ParseRateCaveat), "coverage", "correct") {
		t.Fatalf("ParseRateCaveat does not distinguish coverage from correctness: %q", ParseRateCaveat)
	}
}

func containsAll(s string, subs ...string) bool {
	for _, sub := range subs {
		found := false
		for i := 0; i+len(sub) <= len(s); i++ {
			if s[i:i+len(sub)] == sub {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	return true
}

// TestParseRateCountsAMessageOnceHoweverManyTimesItWasAppended.
//
// ingest.alreadyHandled is a read followed by an append with no lock between
// them, and its own doc measures the window at 8 appends for one message. The
// numerator counted ROWS while the population counted distinct (user, ingest_id)
// identities, so every one of those races added 1 to the numerator and 0 to the
// denominator — the concurrency window inflated the number the exit gate is read
// off, in the direction that passes the gate.
func TestParseRateCountsAMessageOnceHoweverManyTimesItWasAppended(t *testing.T) {
	pool := pgtest.New(t)
	u := insertUser(t, pool)
	now, from, to := window()

	raced := sha256.Sum256([]byte("one message, eight appends"))
	for i := 0; i < 8; i++ {
		diagRowFor(t, pool, u, raced[:], now, diag.EventArrival, diag.OutcomeAppended, diag.TierTemplate, "")
	}
	id := arrival(t, pool, u, now, diag.OutcomeAppended, diag.TierNone, "")
	adjudicate(t, pool, u, id, VerdictTransaction)

	rep, err := ParseRate(bg, pool, ParseRateOptions{From: from, To: to})
	if err != nil {
		t.Fatalf("ParseRate: %v", err)
	}
	if rep.Parsed != 1 {
		t.Fatalf("parsed = %d, want 1: eight appends of one email are one email", rep.Parsed)
	}
	if want := 0.5; math.Abs(rep.Rate-want) > 1e-9 {
		t.Fatalf("rate = %v, want %v (1 parsed of 2 messages, not 8 of 9)", rep.Rate, want)
	}
}

// TestParseRateMeasuresPromotedQuarantineMail.
//
// Under trust-on-first-use every sender's FIRST batch is quarantined, then
// promoted and parsed once the user confirms them. The promote writes
// event='reprocess'; the population and the numerator both read event='arrival'
// only, so that mail left through Excluded['quarantined'] and never came back.
// The rate was measured over the mail from senders that were already trusted —
// which is the mail most likely to parse.
func TestParseRateMeasuresPromotedQuarantineMail(t *testing.T) {
	pool := pgtest.New(t)
	u := insertUser(t, pool)
	now, from, to := window()

	// One ordinary parsed arrival.
	arrival(t, pool, u, now, diag.OutcomeAppended, diag.TierTemplate, "")

	// A held message, later promoted and parsed by a template.
	good := arrival(t, pool, u, now, diag.OutcomeQuarantined, diag.TierNone, "")
	promote(t, pool, u, good, now)
	diagRowFor(t, pool, u, good, now.Add(time.Minute), diag.EventReprocess,
		diag.OutcomeAppended, diag.TierTemplate, "")

	// A held message, promoted, and STILL unparsed. It is a genuine parse
	// failure and must reach the population.
	bad := arrival(t, pool, u, now, diag.OutcomeQuarantined, diag.TierNone, "")
	promote(t, pool, u, bad, now)
	diagRowFor(t, pool, u, bad, now.Add(time.Minute), diag.EventReprocess,
		diag.OutcomeAppended, diag.TierNone, "")

	// A message still sitting in quarantine: not parsed YET, and excluded.
	stillHeld := arrival(t, pool, u, now, diag.OutcomeQuarantined, diag.TierNone, "")
	hold(t, pool, u, stillHeld, now)

	rep, err := ParseRate(bg, pool, ParseRateOptions{From: from, To: to})
	if !errors.Is(err, ErrUnadjudicated) {
		t.Fatalf("ParseRate err = %v, want ErrUnadjudicated for the promoted-but-unparsed message", err)
	}
	if rep.Parsed != 2 {
		t.Fatalf("parsed = %d, want 2 (one direct, one promoted then parsed)", rep.Parsed)
	}
	if rep.Unparsed != 1 {
		t.Fatalf("unparsed = %d, want 1 (the promoted message no template matched): %+v",
			rep.Unparsed, rep.Pending)
	}
	if len(rep.Pending) != 1 || string(rep.Pending[0].IngestID) != string(bad) {
		t.Fatalf("pending = %+v, want exactly the promoted-and-unparsed message", rep.Pending)
	}
	if rep.Lost[LossHeldUnconfirmed] != 1 {
		t.Fatalf("lost = %v, want the one message that is still held", rep.Lost)
	}

	adjudicate(t, pool, u, bad, VerdictTransaction)
	got, err := ParseRate(bg, pool, ParseRateOptions{From: from, To: to})
	if err != nil {
		t.Fatalf("ParseRate: %v", err)
	}
	// 2 parsed, 1 adjudicated miss, 1 still held and unconfirmed.
	if want := 2.0 / 4.0; math.Abs(got.Rate-want) > 1e-9 {
		t.Fatalf("rate = %v, want %v", got.Rate, want)
	}
}

// ---------------------------------------------------------------------------
// The denominator has to contain what the alpha LOST
// ---------------------------------------------------------------------------

// reject writes an arrival that was refused with a reason. These are our
// failures, not the sender's, and they all used to collapse into one
// "rejected" bucket that the gate never looked at.
func reject(t *testing.T, pool *pgxpool.Pool, u uuid.UUID, at time.Time, reason string) []byte {
	t.Helper()
	outcome := diag.OutcomeRejected
	if reason == diag.RejectOverQuota {
		outcome = diag.OutcomeOverQuota
	}
	return arrival(t, pool, u, at, outcome, diag.TierNone, reason)
}

// TestParseRateCountsMailTheNormalizerLost is the critic's first scenario: the
// normalizer breaks on one bank, the alpha loses 40 of 100 messages, and the
// instrument reported a perfect score because every one of them left through
// Excluded and MeetsGate never looked at it.
func TestParseRateCountsMailTheNormalizerLost(t *testing.T) {
	pool := pgtest.New(t)
	u := insertUser(t, pool)
	now, from, to := window()

	for i := 0; i < 60; i++ {
		arrival(t, pool, u, now, diag.OutcomeAppended, diag.TierTemplate, "")
	}
	for i := 0; i < 40; i++ {
		reject(t, pool, u, now, diag.RejectNoTextPart)
	}

	rep, err := ParseRate(bg, pool, ParseRateOptions{From: from, To: to})
	if err != nil {
		t.Fatalf("ParseRate: %v", err)
	}
	if rep.Lost[diag.RejectNoTextPart] != 40 {
		t.Fatalf("lost = %v, want 40 under no_text_part — the reason is on the row and "+
			"collapsing it into 'rejected' hides whose failure it was", rep.Lost)
	}
	if want := 0.6; math.Abs(rep.Rate-want) > 1e-9 {
		t.Fatalf("rate = %.4f, want %v: 40 messages the alpha sent produced no transaction",
			rep.Rate, want)
	}
	if rep.MeetsGate() {
		t.Fatal("gate passes with 40%% of the alpha's mail lost before the parser")
	}
}

// The critic's second scenario: trust-on-first-use holds the user never
// confirms, expired by the sweep. 200 messages gone, previously rate=1.0000.
func TestParseRateCountsHeldMailTheUserNeverConfirmed(t *testing.T) {
	pool := pgtest.New(t)
	u := insertUser(t, pool)
	now, from, to := window()

	for i := 0; i < 10; i++ {
		arrival(t, pool, u, now, diag.OutcomeAppended, diag.TierTemplate, "")
	}
	for i := 0; i < 150; i++ {
		expire(t, pool, u, arrival(t, pool, u, now, diag.OutcomeQuarantined, diag.TierNone, ""), now)
	}
	for i := 0; i < 50; i++ {
		hold(t, pool, u, arrival(t, pool, u, now, diag.OutcomeQuarantined, diag.TierNone, ""), now)
	}

	rep, err := ParseRate(bg, pool, ParseRateOptions{From: from, To: to})
	if err != nil {
		t.Fatalf("ParseRate: %v", err)
	}
	if rep.Lost[LossHeldExpired] != 150 || rep.Lost[LossHeldUnconfirmed] != 50 {
		t.Fatalf("lost = %v, want 150 expired / 50 still held", rep.Lost)
	}
	if rep.Rate > 0.05 {
		t.Fatalf("rate = %.4f with 10 parsed and 200 lost", rep.Rate)
	}
	if rep.MeetsGate() {
		t.Fatal("gate passes with 200 of the alpha's 210 messages never becoming a transaction")
	}
}

// A redelivery is the ONE exclusion that is not a loss: its original is counted.
func TestParseRateStillExcludesDuplicatesAndNothingElse(t *testing.T) {
	pool := pgtest.New(t)
	u := insertUser(t, pool)
	now, from, to := window()

	id := arrival(t, pool, u, now, diag.OutcomeAppended, diag.TierTemplate, "")
	diagRowFor(t, pool, u, id, now.Add(time.Minute), diag.EventArrival, diag.OutcomeDuplicate, diag.TierNone, "")

	rep, err := ParseRate(bg, pool, ParseRateOptions{From: from, To: to})
	if err != nil {
		t.Fatalf("ParseRate: %v", err)
	}
	if rep.LostTotal != 0 {
		t.Fatalf("lost = %v, want none: a retry of a stored message shares its ingest id, "+
			"so it merges into that message rather than needing an exclusion rule", rep.Lost)
	}
	if rep.Parsed != 1 || rep.Rate != 1 {
		t.Fatalf("parsed = %d rate = %v, want 1 and 1", rep.Parsed, rep.Rate)
	}
}

// TestParseRateReportsWhatItCannotSee mirrors the accounting report: a bare
// number overclaims, and the classes with no user-scoped diagnostics row at all
// (tarpit, connection caps, over-long lines) cannot even reach Lost.
func TestParseRateReportsWhatItCannotSee(t *testing.T) {
	pool := pgtest.New(t)
	now, from, to := window()
	_ = now
	rep, err := ParseRate(bg, pool, ParseRateOptions{From: from, To: to})
	if err != nil {
		t.Fatalf("ParseRate: %v", err)
	}
	if len(rep.BlindSpots) == 0 {
		t.Fatal("the parse-rate report names no blind spots; verify.Report carries them " +
			"precisely because a bare number overclaims, and this number is the SOLE " +
			"evidence for the ship gate")
	}
	for _, b := range rep.BlindSpots {
		if b.Reason == "" || b.Direction == "" {
			t.Errorf("blind spot %q is missing a reason or a direction", b.ID)
		}
	}
}

// ---------------------------------------------------------------------------
// A past window's number must not rise
// ---------------------------------------------------------------------------

// TestParseRateDoesNotRiseWhenATemplateIsFixedLater.
//
// best_tier was max() over every diagnostics row for the identity with no event
// or time filter, so publishing a template and reprocessing six weeks later
// raised the score of a window that had already been measured — and "two
// consecutive weeks" could be satisfied retroactively.
//
// Promotion out of quarantine is the fold-in that must survive, and it is
// distinguishable: a promote writes reprocess/appended, a template fix writes
// reprocess/superseded or reprocess/unchanged.
func TestParseRateDoesNotRiseWhenATemplateIsFixedLater(t *testing.T) {
	pool := pgtest.New(t)
	u := insertUser(t, pool)
	now, from, to := window()

	arrival(t, pool, u, now, diag.OutcomeAppended, diag.TierTemplate, "")
	unparsed := arrival(t, pool, u, now, diag.OutcomeAppended, diag.TierNone, "")
	adjudicate(t, pool, u, unparsed, VerdictTransaction)

	before, err := ParseRate(bg, pool, ParseRateOptions{From: from, To: to})
	if err != nil {
		t.Fatalf("ParseRate: %v", err)
	}
	if before.Rate != 0.5 {
		t.Fatalf("rate = %v, want 0.5", before.Rate)
	}

	// Six weeks later: publish a template, reprocess, the message now parses.
	diagRowFor(t, pool, u, unparsed, now.Add(6*7*24*time.Hour), diag.EventReprocess,
		diag.OutcomeSuperseded, diag.TierTemplate, "")

	after, err := ParseRate(bg, pool, ParseRateOptions{From: from, To: to})
	if err != nil {
		t.Fatalf("ParseRate: %v", err)
	}
	if after.Rate != before.Rate {
		t.Fatalf("the same window now reports %.4f, was %.4f: a window already measured must "+
			"not improve because a template was fixed afterwards", after.Rate, before.Rate)
	}
	if after.MeetsGate() {
		t.Fatal("gate passes retroactively")
	}
}

// ---------------------------------------------------------------------------
// Gate shape: per user, per week, minimum volume
// ---------------------------------------------------------------------------

// One totally broken alpha is invisible in the aggregate. The critic's numbers:
// 4 alphas x 130 clean plus 1 alpha with 27 failures and zero parses averages to
// 0.9506 and passed.
func TestParseRateGateFailsWhenOneAlphaIsBrokenAndTheAggregatePasses(t *testing.T) {
	pool := pgtest.New(t)
	now, from, to := twoWeekWindow()

	for i := 0; i < 4; i++ {
		u := insertUser(t, pool)
		for j := 0; j < 130; j++ {
			arrival(t, pool, u, now, diag.OutcomeAppended, diag.TierTemplate, "")
		}
	}
	broken := insertUser(t, pool)
	for j := 0; j < 27; j++ {
		id := arrival(t, pool, broken, now, diag.OutcomeAppended, diag.TierNone, "")
		adjudicate(t, pool, broken, id, VerdictTransaction)
	}

	rep, err := ParseRate(bg, pool, ParseRateOptions{From: from, To: to})
	if err != nil {
		t.Fatalf("ParseRate: %v", err)
	}
	if rep.LowerBound < GateThreshold {
		t.Fatalf("precondition lost: aggregate %.4f already fails, so this test proves nothing",
			rep.LowerBound)
	}
	if rep.MeetsGate() {
		t.Fatalf("gate passes while one alpha parsed 0 of 27: %+v", rep.PerUser)
	}
	var seen bool
	for _, pu := range rep.PerUser {
		if pu.UserID == broken {
			seen = true
			if pu.Rate != 0 {
				t.Fatalf("the broken alpha reports %.4f, want 0", pu.Rate)
			}
		}
	}
	if !seen {
		t.Fatal("the report has no per-user rows, so an operator cannot see which alpha failed")
	}
}

// twoWeekWindow is a window long enough for the exit criterion to be assertable.
func twoWeekWindow() (time.Time, time.Time, time.Time) {
	now := time.Now().UTC().Add(-24 * time.Hour)
	return now, now.Add(-13 * 24 * time.Hour), now.Add(24 * time.Hour)
}

// "Two consecutive weeks" was never enforced: 90% then 100% averages to a pass.
func TestParseRateRequiresEachWeekToClearTheGate(t *testing.T) {
	pool := pgtest.New(t)
	u := insertUser(t, pool)
	now, from, to := twoWeekWindow()
	week2 := now.Add(-3 * 24 * time.Hour) // inside the second 7-day bucket

	// Week 1: 90 parsed, 10 genuine misses -> 0.90.
	for i := 0; i < 90; i++ {
		arrival(t, pool, u, from.Add(time.Hour), diag.OutcomeAppended, diag.TierTemplate, "")
	}
	for i := 0; i < 10; i++ {
		id := arrival(t, pool, u, from.Add(time.Hour), diag.OutcomeAppended, diag.TierNone, "")
		adjudicate(t, pool, u, id, VerdictTransaction)
	}
	// Week 2: 100 parsed -> 1.00. The mean clears 95%.
	for i := 0; i < 100; i++ {
		arrival(t, pool, u, week2, diag.OutcomeAppended, diag.TierTemplate, "")
	}

	rep, err := ParseRate(bg, pool, ParseRateOptions{From: from, To: to})
	if err != nil {
		t.Fatalf("ParseRate: %v", err)
	}
	if len(rep.Weeks) < 2 {
		t.Fatalf("a two-week window produced %d week rows; the criterion is about each week",
			len(rep.Weeks))
	}
	if rep.MeetsGate() {
		t.Fatalf("gate passes on a 0.90 week followed by a 1.00 week: %+v", rep.Weeks)
	}
}

func TestParseRateGateNeedsAWindowAndAVolumeWorthShippingOn(t *testing.T) {
	pool := pgtest.New(t)
	u := insertUser(t, pool)
	now := time.Now().UTC()

	// One perfectly parsed message over two minutes: the exit record's own
	// worked example, which printed a green gate.
	arrival(t, pool, u, now.Add(-time.Minute), diag.OutcomeAppended, diag.TierTemplate, "")
	rep, err := ParseRate(bg, pool, ParseRateOptions{From: now.Add(-2 * time.Minute), To: now})
	if err != nil {
		t.Fatalf("ParseRate: %v", err)
	}
	if rep.MeetsGate() {
		t.Fatal("a two-minute window with one message passes the ship gate")
	}
	if len(rep.Gate.Reasons) == 0 {
		t.Fatal("the gate failed without saying why")
	}
	joined := strings.Join(rep.Gate.Reasons, " ")
	if !strings.Contains(joined, "window") || !strings.Contains(joined, "message") {
		t.Fatalf("gate reasons %q name neither the short window nor the tiny volume", joined)
	}
}

// The sample must be drawn by ingest id, which is a SHA-256 and therefore
// independent of everything; drawing the EARLIEST N instead would be a
// chronological sample, and the Wilson interval's validity rests on the draw
// being uniform. Nothing asserted this, so the mutation survived.
func TestParseRateSamplesUniformlyByIngestIDNotChronologically(t *testing.T) {
	pool := pgtest.New(t)
	u := insertUser(t, pool)
	now, from, to := window()

	type seeded struct {
		id []byte
		at time.Time
	}
	var all []seeded
	for i := 0; i < 40; i++ {
		at := now.Add(-time.Duration(i) * time.Minute)
		all = append(all, seeded{arrival(t, pool, u, at, diag.OutcomeAppended, diag.TierNone, ""), at})
	}
	rep, _ := ParseRate(bg, pool, ParseRateOptions{From: from, To: to, Sample: 5})
	if len(rep.Pending) != 5 {
		t.Fatalf("pending = %d, want the 5 drawn", len(rep.Pending))
	}
	// The drawn set must be the 5 smallest ingest ids.
	sorted := slices.Clone(all)
	slices.SortFunc(sorted, func(a, b seeded) int { return bytes.Compare(a.id, b.id) })
	for i, p := range rep.Pending {
		if !bytes.Equal(p.IngestID, sorted[i].id) {
			t.Fatalf("draw %d is not the ingest-id ordering; a chronological draw is not a "+
				"uniform sample and the Wilson interval would not apply", i)
		}
	}
}

func TestParseRateWindowIsHalfOpen(t *testing.T) {
	pool := pgtest.New(t)
	u := insertUser(t, pool)
	to := time.Now().UTC().Truncate(time.Microsecond)
	from := to.Add(-time.Hour)

	arrival(t, pool, u, from, diag.OutcomeAppended, diag.TierTemplate, "")
	arrival(t, pool, u, to, diag.OutcomeAppended, diag.TierTemplate, "")

	rep, err := ParseRate(bg, pool, ParseRateOptions{From: from, To: to})
	if err != nil {
		t.Fatalf("ParseRate: %v", err)
	}
	if rep.Parsed != 1 {
		t.Fatalf("parsed = %d, want 1: [from, to) excludes a message dated exactly `to`", rep.Parsed)
	}
}

// ---------------------------------------------------------------------------
// RecordVerdict and ColdTexts: previously untested anywhere
// ---------------------------------------------------------------------------

// The verdict table is the ship gate's denominator, held by a party interested
// in the outcome, so its append-only guarantee is the whole point. Flipping six
// of ten verdicts was measured to move the rate from 0.9000 to 0.9574 leaving
// ten rows and no trace.
func TestRecordVerdictAppendsAndTheOldVerdictSurvives(t *testing.T) {
	pool := pgtest.New(t)
	u := insertUser(t, pool)
	id := sha256.Sum256([]byte("a message judged twice"))

	if err := RecordVerdict(bg, pool, u, id[:], VerdictNonTransactional, "alice"); err != nil {
		t.Fatalf("RecordVerdict: %v", err)
	}
	if err := RecordVerdict(bg, pool, u, id[:], VerdictTransaction, "alice"); err != nil {
		t.Fatalf("RecordVerdict (revision): %v", err)
	}

	var rows int
	if err := pool.QueryRow(bg,
		`SELECT count(*) FROM parse_rate_adjudications WHERE ingest_id = $1`, id[:]).Scan(&rows); err != nil {
		t.Fatal(err)
	}
	if rows != 2 {
		t.Fatalf("%d row(s) after a revision, want 2: the earlier verdict must survive or "+
			"the number can be edited into passing with no trace", rows)
	}
	superseded, changed, err := Revisions(bg, pool)
	if err != nil {
		t.Fatalf("Revisions: %v", err)
	}
	if superseded != 1 || changed != 1 {
		t.Fatalf("Revisions = (%d, %d), want (1, 1)", superseded, changed)
	}

	// And the LIVE verdict is the newest one.
	got, err := adjudications(bg, pool, ParseRateOptions{}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if got[key(u, id[:])] != VerdictTransaction {
		t.Fatalf("live verdict = %q, want the newest", got[key(u, id[:])])
	}
}

func TestTheVerdictTableRefusesRewrites(t *testing.T) {
	pool := pgtest.New(t)
	u := insertUser(t, pool)
	id := sha256.Sum256([]byte("a verdict somebody wants to change quietly"))
	if err := RecordVerdict(bg, pool, u, id[:], VerdictTransaction, "alice"); err != nil {
		t.Fatal(err)
	}
	for _, sql := range []string{
		`UPDATE parse_rate_adjudications SET verdict = 'non_transactional'`,
		`DELETE FROM parse_rate_adjudications`,
		`TRUNCATE parse_rate_adjudications`,
	} {
		if _, err := pool.Exec(bg, sql); err == nil {
			t.Fatalf("%q succeeded; the audit trail is not append-only", sql)
		}
	}
	// Erasing the ACCOUNT still works: that is a person asking to be forgotten,
	// not history being edited.
	if _, err := pool.Exec(bg, `DELETE FROM users WHERE id = $1`, u); err != nil {
		t.Fatalf("account deletion was blocked by the audit trigger: %v", err)
	}
}

func TestRecordVerdictRefusesWhatItCannotStore(t *testing.T) {
	pool := pgtest.New(t)
	u := insertUser(t, pool)
	id := sha256.Sum256([]byte("x"))
	for _, tc := range []struct {
		name, verdict, operator string
		ingest                  []byte
	}{
		{"an unknown verdict", "probably", "alice", id[:]},
		{"a short ingest id", VerdictTransaction, "alice", []byte("short")},
		{"an operator that is not an identifier", VerdictTransaction, "AMOUNT: AED 45.00", id[:]},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := RecordVerdict(bg, pool, u, tc.ingest, tc.verdict, tc.operator)
			if err == nil {
				t.Fatal("accepted")
			}
			// The rejected value is never echoed: the caller that got this wrong
			// is the one that might have passed a line of somebody's mail.
			if strings.Contains(err.Error(), "AED") || strings.Contains(err.Error(), "probably") {
				t.Fatalf("the error echoes the value it rejected: %v", err)
			}
		})
	}
}

// ColdTexts is the one function in this package that reads content. It had no
// test at all, so nothing checked that it returns the right message's body — the
// failure that would silently show an operator one email while asking them to
// judge another.
func TestColdTextsReturnsEachMessagesOwnBody(t *testing.T) {
	pool := pgtest.New(t)
	u := insertUser(t, pool)
	ap := &oplog.Appender{Pool: pool}

	type seeded struct {
		id   []byte
		body string
	}
	var want []seeded
	for i := 0; i < 3; i++ {
		raw := fmt.Sprintf("From: bank%d@bank.test\r\nSubject: Alert %d\r\n\r\nPurchase %d AED\r\n", i, i, i)
		sum := sha256.Sum256([]byte(raw))
		rb, err := oplog.EncodeRawBody(oplog.RawBody{
			V: 1, Kind: oplog.KindRawBody, IngestID: hex.EncodeToString(sum[:]),
			ReceivedAt: time.Now().UTC(), RawBase64: base64.StdEncoding.EncodeToString([]byte(raw)),
		})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := ap.AppendIngest(bg, u, []oplog.IngestBlob{
			{Stream: blob.StreamCold, Plaintext: rb, CreatedAt: time.Now()},
		}); err != nil {
			t.Fatal(err)
		}
		want = append(want, seeded{sum[:], raw})
	}

	ids := [][]byte{want[2].id, want[0].id}
	got, err := ColdTexts(bg, pool, nil, u, ids)
	if err != nil {
		t.Fatalf("ColdTexts: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("got %d bodies, want 2", len(got))
	}
	for _, w := range []seeded{want[0], want[2]} {
		text, ok := got[hex.EncodeToString(w.id)]
		if !ok {
			t.Fatalf("no body for %x", w.id[:6])
		}
		if !strings.Contains(text, "Purchase") {
			t.Fatalf("body for %x does not look normalized: %q", w.id[:6], text)
		}
	}
	// The one NOT asked for must not come back: an operator judging message A
	// while looking at message B is the failure this guards.
	if _, ok := got[hex.EncodeToString(want[1].id)]; ok {
		t.Fatal("ColdTexts returned a message that was not requested")
	}
}

func TestColdTextsSkipsAMessageItCannotRead(t *testing.T) {
	pool := pgtest.New(t)
	u := insertUser(t, pool)
	missing := sha256.Sum256([]byte("never stored"))

	got, err := ColdTexts(bg, pool, nil, u, [][]byte{missing[:]})
	if err != nil {
		t.Fatalf("ColdTexts: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("got %v, want nothing: the caller records VerdictUnreadable for a body it "+
			"could not fetch, and an error here would stop the whole batch", got)
	}
}
