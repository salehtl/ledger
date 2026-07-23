# Cost & Performance Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the cost/perf findings from `docs/cost-performance-review-2026-07-23.md`: kill the unbounded parse-retry loop, stop AI repeat-billing, bound AI request sizes, fix SQLite pragmas/indexes, debounce SSE-driven refetch storms, and compress raw email storage (165 MB → ~20 MB).

**Architecture:** All changes are surgical edits inside the existing single-binary pipeline (store → parse → categorize → server) plus one small frontend hook change. New persistent state: `ingest_log.parse_attempts` column and an `ai_suggestions` memo table, both via the existing idempotent schema/migrate path. No new dependencies.

**Tech Stack:** Go (stdlib + modernc sqlite via existing `store`), React/TypeScript/vitest for the one frontend task.

## Global Constraints

- Money is integer minor units (`int64` fils); never floats for money.
- Schema changes are additive only: `CREATE TABLE/INDEX IF NOT EXISTS` in `internal/store/schema.sql`, or `addColumnIfMissing` in `internal/store/store.go` `migrate()`. No migration tool exists.
- The frontend builds into `internal/web/dist/` which Go embeds; **rebuild the combined dist before finishing the branch** (`cd frontend && bun install && bun run build`), and rebuild Go with `CGO_ENABLED=0 go build -o ledger ./cmd/ledger`.
- Frontend vitest stays single-fork (`fileParallelism: false`) — do not change `vite.config.ts` test settings.
- Go tests: `go test ./...`. Known environment quirk: `internal/config` `TestAIConfigEnabledRequiresAPIKey` fails when `LEDGER_AI_API_KEY` is set in the environment — run config tests with `env -u LEDGER_AI_API_KEY go test ./internal/config/` and treat that as the authoritative result.
- Commit after every task with the message given in the task.

## Execution notes (read before dispatching subagents)

- **Worktree:** create the working branch via a worktree at execution time. The worktree tool branches from `origin/main`, which may be behind local `main` — merge/fast-forward local `main` into the worktree branch first. Subagents spawn with cwd `/root/Coding/ledger` (the main checkout) — every subagent prompt must mandate `cd <worktree path>` and verify `git branch --show-current` before touching files.
- **Ordering:** Tasks 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 in order. Tasks 1, 3, and 7 all touch `SelectForParse`/`processor.go`; Tasks 4 and 5 both touch `schema.sql`/store; do not parallelize.
- **Out of scope (decided, do not add):** Anthropic Batch API for the bulk categorize job; `/api/transactions` pagination/virtualization; budget `?all=1` grouped query; `NetTransferPairs` bucketing; high-water-UID IMAP sync; `SetMaxOpenConns(1)`; prompt caching (prompts are below the cacheable minimum); idempotency keys (not a Messages API feature).

---

### Task 1: Cap automatic parse retries (`parse_attempts`)

The 60s ingest hook currently re-runs every permanently-unparseable email through the full cascade forever (21,778 attempted AI calls on 2026-07-11). Add an attempt counter; the periodic hook skips rows that have already failed 3 times. Manual `/api/reprocess` still processes everything (no cap), so nothing is ever unrecoverable.

**Files:**
- Modify: `internal/store/store.go` (migrate: add `parse_attempts` column)
- Modify: `internal/store/transactions.go:108-152` (`SelectForParseOpts`, `SelectForParse`, `MarkParsed`)
- Modify: `cmd/ledger/main.go:327-329` (ingest post-process hook)
- Test: `internal/store/parse_attempts_test.go` (new)

**Interfaces:**
- Produces: `SelectForParseOpts.MaxAttempts int` (0 = no cap); `MarkParsed` increments `parse_attempts` when marking `'unparsed'`. Task 3 and Task 7 build on this file state.

- [ ] **Step 1: Write the failing test**

```go
// internal/store/parse_attempts_test.go
package store

import (
	"testing"
	"time"
)

func TestSelectForParseSkipsExhaustedRows(t *testing.T) {
	st, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	rec := IngestRecord{
		MessageUID: "uid-1", FromAddr: "noreply@bank.example", Subject: "alert",
		ParseStatus: "unparsed", RawBody: []byte("body"),
		ReceivedAt: time.Now(), CreatedAt: time.Now(),
	}
	if _, err := st.InsertIngest(rec); err != nil {
		t.Fatal(err)
	}
	rows, err := st.SelectForParse(SelectForParseOpts{OnlyUnparsed: true, MaxAttempts: 3})
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 {
		t.Fatalf("fresh row should be selected, got %d rows", len(rows))
	}
	id := rows[0].ID

	// Three failed parses exhaust the automatic-retry budget.
	for i := 0; i < 3; i++ {
		if err := st.MarkParsed(id, "unparsed", "", "no tier matched"); err != nil {
			t.Fatal(err)
		}
	}
	rows, err = st.SelectForParse(SelectForParseOpts{OnlyUnparsed: true, MaxAttempts: 3})
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 0 {
		t.Fatalf("exhausted row must be skipped by the capped select, got %d rows", len(rows))
	}

	// The uncapped (manual reprocess) select still sees it.
	rows, err = st.SelectForParse(SelectForParseOpts{OnlyUnparsed: true})
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 {
		t.Fatalf("uncapped select must still return the row, got %d rows", len(rows))
	}
}

func TestMarkParsedSuccessDoesNotIncrementAttempts(t *testing.T) {
	st, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	if _, err := st.InsertIngest(IngestRecord{
		MessageUID: "uid-2", FromAddr: "noreply@bank.example", Subject: "alert",
		ParseStatus: "unparsed", RawBody: []byte("b"),
		ReceivedAt: time.Now(), CreatedAt: time.Now(),
	}); err != nil {
		t.Fatal(err)
	}
	rows, _ := st.SelectForParse(SelectForParseOpts{OnlyUnparsed: true})
	id := rows[0].ID
	if err := st.MarkParsed(id, "parsed", "template", ""); err != nil {
		t.Fatal(err)
	}
	var attempts int
	if err := st.DB.QueryRow(`SELECT parse_attempts FROM ingest_log WHERE id=?`, id).Scan(&attempts); err != nil {
		t.Fatal(err)
	}
	if attempts != 0 {
		t.Fatalf("successful parse must not consume the retry budget, attempts=%d", attempts)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/store/ -run 'TestSelectForParseSkipsExhausted|TestMarkParsedSuccess' -v`
Expected: FAIL — `unknown field MaxAttempts` (compile error).

- [ ] **Step 3: Implement**

In `internal/store/store.go`, inside `migrate()` (after the `ai_cap_latched` block, before the `project_id` block), add:

```go
	// Automatic parse retries are capped; the periodic ingest hook skips rows
	// whose budget is spent. Manual reprocess ignores the cap.
	if err := addColumnIfMissing(db, "ingest_log", "parse_attempts", "INTEGER NOT NULL DEFAULT 0"); err != nil {
		return err
	}
```

In `internal/store/transactions.go`, change `SelectForParseOpts` and `SelectForParse`:

```go
// SelectForParseOpts filters which ingest rows to (re)process.
type SelectForParseOpts struct {
	OnlyUnparsed bool   // true: only parse_status='unparsed'; false: also 'low_confidence'
	FromLike     string // optional: restrict to a sender substring (e.g. a bank)
	MaxAttempts  int    // >0: skip rows already failed this many times (periodic hook); 0: no cap (manual reprocess)
}
```

and in the query construction (after the `FromLike` block):

```go
	if opts.MaxAttempts > 0 {
		q += " AND parse_attempts < ?"
		args = append(args, opts.MaxAttempts)
	}
```

Change `MarkParsed` to burn one attempt on each failed parse:

```go
// MarkParsed stamps an ingest_log row's parse outcome. A failed parse
// (status 'unparsed') consumes one automatic-retry attempt.
func (s *Store) MarkParsed(ingestID int64, status, tier, parseErr string) error {
	_, err := s.DB.Exec(
		`UPDATE ingest_log
		    SET parse_status=?, parse_tier=?, parse_error=?,
		        parse_attempts = CASE WHEN ?='unparsed' THEN parse_attempts+1 ELSE parse_attempts END
		  WHERE id=?`,
		status, nullable(tier), nullable(parseErr), status, ingestID)
	return err
}
```

In `cmd/ledger/main.go:327-329`, cap the periodic hook:

```go
		worker.SetPostProcess(func(ctx context.Context) (int, error) {
			// Cap automatic retries: rows that failed 3 times wait for a parser
			// fix + manual reprocess instead of burning CPU (and AI calls, when
			// enabled) every poll cycle forever.
			return processor.ProcessPending(ctx, store.SelectForParseOpts{OnlyUnparsed: true, MaxAttempts: 3})
		})
```

- [ ] **Step 4: Run tests**

Run: `go test ./internal/store/ ./internal/parse/ ./cmd/... -count=1` then `go test ./... -count=1` (expect only the known `internal/config` env failure, if any).
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/store/store.go internal/store/transactions.go internal/store/parse_attempts_test.go cmd/ledger/main.go
git commit -m "feat(store,parse): cap automatic parse retries at 3 attempts"
```

---

### Task 2: Bound AI request sizes (extraction body cap + max_tokens)

Extraction sends the whole email body uncapped — the dominant input-token cost. Cap it at 8 KB (bank alerts fit in ~2 KB; the excess is boilerplate). Also trim `max_tokens` to sane ceilings (billing is on actual output, so this is a runaway guard, not a saving).

**Files:**
- Modify: `internal/parse/ai.go:101-107` (truncate body, `MaxTokens` 400→200)
- Modify: `internal/categorize/ai.go:87` (`MaxTokens` 200→60)
- Test: `internal/parse/ai_truncate_test.go` (new)

**Interfaces:**
- Produces: `truncateBody(string) string` and `const maxExtractBodyBytes` (package-private in `parse`). No cross-task consumers.

- [ ] **Step 1: Write the failing test**

```go
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
	s := strings.Repeat("é", maxExtractBodyBytes) // 2 bytes per rune; cap lands mid-rune
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/parse/ -run TestExtractTruncates -v`
Expected: FAIL — `undefined: maxExtractBodyBytes` / `undefined: truncateBody`.

- [ ] **Step 3: Implement**

In `internal/parse/ai.go` add (near the top, after `extractorSystemPrompt`; add `"unicode/utf8"` to imports):

```go
// maxExtractBodyBytes bounds what one extraction sends to the API. Real bank
// alerts fit comfortably; anything beyond this is boilerplate the model does
// not need, and unbounded bodies are the dominant input-token cost.
const maxExtractBodyBytes = 8 << 10

func truncateBody(s string) string {
	if len(s) <= maxExtractBodyBytes {
		return s
	}
	cut := s[:maxExtractBodyBytes]
	for len(cut) > 0 && !utf8.ValidString(cut) {
		cut = cut[:len(cut)-1]
	}
	return cut
}
```

In `Extract` (`ai.go:101-107`) change the payload:

```go
	payload := extractReq{
		Model:     a.model,
		MaxTokens: 200, // reply is one ~100-token JSON line; this is a runaway guard
		System:    extractorSystemPrompt,
		Messages:  []extMsg{{Role: "user", Content: truncateBody(textBody)}},
	}
```

In `internal/categorize/ai.go:87` change `MaxTokens: 200,` to:

```go
		MaxTokens: 60, // reply is one ~20-token JSON line; this is a runaway guard
```

- [ ] **Step 4: Run tests**

Run: `go test ./internal/parse/ ./internal/categorize/ -count=1`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/parse/ai.go internal/parse/ai_truncate_test.go internal/categorize/ai.go
git commit -m "feat(ai): cap extraction body at 8KB and tighten max_tokens"
```

---

### Task 3: Reprocess must not re-bill AI-extracted rows

`Reprocess` selects `low_confidence` rows — which are exactly the rows AI already extracted — and runs them back through the cascade, re-invoking the AI tier and re-billing for a result we already have. Skip the AI tier for rows whose current status is `low_confidence`; the template/heuristic tiers still run (that's the point of reprocess: a fixed parser upgrades them for free).

**Files:**
- Modify: `internal/store/transactions.go` (`IngestForParse` gains `ParseStatus`; `SelectForParse` selects it)
- Modify: `internal/parse/processor.go:61-70` (drop AI tier for `low_confidence` rows)
- Test: `internal/parse/processor_ai_skip_test.go` (new)

**Interfaces:**
- Consumes: Task 1's `SelectForParseOpts` (unchanged here).
- Produces: `IngestForParse.ParseStatus string`. Task 7 must keep this scan shape intact.

- [ ] **Step 1: Write the failing test**

```go
// internal/parse/processor_ai_skip_test.go
package parse

import (
	"context"
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

func TestReprocessSkipsAITierForLowConfidenceRows(t *testing.T) {
	st, err := store.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	// Two rows with bodies no template/heuristic tier can parse: one fresh
	// unparsed, one already AI-extracted (low_confidence).
	for _, r := range []store.IngestRecord{
		{MessageUID: "u1", FromAddr: "x@y.z", Subject: "s", ParseStatus: "unparsed", RawBody: []byte("hello world"), ReceivedAt: time.Now(), CreatedAt: time.Now()},
		{MessageUID: "u2", FromAddr: "x@y.z", Subject: "s", ParseStatus: "low_confidence", RawBody: []byte("hello again"), ReceivedAt: time.Now(), CreatedAt: time.Now()},
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/parse/ -run TestReprocessSkipsAITier -v`
Expected: FAIL — `ext.calls` is 2 (AI ran for both rows). (If it fails earlier with a missing `ParseStatus` field once Step 3 is partially applied, keep going — the final state must make this pass.)

- [ ] **Step 3: Implement**

In `internal/store/transactions.go` add the field and select it:

```go
// IngestForParse is one ingest_log row the processor will run the cascade over.
type IngestForParse struct {
	ID          int64
	FromAddr    string
	Subject     string
	ParseStatus string
	RawBody     []byte
}
```

Change the query and scan in `SelectForParse`:

```go
	q := `SELECT id, from_addr, subject, parse_status, raw_body FROM ingest_log WHERE parse_status IN ` + statuses
```

```go
		if err := rows.Scan(&r.ID, &r.FromAddr, &r.Subject, &r.ParseStatus, &raw); err != nil {
			return nil, err
		}
```

In `internal/parse/processor.go`, inside the `for _, row := range rows` loop, replace `res := p.cascade.Run(ctx, from, subject, text)` with:

```go
		// A low_confidence row was already extracted by the AI tier once —
		// re-running AI would just re-bill for the same guess. Reprocess exists
		// so a *fixed deterministic parser* can upgrade the row; run the cascade
		// without its AI tier for those rows.
		casc := p.cascade
		if row.ParseStatus == StatusLowConfidence {
			c := *p.cascade
			c.AI = nil
			casc = &c
		}
		res := casc.Run(ctx, from, subject, text)
```

- [ ] **Step 4: Run tests**

Run: `go test ./internal/parse/ ./internal/store/ -count=1`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/store/transactions.go internal/parse/processor.go internal/parse/processor_ai_skip_test.go
git commit -m "feat(parse): reprocess no longer re-bills AI for low_confidence rows"
```

---

### Task 4: Persist AI category suggestions (never pay for the same merchant twice)

With auto-accept off (the live setting), `buildCategorizer` sets an unreachable threshold, so no rule is ever written back and every bulk categorize run re-sends every still-unreviewed merchant to the API. Add a persistent `ai_suggestions` memo consulted before any categorization API call, written after every successful one — regardless of confidence. Also normalize the bulk job's in-run cache key (currently raw string; casing variants double-call).

**Files:**
- Modify: `internal/store/schema.sql` (new `ai_suggestions` table)
- Create: `internal/store/suggestions.go`
- Create: `internal/categorize/memo.go`
- Modify: `cmd/ledger/main.go:209-214` (wrap the real categorizer in the memo)
- Modify: `internal/server/categorize_job.go:85-89` (normalize cache key; add `"strings"` import)
- Test: `internal/categorize/memo_test.go`, `internal/store/suggestions_test.go` (new)

**Interfaces:**
- Produces: `store.GetAISuggestion(merchantNorm string) (categoryName string, confidence float64, ok bool, err error)`; `store.PutAISuggestion(merchantNorm string, categoryID int64, confidence float64) error`; `categorize.MemoAI{Inner AICategorizer, Store SuggestionStore}` implementing `AICategorizer`.
- Known tradeoff (accepted): a memo row pointing at a later-renamed category resolves by JOIN so renames are safe; a memo row whose category is deleted returns no row (FK-less lookup misses) — falls through to a fresh API call. Do not build invalidation machinery.

- [ ] **Step 1: Write the failing tests**

```go
// internal/categorize/memo_test.go
package categorize

import (
	"context"
	"testing"
)

type countingAI struct{ calls int }

func (c *countingAI) Categorize(context.Context, string, []Category) (string, float64, error) {
	c.calls++
	return "Dining", 0.7, nil
}

type mapMemo struct {
	rows map[string]struct {
		catID int64
		conf  float64
	}
}

func (m *mapMemo) GetAISuggestion(k string) (string, float64, bool, error) {
	r, ok := m.rows[k]
	if !ok {
		return "", 0, false, nil
	}
	_ = r.catID
	return "Dining", r.conf, true, nil
}

func (m *mapMemo) PutAISuggestion(k string, catID int64, conf float64) error {
	m.rows[k] = struct {
		catID int64
		conf  float64
	}{catID, conf}
	return nil
}

func TestMemoAICallsInnerOncePerMerchant(t *testing.T) {
	inner := &countingAI{}
	memo := MemoAI{Inner: inner, Store: &mapMemo{rows: map[string]struct {
		catID int64
		conf  float64
	}{}}}
	cats := []Category{{ID: 7, Name: "Dining"}}

	name, conf, err := memo.Categorize(context.Background(), "Some Cafe LLC", cats)
	if err != nil || name != "Dining" || conf != 0.7 {
		t.Fatalf("first call: %q %v %v", name, conf, err)
	}
	// Same merchant, different casing/whitespace → memo hit, no second API call.
	if _, _, err := memo.Categorize(context.Background(), "  SOME CAFE llc ", cats); err != nil {
		t.Fatal(err)
	}
	if inner.calls != 1 {
		t.Fatalf("inner AI must be called exactly once, got %d", inner.calls)
	}
}
```

```go
// internal/store/suggestions_test.go
package store

import "testing"

func TestAISuggestionRoundTrip(t *testing.T) {
	st, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	var catID int64
	var catName string
	if err := st.DB.QueryRow(`SELECT id, name FROM categories LIMIT 1`).Scan(&catID, &catName); err != nil {
		t.Fatal(err) // seeded by Open
	}
	if _, _, ok, err := st.GetAISuggestion("some cafe llc"); err != nil || ok {
		t.Fatalf("empty memo must miss: ok=%v err=%v", ok, err)
	}
	if err := st.PutAISuggestion("some cafe llc", catID, 0.7); err != nil {
		t.Fatal(err)
	}
	name, conf, ok, err := st.GetAISuggestion("some cafe llc")
	if err != nil || !ok || name != catName || conf != 0.7 {
		t.Fatalf("got %q %v %v %v, want %q 0.7 true nil", name, conf, ok, err, catName)
	}
	// Upsert overwrites.
	if err := st.PutAISuggestion("some cafe llc", catID, 0.9); err != nil {
		t.Fatal(err)
	}
	if _, conf, _, _ := st.GetAISuggestion("some cafe llc"); conf != 0.9 {
		t.Fatalf("upsert did not overwrite, conf=%v", conf)
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./internal/categorize/ -run TestMemoAI -v && go test ./internal/store/ -run TestAISuggestion -v`
Expected: FAIL — `undefined: MemoAI` / `undefined: GetAISuggestion`.

- [ ] **Step 3: Implement**

Append to `internal/store/schema.sql` (after the `ai_usage` block):

```sql
-- AI category-suggestion memo: every successful AI categorization is remembered
-- (even below the auto-accept threshold) so an unreviewed merchant is never
-- paid for twice across runs and restarts. Keyed by lowercased/trimmed merchant.
CREATE TABLE IF NOT EXISTS ai_suggestions (
  merchant_norm TEXT PRIMARY KEY,
  category_id   INTEGER NOT NULL REFERENCES categories(id),
  confidence    REAL NOT NULL,
  created_at    TEXT NOT NULL
);
```

Create `internal/store/suggestions.go`:

```go
package store

import (
	"database/sql"
	"errors"
	"time"
)

// GetAISuggestion returns the remembered AI category suggestion for a
// normalized (lowercased, trimmed) merchant string. ok=false means no memo.
// The category name is resolved by JOIN so later renames stay correct; a memo
// whose category was deleted simply misses and the caller re-asks the AI.
func (s *Store) GetAISuggestion(merchantNorm string) (string, float64, bool, error) {
	var name string
	var conf float64
	err := s.DB.QueryRow(
		`SELECT c.name, m.confidence
		   FROM ai_suggestions m JOIN categories c ON c.id = m.category_id
		  WHERE m.merchant_norm = ?`, merchantNorm).Scan(&name, &conf)
	if errors.Is(err, sql.ErrNoRows) {
		return "", 0, false, nil
	}
	if err != nil {
		return "", 0, false, err
	}
	return name, conf, true, nil
}

// PutAISuggestion upserts the memo for a normalized merchant string.
func (s *Store) PutAISuggestion(merchantNorm string, categoryID int64, confidence float64) error {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	_, err := s.DB.Exec(
		`INSERT INTO ai_suggestions (merchant_norm, category_id, confidence, created_at)
		 VALUES (?, ?, ?, ?)
		 ON CONFLICT(merchant_norm) DO UPDATE SET
		   category_id = excluded.category_id,
		   confidence  = excluded.confidence,
		   created_at  = excluded.created_at`,
		merchantNorm, categoryID, confidence, now)
	return err
}
```

Create `internal/categorize/memo.go`:

```go
package categorize

import (
	"context"
	"strings"
)

// SuggestionStore persists AI category suggestions keyed by normalized merchant.
// *store.Store satisfies it.
type SuggestionStore interface {
	GetAISuggestion(merchantNorm string) (categoryName string, confidence float64, ok bool, err error)
	PutAISuggestion(merchantNorm string, categoryID int64, confidence float64) error
}

// MemoAI wraps an AICategorizer with a persistent merchant→suggestion memo so
// the same unknown merchant is never sent to the API twice — across runs and
// restarts, and regardless of the auto-accept threshold. Rules always run
// before the AI path, so a manual/confirmed rule still shadows any memo.
type MemoAI struct {
	Inner AICategorizer
	Store SuggestionStore
}

func (m MemoAI) Categorize(ctx context.Context, merchant string, cats []Category) (string, float64, error) {
	key := strings.ToLower(strings.TrimSpace(merchant))
	if key != "" {
		if name, conf, ok, err := m.Store.GetAISuggestion(key); err == nil && ok {
			return name, conf, nil
		}
	}
	name, conf, err := m.Inner.Categorize(ctx, merchant, cats)
	if err != nil {
		return "", 0, err
	}
	if key != "" {
		for _, c := range cats {
			if strings.EqualFold(c.Name, name) {
				// Best-effort: a failed memo write just means one more API call later.
				_ = m.Store.PutAISuggestion(key, c.ID, conf)
				break
			}
		}
	}
	return name, conf, nil
}
```

In `cmd/ledger/main.go:210`, replace the single line

```go
		aiCat = categorize.NewAnthropicCategorizer(cfg.AI.APIKey, cfg.AI.Model, aiGate, aiRecorder)
```

with

```go
		// Memo wrapper: a merchant the AI has already categorized is answered
		// from the ai_suggestions table, not paid for again.
		aiCat = categorize.MemoAI{
			Inner: categorize.NewAnthropicCategorizer(cfg.AI.APIKey, cfg.AI.Model, aiGate, aiRecorder),
			Store: st,
		}
```

(The surrounding `if cfg.AI.Enabled { … }` block, the `AllowAIExtraction` branch, and the log line stay unchanged.)

In `internal/server/categorize_job.go` (`runCategorize`), normalize the in-run cache key (add `"strings"` to imports):

```go
		key := strings.ToLower(strings.TrimSpace(item.MerchantRaw))
		res, cached := cache[key]
		if !cached {
			catID, status, ok, err := s.recatFn(ctx, item.MerchantRaw)
			res = recatOutcome{catID: catID, status: status, ok: ok, err: err}
			cache[key] = res
		}
```

(The one-line job-cache change is covered behaviorally by `TestMemoAICallsInnerOncePerMerchant` at the layer below; no separate server test.)

- [ ] **Step 4: Run tests**

Run: `go test ./internal/categorize/ ./internal/store/ ./internal/server/ ./cmd/... -count=1`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/store/schema.sql internal/store/suggestions.go internal/store/suggestions_test.go internal/categorize/memo.go internal/categorize/memo_test.go cmd/ledger/main.go internal/server/categorize_job.go
git commit -m "feat(categorize): persistent AI suggestion memo — never re-bill a merchant"
```

---

### Task 5: SQLite pragmas on the DSN + missing indexes

`synchronous` sits at FULL (double fsync per commit; NORMAL is crash-safe under WAL) and `foreign_keys=ON` is applied via `db.Exec`, reaching only one pooled connection — the file's own comment at `store.go:34-36` explains the hazard. Move both onto the DSN. Add the two missing indexes: `ingest_log(created_at)` (drift monitor full-scans the table every 5 min) and `transactions(ingest_id)` (reprocess does a full scan per email).

**Files:**
- Modify: `internal/store/store.go:37-50`
- Modify: `internal/store/schema.sql` (two `CREATE INDEX IF NOT EXISTS`)
- Test: `internal/store/pragmas_test.go` (new)

**Interfaces:**
- Consumes: `ai_suggestions` table from Task 4 (used as the FK-enforcement probe).
- Produces: nothing new — connection-level guarantees only.

- [ ] **Step 1: Write the failing test**

```go
// internal/store/pragmas_test.go
package store

import "testing"

func TestConnectionPragmasApplyToEveryConnection(t *testing.T) {
	st, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	var syncMode int
	if err := st.DB.QueryRow(`PRAGMA synchronous`).Scan(&syncMode); err != nil {
		t.Fatal(err)
	}
	if syncMode != 1 { // 1 = NORMAL
		t.Fatalf("synchronous = %d, want 1 (NORMAL)", syncMode)
	}

	// FK enforcement must hold on pooled connections (DSN, not one-shot Exec):
	// inserting a suggestion pointing at a nonexistent category must fail.
	_, err = st.DB.Exec(
		`INSERT INTO ai_suggestions (merchant_norm, category_id, confidence, created_at)
		 VALUES ('fk-probe', 999999, 0.5, '2026-01-01T00:00:00Z')`)
	if err == nil {
		t.Fatal("expected foreign-key violation, insert succeeded")
	}
}

func TestPerfIndexesExist(t *testing.T) {
	st, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	for _, idx := range []string{"idx_ingest_created", "idx_tx_ingest"} {
		var n int
		if err := st.DB.QueryRow(
			`SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name=?`, idx,
		).Scan(&n); err != nil {
			t.Fatal(err)
		}
		if n != 1 {
			t.Fatalf("index %s missing", idx)
		}
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/store/ -run 'TestConnectionPragmas|TestPerfIndexes' -v`
Expected: FAIL — `synchronous = 2, want 1` and `index idx_ingest_created missing`.

- [ ] **Step 3: Implement**

In `internal/store/store.go` replace the DSN line and delete the `foreign_keys` Exec block (keep the WAL Exec — `journal_mode` is a persistent DB-level setting):

```go
	// These pragmas ride on the DSN so every pooled connection gets them —
	// a PRAGMA via db.Exec only reaches the one connection that runs it.
	// busy_timeout: a second concurrent writer waits instead of failing with
	// SQLITE_BUSY. synchronous(NORMAL): crash-safe under WAL at roughly half
	// the fsync cost of the FULL default. foreign_keys: enforced everywhere,
	// not just on whichever connection ran a one-shot Exec.
	dsn := filepath.Join(dataDir, "ledger.db") +
		"?_pragma=busy_timeout(5000)&_pragma=synchronous(NORMAL)&_pragma=foreign_keys(ON)"
```

Remove:

```go
	if _, err := db.Exec("PRAGMA foreign_keys=ON;"); err != nil {
		db.Close()
		return nil, fmt.Errorf("set foreign_keys: %w", err)
	}
```

In `internal/store/schema.sql`: after the existing `idx_tx_fingerprint` line add

```sql
CREATE INDEX IF NOT EXISTS idx_tx_ingest ON transactions(ingest_id);
```

and after the `ingest_log` table definition add

```sql
-- Drift monitor aggregates over a recent created_at window every 5 minutes;
-- without this it full-scans the table each time.
CREATE INDEX IF NOT EXISTS idx_ingest_created ON ingest_log(created_at);
```

- [ ] **Step 4: Run tests**

Run: `go test ./internal/store/ -count=1` then `go test ./... -count=1` — FK enforcement is now real on every connection, so watch for tests that previously relied on it being silently off; fix any such test data (legitimate FK targets), never by dropping the pragma.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/store/store.go internal/store/schema.sql internal/store/pragmas_test.go
git commit -m "perf(store): DSN-level synchronous=NORMAL + foreign_keys, add ingest/tx indexes"
```

---

### Task 6: Debounce SSE-driven query invalidation (frontend)

Every SSE message invalidates all six query keys with `staleTime: 5s`, so a bulk import emitting one event per transaction fans out into N×6 refetches on the phone. Coalesce bursts with a trailing debounce plus a max-wait so the UI is never more than ~2s stale during a sustained burst.

**Files:**
- Create: `frontend/src/lib/liveInvalidation.ts`
- Modify: `frontend/src/hooks/useLiveEvents.ts`
- Test: `frontend/src/lib/liveInvalidation.test.ts` (new)

**Interfaces:**
- Produces: `createInvalidationScheduler(flush: () => void, delayMs?: number, maxWaitMs?: number): { schedule(): void; cancel(): void }` — pure, timer-based, framework-free (per the `lib/` convention).

- [ ] **Step 1: Write the failing test**

```ts
// frontend/src/lib/liveInvalidation.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createInvalidationScheduler } from "./liveInvalidation";

describe("createInvalidationScheduler", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("collapses a burst into one flush after the trailing delay", () => {
    const flush = vi.fn();
    const s = createInvalidationScheduler(flush, 300, 2000);
    for (let i = 0; i < 10; i++) {
      s.schedule();
      vi.advanceTimersByTime(50); // events 50ms apart — inside the 300ms window
    }
    expect(flush).not.toHaveBeenCalled();
    vi.advanceTimersByTime(300);
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it("max-wait flushes during a sustained burst", () => {
    const flush = vi.fn();
    const s = createInvalidationScheduler(flush, 300, 2000);
    // An event every 100ms for 3s: the trailing debounce alone would starve.
    for (let i = 0; i < 30; i++) {
      s.schedule();
      vi.advanceTimersByTime(100);
    }
    expect(flush.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it("cancel prevents any pending flush", () => {
    const flush = vi.fn();
    const s = createInvalidationScheduler(flush, 300, 2000);
    s.schedule();
    s.cancel();
    vi.advanceTimersByTime(5000);
    expect(flush).not.toHaveBeenCalled();
  });

  it("a flush resets state so the next event schedules again", () => {
    const flush = vi.fn();
    const s = createInvalidationScheduler(flush, 300, 2000);
    s.schedule();
    vi.advanceTimersByTime(300);
    s.schedule();
    vi.advanceTimersByTime(300);
    expect(flush).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && bunx vitest run src/lib/liveInvalidation.test.ts`
Expected: FAIL — cannot resolve `./liveInvalidation`.

- [ ] **Step 3: Implement**

Create `frontend/src/lib/liveInvalidation.ts`:

```ts
export type InvalidationScheduler = { schedule: () => void; cancel: () => void };

// Trailing debounce with a max-wait: a burst of SSE events collapses into one
// flush ~delayMs after the last event, but a sustained burst still flushes
// every maxWaitMs so the UI is never more than maxWaitMs stale.
export function createInvalidationScheduler(
  flush: () => void,
  delayMs = 300,
  maxWaitMs = 2000,
): InvalidationScheduler {
  let trailing: ReturnType<typeof setTimeout> | null = null;
  let deadline: ReturnType<typeof setTimeout> | null = null;

  const clear = () => {
    if (trailing) clearTimeout(trailing);
    if (deadline) clearTimeout(deadline);
    trailing = null;
    deadline = null;
  };
  const fire = () => {
    clear();
    flush();
  };

  return {
    schedule() {
      if (trailing) clearTimeout(trailing);
      trailing = setTimeout(fire, delayMs);
      if (!deadline) deadline = setTimeout(fire, maxWaitMs);
    },
    cancel: clear,
  };
}
```

Replace `frontend/src/hooks/useLiveEvents.ts` with:

```ts
import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { createInvalidationScheduler } from "../lib/liveInvalidation";

export const LIVE_INVALIDATE_KEYS = [["summary"], ["transactions"], ["review"], ["insights-categories"], ["insights-trend"], ["categorize-status"]] as const;

export function useLiveEvents() {
  const qc = useQueryClient();
  useEffect(() => {
    const es = new EventSource("/api/events");
    // Bulk operations emit one SSE message per transaction; invalidating all
    // keys per message refetches every active query N times on the phone.
    // Coalesce bursts: flush once shortly after the burst ends, with a
    // max-wait so a long import still repaints every couple of seconds.
    const scheduler = createInvalidationScheduler(() => {
      for (const key of LIVE_INVALIDATE_KEYS) {
        qc.invalidateQueries({ queryKey: [...key] });
      }
    });
    // The backend broadcasts transaction payloads as the default (unnamed) SSE
    // event — only the keepalive is a named "heartbeat" event. So we listen on
    // "message" (the default), NOT on named "tx"/"summary" events, which the
    // backend never emits. Drift alerts carry no view data, so we skip them.
    const onMessage = (e: MessageEvent) => {
      let type = "";
      try { type = (JSON.parse(e.data) as { type?: string })?.type ?? ""; } catch { /* non-JSON / heartbeat */ }
      if (type === "drift_alert") return;
      scheduler.schedule();
    };
    es.addEventListener("message", onMessage);
    es.onerror = () => { /* EventSource auto-reconnects */ };
    return () => {
      scheduler.cancel();
      es.close();
    };
  }, [qc]);
}
```

- [ ] **Step 4: Run tests**

Run: `cd frontend && bun run test`
Expected: PASS (all frontend tests, single-fork).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/liveInvalidation.ts frontend/src/lib/liveInvalidation.test.ts frontend/src/hooks/useLiveEvents.ts
git commit -m "perf(pwa): debounce SSE query invalidation to stop refetch storms"
```

---

### Task 7: Compress `raw_body` (gzip) + `ledger compact` backfill

164 MB of the 165 MB database is uncompressed raw email HTML that only the manual reprocess path ever reads. Gzip on write, transparently gunzip on read (magic-byte sniff keeps old plain rows working), and add a `ledger compact` subcommand that rewrites existing rows and VACUUMs. "Nothing is ever dropped" is preserved — bodies remain fully recoverable.

**Files:**
- Create: `internal/store/rawbody.go`
- Modify: `internal/store/ingest.go:32-53` (`InsertIngest` compresses)
- Modify: `internal/store/transactions.go` (`SelectForParse` scan decodes)
- Create: `internal/store/compact.go` (`CompressRawBodies`, `Vacuum`)
- Modify: `cmd/ledger/main.go` (dispatch `compact` subcommand — follow the existing `os.Args[1]` dispatch pattern used by `import`/`vapid-keys`)
- Test: `internal/store/rawbody_test.go` (new)

Before starting, run `grep -rn "raw_body" internal/ cmd/ --include='*.go'` — if any reader besides `SelectForParse`/`InsertIngest`/the new compact code touches the column, route it through `decodeBody` too and note it in the commit message.

**Interfaces:**
- Consumes: Task 3's `SelectForParse` scan shape (`var raw []byte` replaces `var raw string`).
- Produces: `compressBody([]byte) []byte`, `decodeBody([]byte) ([]byte, error)` (package-private); `store.CompressRawBodies() (int, error)`; `store.Vacuum() error`.

- [ ] **Step 1: Write the failing test**

```go
// internal/store/rawbody_test.go
package store

import (
	"bytes"
	"strings"
	"testing"
	"time"
)

func TestRawBodyRoundTripCompressed(t *testing.T) {
	st, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	body := []byte(strings.Repeat("<tr><td>transaction row</td></tr>\n", 500))
	if _, err := st.InsertIngest(IngestRecord{
		MessageUID: "u1", ParseStatus: "unparsed", RawBody: body,
		ReceivedAt: time.Now(), CreatedAt: time.Now(),
	}); err != nil {
		t.Fatal(err)
	}

	// Stored form must be gzip (much smaller, gzip magic prefix)...
	var stored []byte
	if err := st.DB.QueryRow(`SELECT raw_body FROM ingest_log WHERE message_uid='u1'`).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if !bytes.HasPrefix(stored, []byte{0x1f, 0x8b}) {
		t.Fatal("stored raw_body is not gzip")
	}
	if len(stored) >= len(body) {
		t.Fatalf("no size win: stored %d >= raw %d", len(stored), len(body))
	}

	// ...and the read path must return the original bytes.
	rows, err := st.SelectForParse(SelectForParseOpts{OnlyUnparsed: true})
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 || !bytes.Equal(rows[0].RawBody, body) {
		t.Fatal("SelectForParse did not round-trip the body")
	}
}

func TestLegacyPlainRowsStillReadAndCompact(t *testing.T) {
	st, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	// A pre-compression row: plain text inserted directly.
	plain := "legacy plain email body"
	if _, err := st.DB.Exec(
		`INSERT INTO ingest_log (message_uid, from_addr, subject, parse_status, raw_body, created_at)
		 VALUES ('legacy', 'a@b.c', 's', 'unparsed', ?, '2026-01-01T00:00:00Z')`, plain); err != nil {
		t.Fatal(err)
	}
	rows, err := st.SelectForParse(SelectForParseOpts{OnlyUnparsed: true})
	if err != nil || len(rows) != 1 || string(rows[0].RawBody) != plain {
		t.Fatalf("legacy row read failed: %v rows=%v", err, rows)
	}

	// Compact converts it in place; reads still return the original.
	n, err := st.CompressRawBodies()
	if err != nil || n != 1 {
		t.Fatalf("CompressRawBodies = %d, %v; want 1, nil", n, err)
	}
	var stored []byte
	if err := st.DB.QueryRow(`SELECT raw_body FROM ingest_log WHERE message_uid='legacy'`).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if !bytes.HasPrefix(stored, []byte{0x1f, 0x8b}) {
		t.Fatal("compact did not gzip the legacy row")
	}
	rows, _ = st.SelectForParse(SelectForParseOpts{OnlyUnparsed: true})
	if len(rows) != 1 || string(rows[0].RawBody) != plain {
		t.Fatal("post-compact read did not round-trip")
	}
	// Second run is a no-op.
	if n, err := st.CompressRawBodies(); err != nil || n != 0 {
		t.Fatalf("second compact = %d, %v; want 0, nil", n, err)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/store/ -run 'TestRawBody|TestLegacyPlain' -v`
Expected: FAIL — stored body has no gzip prefix; `undefined: CompressRawBodies`.

- [ ] **Step 3: Implement**

Create `internal/store/rawbody.go`:

```go
package store

import (
	"bytes"
	"compress/gzip"
	"io"
)

var gzipMagic = []byte{0x1f, 0x8b}

// compressBody gzips a raw email body for storage. Bodies are write-once and
// read only by reprocess, so a ~10x size reduction on write is effectively free.
func compressBody(raw []byte) []byte {
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	_, _ = zw.Write(raw)
	_ = zw.Close()
	return buf.Bytes()
}

// decodeBody transparently gunzips a stored raw_body. Rows written before
// compression landed are plain and pass through unchanged (magic-byte sniff).
func decodeBody(stored []byte) ([]byte, error) {
	if !bytes.HasPrefix(stored, gzipMagic) {
		return stored, nil
	}
	zr, err := gzip.NewReader(bytes.NewReader(stored))
	if err != nil {
		return nil, err
	}
	defer zr.Close()
	return io.ReadAll(zr)
}
```

In `internal/store/ingest.go` `InsertIngest`, change the `raw_body` argument from `string(r.RawBody)` to:

```go
		compressBody(r.RawBody),
```

In `internal/store/transactions.go` `SelectForParse`, change the scan to bytes + decode:

```go
	for rows.Next() {
		var r IngestForParse
		var raw []byte
		if err := rows.Scan(&r.ID, &r.FromAddr, &r.Subject, &r.ParseStatus, &raw); err != nil {
			return nil, err
		}
		body, err := decodeBody(raw)
		if err != nil {
			return nil, err
		}
		r.RawBody = body
		out = append(out, r)
	}
```

Create `internal/store/compact.go`:

```go
package store

import "bytes"

// CompressRawBodies gzips every still-plain raw_body in ingest_log, in id-order
// batches so the whole table is never held in memory. Returns how many rows
// were converted. Idempotent: already-gzipped rows are skipped.
func (s *Store) CompressRawBodies() (int, error) {
	converted := 0
	lastID := int64(0)
	for {
		type rowT struct {
			id  int64
			raw []byte
		}
		var batch []rowT
		rows, err := s.DB.Query(
			`SELECT id, raw_body FROM ingest_log
			  WHERE id > ? AND raw_body IS NOT NULL ORDER BY id LIMIT 200`, lastID)
		if err != nil {
			return converted, err
		}
		for rows.Next() {
			var r rowT
			if err := rows.Scan(&r.id, &r.raw); err != nil {
				rows.Close()
				return converted, err
			}
			batch = append(batch, r)
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return converted, err
		}
		rows.Close()
		if len(batch) == 0 {
			return converted, nil
		}
		for _, r := range batch {
			lastID = r.id
			if bytes.HasPrefix(r.raw, gzipMagic) {
				continue
			}
			if _, err := s.DB.Exec(
				`UPDATE ingest_log SET raw_body=? WHERE id=?`, compressBody(r.raw), r.id); err != nil {
				return converted, err
			}
			converted++
		}
	}
}

// Vacuum reclaims file space after CompressRawBodies rewrote the big rows.
func (s *Store) Vacuum() error {
	_, err := s.DB.Exec("VACUUM")
	return err
}
```

In `cmd/ledger/main.go`, add a `compact` case to the existing `os.Args[1]` subcommand dispatch (same pattern as `import`/`vapid-keys` — inspect the top of `main()` and mirror it), implemented as:

```go
// runCompact gzips historical raw_body rows and VACUUMs to reclaim space.
// Run it with the service stopped; VACUUM needs the database to itself.
func runCompact(args []string) {
	fs := flag.NewFlagSet("compact", flag.ExitOnError)
	configPath := fs.String("config", "", "path to config.toml")
	_ = fs.Parse(args)
	cfg, err := config.Load(*configPath)
	if err != nil {
		log.Fatalf("config: %v", err)
	}
	st, err := store.Open(cfg.Server.DataDir)
	if err != nil {
		log.Fatalf("open store: %v", err)
	}
	defer st.Close()
	n, err := st.CompressRawBodies()
	if err != nil {
		log.Fatalf("compress: %v (converted %d rows before failing; rerun to continue)", err, n)
	}
	log.Printf("compressed %d raw bodies; running VACUUM (may take a minute)…", n)
	if err := st.Vacuum(); err != nil {
		log.Fatalf("vacuum: %v", err)
	}
	log.Printf("compact done")
}
```

(Match the exact `config.Load` signature and dispatch style already in the file — read them first; if `config.Load` takes different arguments, follow the `import` subcommand's usage.)

- [ ] **Step 4: Run tests**

Run: `go test ./internal/store/ ./internal/parse/ -count=1 && go build ./...`
Expected: PASS; binary builds.

- [ ] **Step 5: Commit**

```bash
git add internal/store/rawbody.go internal/store/rawbody_test.go internal/store/ingest.go internal/store/transactions.go internal/store/compact.go cmd/ledger/main.go
git commit -m "feat(store): gzip raw email bodies + ledger compact backfill subcommand"
```

---

### Task 8: Ship it — dist rebuild, merge, prod config, deploy

**STOP: confirm with the user before executing this task** — it restarts the production service and rewrites the production DB (compact).

**Files:**
- Modify: `deploy/ledger.service` (add memory ceiling)
- Modify (on host, not in repo): `/etc/ledger/config.toml` (IDLE + poll interval)

- [ ] **Step 1: Add the memory ceiling to the unit file**

In `deploy/ledger.service` under `[Service]` add:

```ini
# This box doubles as the dev machine; cap the service so a leak can never
# starve interactive work. Steady-state RSS is ~250M.
MemoryMax=384M
```

Commit: `git add deploy/ledger.service && git commit -m "deploy: cap service memory (shared dev box)"`

- [ ] **Step 2: Full verification on the branch**

```bash
go test ./... -count=1        # only tolerated failure: internal/config env quirk (verify with env -u LEDGER_AI_API_KEY)
go vet ./...
cd frontend && bun run test && bun run build && cd ..
CGO_ENABLED=0 go build -o ledger ./cmd/ledger
git add internal/web/dist && git commit -m "build: embed rebuilt PWA dist" # only if dist changed
```

- [ ] **Step 3: Merge to main** — use superpowers:finishing-a-development-branch. Before merging: re-check `main` for parallel-session commits and rebuild the combined dist if `main` moved; remove any untracked copy of this plan file in the main checkout if the branch commits it (known merge-collision footgun).

- [ ] **Step 4: Deploy (run as root, step by step — no `set -e` chains)**

```bash
# 1. Backup (root-owned /var/backups; do NOT sudo -u ledger)
sqlite3 /var/lib/ledger/ledger.db ".backup /var/backups/ledger-$(date +%Y%m%d-%H%M%S).db"

# 2. Stop, install, compact (compact needs the DB to itself for VACUUM)
systemctl stop ledger
install -m 755 ledger /usr/local/bin/ledger
sudo -u ledger /usr/local/bin/ledger compact -config /etc/ledger/config.toml

# 3. Prod config: IDLE + relaxed poll (new mail stays instant via IDLE;
#    the poll becomes a fallback heartbeat)
#    Edit /etc/ledger/config.toml [imap]:  use_idle = true, poll_interval = "15m"

# 4. Restart + verify
systemctl daemon-reload && systemctl start ledger
```

- [ ] **Step 5: Post-deploy verification**

```bash
# The running process must be the new binary (inode match — not just green health)
ls -i /usr/local/bin/ledger && ls -l /proc/$(systemctl show -p MainPID --value ledger)/exe
journalctl -u ledger -n 20 --no-pager        # expect "idle+poll, interval 15m0s"
curl -s localhost:8080/api/health            # ingest may show "starting" for minutes (7k-UID first sync — not a hang)
du -sh /var/lib/ledger/ledger.db             # expect ~20 MB, down from 165 MB
sqlite3 'file:/var/lib/ledger/ledger.db?mode=ro' 'PRAGMA synchronous'   # informational; service conn uses DSN
```

Then confirm one poll cycle ingests cleanly and (after the next real bank email) that the review flow still shows it.
