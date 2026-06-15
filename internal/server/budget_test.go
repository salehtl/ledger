package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"ledger/internal/budget"
	"ledger/internal/store"
)

func newTestServer(t *testing.T) (*Server, *store.Store) {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "data"))
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { st.Close() })
	if err := st.EnsureBudgetConfig(); err != nil {
		t.Fatal(err)
	}
	srv := New(st, fstest())
	srv.SetCategoryStore(st)
	srv.SetBudgetStore(st)
	return srv, st
}

func TestGetSummary(t *testing.T) {
	srv, st := newTestServer(t)
	_ = st.UpdateBudgetConfig(store.BudgetConfig{
		MonthlyIncome: 2000000, NeedPct: 0.5, WantPct: 0.3, SavingPct: 0.2, IncomeSource: "config",
	})
	req := httptest.NewRequest(http.MethodGet, "/api/summary", nil)
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", rec.Code, rec.Body.String())
	}
	var s budget.Summary
	if err := json.Unmarshal(rec.Body.Bytes(), &s); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(s.Buckets) != 3 || s.Buckets[0].Bucket != "need" {
		t.Errorf("buckets = %+v", s.Buckets)
	}
	if s.Income != 2000000 {
		t.Errorf("income = %d", s.Income)
	}
}

func TestSummaryHonorsPeriodParam(t *testing.T) {
	srv, st := newTestServer(t)
	_ = st.UpdateBudgetConfig(store.BudgetConfig{
		MonthlyIncome: 2000000, NeedPct: 0.5, WantPct: 0.3, SavingPct: 0.2, IncomeSource: "config",
	})
	req := httptest.NewRequest("GET", "/api/summary?period=2026-05", nil)
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("code = %d", rec.Code)
	}
	var got map[string]any
	json.Unmarshal(rec.Body.Bytes(), &got)
	if got["period"] != "2026-05" {
		t.Fatalf("period = %v, want 2026-05", got["period"])
	}
}

func TestPutThenGetBudget(t *testing.T) {
	srv, _ := newTestServer(t)
	body := `{"monthly_income":3000000,"need_pct":0.6,"want_pct":0.2,"saving_pct":0.2,"income_source":"config","freeze_history":true}`
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, httptest.NewRequest(http.MethodPut, "/api/budget", strings.NewReader(body)))
	if rec.Code != http.StatusOK {
		t.Fatalf("PUT status = %d, body=%s", rec.Code, rec.Body.String())
	}
	rec = httptest.NewRecorder()
	srv.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/budget", nil))
	var got budgetJSON
	json.Unmarshal(rec.Body.Bytes(), &got)
	if got.MonthlyIncome != 3000000 || got.NeedPct != 0.6 || !got.FreezeHistory {
		t.Errorf("round-trip mismatch: %+v", got)
	}
}

func TestPutBudgetRejectsBadPcts(t *testing.T) {
	srv, _ := newTestServer(t)
	body := `{"monthly_income":100,"need_pct":0.9,"want_pct":0.9,"saving_pct":0.9,"income_source":"config"}`
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, httptest.NewRequest(http.MethodPut, "/api/budget", strings.NewReader(body)))
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400 for pcts summing > 1", rec.Code)
	}
}

func TestSummaryBadPeriodReturns400(t *testing.T) {
	srv, st := newTestServer(t)
	_ = st.UpdateBudgetConfig(store.BudgetConfig{
		MonthlyIncome: 2000000, NeedPct: 0.5, WantPct: 0.3, SavingPct: 0.2, IncomeSource: "config",
	})
	req := httptest.NewRequest("GET", "/api/summary?period=not-a-month", nil)
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("code = %d, want 400", rec.Code)
	}
}

func TestCategorySpendBadPeriodReturns400(t *testing.T) {
	srv := New(nil, fstest())
	srv.SetInsightsStore(stubInsights{})
	req := httptest.NewRequest("GET", "/api/insights/categories?period=not-a-month", nil)
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("code = %d, want 400", rec.Code)
	}
}
