package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"ledger/internal/budget"
	"ledger/internal/store"
)

// newEnvelopeTestServer wires a real store with a config income of 3000.00 AED
// and three bucketed spending categories.
func newEnvelopeTestServer(t *testing.T) (*Server, *store.Store, [3]int64) {
	t.Helper()
	st := newTestServerStore(t)
	if err := st.EnsureBudgetConfig(); err != nil {
		t.Fatal(err)
	}
	if err := st.UpdateBudgetConfig(store.BudgetConfig{
		MonthlyIncome: 3000_00, NeedPct: 0.5, WantPct: 0.3, SavingPct: 0.2, IncomeSource: "config",
	}); err != nil {
		t.Fatal(err)
	}
	// Deactivate the seeded default categories so the envelope list is only
	// the test's three, keeping assertions exact.
	if _, err := st.DB.Exec(`UPDATE categories SET is_active=0`); err != nil {
		t.Fatal(err)
	}
	var cats [3]int64
	cats[0] = projInsertCategory(t, st, "EnvNeed", "spending", "need")
	cats[1] = projInsertCategory(t, st, "EnvWant", "spending", "want")
	cats[2] = projInsertCategory(t, st, "EnvSave", "spending", "saving")
	srv := New(st, testFS())
	srv.SetEnvelopeStore(st)
	return srv, st, cats
}

func decodeSummary(t *testing.T, body []byte) budget.EnvelopeSummary {
	t.Helper()
	var sum budget.EnvelopeSummary
	if err := json.Unmarshal(body, &sum); err != nil {
		t.Fatalf("decode summary: %v; body: %s", err, body)
	}
	return sum
}

func TestGetEnvelopesSummary(t *testing.T) {
	srv, st, cats := newEnvelopeTestServer(t)
	if err := st.UpsertEnvelopeAssignment("2026-07", cats[0], 1000_00); err != nil {
		t.Fatal(err)
	}
	projInsertTxn(t, st, cats[0], "debit", 400_00, "2026-07-10", "confirmed")

	w := doJSON(t, srv, "GET", "/api/envelopes?month=2026-07", nil)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d; body: %s", w.Code, w.Body)
	}
	sum := decodeSummary(t, w.Body.Bytes())
	if sum.Month != "2026-07" || sum.IncomeFils != 3000_00 || sum.AssignedFils != 1000_00 {
		t.Fatalf("summary header = %+v", sum)
	}
	if sum.ReadyToAssignFils != 2000_00 {
		t.Errorf("RTA = %d, want 2000_00", sum.ReadyToAssignFils)
	}
	if len(sum.Envelopes) != 3 {
		t.Fatalf("envelopes = %d, want 3", len(sum.Envelopes))
	}
	need := sum.Envelopes[0]
	if need.CategoryID != cats[0] || need.AssignedFils != 1000_00 || need.ActivityFils != 400_00 || need.AvailableFils != 600_00 {
		t.Errorf("need envelope = %+v", need)
	}
}

func TestGetEnvelopesBadMonth(t *testing.T) {
	srv, _, _ := newEnvelopeTestServer(t)
	w := doJSON(t, srv, "GET", "/api/envelopes?month=July", nil)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", w.Code)
	}
}

func TestEnvelopesAssignBatch(t *testing.T) {
	srv, _, cats := newEnvelopeTestServer(t)
	w := doJSON(t, srv, "POST", "/api/envelopes/assign", map[string]any{
		"month": "2026-07",
		"assignments": []map[string]any{
			{"category_id": cats[0], "assigned_fils": 1500_00},
			{"category_id": cats[1], "assigned_fils": 900_00},
		},
	})
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d; body: %s", w.Code, w.Body)
	}
	sum := decodeSummary(t, w.Body.Bytes())
	if sum.AssignedFils != 2400_00 || sum.ReadyToAssignFils != 600_00 {
		t.Fatalf("assigned=%d rta=%d", sum.AssignedFils, sum.ReadyToAssignFils)
	}

	tests := []struct {
		name string
		body map[string]any
	}{
		{"no assignments", map[string]any{"month": "2026-07"}},
		{"bad month", map[string]any{"month": "nope", "assignments": []map[string]any{{"category_id": cats[0], "assigned_fils": 1}}}},
		{"negative amount", map[string]any{"month": "2026-07", "assignments": []map[string]any{{"category_id": cats[0], "assigned_fils": -5}}}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			w := doJSON(t, srv, "POST", "/api/envelopes/assign", tc.body)
			if w.Code != http.StatusBadRequest {
				t.Errorf("status = %d, want 400; body: %s", w.Code, w.Body)
			}
		})
	}
}

func TestEnvelopesMove(t *testing.T) {
	srv, st, cats := newEnvelopeTestServer(t)
	if err := st.UpsertEnvelopeAssignment("2026-07", cats[0], 1000_00); err != nil {
		t.Fatal(err)
	}
	w := doJSON(t, srv, "POST", "/api/envelopes/move", map[string]any{
		"month": "2026-07", "from_category_id": cats[0], "to_category_id": cats[1], "amount_fils": 400_00,
	})
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d; body: %s", w.Code, w.Body)
	}
	sum := decodeSummary(t, w.Body.Bytes())
	byCat := map[int64]int64{}
	for _, e := range sum.Envelopes {
		byCat[e.CategoryID] = e.AssignedFils
	}
	if byCat[cats[0]] != 600_00 || byCat[cats[1]] != 400_00 {
		t.Fatalf("after move: from=%d to=%d", byCat[cats[0]], byCat[cats[1]])
	}
	if sum.AssignedFils != 1000_00 {
		t.Errorf("total assigned changed by move: %d", sum.AssignedFils)
	}

	tests := []struct {
		name string
		body map[string]any
	}{
		{"zero amount", map[string]any{"month": "2026-07", "from_category_id": cats[0], "to_category_id": cats[1], "amount_fils": 0}},
		{"same category", map[string]any{"month": "2026-07", "from_category_id": cats[0], "to_category_id": cats[0], "amount_fils": 100}},
		{"bad month", map[string]any{"month": "x", "from_category_id": cats[0], "to_category_id": cats[1], "amount_fils": 100}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			w := doJSON(t, srv, "POST", "/api/envelopes/move", tc.body)
			if w.Code != http.StatusBadRequest {
				t.Errorf("status = %d, want 400; body: %s", w.Code, w.Body)
			}
		})
	}
}

func TestEnvelopesAutoAssign(t *testing.T) {
	srv, st, cats := newEnvelopeTestServer(t)
	// A target on the need envelope is funded first; the leftover seeds all
	// three buckets pro-rata.
	if err := st.UpsertCategoryTarget(store.CategoryTargetRow{
		CategoryID: cats[0], EffectiveMonth: "2026-07", TargetType: "set_aside", AmountFils: 500_00,
	}); err != nil {
		t.Fatal(err)
	}
	w := doJSON(t, srv, "POST", "/api/envelopes/auto-assign", map[string]any{"month": "2026-07"})
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d; body: %s", w.Code, w.Body)
	}
	var resp struct {
		Allocations []budget.Allocation    `json:"allocations"`
		Summary     budget.EnvelopeSummary `json:"summary"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	var total int64
	for _, a := range resp.Allocations {
		total += a.AmountFils
	}
	if total != 3000_00 {
		t.Fatalf("allocations sum = %d, want full RTA 3000_00; %+v", total, resp.Allocations)
	}
	if resp.Summary.ReadyToAssignFils != 0 {
		t.Errorf("post-assign RTA = %d, want 0", resp.Summary.ReadyToAssignFils)
	}
	if resp.Summary.AssignedFils != 3000_00 {
		t.Errorf("post-assign total = %d, want 3000_00", resp.Summary.AssignedFils)
	}
	// The target got at least its ask.
	for _, e := range resp.Summary.Envelopes {
		if e.CategoryID == cats[0] && e.AssignedFils < 500_00 {
			t.Errorf("target envelope assigned %d < target 500_00", e.AssignedFils)
		}
	}

	// A second auto-assign with RTA now 0 allocates nothing.
	w = doJSON(t, srv, "POST", "/api/envelopes/auto-assign", map[string]any{"month": "2026-07"})
	if w.Code != http.StatusOK {
		t.Fatalf("second status = %d", w.Code)
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if len(resp.Allocations) != 0 {
		t.Errorf("second run allocations = %+v, want none", resp.Allocations)
	}
}

// TestEnvelopesRejectNonEnvelopeCategories: assign/move against categories the
// summary can never surface (income kind, inactive, unknown) must 400 — a 200
// whose money silently disappears from RTA is the bug this guards against.
func TestEnvelopesRejectNonEnvelopeCategories(t *testing.T) {
	srv, st, cats := newEnvelopeTestServer(t)
	salary := projInsertCategory(t, st, "EnvIncomeCat", "income", "")
	inactive, err := st.InsertCategory(store.CategoryRow{Name: "EnvInactiveCat", Kind: "spending", Bucket: "want", IsActive: false})
	if err != nil {
		t.Fatal(err)
	}
	if err := st.UpsertEnvelopeAssignment("2026-07", cats[0], 1000_00); err != nil {
		t.Fatal(err)
	}

	for name, target := range map[string]int64{"income kind": salary, "inactive": inactive, "unknown": 999999} {
		t.Run("assign "+name, func(t *testing.T) {
			w := doJSON(t, srv, "POST", "/api/envelopes/assign", map[string]any{
				"month":       "2026-07",
				"assignments": []map[string]any{{"category_id": target, "assigned_fils": 500_00}},
			})
			if w.Code != http.StatusBadRequest {
				t.Errorf("status = %d, want 400; body: %s", w.Code, w.Body)
			}
		})
		t.Run("move to "+name, func(t *testing.T) {
			w := doJSON(t, srv, "POST", "/api/envelopes/move", map[string]any{
				"month": "2026-07", "from_category_id": cats[0], "to_category_id": target, "amount_fils": 100_00,
			})
			if w.Code != http.StatusBadRequest {
				t.Errorf("status = %d, want 400; body: %s", w.Code, w.Body)
			}
		})
	}

	// The failed moves were atomic: the source envelope kept every fils.
	w := doJSON(t, srv, "GET", "/api/envelopes?month=2026-07", nil)
	if w.Code != http.StatusOK {
		t.Fatalf("summary status = %d", w.Code)
	}
	sum := decodeSummary(t, w.Body.Bytes())
	if sum.AssignedFils != 1000_00 {
		t.Fatalf("assigned after rejected moves = %d, want 1000_00 untouched", sum.AssignedFils)
	}
	for _, e := range sum.Envelopes {
		if e.CategoryID == cats[0] && e.AssignedFils != 1000_00 {
			t.Fatalf("source envelope assigned = %d, want 1000_00 (a failed move leg shrank it)", e.AssignedFils)
		}
	}
}

// TestEnvelopesOverspendSettlesForItsExactCost is the wire-level RTA-identity
// regression (review scenario, income 3000.00): assign 200.00 in Jan, spend
// 300.00 → Feb charges the 100.00 overspend once (RTA 2900.00) — then March
// must charge nothing, and a March assignment of 100.00 must cost exactly
// 100.00 of RTA while staying spendable (no double charge, no phantom
// available that later evaporates).
func TestEnvelopesOverspendSettlesForItsExactCost(t *testing.T) {
	srv, st, cats := newEnvelopeTestServer(t)
	// This regression is specifically about envelope-mode carryover/debt
	// accounting; the default is now BudgetModeSimple (see budget_mode), so
	// this test must opt into envelope mode explicitly to still exercise it.
	if err := st.UpdateBudgetMode(store.BudgetModeEnvelope); err != nil {
		t.Fatal(err)
	}
	if err := st.UpsertEnvelopeAssignment("2026-01", cats[1], 200_00); err != nil {
		t.Fatal(err)
	}
	projInsertTxn(t, st, cats[1], "debit", 300_00, "2026-01-15", "confirmed")

	get := func(month string) budget.EnvelopeSummary {
		t.Helper()
		w := doJSON(t, srv, "GET", "/api/envelopes?month="+month, nil)
		if w.Code != http.StatusOK {
			t.Fatalf("GET %s: status %d body %s", month, w.Code, w.Body)
		}
		return decodeSummary(t, w.Body.Bytes())
	}
	envOf := func(sum budget.EnvelopeSummary, id int64) budget.Envelope {
		t.Helper()
		for _, e := range sum.Envelopes {
			if e.CategoryID == id {
				return e
			}
		}
		t.Fatalf("envelope %d missing", id)
		return budget.Envelope{}
	}

	// February: the overspend charges once. RTA = 3000 − 0 − 100.
	feb := get("2026-02")
	if feb.OverspendDebtFils != 100_00 || feb.ReadyToAssignFils != 2900_00 {
		t.Fatalf("Feb debt/RTA = %d/%d, want 10000/290000 (charged once)", feb.OverspendDebtFils, feb.ReadyToAssignFils)
	}
	// March, untouched: no re-charge — full income assignable again.
	mar := get("2026-03")
	if mar.OverspendDebtFils != 0 || mar.ReadyToAssignFils != 3000_00 {
		t.Fatalf("Mar debt/RTA = %d/%d, want 0/300000 (no perpetual charge)", mar.OverspendDebtFils, mar.ReadyToAssignFils)
	}
	// The user assigns 100.00 in March anyway: costs exactly 100.00 of RTA
	// and shows as real available money…
	w := doJSON(t, srv, "POST", "/api/envelopes/assign", map[string]any{
		"month":       "2026-03",
		"assignments": []map[string]any{{"category_id": cats[1], "assigned_fils": 100_00}},
	})
	if w.Code != http.StatusOK {
		t.Fatalf("assign status %d body %s", w.Code, w.Body)
	}
	mar = decodeSummary(t, w.Body.Bytes())
	if mar.ReadyToAssignFils != 2900_00 {
		t.Fatalf("Mar RTA after covering-style assign = %d, want 290000 (never 280000 — no double charge)", mar.ReadyToAssignFils)
	}
	if e := envOf(mar, cats[1]); e.AvailableFils != 100_00 || e.OverspendDebtFils != 0 {
		t.Fatalf("Mar envelope avail/debt = %d/%d, want 10000/0", e.AvailableFils, e.OverspendDebtFils)
	}
	// …which survives into April instead of silently evaporating.
	apr := get("2026-04")
	if e := envOf(apr, cats[1]); e.CarryoverFils != 100_00 || e.AvailableFils != 100_00 || e.OverspendDebtFils != 0 {
		t.Fatalf("Apr carry/avail/debt = %d/%d/%d, want 10000/10000/0 (money must not vanish)",
			e.CarryoverFils, e.AvailableFils, e.OverspendDebtFils)
	}
}

// TestEnvelopesDefaultModeZeroesCarryoverAndDebtAtWireLevel is the
// wire-level counterpart to internal/store's
// TestEnvelopeMonthSummary_SimpleModeCarriesNothing: it proves the DEFAULT
// mode (nothing set explicitly — the same app_settings row a fresh install
// gets) zeroes carryover_fils and overspend_debt_fils in the actual
// /api/envelopes JSON, and that ready_to_assign_fils holds the simple-mode
// identity income − assigned exactly (no debt subtracted).
//
// The fixture (assign 200.00 in Jan, spend 300.00, query Feb) is exactly the
// one TestEnvelopesOverspendSettlesForItsExactCost uses to prove envelope
// mode charges 100.00 of debt at this same month — so this is not a fixture
// that happens to produce zero under any interpretation; under envelope mode
// it demonstrably does not.
func TestEnvelopesDefaultModeZeroesCarryoverAndDebtAtWireLevel(t *testing.T) {
	srv, st, cats := newEnvelopeTestServer(t)
	// No UpdateBudgetMode call: this exercises whatever a fresh app_settings
	// row defaults to (BudgetModeSimple, per store.NormalizeBudgetMode).
	if err := st.UpsertEnvelopeAssignment("2026-01", cats[1], 200_00); err != nil {
		t.Fatal(err)
	}
	projInsertTxn(t, st, cats[1], "debit", 300_00, "2026-01-15", "confirmed")

	w := doJSON(t, srv, "GET", "/api/envelopes?month=2026-02", nil)
	if w.Code != http.StatusOK {
		t.Fatalf("GET 2026-02: status %d body %s", w.Code, w.Body)
	}
	feb := decodeSummary(t, w.Body.Bytes())

	var envelope *budget.Envelope
	for i := range feb.Envelopes {
		if feb.Envelopes[i].CategoryID == cats[1] {
			envelope = &feb.Envelopes[i]
		}
	}
	if envelope == nil {
		t.Fatalf("envelope %d missing from summary", cats[1])
	}
	if envelope.CarryoverFils != 0 {
		t.Errorf("CarryoverFils = %d, want 0 under default (simple) mode", envelope.CarryoverFils)
	}
	if envelope.OverspendDebtFils != 0 {
		t.Errorf("OverspendDebtFils = %d, want 0 under default (simple) mode — envelope mode gives 10000 (100.00 AED) for this exact fixture at this exact month", envelope.OverspendDebtFils)
	}
	if feb.OverspendDebtFils != 0 {
		t.Errorf("summary OverspendDebtFils = %d, want 0 under default (simple) mode", feb.OverspendDebtFils)
	}
	if want := feb.IncomeFils - feb.AssignedFils; feb.ReadyToAssignFils != want {
		t.Errorf("ReadyToAssignFils = %d, want %d (income - assigned, no debt subtracted)", feb.ReadyToAssignFils, want)
	}
}

// TestEnvelopesAutoAssignConcurrentRTANonNegative: auto-assign is
// read-plan-apply — compute the summary, plan against its RTA, apply deltas.
// Each apply is atomic, but without envelopeMu spanning the PAIR two
// overlapping requests (double-tap/retry) could both observe the full
// positive RTA and both apply complete plans, driving RTA negative and
// violating the contract's "auto-assign can never drive RTA negative".
func TestEnvelopesAutoAssignConcurrentRTANonNegative(t *testing.T) {
	srv, st, cats := newEnvelopeTestServer(t)
	if err := st.UpsertCategoryTarget(store.CategoryTargetRow{
		CategoryID: cats[0], EffectiveMonth: "2026-07", TargetType: "set_aside", AmountFils: 500_00,
	}); err != nil {
		t.Fatal(err)
	}

	const parallel = 4
	var wg sync.WaitGroup
	for i := 0; i < parallel; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			r := httptest.NewRequest("POST", "/api/envelopes/auto-assign",
				strings.NewReader(`{"month":"2026-07"}`))
			r.Header.Set("Content-Type", "application/json")
			srv.ServeHTTP(httptest.NewRecorder(), r)
		}()
	}
	wg.Wait()

	w := doJSON(t, srv, "GET", "/api/envelopes?month=2026-07", nil)
	if w.Code != http.StatusOK {
		t.Fatalf("GET = %d", w.Code)
	}
	sum := decodeSummary(t, w.Body.Bytes())
	if sum.ReadyToAssignFils < 0 {
		t.Fatalf("RTA = %d after concurrent auto-assign; the compute→apply pair is not serialized", sum.ReadyToAssignFils)
	}
	// Exactly one plan's worth of money landed: full income assigned, RTA 0.
	if sum.AssignedFils != 3000_00 || sum.ReadyToAssignFils != 0 {
		t.Fatalf("assigned=%d rta=%d, want 3000_00/0", sum.AssignedFils, sum.ReadyToAssignFils)
	}
}
