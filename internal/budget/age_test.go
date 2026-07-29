package budget

import (
	"testing"
	"time"

	"ledger/internal/store"
)

func day(d int) time.Time {
	return time.Date(2026, 7, d, 10, 0, 0, 0, time.UTC)
}

func income(d int, fils int64) store.CashflowTxn {
	return store.CashflowTxn{PostedAt: day(d), AmountFils: fils, IsIncome: true}
}

func spend(d int, fils int64) store.CashflowTxn {
	return store.CashflowTxn{PostedAt: day(d), AmountFils: fils}
}

func TestAgeOfMoney(t *testing.T) {
	tests := []struct {
		name       string
		flows      []store.CashflowTxn
		wantDays   int64
		wantSample int
	}{
		{"no flows", nil, 0, 0},
		{"income only", []store.CashflowTxn{income(1, 100)}, 0, 0},
		{"spend before any income is skipped", []store.CashflowTxn{spend(1, 100), income(2, 100)}, 0, 0},
		{
			"single funded spend ages from its lot",
			[]store.CashflowTxn{income(1, 500), spend(11, 100)},
			10, 1,
		},
		{
			"fifo: second spend still draws the old lot",
			[]store.CashflowTxn{income(1, 200), income(5, 200), spend(11, 100), spend(12, 100)},
			// both spends fully funded by the day-1 lot → ages 10 and 11 → avg 10
			10, 2,
		},
		{
			"spend spanning lots ages from the lot funding its final fil",
			[]store.CashflowTxn{income(1, 100), income(10, 100), spend(11, 150)},
			// 100 from day 1, 50 from day 10 → age = 11−10 = 1
			1, 1,
		},
		{
			"pool exhaustion: only funded spends count",
			[]store.CashflowTxn{
				income(1, 1000),
				spend(2, 100), spend(3, 100), spend(4, 100), spend(5, 100),
				spend(6, 100), spend(7, 100), spend(8, 100), spend(9, 100),
				spend(10, 100), spend(11, 100), spend(12, 100), spend(13, 100),
			},
			// days 2..11 drain the day-1 lot (ages 1..10, avg 5.5 → 5);
			// days 12–13 hit an empty pool and are skipped.
			5, 10,
		},
		{
			"overdrawn pool: funded portion still ages, rest ignored",
			[]store.CashflowTxn{income(1, 100), spend(6, 300)},
			5, 1,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			days, sample := AgeOfMoney(tc.flows)
			if days != tc.wantDays || sample != tc.wantSample {
				t.Errorf("AgeOfMoney = (%d, %d), want (%d, %d)", days, sample, tc.wantDays, tc.wantSample)
			}
		})
	}
}
