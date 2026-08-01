package norm

import (
	"bufio"
	"encoding/base64"
	"encoding/json"
	"os"
	"testing"
	"time"

	"ledger/internal/v2/corpus"
)

// The cross-executor corpus check.
//
// conformance/normalizer/*.json pins 37 real messages and 88 synthetic ones.
// That is 0.53% of the corpus, and a conformance suite that covers only the
// cases someone thought to select is exactly the shape of a suite that agrees
// on 6,997 messages and disagrees on the one that matters.
//
// So the two executors are also compared over EVERY message the corpus holds.
// This test exports what Go produces; client/scripts/crossexec.ts runs the
// TypeScript normalizer over the same bytes and diffs the two field by field.
// Neither side recomputes the other's answer, and neither shares code with the
// other, which is what makes the comparison mean something.
//
//	S=/scratch
//	LEDGER_CORPUS_DB=$S/corpus.db LEDGER_CROSSEXEC_OUT=$S/go-corpus.jsonl \
//	  go test ./internal/v2/norm/ -run TestWriteCrossExecutorCorpus -timeout 20m
//	(cd client && bun run scripts/crossexec.ts $S/go-corpus.jsonl)
//
// The output is ~100 MB for 7,002 messages and is deliberately NOT committed:
// it is a measurement, reproducible from the corpus, not a fixture.

// crossExecRow is one message's Go result, as the TypeScript side reads it.
type crossExecRow struct {
	ID         int64  `json:"id"`
	ReceivedAt string `json:"received_at"`
	RawBase64  string `json:"raw_base64"`

	Error      string `json:"error"` // "" | "no_text_part" | other
	Text       string `json:"text_base64"`
	Part       string `json:"part"`
	Charset    string `json:"charset"`
	Subject    string `json:"subject_base64"`
	From       string `json:"from_base64"`
	Forwarded  bool   `json:"forwarded"`
	EmailDate  string `json:"email_date"`
	DateSource string `json:"date_source"`
}

func TestWriteCrossExecutorCorpus(t *testing.T) {
	out := os.Getenv("LEDGER_CROSSEXEC_OUT")
	if out == "" {
		t.Skip("LEDGER_CROSSEXEC_OUT is unset; this exports the corpus for the TypeScript differ")
	}
	path := os.Getenv("LEDGER_CORPUS_DB")
	if path == "" {
		t.Fatal("LEDGER_CROSSEXEC_OUT is set but LEDGER_CORPUS_DB is not; a typo must not silently skip the check")
	}
	db, err := corpus.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	f, err := os.Create(out)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	w := bufio.NewWriterSize(f, 1<<20)
	enc := json.NewEncoder(w)

	var n, failed int
	err = db.Each(func(m corpus.Message) error {
		row := crossExecRow{
			ID:         m.ID,
			ReceivedAt: m.ReceivedAt.UTC().Format(time.RFC3339),
			RawBase64:  base64.StdEncoding.EncodeToString(m.RawBody),
		}
		res, nerr := Normalize(CurrentVersion, m.RawBody, m.ReceivedAt.UTC())
		switch {
		case nerr == ErrNoTextPart:
			row.Error = "no_text_part"
			failed++
		case nerr != nil:
			row.Error = nerr.Error()
			failed++
		default:
			row.Text = base64.StdEncoding.EncodeToString([]byte(res.Text))
			row.Part = res.PartUsed
			row.Charset = res.Charset
			row.Subject = base64.StdEncoding.EncodeToString([]byte(res.Subject))
			row.From = base64.StdEncoding.EncodeToString([]byte(res.From))
			row.Forwarded = res.Forwarded
			row.EmailDate = res.EmailDate.UTC().Format(time.RFC3339)
			row.DateSource = res.DateSource
		}
		n++
		return enc.Encode(&row)
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := w.Flush(); err != nil {
		t.Fatal(err)
	}
	t.Logf("wrote %d rows (%d normalizer errors) to %s", n, failed, out)
}
