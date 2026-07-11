package categorize

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"ledger/internal/anthropic"
)

func TestAnthropicCategorizerSuccess(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Verify headers
		if got := r.Header.Get("x-api-key"); got != "test-key" {
			t.Errorf("expected x-api-key=test-key, got %q", got)
		}
		if got := r.Header.Get("anthropic-version"); got == "" {
			t.Error("expected non-empty anthropic-version header")
		}

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"content":[{"type":"text","text":"{\"category\":\"Shopping\",\"confidence\":0.95}"}]}`))
	}))
	defer srv.Close()

	ac := &AnthropicCategorizer{
		apiKey:   "test-key",
		model:    "claude-haiku-4-5-20251001",
		endpoint: srv.URL + "/v1/messages",
		retry:    anthropic.New(srv.Client()),
	}

	cats := []Category{
		{ID: 1, Name: "Shopping", Kind: "spending", Bucket: "want"},
		{ID: 2, Name: "Dining", Kind: "spending", Bucket: "want"},
	}

	name, conf, err := ac.Categorize(t.Context(), "AMAZON.AE", cats)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if name != "Shopping" {
		t.Errorf("expected name=Shopping, got %q", name)
	}
	if conf != 0.95 {
		t.Errorf("expected conf=0.95, got %f", conf)
	}
}

// Fenced/prose-wrapped JSON must still parse, and an out-of-range confidence
// must be clamped so it can't trivially clear the auto-accept threshold.
func TestAnthropicCategorizerToleratesFencedJSONAndClampsConfidence(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		resp, _ := json.Marshal(map[string]any{
			"content": []map[string]string{{"type": "text", "text": "```json\n{\"category\":\"Shopping\",\"confidence\":1.5}\n```"}},
		})
		_, _ = w.Write(resp)
	}))
	defer srv.Close()

	ac := &AnthropicCategorizer{
		apiKey:   "test-key",
		model:    "claude-haiku-4-5-20251001",
		endpoint: srv.URL + "/v1/messages",
		retry:    anthropic.New(srv.Client()),
	}
	name, conf, err := ac.Categorize(t.Context(), "AMAZON.AE", []Category{{ID: 1, Name: "Shopping"}})
	if err != nil {
		t.Fatalf("fenced JSON should still parse, got error: %v", err)
	}
	if name != "Shopping" {
		t.Errorf("name = %q, want Shopping", name)
	}
	if conf != 1.0 {
		t.Errorf("conf = %v, want clamped to 1.0", conf)
	}
}

func TestAnthropicCategorizerSendsOnlyMerchant(t *testing.T) {
	var capturedBody []byte

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var buf [4096]byte
		n, _ := r.Body.Read(buf[:])
		capturedBody = make([]byte, n)
		copy(capturedBody, buf[:n])

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"content":[{"type":"text","text":"{\"category\":\"Dining\",\"confidence\":0.88}"}]}`))
	}))
	defer srv.Close()

	ac := &AnthropicCategorizer{
		apiKey:   "test-key",
		model:    "claude-haiku-4-5-20251001",
		endpoint: srv.URL + "/v1/messages",
		retry:    anthropic.New(srv.Client()),
	}

	cats := []Category{
		{ID: 1, Name: "Dining", Kind: "spending", Bucket: "want"},
	}

	_, _, err := ac.Categorize(t.Context(), "MCDONALDS", cats)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// Parse the captured body to inspect the user message
	var req anthropicCategReq
	if err := json.Unmarshal(capturedBody, &req); err != nil {
		t.Fatalf("failed to parse request body: %v", err)
	}

	if len(req.Messages) == 0 {
		t.Fatal("expected at least one message in request")
	}

	userContent := req.Messages[0].Content

	// Must contain the merchant name
	if !strings.Contains(userContent, "MCDONALDS") {
		t.Errorf("user message should contain merchant name; got: %q", userContent)
	}

	// Must NOT contain amount or account info patterns
	sensitivePatterns := []string{"amount", "account", "balance", "AED", "USD", "1234", "5678"}
	for _, pat := range sensitivePatterns {
		if strings.Contains(userContent, pat) {
			t.Errorf("user message should not contain %q; got: %q", pat, userContent)
		}
	}
}

func TestAnthropicCategorizerHTTPError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest) // non-retryable: surfaces immediately
	}))
	defer srv.Close()

	ac := &AnthropicCategorizer{
		apiKey:   "test-key",
		model:    "claude-haiku-4-5-20251001",
		endpoint: srv.URL + "/v1/messages",
		retry:    anthropic.New(srv.Client()),
	}

	cats := []Category{
		{ID: 1, Name: "Shopping", Kind: "spending", Bucket: "want"},
	}

	_, _, err := ac.Categorize(t.Context(), "AMAZON.AE", cats)
	if err == nil {
		t.Error("expected error for HTTP 503 response, got nil")
	}
}

func TestCategorizerTransportFailureRecordsOnce(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	deadURL := srv.URL
	srv.Close() // now unreachable: connections fail immediately

	var records int
	var got anthropic.Usage
	ac := &AnthropicCategorizer{
		apiKey:   "test-key",
		model:    "claude-haiku-4-5",
		endpoint: deadURL,
		retry:    &anthropic.Retrier{HTTP: &http.Client{Timeout: 200 * time.Millisecond}, MaxRetries: 0},
		rec:      func(u anthropic.Usage) { records++; got = u },
	}

	cats := []Category{{ID: 1, Name: "Shopping"}}
	_, _, err := ac.Categorize(context.Background(), "AMAZON.AE", cats)
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

func TestCategorizerRecordsUsage(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"model":"claude-haiku-4-5","content":[{"type":"text","text":"{\"category\":\"Groceries\",\"confidence\":0.9}"}],"usage":{"input_tokens":120,"output_tokens":8}}`))
	}))
	defer srv.Close()
	var got anthropic.Usage
	c := NewAnthropicCategorizer("key", "claude-haiku-4-5", nil, func(u anthropic.Usage) { got = u })
	c.endpoint = srv.URL
	if _, _, err := c.Categorize(context.Background(), "TESCO", []Category{{ID: 1, Name: "Groceries"}}); err != nil {
		t.Fatal(err)
	}
	if got.Path != "categorize" || got.InputTokens != 120 || got.OutputTokens != 8 || !got.OK {
		t.Fatalf("usage = %+v", got)
	}
}
