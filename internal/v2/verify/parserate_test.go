package verify

import (
	"errors"
	"math"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"ledger/internal/v2/diag"
	"ledger/internal/v2/pgtest"
)

func adjudicate(t *testing.T, pool *pgxpool.Pool, u uuid.UUID, id []byte, verdict string) {
	t.Helper()
	exec(t, pool, `INSERT INTO parse_rate_adjudications (ingest_id, user_id, verdict, adjudicated_at)
	               VALUES ($1,$2,$3, now())
	               ON CONFLICT (ingest_id, user_id) DO UPDATE SET verdict = EXCLUDED.verdict`,
		id, u, verdict)
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

	arrival(t, pool, u, now, diag.OutcomeAppended, diag.TierTemplate, "")
	arrival(t, pool, u, now, diag.OutcomeQuarantined, diag.TierNone, "")
	arrival(t, pool, u, now, diag.OutcomeDuplicate, diag.TierNone, "")
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
	if !rep.HasRate || rep.Rate != 1 {
		t.Fatalf("rate = %v (has=%v), want 1", rep.Rate, rep.HasRate)
	}
	if rep.Excluded[diag.OutcomeQuarantined] != 1 || rep.Excluded[diag.OutcomeDuplicate] != 1 {
		t.Fatalf("excluded = %v: what was left out has to be reported, or the denominator "+
			"is a choice nobody can audit", rep.Excluded)
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
	arrival(t, pool, u, now, diag.OutcomeQuarantined, diag.TierTemplate, "")

	rep, err := ParseRate(bg, pool, ParseRateOptions{From: from, To: to})
	if err != nil {
		t.Fatalf("ParseRate: %v", err)
	}
	if rep.Parsed != 1 {
		t.Fatalf("parsed = %d, want 1: a template match that was not appended is not a parse "+
			"the numerator may claim", rep.Parsed)
	}
	if rep.Excluded[diag.OutcomeQuarantined] != 1 {
		t.Fatalf("excluded = %v, want the quarantined row named", rep.Excluded)
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
