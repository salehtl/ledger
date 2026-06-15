// internal/server/insights_test.go
package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"ledger/internal/store"
)

type stubInsights struct {
	cats  []store.CategorySpendRow
	trend []store.MonthlyTotalRow
	cfg   store.BudgetConfig
}

func (s stubInsights) SelectCategorySpend(period string, frozen bool) ([]store.CategorySpendRow, error) {
	return s.cats, nil
}
func (s stubInsights) SelectMonthlyTotals(months int) ([]store.MonthlyTotalRow, error) {
	return s.trend, nil
}
func (s stubInsights) SelectBudgetConfig() (store.BudgetConfig, error) { return s.cfg, nil }

func TestHandleGetCategorySpend(t *testing.T) {
	srv := New(nil, fstest())
	srv.SetInsightsStore(stubInsights{
		cats: []store.CategorySpendRow{{CategoryID: 1, Name: "Groceries", Bucket: "need", AmountFils: 8000}},
	})
	req := httptest.NewRequest("GET", "/api/insights/categories?period=2026-06", nil)
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("code = %d", rec.Code)
	}
	var got []map[string]any
	json.Unmarshal(rec.Body.Bytes(), &got)
	if len(got) != 1 || got[0]["name"] != "Groceries" || got[0]["spent"].(float64) != 8000 {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

func TestHandleGetTrend(t *testing.T) {
	srv := New(nil, fstest())
	srv.SetInsightsStore(stubInsights{
		trend: []store.MonthlyTotalRow{{Period: "2026-06", SpentFils: 8000, IncomeFils: 100000}},
	})
	req := httptest.NewRequest("GET", "/api/insights/trend?months=3", nil)
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("code = %d", rec.Code)
	}
	var got []map[string]any
	json.Unmarshal(rec.Body.Bytes(), &got)
	if len(got) != 1 || got[0]["period"] != "2026-06" || got[0]["spent"].(float64) != 8000 {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

func TestInsightsUnset503(t *testing.T) {
	srv := New(nil, fstest())
	req := httptest.NewRequest("GET", "/api/insights/categories", nil)
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("code = %d, want 503", rec.Code)
	}
}
