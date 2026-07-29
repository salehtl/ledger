// Package recur owns recurring-transaction intelligence: mining confirmed
// transaction history for recurring merchants (Detect), matching arriving
// transactions to active schedules (Match), and flagging bills whose expected
// email never arrived (Sweep).
//
// Everything in detect.go/match.go/sweep.go is pure, deterministic code — no
// AI, no randomness, no wall clock (callers pass now). The Runner in runner.go
// is the thin store-backed shell that cmd/ledger wires into the ingest
// post-process path. All money is int64 AED fils; all tolerance math is
// integer percent points.
package recur

import (
	"strings"
	"time"
)

// Txn is the minimal transaction view the detector and matcher need.
// AmountFils is AED fils (the store's amount_aed snapshot, falling back to the
// raw amount).
type Txn struct {
	ID         int64
	PostedAt   time.Time
	AmountFils int64
	Merchant   string // raw merchant string; normalized internally
	Direction  string // "debit" | "credit"
	CategoryID *int64
}

// Schedule is the minimal active-schedule view the matcher and sweeper need.
// NextDue is a UTC-midnight date.
type Schedule struct {
	ID                 int64
	NormalizedMerchant string
	AmountFils         int64
	TolerancePct       int64 // ± percent points for price-change flagging
	IntervalDays       int64
	NextDue            time.Time
	Direction          string
	Missed             bool
}

// Normalize is the canonical merchant key: lowercased with interior whitespace
// collapsed — the same normalization the transaction fingerprint uses, and
// byte-identical to the collapse store.validateScheduled applies to stored
// scheduled_transactions merchants (duplicated there because store cannot
// import recur), so stored schedules always compare equal to this key.
func Normalize(merchant string) string {
	return strings.ToLower(strings.Join(strings.Fields(merchant), " "))
}

// dayOf truncates a timestamp to its UTC calendar day.
func dayOf(t time.Time) time.Time {
	y, m, d := t.UTC().Date()
	return time.Date(y, m, d, 0, 0, 0, 0, time.UTC)
}

// daysBetween returns b − a in whole days, both truncated to UTC dates.
func daysBetween(a, b time.Time) int64 {
	return int64(dayOf(b).Sub(dayOf(a)) / (24 * time.Hour))
}

// clampInt64 bounds v to [lo, hi].
func clampInt64(v, lo, hi int64) int64 {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

// withinPct reports whether a is within ±pct percent points of ref
// (integer math only; ref must be > 0).
func withinPct(a, ref, pct int64) bool {
	d := a - ref
	if d < 0 {
		d = -d
	}
	return d*100 <= ref*pct
}

// intervalTolDays is the ±20% stability band for an interval, floored at 2
// days (posting jitter exists even for weekly bills) and capped at 45 (an
// annual bill more than ~6 weeks off cadence is not the same bill).
func intervalTolDays(interval int64) int64 {
	return clampInt64(interval*20/100, 2, 45)
}

// earlyWindowDays is how many days before next_due a matching transaction may
// arrive (bills post early; annual renewals bill weeks ahead).
func earlyWindowDays(interval int64) int64 {
	return clampInt64(interval/4, 2, 10)
}

// lateWindowDays is how many days after next_due a matching transaction may
// still arrive. Deliberately wider than GraceDays so a bill flagged missed is
// un-flagged when its email finally shows up.
func lateWindowDays(interval int64) int64 {
	return clampInt64(interval/2, 3, 45)
}

// GraceDays is how long past next_due a schedule waits before Sweep flags it
// missed: a tenth of the interval, between 2 and 7 days.
func GraceDays(interval int64) int64 {
	return clampInt64(interval/10, 2, 7)
}
