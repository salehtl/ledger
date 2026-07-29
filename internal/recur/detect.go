package recur

import (
	"sort"
	"time"
)

// Detection thresholds. All deterministic constants — tuning them re-runs
// identically over the same history.
const (
	// MinOccurrences is the fewest sightings that can establish a pattern.
	MinOccurrences = 3
	// minOccurrencesShort is required for sub-monthly cadences: a weekly-ish
	// gap is easy to hit by chance, so it needs one more sighting.
	minOccurrencesShort = 4
	// shortIntervalDays is the boundary below which minOccurrencesShort applies.
	shortIntervalDays = 25
	// minIntervalDays rejects cadences tighter than ~weekly: nothing shorter
	// is a bill, and frequent errands (groceries, coffee) live down there.
	minIntervalDays = 6
	// DefaultTolerancePct is the ± amount band proposed schedules start with.
	DefaultTolerancePct = 10
	// staleFactor: a series whose last sighting is more than staleFactor ×
	// interval old has stopped; don't propose a dead bill.
	staleFactor = 2
)

// cadences are the canonical intervals a raw median snaps to when it lands
// within that cadence's tolerance band (bands never overlap).
var cadences = [...]int64{7, 14, 30, 91, 365}

// Provenance records how a proposal was mined, persisted as JSON on the
// scheduled_transactions row so the review UI can show "seen 6× every ~30
// days" and link the matched transactions.
type Provenance struct {
	Count           int     `json:"count"`
	AvgIntervalDays int64   `json:"avg_interval_days"`
	LastAmountsFils []int64 `json:"last_amounts_fils"` // chronological, up to 6
	TxIDs           []int64 `json:"tx_ids"`            // matched occurrences, oldest first
	PriceStepped    bool    `json:"price_stepped,omitempty"`
}

// Proposal is one mined recurring pattern, ready to become a
// scheduled_transactions row (source=detected, status=proposed).
type Proposal struct {
	NormalizedMerchant string
	Direction          string
	AmountFils         int64 // current price (post-step when the price crept)
	TolerancePct       int64
	IntervalDays       int64
	NextDue            time.Time // UTC midnight
	CategoryID         *int64
	Provenance         Provenance
}

// Detect mines recurring merchants from confirmed transaction history.
// Deterministic: same inputs, same proposals, sorted by merchant then
// direction. now anchors staleness and next-due math; existing is the set of
// normalized merchants that already have a schedule in any status (including
// dismissed — a "no" sticks) and is never re-proposed. nil existing means no
// exclusions.
func Detect(now time.Time, txns []Txn, existing map[string]bool) []Proposal {
	type key struct{ merchant, direction string }
	groups := make(map[key][]Txn)
	for _, t := range txns {
		m := Normalize(t.Merchant)
		if m == "" || existing[m] {
			continue
		}
		if t.Direction != "debit" && t.Direction != "credit" {
			continue
		}
		if t.AmountFils <= 0 {
			continue
		}
		k := key{m, t.Direction}
		groups[k] = append(groups[k], t)
	}

	var out []Proposal
	for k, group := range groups {
		occ := occurrences(group)
		if len(occ) < MinOccurrences {
			continue
		}
		window, interval, amount, stepped, ok := stableSuffix(occ)
		if !ok {
			continue
		}
		// Dead series: the bill stopped arriving long ago.
		last := dayOf(window[len(window)-1].PostedAt)
		if daysBetween(last, dayOf(now)) > staleFactor*interval {
			continue
		}
		amounts := make([]int64, len(window))
		for i, t := range window {
			amounts[i] = t.AmountFils
		}
		out = append(out, Proposal{
			NormalizedMerchant: k.merchant,
			Direction:          k.direction,
			AmountFils:         amount,
			TolerancePct:       DefaultTolerancePct,
			IntervalDays:       interval,
			NextDue:            last.AddDate(0, 0, int(interval)),
			CategoryID:         modeCategory(window),
			Provenance:         provenanceFor(window, amounts, stepped),
		})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].NormalizedMerchant != out[j].NormalizedMerchant {
			return out[i].NormalizedMerchant < out[j].NormalizedMerchant
		}
		return out[i].Direction < out[j].Direction
	})
	return out
}

// occurrences orders a merchant's transactions chronologically and collapses
// same-day repeats to the first one — two charges on one day are one sighting,
// not a zero-day interval that would wreck stability.
func occurrences(group []Txn) []Txn {
	sorted := make([]Txn, len(group))
	copy(sorted, group)
	sort.Slice(sorted, func(i, j int) bool {
		if !sorted[i].PostedAt.Equal(sorted[j].PostedAt) {
			return sorted[i].PostedAt.Before(sorted[j].PostedAt)
		}
		return sorted[i].ID < sorted[j].ID
	})
	var out []Txn
	for _, t := range sorted {
		if len(out) > 0 && dayOf(out[len(out)-1].PostedAt).Equal(dayOf(t.PostedAt)) {
			continue
		}
		out = append(out, t)
	}
	return out
}

// stableSuffix finds the longest run of most-recent occurrences (length ≥ the
// occurrence minimum) whose gaps hold a stable interval AND whose amounts pass
// stableAmount, returning the run with its canonical interval, settled amount
// and price-step flag. Searching suffixes longest-first lets a merchant with
// irregular old history that settled into a subscription still detect, while
// preferring the most evidence. The amount check is folded into the loop: an
// interval-stable window rejected only for its amounts (a mid-series one-off
// purchase that happened to land on the cadence day) resumes the search at
// the next start, so a clean trailing run behind an amount outlier still
// proposes instead of silently disqualifying the merchant.
func stableSuffix(occ []Txn) (window []Txn, interval, amount int64, stepped, ok bool) {
	for start := 0; start+MinOccurrences <= len(occ); start++ {
		w := occ[start:]
		interval, intervalOK := stableInterval(w)
		if !intervalOK {
			continue
		}
		need := MinOccurrences
		if interval < shortIntervalDays {
			need = minOccurrencesShort
		}
		if len(w) < need {
			continue
		}
		amounts := make([]int64, len(w))
		for i, t := range w {
			amounts[i] = t.AmountFils
		}
		amount, stepped, amountOK := stableAmount(amounts, DefaultTolerancePct)
		if !amountOK {
			continue
		}
		return w, interval, amount, stepped, true
	}
	return nil, 0, 0, false, false
}

// stableInterval returns the canonical interval of a chronological window:
// the lower-median gap, snapped to a canonical cadence when within its band,
// accepted only when every gap sits within ±intervalTolDays of it.
func stableInterval(window []Txn) (int64, bool) {
	gaps := make([]int64, 0, len(window)-1)
	for i := 1; i < len(window); i++ {
		gaps = append(gaps, daysBetween(window[i-1].PostedAt, window[i].PostedAt))
	}
	sorted := make([]int64, len(gaps))
	copy(sorted, gaps)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i] < sorted[j] })
	median := sorted[(len(sorted)-1)/2] // lower median: deterministic, integer
	target := median
	for _, c := range cadences {
		d := median - c
		if d < 0 {
			d = -d
		}
		if d <= intervalTolDays(c) {
			target = c
			break
		}
	}
	if target < minIntervalDays {
		return 0, false
	}
	tol := intervalTolDays(target)
	for _, g := range gaps {
		d := g - target
		if d < 0 {
			d = -d
		}
		if d > tol {
			return 0, false
		}
	}
	return target, true
}

// stableAmount judges a chronological amount series. Outcomes:
//   - all amounts within ±tolPct of the latest → stable, amount = latest.
//   - a trailing run of ≥2 at a new level with a stable run before it → the
//     price shifted and stayed (subscription creep): amount = latest,
//     stepped = true.
//   - a lone trailing outlier after an otherwise stable series of ≥
//     MinOccurrences → one-off anomaly, tolerated: amount = the stable level.
//   - anything else → not a recurring amount.
func stableAmount(amounts []int64, tolPct int64) (amount int64, stepped, ok bool) {
	last := amounts[len(amounts)-1]
	suffix := 1
	for i := len(amounts) - 2; i >= 0 && withinPct(amounts[i], last, tolPct); i-- {
		suffix++
	}
	if suffix == len(amounts) {
		return last, false, true
	}
	prefix := amounts[:len(amounts)-suffix]
	ref := prefix[len(prefix)-1]
	prefixStable := true
	for _, a := range prefix {
		if !withinPct(a, ref, tolPct) {
			prefixStable = false
			break
		}
	}
	if suffix >= 2 && prefixStable {
		return last, true, true
	}
	if suffix == 1 && prefixStable && len(prefix) >= MinOccurrences {
		return ref, false, true
	}
	return 0, false, false
}

// modeCategory returns the most frequent non-nil category in the window
// (ties broken by the smaller category id), or nil when uncategorized.
func modeCategory(window []Txn) *int64 {
	counts := make(map[int64]int)
	for _, t := range window {
		if t.CategoryID != nil {
			counts[*t.CategoryID]++
		}
	}
	var best int64
	bestN := 0
	for id, n := range counts {
		if n > bestN || (n == bestN && bestN > 0 && id < best) {
			best, bestN = id, n
		}
	}
	if bestN == 0 {
		return nil
	}
	return &best
}

func provenanceFor(window []Txn, amounts []int64, stepped bool) Provenance {
	var sum int64
	for i := 1; i < len(window); i++ {
		sum += daysBetween(window[i-1].PostedAt, window[i].PostedAt)
	}
	n := int64(len(window) - 1)
	ids := make([]int64, len(window))
	for i, t := range window {
		ids[i] = t.ID
	}
	lastAmounts := amounts
	if len(lastAmounts) > 6 {
		lastAmounts = lastAmounts[len(lastAmounts)-6:]
	}
	return Provenance{
		Count:           len(window),
		AvgIntervalDays: (sum + n/2) / n,
		LastAmountsFils: append([]int64(nil), lastAmounts...),
		TxIDs:           ids,
		PriceStepped:    stepped,
	}
}
