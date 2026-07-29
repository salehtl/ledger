// Age of money (v3 reports): FIFO days between income fils arriving and being
// spent. Pure integer/date math over the store's confirmed cashflow stream.
package budget

import (
	"time"

	"ledger/internal/store"
)

// ageSampleSize is how many recent spends the age average runs over (YNAB's
// last-10 convention).
const ageSampleSize = 10

// AgeOfMoney walks the chronological cashflow stream (income credits fill a
// FIFO pool of dated fils; spending debits drain it oldest-first) and returns
// the average age, in whole days, of the last ten funded spends — where a
// spend's age is the days between the arrival of the income lot that funded
// its final fil and the spend itself. Spends that hit an empty pool (spending
// before any income was ever recorded) are skipped, not aged at zero.
// sample is how many spends the average covers; 0 means no funded spends yet
// (days is 0 then).
func AgeOfMoney(flows []store.CashflowTxn) (days int64, sample int) {
	type lot struct {
		at        time.Time
		remaining int64
	}
	var pool []lot
	var ages []int64
	for _, f := range flows {
		if f.AmountFils <= 0 {
			continue
		}
		if f.IsIncome {
			pool = append(pool, lot{at: f.PostedAt, remaining: f.AmountFils})
			continue
		}
		remaining := f.AmountFils
		funded := false
		var lastLotAt time.Time
		for remaining > 0 && len(pool) > 0 {
			l := &pool[0]
			take := min(l.remaining, remaining)
			l.remaining -= take
			remaining -= take
			funded = true
			lastLotAt = l.at
			if l.remaining == 0 {
				pool = pool[1:]
			}
		}
		if !funded {
			continue
		}
		ages = append(ages, wholeDaysBetween(lastLotAt, f.PostedAt))
		if len(ages) > ageSampleSize {
			ages = ages[1:]
		}
	}
	if len(ages) == 0 {
		return 0, 0
	}
	var sum int64
	for _, a := range ages {
		sum += a
	}
	return sum / int64(len(ages)), len(ages)
}

// wholeDaysBetween is b − a in whole days, both truncated to UTC calendar
// days; never negative (out-of-order same-day noise clamps to 0).
func wholeDaysBetween(a, b time.Time) int64 {
	ay, am, ad := a.UTC().Date()
	by, bm, bd := b.UTC().Date()
	d := int64(time.Date(by, bm, bd, 0, 0, 0, 0, time.UTC).
		Sub(time.Date(ay, am, ad, 0, 0, 0, 0, time.UTC)) / (24 * time.Hour))
	return max(d, 0)
}
