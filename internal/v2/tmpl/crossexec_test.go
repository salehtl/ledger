package tmpl

// The cross-executor corpus check for the template executor.
//
// conformance/templates/ pins 1,062 real messages out of 6,930 the seed
// templates are eligible for — 15% — plus 102 synthetic cases. A conformance
// suite that covers only the cases someone thought to select is exactly the
// shape of a suite that agrees on 6,929 messages and disagrees on the one that
// matters, so the two executors are ALSO compared over every message the
// corpus holds. This test exports what Go produced;
// client/scripts/crossexec-tmpl.ts runs the TypeScript executor over the same
// inputs and diffs them field by field. Neither side recomputes the other's
// answer and the two share no code.
//
//	S=/scratch
//	LEDGER_CORPUS_DB=$S/corpus.db LEDGER_CROSSEXEC_OUT=$S/go-templates.jsonl \
//	  go test ./internal/v2/tmpl/ -run TestWriteCrossExecutorTemplates -timeout 20m
//	(cd client && bun run scripts/crossexec-tmpl.ts $S/go-templates.jsonl)
//
// The output is tens of MB and is deliberately NOT committed: it is a
// measurement, reproducible from the corpus, not a fixture.

import (
	"bufio"
	"encoding/base64"
	"encoding/json"
	"os"
	"testing"

	"ledger/internal/v2/corpus"
	"ledger/internal/v2/norm"
)

// crossExecTemplateRow is one (template, message) pair as TypeScript reads it.
type crossExecTemplateRow struct {
	Template   string `json:"template"`
	Definition string `json:"definition_base64"`
	ID         int64  `json:"id"`
	Subject    string `json:"subject_base64"`
	Body       string `json:"normalized_body_base64"`

	Expect templateExpect `json:"expect"`
}

func TestWriteCrossExecutorTemplates(t *testing.T) {
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

	defs, raws := loadSeedTemplates(t)
	compiled := make([]*Compiled, len(defs))
	for i, d := range defs {
		c, err := Compile(d)
		if err != nil {
			t.Fatal(err)
		}
		compiled[i] = c
	}

	f, err := os.Create(out)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	w := bufio.NewWriterSize(f, 1<<20)
	enc := json.NewEncoder(w)

	var rows, matched, normFailed int
	err = db.Each(func(m corpus.Message) error {
		dom := senderDomain(m.FromAddr)
		r, err := norm.Normalize(norm.CurrentVersion, m.RawBody, m.ReceivedAt)
		if err != nil {
			normFailed++
			return nil
		}
		// EVERY eligible template, not the first that matches: the ingest path
		// runs the whole published set for a sender, and a disagreement about a
		// template that does not match is still a disagreement.
		subject := base64.StdEncoding.EncodeToString([]byte(r.Subject))
		body := base64.StdEncoding.EncodeToString([]byte(r.Text))
		for i, d := range defs {
			if !MatchesSenderDomain(d, dom) {
				continue
			}
			e, execErr := compiled[i].Execute(r.Subject, r.Text)
			if e.Matched {
				matched++
			}
			rows++
			if err := enc.Encode(crossExecTemplateRow{
				Template:   d.ID,
				Definition: base64.StdEncoding.EncodeToString(raws[i]),
				ID:         m.ID,
				Subject:    subject,
				Body:       body,
				Expect:     expectOf(e, execErr),
			}); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := w.Flush(); err != nil {
		t.Fatal(err)
	}
	t.Logf("wrote %s: %d rows, %d matched, %d messages the normalizer refused", out, rows, matched, normFailed)
	if rows == 0 {
		t.Fatal("no rows written; the corpus snapshot holds no mail from any seed template's sender")
	}
}
