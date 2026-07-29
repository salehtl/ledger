package recur

import (
	"sort"
	"time"
)

// Sweep returns the ids of schedules whose next_due + grace has passed with no
// match — the expected email never arrived, which only an always-on ingest
// stream can notice. Already-missed schedules are skipped (the flag is sticky
// until a match clears it). Output is sorted ascending for determinism.
func Sweep(now time.Time, schedules []Schedule) []int64 {
	today := dayOf(now)
	var out []int64
	for _, s := range schedules {
		if s.Missed {
			continue
		}
		if daysBetween(s.NextDue, today) > GraceDays(s.IntervalDays) {
			out = append(out, s.ID)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	return out
}

// Rearm is one schedule whose stale next_due should jump forward to NextDue.
type Rearm struct {
	ID      int64
	NextDue time.Time
}

// RearmStale keeps a schedule matchable after a fully-missed cycle. Once
// next_due falls more than lateWindowDays behind today, no future arrival can
// EVER match (lateWindowDays < interval for every cadence, so each later
// on-cadence occurrence posts at offset ≥ interval > the late window) — the
// schedule would sit missed/overdue forever with auto-matching silently dead.
// For each such schedule, advance next_due by whole intervals — preserving the
// bill's original cadence phase — until it lands back inside the late window
// (the first cycle date d with daysBetween(d, today) ≤ lateWindowDays), so the
// next natural occurrence can match again. The missed flag is NOT touched:
// the bill genuinely went missing and stays flagged until a match clears it.
// Output is sorted by id for determinism.
func RearmStale(now time.Time, schedules []Schedule) []Rearm {
	today := dayOf(now)
	var out []Rearm
	for _, s := range schedules {
		if s.IntervalDays <= 0 {
			continue // store validates; never loop on a corrupt row
		}
		late := lateWindowDays(s.IntervalDays)
		if daysBetween(s.NextDue, today) <= late {
			continue
		}
		due := s.NextDue
		for daysBetween(due, today) > late {
			due = due.AddDate(0, 0, int(s.IntervalDays))
		}
		out = append(out, Rearm{ID: s.ID, NextDue: due})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}
