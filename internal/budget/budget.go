// Package budget computes 50/30/20 jar rollups from confirmed spending (§6.5).
// It is pure: callers fetch config + rows from the store and pass a clock.
package budget

import (
	"time"

	"ledger/internal/store"
)

// BucketSummary is one jar's state for the period.
type BucketSummary struct {
	Bucket     string  `json:"bucket"`
	Target     int64   `json:"target"`
	Spent      int64   `json:"spent"`
	Remaining  int64   `json:"remaining"`
	PctUsed    float64 `json:"pct_used"`
	Projection int64   `json:"projection"`
}

// Summary is the full dashboard payload (§6.7 GET /api/summary).
type Summary struct {
	Period        string             `json:"period"`
	Income        int64              `json:"income"`
	MonthProgress float64            `json:"month_progress"`
	Buckets       []BucketSummary    `json:"buckets"`
	Recent        []store.ReviewItem `json:"recent"`
}

// buckets are always reported in this fixed order.
var bucketOrder = []string{"need", "want", "saving"}

// Compute rolls spend rows into jars for the month of now. income is already
// resolved by the caller (config figure or summed income categories).
func Compute(cfg store.BudgetConfig, income int64, spend []store.SpendRow, recent []store.ReviewItem, now time.Time) Summary {
	pct := map[string]float64{"need": cfg.NeedPct, "want": cfg.WantPct, "saving": cfg.SavingPct}

	net := map[string]int64{}
	for _, r := range spend {
		switch r.Direction {
		case "debit":
			net[r.Bucket] += r.AmountFils
		case "credit":
			net[r.Bucket] -= r.AmountFils
		}
	}

	progress := monthProgress(now)
	out := Summary{
		Period:        now.Format("2006-01"),
		Income:        income,
		MonthProgress: progress,
		Recent:        recent,
	}
	for _, name := range bucketOrder {
		target := int64(float64(income) * pct[name])
		spent := net[name]
		b := BucketSummary{
			Bucket:    name,
			Target:    target,
			Spent:     spent,
			Remaining: target - spent,
		}
		if target > 0 {
			b.PctUsed = float64(spent) / float64(target)
		}
		if progress > 0 {
			b.Projection = int64(float64(spent) / progress)
		} else {
			b.Projection = spent
		}
		out.Buckets = append(out.Buckets, b)
	}
	return out
}

// monthProgress is the fraction of the current month elapsed (day / daysInMonth).
func monthProgress(now time.Time) float64 {
	year, month, _ := now.Date()
	firstNext := time.Date(year, month, 1, 0, 0, 0, 0, now.Location()).AddDate(0, 1, 0)
	daysInMonth := firstNext.AddDate(0, 0, -1).Day()
	return float64(now.Day()) / float64(daysInMonth)
}
