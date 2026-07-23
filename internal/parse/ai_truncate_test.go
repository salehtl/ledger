// internal/parse/ai_truncate_test.go
package parse

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"unicode/utf8"
)

func TestExtractTruncatesOversizedBody(t *testing.T) {
	var sentLen int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req extractReq
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Errorf("decode request: %v", err)
		}
		sentLen = len(req.Messages[0].Content)
		fmt.Fprint(w, `{"model":"m","content":[{"type":"text","text":"{\"posted_at\":\"2026-01-01T00:00:00Z\",\"amount_fils\":100,\"currency\":\"AED\",\"direction\":\"debit\",\"merchant_raw\":\"X\",\"last4\":\"\",\"confidence\":0.8}"}],"usage":{"input_tokens":1,"output_tokens":1}}`)
	}))
	defer srv.Close()

	ex := NewAnthropicExtractor("test-key", "m", func() error { return nil }, nil)
	ex.endpoint = srv.URL
	if _, err := ex.Extract(context.Background(), strings.Repeat("a", 100_000)); err != nil {
		t.Fatal(err)
	}
	if sentLen == 0 || sentLen > maxExtractBodyBytes {
		t.Fatalf("body sent to API not truncated: %d bytes (cap %d)", sentLen, maxExtractBodyBytes)
	}
}

func TestTruncateBodyKeepsValidUTF8(t *testing.T) {
	s := strings.Repeat("€", maxExtractBodyBytes) // 3 bytes per rune; the cap lands mid-rune
	got := truncateBody(s)
	if len(got) > maxExtractBodyBytes {
		t.Fatalf("not truncated: %d", len(got))
	}
	if !utf8.ValidString(got) {
		t.Fatal("truncation split a UTF-8 rune")
	}
	if short := "small"; truncateBody(short) != short {
		t.Fatal("short bodies must pass through unchanged")
	}
}
