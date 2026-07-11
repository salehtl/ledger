package parse

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"ledger/internal/anthropic"
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
		retry:    anthropic.New(srv.Client()),
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

func TestAnthropicExtractorNormalizesCurrency(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"content":[{"type":"text","text":"{\"posted_at\":\"2025-08-19T00:00:00Z\",\"amount_fils\":1009,\"currency\":\" usd \",\"direction\":\"debit\",\"merchant_raw\":\"HETZNER\",\"last4\":\"\",\"confidence\":0.7}"}]}`))
	}))
	defer srv.Close()

	ex := &AnthropicExtractor{
		apiKey:   "test-key",
		model:    "claude-haiku-4-5-20251001",
		endpoint: srv.URL + "/v1/messages",
		retry:    anthropic.New(srv.Client()),
	}

	p, err := ex.Extract(context.Background(), "some email body")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if p.Currency != "USD" {
		t.Errorf("Currency: got %q, want %q", p.Currency, "USD")
	}
	if err := Validate(p); err != nil {
		t.Errorf("expected normalized currency to pass Validate, got %v", err)
	}
}

// Models occasionally wrap their JSON in markdown fences or prose despite the
// prompt. That must not fail the whole tier; and a confidence outside [0,1]
// must be clamped.
func TestAnthropicExtractorToleratesFencedJSONAndClampsConfidence(t *testing.T) {
	content := "```json\n{\"posted_at\":\"2025-08-19T00:00:00Z\",\"amount_fils\":21500,\"currency\":\"AED\",\"direction\":\"debit\",\"merchant_raw\":\"AMAZON.AE\",\"last4\":\"\",\"confidence\":1.7}\n```"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		resp, _ := json.Marshal(map[string]any{
			"content": []map[string]string{{"type": "text", "text": content}},
		})
		_, _ = w.Write(resp)
	}))
	defer srv.Close()

	ex := &AnthropicExtractor{
		apiKey:   "test-key",
		model:    "claude-haiku-4-5-20251001",
		endpoint: srv.URL + "/v1/messages",
		retry:    anthropic.New(srv.Client()),
	}
	p, err := ex.Extract(context.Background(), "some email body")
	if err != nil {
		t.Fatalf("fenced JSON should still parse, got error: %v", err)
	}
	if p.AmountFils != 21500 {
		t.Errorf("AmountFils = %d, want 21500", p.AmountFils)
	}
	if p.Confidence != 1.0 {
		t.Errorf("Confidence = %v, want clamped to 1.0", p.Confidence)
	}
}

func TestAnthropicExtractorHTTPError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest) // non-retryable: surfaces immediately
	}))
	defer srv.Close()

	ex := &AnthropicExtractor{
		apiKey:   "test-key",
		model:    "claude-haiku-4-5-20251001",
		endpoint: srv.URL + "/v1/messages",
		retry:    anthropic.New(srv.Client()),
	}

	_, err := ex.Extract(context.Background(), "some email body")
	if err == nil {
		t.Fatal("expected error for 502 response, got nil")
	}
}

func TestExtractorRecordsUsage(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"model":"claude-haiku-4-5","content":[{"type":"text","text":"{\"posted_at\":\"2024-01-15T00:00:00Z\",\"amount_fils\":100,\"currency\":\"AED\",\"direction\":\"debit\",\"merchant_raw\":\"X\",\"last4\":\"\",\"confidence\":0.8}"}],"usage":{"input_tokens":812,"output_tokens":47}}`))
	}))
	defer srv.Close()

	var got anthropic.Usage
	ex := NewAnthropicExtractor("key", "claude-haiku-4-5", nil, func(u anthropic.Usage) { got = u })
	ex.endpoint = srv.URL
	if _, err := ex.Extract(context.Background(), "body"); err != nil {
		t.Fatal(err)
	}
	if got.Path != "extract" || got.InputTokens != 812 || got.OutputTokens != 47 || !got.OK {
		t.Fatalf("usage = %+v", got)
	}
}

func TestExtractorTransportFailureRecordsOnce(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	deadURL := srv.URL
	srv.Close() // now unreachable: connections fail immediately

	var records int
	var got anthropic.Usage
	ex := &AnthropicExtractor{
		apiKey:   "test-key",
		model:    "claude-haiku-4-5",
		endpoint: deadURL,
		retry:    &anthropic.Retrier{HTTP: &http.Client{Timeout: 200 * time.Millisecond}, MaxRetries: 0},
		rec:      func(u anthropic.Usage) { records++; got = u },
	}

	_, err := ex.Extract(context.Background(), "some email body")
	if err == nil {
		t.Fatal("expected error for transport failure, got nil")
	}
	if errors.Is(err, anthropic.ErrAIDisabled) {
		t.Fatal("transport failure should not look like the gated error")
	}
	if records != 1 {
		t.Fatalf("records = %d, want 1", records)
	}
	if got.OK {
		t.Errorf("got.OK = true, want false")
	}
	if got.InputTokens != 0 || got.OutputTokens != 0 {
		t.Errorf("got tokens = %d/%d, want 0/0", got.InputTokens, got.OutputTokens)
	}
}

func TestExtractorGatedDoesNotRecord(t *testing.T) {
	var hits, records int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { hits++ }))
	defer srv.Close()
	ex := NewAnthropicExtractor("key", "m", func() error { return anthropic.ErrAIDisabled }, func(u anthropic.Usage) { records++ })
	ex.endpoint = srv.URL
	if _, err := ex.Extract(context.Background(), "body"); err == nil {
		t.Fatal("expected error when gated")
	}
	if hits != 0 || records != 0 {
		t.Fatalf("hits=%d records=%d, want 0/0", hits, records)
	}
}
