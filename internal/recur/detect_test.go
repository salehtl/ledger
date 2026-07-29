package recur

import (
	"testing"
	"time"
)

func d(t *testing.T, s string) time.Time {
	t.Helper()
	tm, err := time.Parse("2006-01-02", s)
	if err != nil {
		t.Fatalf("bad date %q: %v", s, err)
	}
	return tm.UTC()
}

type occ struct {
	day string
	amt int64
}

// series builds a chronological txn slice for one merchant. IDs are
// startID, startID+1, …
func series(t *testing.T, startID int64, merchant, direction string, occs []occ) []Txn {
	t.Helper()
	out := make([]Txn, len(occs))
	for i, o := range occs {
		out[i] = Txn{
			ID:         startID + int64(i),
			PostedAt:   d(t, o.day).Add(9 * time.Hour), // real posting times aren't midnight
			AmountFils: o.amt,
			Merchant:   merchant,
			Direction:  direction,
		}
	}
	return out
}

type wantProposal struct {
	merchant  string
	direction string
	amount    int64
	interval  int64
	nextDue   string
	count     int
	avgDays   int64
	stepped   bool
}

func TestDetect(t *testing.T) {
	monthly := []occ{
		{"2026-01-05", 3_900}, {"2026-02-03", 3_900}, {"2026-03-07", 3_950},
		{"2026-04-04", 3_900}, {"2026-05-06", 3_900}, {"2026-06-03", 3_900},
	}
	cases := []struct {
		name     string
		now      string
		txns     []Txn
		existing map[string]bool
		want     []wantProposal
	}{
		{
			name: "monthly bill with ±3-day jitter",
			now:  "2026-06-20",
			txns: series(t, 1, "NETFLIX.COM Amsterdam", "debit", monthly),
			want: []wantProposal{{
				merchant: "netflix.com amsterdam", direction: "debit",
				amount: 3_900, interval: 30, nextDue: "2026-07-03",
				count: 6, avgDays: 30,
			}},
		},
		{
			name: "annual subscription",
			now:  "2026-06-01",
			txns: series(t, 1, "iCloud Storage", "debit", []occ{
				{"2024-03-01", 120_00}, {"2025-03-01", 120_00}, {"2026-03-02", 120_00},
			}),
			want: []wantProposal{{
				merchant: "icloud storage", direction: "debit",
				amount: 120_00, interval: 365, nextDue: "2027-03-02",
				count: 3, avgDays: 366,
			}},
		},
		{
			name: "price creep: shifted and stayed",
			now:  "2026-05-10",
			txns: series(t, 1, "Spotify", "debit", []occ{
				{"2026-01-01", 3_900}, {"2026-01-31", 3_900}, {"2026-03-02", 3_900},
				{"2026-04-01", 4_500}, {"2026-05-01", 4_500},
			}),
			want: []wantProposal{{
				merchant: "spotify", direction: "debit",
				amount: 4_500, interval: 30, nextDue: "2026-05-31",
				count: 5, avgDays: 30, stepped: true,
			}},
		},
		{
			name: "weekly needs four sightings and gets them",
			now:  "2026-06-25",
			txns: series(t, 1, "Gym Club", "debit", []occ{
				{"2026-06-01", 15_000}, {"2026-06-08", 15_000},
				{"2026-06-16", 15_000}, {"2026-06-22", 15_000},
			}),
			want: []wantProposal{{
				merchant: "gym club", direction: "debit",
				amount: 15_000, interval: 7, nextDue: "2026-06-29",
				count: 4, avgDays: 7,
			}},
		},
		{
			name: "weekly with only three sightings is not enough",
			now:  "2026-06-20",
			txns: series(t, 1, "Gym Club", "debit", []occ{
				{"2026-06-01", 15_000}, {"2026-06-08", 15_000}, {"2026-06-16", 15_000},
			}),
			want: nil,
		},
		{
			name: "near-duplicate merchants stay separate",
			now:  "2026-06-20",
			txns: append(
				series(t, 1, "salik recharge", "debit", []occ{
					{"2026-03-10", 5_000}, {"2026-04-09", 5_000}, {"2026-05-10", 5_000}, {"2026-06-09", 5_000},
				}),
				series(t, 100, "salik fine payment", "debit", []occ{
					{"2026-04-20", 40_000}, {"2026-06-02", 40_000},
				})...,
			),
			want: []wantProposal{{
				merchant: "salik recharge", direction: "debit",
				amount: 5_000, interval: 30, nextDue: "2026-07-09",
				count: 4, avgDays: 30,
			}},
		},
		{
			name: "two occurrences never propose",
			now:  "2026-06-20",
			txns: series(t, 1, "DEWA", "debit", []occ{
				{"2026-04-15", 62_000}, {"2026-05-15", 61_000},
			}),
			want: nil,
		},
		{
			name: "unstable interval never proposes",
			now:  "2026-06-20",
			txns: series(t, 1, "Random Shop", "debit", []occ{
				{"2026-01-01", 9_900}, {"2026-01-11", 9_900}, {"2026-02-25", 9_900}, {"2026-03-17", 9_900},
			}),
			want: nil,
		},
		{
			name: "unstable amounts never propose",
			now:  "2026-06-20",
			txns: series(t, 1, "Carrefour", "debit", []occ{
				{"2026-03-01", 3_900}, {"2026-03-31", 8_000}, {"2026-04-30", 2_100}, {"2026-05-30", 5_000},
			}),
			want: nil,
		},
		{
			// A one-off purchase landing mid-series on the cadence day must not
			// disqualify the merchant: the suffix search resumes past the
			// interval-stable-but-amount-unstable window and proposes from the
			// clean trailing run ([25000, 3900, 3900, 3900] reads as a settled
			// price, so the proposal is at 3900).
			name: "mid-series amount outlier still proposes the trailing run",
			now:  "2026-06-20",
			txns: series(t, 1, "Anghami", "debit", []occ{
				{"2026-01-05", 3_900}, {"2026-02-04", 3_900}, {"2026-03-06", 25_000},
				{"2026-04-05", 3_900}, {"2026-05-05", 3_900}, {"2026-06-04", 3_900},
			}),
			want: []wantProposal{{
				merchant: "anghami", direction: "debit",
				amount: 3_900, interval: 30, nextDue: "2026-07-04",
				count: 4, avgDays: 30, stepped: true,
			}},
		},
		{
			name: "lone trailing outlier keeps the stable price",
			now:  "2026-06-05",
			txns: series(t, 1, "Etisalat", "debit", []occ{
				{"2026-02-01", 30_000}, {"2026-03-03", 30_000}, {"2026-04-02", 30_000},
				{"2026-05-02", 30_000}, {"2026-06-01", 80_000},
			}),
			want: []wantProposal{{
				merchant: "etisalat", direction: "debit",
				amount: 30_000, interval: 30, nextDue: "2026-07-01",
				count: 5, avgDays: 30,
			}},
		},
		{
			name:     "existing schedule merchant is never re-proposed",
			now:      "2026-06-20",
			txns:     series(t, 1, "NETFLIX.COM Amsterdam", "debit", monthly),
			existing: map[string]bool{"netflix.com amsterdam": true},
			want:     nil,
		},
		{
			name: "dead series is not proposed",
			now:  "2026-06-20",
			txns: series(t, 1, "Old Gym", "debit", []occ{
				{"2025-11-01", 20_000}, {"2025-12-01", 20_000}, {"2026-01-01", 20_000},
			}),
			want: nil, // last sighting 170 days ago > 2×30
		},
		{
			name: "same-day repeats collapse to one sighting",
			now:  "2026-03-15",
			txns: append(
				series(t, 1, "Insurance Co", "debit", []occ{{"2026-01-05", 50_000}}),
				series(t, 2, "Insurance Co", "debit", []occ{
					{"2026-01-05", 50_000}, {"2026-02-04", 50_000}, {"2026-03-06", 50_000},
				})...,
			),
			want: []wantProposal{{
				merchant: "insurance co", direction: "debit",
				amount: 50_000, interval: 30, nextDue: "2026-04-05",
				count: 3, avgDays: 30,
			}},
		},
		{
			name: "recurring income detects as credit",
			now:  "2026-06-05",
			txns: series(t, 1, "ACME Corp Payroll", "credit", []occ{
				{"2026-03-28", 2_500_000}, {"2026-04-28", 2_500_000}, {"2026-05-28", 2_500_000},
			}),
			want: []wantProposal{{
				merchant: "acme corp payroll", direction: "credit",
				amount: 2_500_000, interval: 30, nextDue: "2026-06-27",
				count: 3, avgDays: 31,
			}},
		},
		{
			name: "irregular history that settled into a subscription",
			now:  "2026-06-20",
			txns: series(t, 1, "Amazon.ae", "debit", []occ{
				{"2025-10-03", 12_345}, {"2025-10-20", 89_900}, // noise
				{"2026-03-05", 4_900}, {"2026-04-04", 4_900}, {"2026-05-05", 4_900}, {"2026-06-04", 4_900},
			}),
			want: []wantProposal{{
				merchant: "amazon.ae", direction: "debit",
				amount: 4_900, interval: 30, nextDue: "2026-07-04",
				count: 4, avgDays: 30,
			}},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := Detect(d(t, tc.now), tc.txns, tc.existing)
			if len(got) != len(tc.want) {
				t.Fatalf("got %d proposals, want %d: %+v", len(got), len(tc.want), got)
			}
			for i, w := range tc.want {
				p := got[i]
				if p.NormalizedMerchant != w.merchant {
					t.Errorf("[%d] merchant = %q, want %q", i, p.NormalizedMerchant, w.merchant)
				}
				if p.Direction != w.direction {
					t.Errorf("[%d] direction = %q, want %q", i, p.Direction, w.direction)
				}
				if p.AmountFils != w.amount {
					t.Errorf("[%d] amount = %d, want %d", i, p.AmountFils, w.amount)
				}
				if p.IntervalDays != w.interval {
					t.Errorf("[%d] interval = %d, want %d", i, p.IntervalDays, w.interval)
				}
				if nd := p.NextDue.Format("2006-01-02"); nd != w.nextDue {
					t.Errorf("[%d] next due = %s, want %s", i, nd, w.nextDue)
				}
				if p.TolerancePct != DefaultTolerancePct {
					t.Errorf("[%d] tolerance = %d, want %d", i, p.TolerancePct, DefaultTolerancePct)
				}
				if p.Provenance.Count != w.count {
					t.Errorf("[%d] provenance count = %d, want %d", i, p.Provenance.Count, w.count)
				}
				if p.Provenance.AvgIntervalDays != w.avgDays {
					t.Errorf("[%d] avg interval = %d, want %d", i, p.Provenance.AvgIntervalDays, w.avgDays)
				}
				if p.Provenance.PriceStepped != w.stepped {
					t.Errorf("[%d] price stepped = %v, want %v", i, p.Provenance.PriceStepped, w.stepped)
				}
				if len(p.Provenance.TxIDs) != w.count {
					t.Errorf("[%d] tx ids = %v, want %d entries", i, p.Provenance.TxIDs, w.count)
				}
			}
		})
	}
}

func TestDetectDeterministicOrderAndProvenanceIDs(t *testing.T) {
	txns := append(
		series(t, 10, "beta stream", "debit", []occ{
			{"2026-03-01", 2_000}, {"2026-03-31", 2_000}, {"2026-04-30", 2_000},
		}),
		series(t, 20, "alpha stream", "debit", []occ{
			{"2026-03-02", 4_000}, {"2026-04-01", 4_000}, {"2026-05-01", 4_000},
		})...,
	)
	for run := 0; run < 5; run++ {
		got := Detect(d(t, "2026-05-10"), txns, nil)
		if len(got) != 2 || got[0].NormalizedMerchant != "alpha stream" || got[1].NormalizedMerchant != "beta stream" {
			t.Fatalf("run %d: order not deterministic: %+v", run, got)
		}
	}
	got := Detect(d(t, "2026-05-10"), txns, nil)
	wantIDs := []int64{20, 21, 22}
	for i, id := range got[0].Provenance.TxIDs {
		if id != wantIDs[i] {
			t.Fatalf("provenance tx ids = %v, want %v", got[0].Provenance.TxIDs, wantIDs)
		}
	}
	if got[0].Provenance.LastAmountsFils[0] != 4_000 {
		t.Fatalf("last amounts = %v", got[0].Provenance.LastAmountsFils)
	}
}
