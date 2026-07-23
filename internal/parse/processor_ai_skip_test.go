// internal/parse/processor_ai_skip_test.go
package parse

import (
	"context"
	"encoding/base64"
	"errors"
	"testing"
	"time"

	"ledger/internal/store"
)

type countingExtractor struct{ calls int }

func (c *countingExtractor) Extract(context.Context, string) (ParsedTxn, error) {
	c.calls++
	return ParsedTxn{}, errors.New("always fails")
}

func simpleEmail(body string) []byte {
	enc := base64.StdEncoding.EncodeToString([]byte(body))
	return []byte("From: x@y.z\r\nSubject: s\r\n" +
		"MIME-Version: 1.0\r\nContent-Type: text/html; charset=\"utf-8\"\r\n" +
		"Content-Transfer-Encoding: base64\r\n\r\n" + enc)
}

func TestReprocessSkipsAITierForLowConfidenceRows(t *testing.T) {
	st, err := store.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	// Two rows with bodies no template/heuristic tier can parse: one fresh
	// unparsed, one already AI-extracted (low_confidence).
	for _, r := range []store.IngestRecord{
		{MessageUID: "u1", FromAddr: "x@y.z", Subject: "s", ParseStatus: "unparsed", RawBody: simpleEmail("hello world"), ReceivedAt: time.Now(), CreatedAt: time.Now()},
		{MessageUID: "u2", FromAddr: "x@y.z", Subject: "s", ParseStatus: "low_confidence", RawBody: simpleEmail("hello again"), ReceivedAt: time.Now(), CreatedAt: time.Now()},
	} {
		if _, err := st.InsertIngest(r); err != nil {
			t.Fatal(err)
		}
	}

	ext := &countingExtractor{}
	p := NewProcessor(st, &Cascade{Heuristic: HeuristicParser{}, AI: ext})
	// Manual reprocess shape: unparsed AND low_confidence, no attempt cap.
	if _, err := p.ProcessPending(context.Background(), store.SelectForParseOpts{OnlyUnparsed: false}); err != nil {
		t.Fatal(err)
	}
	if ext.calls != 1 {
		t.Fatalf("AI tier must run only for the unparsed row, got %d calls", ext.calls)
	}
}
