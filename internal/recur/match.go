package recur

// matchBandPctFloor is the loosest amount band matching will accept ON OR
// AFTER next_due. Matching there is deliberately looser than the schedule's
// own tolerance: a subscription whose price crept 30% must still MATCH so the
// store can flag price_change — the strict TolerancePct band is for flagging,
// not finding. Anything more than ±50% off is treated as an unrelated
// purchase at the same merchant.
//
// BEFORE next_due only the schedule's own TolerancePct band applies. The
// early window exists for bills that post a few days ahead; giving it the
// loose band lets any same-merchant one-off purchase (amazon.ae, noon,
// careem…) land days before the real bill and permanently steal the match —
// corrupting next_due off-cycle and raising a false price_change the real
// bill can no longer clear.
const matchBandPctFloor = 50

// Match picks the schedule an arriving transaction pays, or ok=false. A
// candidate must agree on normalized merchant and direction, post within
// [next_due − early, next_due + late] of the schedule's cadence windows, and
// land within the amount band for its side of next_due (tolerance-strict
// early, loose on/late — see matchBandPctFloor). Among candidates the winner
// is the closest amount, then the closest date, then the lowest schedule id —
// fully deterministic.
func Match(tx Txn, schedules []Schedule) (scheduleID int64, ok bool) {
	merchant := Normalize(tx.Merchant)
	if merchant == "" || tx.AmountFils <= 0 {
		return 0, false
	}
	day := dayOf(tx.PostedAt)

	type candidate struct {
		id         int64
		amountDiff int64
		dateDiff   int64
	}
	var best *candidate
	for _, s := range schedules {
		if s.NormalizedMerchant != merchant || s.Direction != tx.Direction {
			continue
		}
		offset := daysBetween(s.NextDue, day) // negative = early
		if offset < -earlyWindowDays(s.IntervalDays) || offset > lateWindowDays(s.IntervalDays) {
			continue
		}
		band := s.TolerancePct
		if offset >= 0 && band < matchBandPctFloor {
			band = matchBandPctFloor
		}
		if !withinPct(tx.AmountFils, s.AmountFils, band) {
			continue
		}
		amountDiff := tx.AmountFils - s.AmountFils
		if amountDiff < 0 {
			amountDiff = -amountDiff
		}
		dateDiff := offset
		if dateDiff < 0 {
			dateDiff = -dateDiff
		}
		c := candidate{id: s.ID, amountDiff: amountDiff, dateDiff: dateDiff}
		if best == nil ||
			c.amountDiff < best.amountDiff ||
			(c.amountDiff == best.amountDiff && c.dateDiff < best.dateDiff) ||
			(c.amountDiff == best.amountDiff && c.dateDiff == best.dateDiff && c.id < best.id) {
			best = &c
		}
	}
	if best == nil {
		return 0, false
	}
	return best.id, true
}

// MatchRescue gives MISSED schedules a second, wider shot at an off-phase
// arrival. Normal matching accepts [next_due − early, next_due + late]; a bill
// whose billing phase permanently shifted by more than the late window but
// less than interval − early (a failed charge retried ~20 days later, with
// renewals billing from the new date) lands in a dead zone forever: RearmStale
// preserves the ORIGINAL phase, so every future arrival sits earlier than the
// early window of the re-armed due date and never matches, while the schedule
// stays flagged missed and — being in ScheduledMerchantSet — is never
// re-proposed either. Rescue accepts an arrival anywhere in the cycle BEFORE
// next_due (offset −(interval−1)…−1) but only for schedules already flagged
// missed (a genuine cycle passed with nothing) and only within the schedule's
// own STRICT tolerance band — never the loose matchBandPctFloor — so a
// same-merchant one-off purchase cannot casually hijack the phase. The caller
// re-phases via MarkScheduledMatched (next_due = arrival + interval), exactly
// like a normal match. Winner selection is the same deterministic
// amount-then-date-then-id order Match uses.
func MatchRescue(tx Txn, schedules []Schedule) (scheduleID int64, ok bool) {
	merchant := Normalize(tx.Merchant)
	if merchant == "" || tx.AmountFils <= 0 {
		return 0, false
	}
	day := dayOf(tx.PostedAt)

	type candidate struct {
		id         int64
		amountDiff int64
		dateDiff   int64
	}
	var best *candidate
	for _, s := range schedules {
		if !s.Missed || s.IntervalDays <= 0 {
			continue
		}
		if s.NormalizedMerchant != merchant || s.Direction != tx.Direction {
			continue
		}
		offset := daysBetween(s.NextDue, day) // negative = early
		if offset < -(s.IntervalDays-1) || offset > -1 {
			continue
		}
		if !withinPct(tx.AmountFils, s.AmountFils, s.TolerancePct) {
			continue
		}
		amountDiff := tx.AmountFils - s.AmountFils
		if amountDiff < 0 {
			amountDiff = -amountDiff
		}
		c := candidate{id: s.ID, amountDiff: amountDiff, dateDiff: -offset}
		if best == nil ||
			c.amountDiff < best.amountDiff ||
			(c.amountDiff == best.amountDiff && c.dateDiff < best.dateDiff) ||
			(c.amountDiff == best.amountDiff && c.dateDiff == best.dateDiff && c.id < best.id) {
			best = &c
		}
	}
	if best == nil {
		return 0, false
	}
	return best.id, true
}
