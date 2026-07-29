// Budget-threshold evaluation (v3): which envelopes and jar buckets have
// crossed 80% / 100% of their budget this month. Pure — the server diffs
// successive evaluations to decide what to actually emit as budget_threshold
// SSE/push events, so a category sitting at 90% doesn't re-notify on every
// confirm.
package budget

import "ledger/internal/store"

// ThresholdCrossing is one envelope or bucket at or past a spend threshold.
// Level is 80 or 100 (percent of the limit). For envelopes the limit is what
// the month made spendable (carryover + assigned); for buckets it is the jar
// target (income × bucket pct, the jar summary's idiom). Key is the stable
// diff key ("env:<catID>" / "bucket:<name>") the server tracks state under.
type ThresholdCrossing struct {
	Key          string `json:"-"`
	Scope        string `json:"scope"` // "envelope" | "bucket"
	CategoryID   int64  `json:"category_id,omitempty"`
	Name         string `json:"name"`
	Bucket       string `json:"bucket,omitempty"`
	Level        int    `json:"level"` // 80 | 100
	ActivityFils int64  `json:"activity_fils"`
	LimitFils    int64  `json:"limit_fils"`
	Month        string `json:"month"`
}

// CurrentThresholdLevels reports every envelope and bucket currently at or
// past 80% of its limit (level 100 when activity ≥ limit, else 80 when
// activity·10 ≥ limit·8 — integer fils math). Envelopes or buckets with a
// non-positive limit or non-positive activity are never reported.
func CurrentThresholdLevels(sum EnvelopeSummary, cfg store.BudgetConfig) []ThresholdCrossing {
	var out []ThresholdCrossing

	bucketActivity := make(map[string]int64)
	for _, e := range sum.Envelopes {
		bucketActivity[e.Bucket] += e.ActivityFils
		limit := e.CarryoverFils + e.AssignedFils
		if lvl := thresholdLevel(e.ActivityFils, limit); lvl > 0 {
			out = append(out, ThresholdCrossing{
				Key:          "env:" + itoa64(e.CategoryID),
				Scope:        "envelope",
				CategoryID:   e.CategoryID,
				Name:         e.CategoryName,
				Bucket:       e.Bucket,
				Level:        lvl,
				ActivityFils: e.ActivityFils,
				LimitFils:    limit,
				Month:        sum.Month,
			})
		}
	}

	pct := bucketPcts(cfg)
	for _, bucket := range bucketOrder {
		// Same float-to-int projection the jar targets use; comparison math
		// below stays pure integer.
		limit := int64(float64(sum.IncomeFils) * pct[bucket])
		activity := bucketActivity[bucket]
		if lvl := thresholdLevel(activity, limit); lvl > 0 {
			out = append(out, ThresholdCrossing{
				Key:          "bucket:" + bucket,
				Scope:        "bucket",
				Name:         bucket,
				Bucket:       bucket,
				Level:        lvl,
				ActivityFils: activity,
				LimitFils:    limit,
				Month:        sum.Month,
			})
		}
	}
	return out
}

// thresholdLevel classifies activity against a limit: 100, 80, or 0 (below /
// not evaluable).
func thresholdLevel(activity, limit int64) int {
	if limit <= 0 || activity <= 0 {
		return 0
	}
	if activity >= limit {
		return 100
	}
	if activity*10 >= limit*8 {
		return 80
	}
	return 0
}

// itoa64 is a minimal int64 → decimal string (avoids strconv import spread).
func itoa64(v int64) string {
	if v == 0 {
		return "0"
	}
	neg := v < 0
	if neg {
		v = -v
	}
	var buf [20]byte
	i := len(buf)
	for v > 0 {
		i--
		buf[i] = byte('0' + v%10)
		v /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}
