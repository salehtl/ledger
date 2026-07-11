package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"ledger/internal/store"
)

type fakeAIUsage struct{}

func (fakeAIUsage) AIUsageStats(now int64) (store.AIUsageStats, error) {
	return store.AIUsageStats{Count30d: 3, Cost30dMuUSD: 4200, CountAll: 10, CostAllMuUSD: 190000}, nil
}
func (fakeAIUsage) RecentAIUsage(limit int) ([]store.AIUsageRow, error) {
	return []store.AIUsageRow{{At: 100, Path: "extract", Model: "m", InputTokens: 5, OutputTokens: 1, CostMuUSD: 10, OK: true, Detail: "X"}}, nil
}

func TestGetAIUsage(t *testing.T) {
	s := New(nil, fstest())
	s.SetAIUsageStore(fakeAIUsage{})
	req := httptest.NewRequest("GET", "/api/ai/usage", nil)
	w := httptest.NewRecorder()
	s.handleGetAIUsage(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("status %d", w.Code)
	}
	var body map[string]any
	json.Unmarshal(w.Body.Bytes(), &body)
	if body["count_30d"].(float64) != 3 || body["cost_all_musd"].(float64) != 190000 {
		t.Fatalf("body = %v", body)
	}
	if len(body["recent"].([]any)) != 1 {
		t.Fatalf("recent = %v", body["recent"])
	}
}

func TestGetAIUsageUnset503(t *testing.T) {
	s := New(nil, fstest())
	req := httptest.NewRequest("GET", "/api/ai/usage", nil)
	w := httptest.NewRecorder()
	s.handleGetAIUsage(w, req)
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("status %d, want 503", w.Code)
	}
}

func TestGetAIUsageEmptyRecentIsEmptyArray(t *testing.T) {
	s := New(nil, fstest())
	s.SetAIUsageStore(emptyAIUsage{})
	req := httptest.NewRequest("GET", "/api/ai/usage", nil)
	w := httptest.NewRecorder()
	s.handleGetAIUsage(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("status %d", w.Code)
	}
	body := w.Body.String()
	if !jsonHasEmptyArray(body, "recent") {
		t.Fatalf("recent should be [] not null: %s", body)
	}
}

type emptyAIUsage struct{}

func (emptyAIUsage) AIUsageStats(now int64) (store.AIUsageStats, error) {
	return store.AIUsageStats{}, nil
}
func (emptyAIUsage) RecentAIUsage(limit int) ([]store.AIUsageRow, error) {
	return nil, nil
}

func jsonHasEmptyArray(body, key string) bool {
	var m map[string]json.RawMessage
	if err := json.Unmarshal([]byte(body), &m); err != nil {
		return false
	}
	raw, ok := m[key]
	if !ok {
		return false
	}
	return string(raw) == "[]"
}
