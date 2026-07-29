package recur

import (
	"encoding/json"
	"time"

	"ledger/internal/store"
)

// Store is the slice of *store.Store the runner needs. Narrow on purpose so
// tests can fake it and the runner stays behind the store boundary.
type Store interface {
	SelectScheduled(statuses ...string) ([]store.ScheduledTxnRow, error)
	SelectScheduledByID(id int64) (store.ScheduledTxnRow, bool, error)
	ScheduledMerchantSet() (map[string]bool, error)
	InsertScheduled(r store.ScheduledTxnRow) (int64, error)
	MarkScheduledMatched(id, txID int64, matchedAt time.Time, amountFils int64) error
	MarkScheduledMissed(id int64) error
	RearmScheduledNextDue(id int64, nextDue string) error
	SelectConfirmedForRecur() ([]store.RecurTxn, error)
	SelectRecurTxnsBetween(from, to time.Time) ([]store.RecurTxn, error)
}

// Runner glues the pure detect/match/sweep functions to the store. It holds no
// state of its own: matching is window-based off each schedule's next_due, so
// it is restart-safe and re-runs are idempotent (a matched transaction moves
// the window past itself).
type Runner struct {
	st         Store
	onDetected func(store.ScheduledTxnRow)
	onMissed   func(store.ScheduledTxnRow)
}

func NewRunner(st Store) *Runner { return &Runner{st: st} }

// SetOnDetected registers a hook fired once per newly proposed schedule —
// the seam for the schedule_detected SSE/push event.
func (r *Runner) SetOnDetected(fn func(store.ScheduledTxnRow)) { r.onDetected = fn }

// SetOnMissed registers a hook fired once per newly missed schedule —
// the seam for the missed_bill SSE/push event.
func (r *Runner) SetOnMissed(fn func(store.ScheduledTxnRow)) { r.onMissed = fn }

// maxMatchPasses bounds the match loop: each pass advances at least one
// schedule by one interval, so this caps a single hook run at three years of
// monthly backfill — far beyond any realistic reprocess batch.
const maxMatchPasses = 36

// PostProcess runs matching, sweeping, then re-arming over the active
// schedules — called from the ingest post-process hook after the parse
// cascade, and after reprocess. Matching first: a bill that arrived in this
// batch must never be flagged missed by the sweep that follows it, and a
// reprocess backfilling months of one bill must advance through every
// occurrence BEFORE re-arm could jump past them. Matching repeats until a
// pass finds nothing, because each match advances next_due and a reprocess
// can backfill several occurrences of the same bill in one batch.
//
// The sweep runs against the POST-MATCH, PRE-REARM due dates: a schedule
// still past next_due + grace at this point genuinely missed its cycle — the
// email never arrived. Sweeping after re-arm instead would silently swallow
// exactly the downtime case the missed flag exists for: RearmStale advances
// next_due onto the next cadence date, and whenever the runner's first pass
// after an outage lands inside the new cycle's grace window (a wide window —
// for a weekly bill a 2-day outage suffices) the miss would never be flagged
// and no missed_bill event would ever fire.
//
// Schedules still stale after matching (a fully-missed cycle) are then
// re-armed onto their next cadence date (RearmStale) and matched once more,
// so auto-matching is never permanently dead for a bill whose email failed
// once. A match inside the re-armed window clears the missed flag — it pays
// a LATER cycle, and any missed_bill already fired in this run correctly
// reported the cycle nothing arrived for.
func (r *Runner) PostProcess(now time.Time) error {
	rows, err := r.st.SelectScheduled("active")
	if err != nil {
		return err
	}
	if len(rows) == 0 {
		return nil
	}

	schedules := make([]Schedule, 0, len(rows))
	// A transaction that already paid some schedule must not pay another one.
	taken := make(map[int64]bool)
	for _, row := range rows {
		due, perr := time.Parse("2006-01-02", row.NextDue)
		if perr != nil {
			continue // store validates next_due; never let one bad row stall the pipeline
		}
		schedules = append(schedules, Schedule{
			ID:                 row.ID,
			NormalizedMerchant: row.NormalizedMerchant,
			AmountFils:         row.AmountFils,
			TolerancePct:       row.TolerancePct,
			IntervalDays:       row.IntervalDays,
			NextDue:            due,
			Direction:          row.Direction,
			Missed:             row.Missed,
		})
		if row.LastMatchedTxID != nil {
			taken[*row.LastMatchedTxID] = true
		}
	}
	if len(schedules) == 0 {
		return nil
	}

	matchLoop := func() error {
		for pass := 0; pass < maxMatchPasses; pass++ {
			matched, merr := r.matchPass(schedules, taken)
			if merr != nil {
				return merr
			}
			if matched == 0 {
				return nil
			}
		}
		return nil
	}
	if err := matchLoop(); err != nil {
		return err
	}

	// Sweep BEFORE re-arm (see the function comment): anything unmatched and
	// past grace right now missed its cycle for real, however far in the past
	// re-arm is about to move next_due.
	for _, id := range Sweep(now, schedules) {
		if err := r.st.MarkScheduledMissed(id); err != nil {
			return err
		}
		for i := range schedules {
			if schedules[i].ID == id {
				schedules[i].Missed = true
				break
			}
		}
		if r.onMissed != nil {
			if row, ok, rerr := r.st.SelectScheduledByID(id); rerr == nil && ok {
				r.onMissed(row)
			}
		}
	}

	if rearms := RearmStale(now, schedules); len(rearms) > 0 {
		for _, ra := range rearms {
			if err := r.st.RearmScheduledNextDue(ra.ID, ra.NextDue.Format("2006-01-02")); err != nil {
				return err
			}
			for i := range schedules {
				if schedules[i].ID == ra.ID {
					schedules[i].NextDue = ra.NextDue
					break
				}
			}
		}
		// A bill that arrived in this batch may now sit inside the re-armed
		// window; catch it immediately instead of waiting for the next sync.
		if err := matchLoop(); err != nil {
			return err
		}
	}
	return nil
}

// matchPass fetches the candidate transactions spanning every schedule's
// current match window, matches them, and advances the matched schedules both
// in the store and in the in-memory slice (so the caller's next pass and the
// final sweep see post-match due dates). Returns how many matches it made.
func (r *Runner) matchPass(schedules []Schedule, taken map[int64]bool) (int, error) {
	// One candidate query spanning every schedule's window; Match applies the
	// exact per-schedule window itself.
	from, to := schedules[0].NextDue, schedules[0].NextDue
	for _, s := range schedules {
		if lo := s.NextDue.AddDate(0, 0, -int(earlyWindowDays(s.IntervalDays))); lo.Before(from) {
			from = lo
		}
		if hi := s.NextDue.AddDate(0, 0, int(lateWindowDays(s.IntervalDays))); hi.After(to) {
			to = hi
		}
	}
	txns, err := r.st.SelectRecurTxnsBetween(from, to)
	if err != nil {
		return 0, err
	}
	matched := 0
	for _, t := range txns {
		if taken[t.ID] {
			continue
		}
		sid, ok := Match(Txn{
			ID:         t.ID,
			PostedAt:   t.PostedAt,
			AmountFils: t.AmountFils,
			Merchant:   t.Merchant,
			Direction:  t.Direction,
		}, schedules)
		if !ok {
			continue
		}
		if err := r.st.MarkScheduledMatched(sid, t.ID, t.PostedAt, t.AmountFils); err != nil {
			return matched, err
		}
		taken[t.ID] = true
		matched++
		for i := range schedules {
			if schedules[i].ID == sid {
				schedules[i].NextDue = dayOf(t.PostedAt).AddDate(0, 0, int(schedules[i].IntervalDays))
				schedules[i].Missed = false
				break
			}
		}
	}
	return matched, nil
}

// DetectAndPropose mines confirmed history and inserts any new patterns as
// proposed schedules (source=detected) with JSON provenance. Merchants that
// already have a schedule in any status — including dismissed — are never
// re-proposed. Returns how many proposals were created.
func (r *Runner) DetectAndPropose(now time.Time) (int, error) {
	existing, err := r.st.ScheduledMerchantSet()
	if err != nil {
		return 0, err
	}
	history, err := r.st.SelectConfirmedForRecur()
	if err != nil {
		return 0, err
	}
	txns := make([]Txn, len(history))
	for i, t := range history {
		txns[i] = Txn{
			ID:         t.ID,
			PostedAt:   t.PostedAt,
			AmountFils: t.AmountFils,
			Merchant:   t.Merchant,
			Direction:  t.Direction,
			CategoryID: t.CategoryID,
		}
	}
	created := 0
	for _, p := range Detect(now, txns, existing) {
		prov, jerr := json.Marshal(p.Provenance)
		if jerr != nil {
			return created, jerr
		}
		row := store.ScheduledTxnRow{
			NormalizedMerchant: p.NormalizedMerchant,
			AmountFils:         p.AmountFils,
			TolerancePct:       p.TolerancePct,
			IntervalDays:       p.IntervalDays,
			NextDue:            p.NextDue.Format("2006-01-02"),
			Direction:          p.Direction,
			CategoryID:         p.CategoryID,
			Source:             "detected",
			Provenance:         string(prov),
		}
		id, ierr := r.st.InsertScheduled(row)
		if ierr != nil {
			return created, ierr
		}
		created++
		if r.onDetected != nil {
			if full, ok, rerr := r.st.SelectScheduledByID(id); rerr == nil && ok {
				r.onDetected(full)
			}
		}
	}
	return created, nil
}
