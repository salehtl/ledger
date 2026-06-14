package parse

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestAnthropicExtractorSuccess(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"content":[{"type":"text","text":"{\"posted_at\":\"2025-08-19T00:00:00Z\",\"amount_fils\":21500,\"currency\":\"AED\",\"direction\":\"debit\",\"merchant_raw\":\"AMAZON.AE\",\"last4\":\"1502\",\"confidence\":0.82}"}]}`))
	}))
	defer srv.Close()

	ex := &AnthropicExtractor{
		apiKey:   "test-key",
		model:    "claude-haiku-4-5-20251001",
		endpoint: srv.URL + "/v1/messages",
		client:   srv.Client(),
	}

	p, err := ex.Extract(context.Background(), "some email body")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if p.AmountFils != 21500 {
		t.Errorf("AmountFils: got %d, want 21500", p.AmountFils)
	}
	if p.Direction != "debit" {
		t.Errorf("Direction: got %q, want %q", p.Direction, "debit")
	}
	if p.MerchantRaw != "AMAZON.AE" {
		t.Errorf("MerchantRaw: got %q, want %q", p.MerchantRaw, "AMAZON.AE")
	}
	wantTime := time.Date(2025, 8, 19, 0, 0, 0, 0, time.UTC)
	if !p.PostedAt.Equal(wantTime) {
		t.Errorf("PostedAt: got %v, want %v", p.PostedAt, wantTime)
	}
	if p.Confidence != 0.82 {
		t.Errorf("Confidence: got %f, want 0.82", p.Confidence)
	}
	if p.Tier != TierAI {
		t.Errorf("Tier: got %q, want %q", p.Tier, TierAI)
	}
}

func TestAnthropicExtractorHTTPError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
	}))
	defer srv.Close()

	ex := &AnthropicExtractor{
		apiKey:   "test-key",
		model:    "claude-haiku-4-5-20251001",
		endpoint: srv.URL + "/v1/messages",
		client:   srv.Client(),
	}

	_, err := ex.Extract(context.Background(), "some email body")
	if err == nil {
		t.Fatal("expected error for 502 response, got nil")
	}
}
