package categorize

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
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
		client:   srv.Client(),
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
		client:   srv.Client(),
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
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer srv.Close()

	ac := &AnthropicCategorizer{
		apiKey:   "test-key",
		model:    "claude-haiku-4-5-20251001",
		endpoint: srv.URL + "/v1/messages",
		client:   srv.Client(),
	}

	cats := []Category{
		{ID: 1, Name: "Shopping", Kind: "spending", Bucket: "want"},
	}

	_, _, err := ac.Categorize(t.Context(), "AMAZON.AE", cats)
	if err == nil {
		t.Error("expected error for HTTP 503 response, got nil")
	}
}
