// Envelope engine (v3 piece 1): per-category per-month envelope math layered
// under the 50/30/20 jars. Like the jar math in budget.go, everything here is
// pure — callers fetch rows from the store (EnvelopeMonthSummary, targets) and
// resolve income (config figure or income categories, the same switch the jar
// summary uses), then pass them in. All money is int64 AED fils.
//
// Core identity, per category per month:
//
//	available = carryover + assigned − activity
//
// Carryover / overspend policy (YNAB semantics — charged exactly once): the
// store hands the engine an EFFECTIVE carryover (≥ 0) and a one-time overspend
// debt per category, both scoped to the category's ENVELOPE ERA — prior
// activity counts only from the category's first assignment month, so
// pre-envelope (v2) history and categories the user leaves un-enveloped never
// surface as debt (see store.EnvelopeMonthRow / store's envelopeEraFold). A
// positive carryover rolls into the month untouched (saved money keeps its
// job). Cash overspend is charged against Ready-to-Assign EXACTLY ONCE, in
// the month after it happened, and the charge simultaneously settles the
// envelope (its carryover baseline is credited by the same amount), so:
// the same overspend never re-charges in later months, no manual "covering"
// assignment is required, and an assignment made to the category afterwards is
// ordinary new funding that stays spendable and carries forward. Overspend in
// the CURRENT month sets Overspent (available < 0) but does not reduce the
// current month's RTA — it is charged to next month's RTA (once).
//
// Ready to Assign:
//
//	RTA = income − Σ assigned(this month) − Σ overspend debt charged this month
//
// It can go negative (assigning more than income is allowed; the Plan screen
// shows it red). Sums run over the rows passed in (the store's active
// spending categories).
package budget

import (
	"fmt"
	"math"
	"time"

	"ledger/internal/store"
)

// TargetStatus is a category target evaluated against the month: how much the
// target asks to be assigned this month (NeededFils), how much of that ask is
// still unmet after this month's assignment (StillNeededFils), and whether it
// is fully funded.
//
// Needed-this-month per target type ("carry" = clamped carryover):
//
//   - set_aside: the flat cadence amount normalized to this calendar month.
//     Normalization goes through a yearly total (weekly ×52, monthly ×12,
//     yearly ×1) divided by 12; the integer-division remainder is absorbed by
//     December (last-month policy) so a year of set-asides sums exactly to the
//     yearly total. Monthly cadence is exact every month.
//   - refill: top the envelope back up to Amount. Needed = max(0, amount −
//     carry + activity); StillNeeded therefore equals max(0, amount −
//     available), the spec's "amount − available", and spending during the
//     month raises the ask again.
//   - save_by_date: remaining = max(0, amount − carry + activity), spread over
//     the months left until the due month INCLUSIVE of the current month
//     (due this month, a past due date, or an unparseable one ⇒ 1 month ⇒ the
//     full remainder is asked now). Needed = remaining / monthsLeft, floor
//     division: early months under-ask by at most monthsLeft−1 fils, and
//     because Needed is recomputed each month from the then-current balance
//     the remainder rides forward and the final month (monthsLeft = 1) asks
//     for the entire remainder — last-month absorption, never lost.
type TargetStatus struct {
	Type            string `json:"type"`
	AmountFils      int64  `json:"amount_fils"`
	Cadence         string `json:"cadence"`
	DueDate         string `json:"due_date,omitempty"`
	MonthsLeft      int64  `json:"months_left,omitempty"` // save_by_date only
	NeededFils      int64  `json:"needed_fils"`
	StillNeededFils int64  `json:"still_needed_fils"`
	Funded          bool   `json:"funded"`
}

// Envelope is one category's envelope state for the month.
type Envelope struct {
	CategoryID    int64  `json:"category_id"`
	CategoryName  string `json:"category_name"`
	Bucket        string `json:"bucket"`
	CarryoverFils int64  `json:"carryover_fils"` // clamped ≥ 0 (see policy above)
	AssignedFils  int64  `json:"assigned_fils"`
	ActivityFils  int64  `json:"activity_fils"`
	AvailableFils int64  `json:"available_fils"`
	Overspent     bool   `json:"overspent"` // available < 0 this month
	// OverspendDebtFils is the prior-month cash overspend charged against
	// this month's Ready-to-Assign — a ONE-TIME charge (see the policy
	// comment at the top of this file): the charge itself settles the
	// envelope, so the same overspend never appears here again.
	OverspendDebtFils int64         `json:"overspend_debt_fils"`
	Target            *TargetStatus `json:"target,omitempty"`
}

// EnvelopeSummary is the full envelope payload for one month
// (GET /api/envelopes).
type EnvelopeSummary struct {
	Month             string     `json:"month"`
	IncomeFils        int64      `json:"income_fils"`
	AssignedFils      int64      `json:"assigned_fils"`       // Σ this month, over Envelopes
	OverspendDebtFils int64      `json:"overspend_debt_fils"` // Σ overspend charged this month (one-time)
	ReadyToAssignFils int64      `json:"ready_to_assign_fils"`
	Envelopes         []Envelope `json:"envelopes"`
}

// ComputeEnvelopes evaluates one month's envelopes. rows come from
// store.EnvelopeMonthSummary(month) (row order — need/want/saving then name —
// is preserved), targets from store.SelectCategoryTargets; income is resolved
// by the caller exactly as for the jar summary. Targets for categories not in
// rows are ignored.
func ComputeEnvelopes(month string, income int64, rows []store.EnvelopeMonthRow, targets []store.CategoryTargetRow) (EnvelopeSummary, error) {
	monthStart, err := time.Parse("2006-01", month)
	if err != nil {
		return EnvelopeSummary{}, fmt.Errorf("bad month %q (want YYYY-MM): %w", month, err)
	}
	targetByCat := make(map[int64]store.CategoryTargetRow, len(targets))
	for _, t := range targets {
		targetByCat[t.CategoryID] = t
	}

	sum := EnvelopeSummary{Month: month, IncomeFils: income}
	for _, r := range rows {
		// The store guarantees effective carryover ≥ 0 and one-time debt ≥ 0
		// (envelopeEraFold); clamp defensively so a bad row can only zero out,
		// never mint negative envelope money.
		carry := clamp0(r.CarryoverFils)
		debt := clamp0(r.OverspendDebtFils)
		e := Envelope{
			CategoryID:        r.CategoryID,
			CategoryName:      r.CategoryName,
			Bucket:            r.Bucket,
			CarryoverFils:     carry,
			AssignedFils:      r.AssignedFils,
			ActivityFils:      r.ActivityFils,
			AvailableFils:     carry + r.AssignedFils - r.ActivityFils,
			OverspendDebtFils: debt,
		}
		e.Overspent = e.AvailableFils < 0
		if t, ok := targetByCat[r.CategoryID]; ok {
			e.Target = targetStatus(t, monthStart, carry, r.AssignedFils, r.ActivityFils)
		}
		sum.AssignedFils += r.AssignedFils
		sum.OverspendDebtFils += debt
		sum.Envelopes = append(sum.Envelopes, e)
	}
	sum.ReadyToAssignFils = income - sum.AssignedFils - sum.OverspendDebtFils
	return sum, nil
}

// targetStatus evaluates one target against the month; see TargetStatus for
// the per-type formulas and remainder policy.
func targetStatus(t store.CategoryTargetRow, monthStart time.Time, carry, assigned, activity int64) *TargetStatus {
	ts := &TargetStatus{Type: t.TargetType, AmountFils: t.AmountFils, Cadence: t.Cadence, DueDate: t.DueDate}
	switch t.TargetType {
	case "set_aside":
		ts.NeededFils = monthlyEquivalent(t.AmountFils, t.Cadence, int(monthStart.Month()))
	case "refill":
		ts.NeededFils = clamp0(t.AmountFils - carry + activity)
	case "save_by_date":
		ts.MonthsLeft = monthsLeft(monthStart, t.DueDate)
		ts.NeededFils = clamp0(t.AmountFils-carry+activity) / ts.MonthsLeft
	}
	ts.StillNeededFils = clamp0(ts.NeededFils - assigned)
	ts.Funded = ts.StillNeededFils == 0
	return ts
}

// monthlyEquivalent normalizes a cadence amount to one calendar month via the
// yearly total (weekly ×52, monthly ×12, yearly ×1) / 12. December absorbs the
// integer-division remainder (last-month policy) so twelve months sum exactly
// to the yearly total; monthly cadence divides exactly every month. Unknown
// cadences fall back to monthly (the store default).
func monthlyEquivalent(amountFils int64, cadence string, calendarMonth int) int64 {
	var yearly int64
	switch cadence {
	case "weekly":
		yearly = amountFils * 52
	case "yearly":
		yearly = amountFils
	default: // "monthly" and the store's empty-string default
		yearly = amountFils * 12
	}
	base := yearly / 12
	if calendarMonth == 12 {
		return yearly - 11*base
	}
	return base
}

// monthsLeft counts months from monthStart's month to the due month, inclusive
// of both — due this month is 1. A past or unparseable due date clamps to 1
// (the whole remainder is asked now).
func monthsLeft(monthStart time.Time, dueDate string) int64 {
	due, err := time.Parse("2006-01-02", dueDate)
	if err != nil {
		return 1
	}
	n := (int64(due.Year())*12 + int64(due.Month())) - (int64(monthStart.Year())*12 + int64(monthStart.Month())) + 1
	return max(n, 1)
}

// Allocation is one category's share of an auto-assign run, a DELTA to add to
// its existing assignment (store.AddToEnvelopeAssignment); always > 0.
type Allocation struct {
	CategoryID int64 `json:"category_id"`
	AmountFils int64 `json:"amount_fils"`
}

// AutoAssign plans one-call distribution of a positive Ready-to-Assign — the
// day-one no-bootcamp default. Pure: it returns the plan (allocations in
// envelope row order, at most one per category); the caller applies it.
//
// Phase 1 — targets first: each envelope with an unmet target gets its
// StillNeededFils, walking rows in order (need → want → saving, then name);
// when RTA cannot cover them all, earlier rows win (first-category policy)
// and the run stops when the pool empties.
//
// Phase 2 — 50/30/20 pro-rata seed: the remaining pool splits by the same
// bucket weights the jar summary uses, converted ONCE to integer per-mille
// weights (bucketWeights — money is never multiplied by a float): each
// bucket's share is pool × w / W in int64, floor division, so the distributed
// total can never exceed the pool even when the configured pcts sum slightly
// above 1 (the budget PUT tolerates |Σ−1| ≤ 0.001). Each bucket's share then
// spreads equally across that bucket's UNtargeted envelopes; the within-bucket
// division remainder goes to the bucket's first envelope. Anything
// undistributed — floor-division remainder, or a bucket whose envelopes all
// have targets — is absorbed by the first seeded envelope in row order
// (first-category policy), so when at least one untargeted envelope exists the
// allocations sum exactly to RTA. With no untargeted envelopes anywhere,
// phase 2 is skipped and the surplus stays in RTA (a fully-targeted budget
// only funds its targets). Envelopes outside the three buckets are never
// seeded. RTA ≤ 0 returns nil.
func AutoAssign(sum EnvelopeSummary, cfg store.BudgetConfig) []Allocation {
	pool := sum.ReadyToAssignFils
	if pool <= 0 || len(sum.Envelopes) == 0 {
		return nil
	}
	amounts := make(map[int64]int64)

	// Phase 1: fund unmet targets in row order until the pool empties.
	for _, e := range sum.Envelopes {
		if pool == 0 {
			break
		}
		if e.Target == nil || e.Target.StillNeededFils <= 0 {
			continue
		}
		give := min(e.Target.StillNeededFils, pool)
		amounts[e.CategoryID] += give
		pool -= give
	}

	// Phase 2: pro-rata seed of the leftover across untargeted envelopes.
	if pool > 0 {
		weights, totalWeight := bucketWeights(cfg)
		perBucket := make(map[string][]int64)
		var seeded []int64 // untargeted envelope ids, row order
		for _, e := range sum.Envelopes {
			if e.Target != nil {
				continue
			}
			if _, ok := weights[e.Bucket]; !ok {
				continue
			}
			perBucket[e.Bucket] = append(perBucket[e.Bucket], e.CategoryID)
			seeded = append(seeded, e.CategoryID)
		}
		if len(seeded) > 0 {
			var distributed int64
			if totalWeight > 0 {
				for _, bucket := range bucketOrder {
					ids := perBucket[bucket]
					if len(ids) == 0 {
						continue // share falls through to the leftover
					}
					// Integer pro-rata, floor division: Σ shares ≤ pool always,
					// so the leftover below is never negative and auto-assign
					// can never assign more than RTA.
					share := pool * weights[bucket] / totalWeight
					per := share / int64(len(ids))
					rem := share - per*int64(len(ids))
					for i, id := range ids {
						amt := per
						if i == 0 {
							amt += rem // within-bucket remainder: first envelope
						}
						amounts[id] += amt
					}
					distributed += share
				}
			}
			if leftover := pool - distributed; leftover > 0 {
				amounts[seeded[0]] += leftover // first-category policy
			}
		}
	}

	var out []Allocation
	for _, e := range sum.Envelopes {
		if amt := amounts[e.CategoryID]; amt > 0 {
			out = append(out, Allocation{CategoryID: e.CategoryID, AmountFils: amt})
		}
	}
	return out
}

// bucketPcts maps the three jar buckets to their configured weights — used by
// the jar summary (computeJars), whose float targets are display values.
func bucketPcts(cfg store.BudgetConfig) map[string]float64 {
	return map[string]float64{"need": cfg.NeedPct, "want": cfg.WantPct, "saving": cfg.SavingPct}
}

// bucketWeights converts the configured bucket pcts to integer per-mille
// weights, rounded ONCE at the boundary, plus their total. AutoAssign
// distributes money with these so no fils amount is ever computed through a
// float (core principle: never use floats for money). Negative pcts clamp to
// 0 defensively.
func bucketWeights(cfg store.BudgetConfig) (map[string]int64, int64) {
	w := make(map[string]int64, 3)
	var total int64
	for bucket, pct := range bucketPcts(cfg) {
		v := int64(math.Round(pct * 1000))
		if v < 0 {
			v = 0
		}
		w[bucket] = v
		total += v
	}
	return w, total
}

func clamp0(v int64) int64 {
	return max(v, 0)
}
