# AI Usage Transparency & Trustworthy Kill Switch — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make "AI off" provably stop all Anthropic API calls, and record + surface every call's tokens and cost in the app, with a monthly spend cap that hard-latches AI off.

**Architecture:** A single gate at the one HTTP egress point (`anthropic.Retrier.Post`) refuses all calls when AI is off / no key / cap latched — both AI paths (extraction, categorization) funnel through it. An `ai_usage` SQLite table records real token counts and integer micro-USD cost at the two call sites. A trailing-30-day sum against `app_settings.ai_spend_cap_musd` hard-latches AI off (`ai_enabled=0`, `ai_cap_latched=1`) and fires a push. A new settings page shows cost, call count, per-call log, and the cap control.

**Tech Stack:** Go (stdlib `net/http`, pure-Go SQLite via `store`), React 18 + TS + Vite + TanStack Query, Tailwind v4.

## Global Constraints

- Money is **integer minor units, never floats**. AI cost is stored as int64 **micro-USD** (µ$, 1e-6 USD; $200 = 200_000_000). Token→cost math is exact integer arithmetic.
- Go SQLite schema is additive only: `CREATE TABLE IF NOT EXISTS` in `internal/store/schema.sql` plus `addColumnIfMissing(db, table, col, ddl)` in `internal/store/store.go` (`Open` runs these). There is no migration tool.
- Build order: frontend (`cd frontend && bun run build` → `internal/web/dist/`) **before** `CGO_ENABLED=0 go build -o ledger ./cmd/ledger`. `internal/web/dist/` is a committed artifact — rebuild before finishing the branch.
- Go tests live beside code as `*_test.go`. Frontend tests are `*.test.ts(x)` run with `bunx vitest run <file>` (vitest is pinned single-fork — do not change).
- `frontend/src/lib/` holds pure, framework-free helpers each with a co-located `*.test.ts`. Extract non-trivial UI logic there.
- Mobile UI conventions (`frontend/src/components/README.md`): 44px tap targets, 16px inputs, `.press` feedback, Dialog-only overlays. Update that catalog if a shared component is added.
- Secrets are env-only. The API key presence is already exposed as `server.aiKeyPresent` (set from `cfg.AI.APIKey != ""`).

---

### Task 1: Price table, cost helper, Usage/Recorder types, gate error (`internal/anthropic`)

Pure additions to the `anthropic` package — the shared types the gate, recorder, and callers use. No behavior change to `Retrier` yet (Task 2).

**Files:**
- Create: `internal/anthropic/usage.go`
- Test: `internal/anthropic/usage_test.go`

**Interfaces:**
- Produces:
  - `var ErrAIDisabled = errors.New("anthropic: AI disabled")`
  - `type Usage struct { Path, Model string; InputTokens, OutputTokens int64; OK bool; Detail string }`
  - `type Recorder func(Usage)`
  - `var PriceMuUSD map[string]struct{ In, Out int64 }`
  - `func CostMuUSD(model string, inTok, outTok int64) int64`

- [ ] **Step 1: Write the failing test**

```go
// internal/anthropic/usage_test.go
package anthropic

import "testing"

func TestCostMuUSD(t *testing.T) {
	cases := []struct {
		name           string
		model          string
		in, out, want  int64
	}{
		{"haiku basic", "claude-haiku-4-5-20251001", 1000, 100, 1500},   // 1000*1 + 100*5
		{"haiku alias", "claude-haiku-4-5", 812, 47, 1047},              // 812*1 + 47*5
		{"opus", "claude-opus-4-8", 1000, 100, 7500},                    // 1000*5 + 100*25
		{"unknown model -> zero", "made-up-model", 1000, 100, 0},
		{"zero tokens", "claude-haiku-4-5", 0, 0, 0},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := CostMuUSD(c.model, c.in, c.out); got != c.want {
				t.Fatalf("CostMuUSD(%q,%d,%d) = %d, want %d", c.model, c.in, c.out, got, c.want)
			}
		})
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/anthropic/ -run TestCostMuUSD -v`
Expected: FAIL — `undefined: CostMuUSD`.

- [ ] **Step 3: Write minimal implementation**

```go
// internal/anthropic/usage.go
package anthropic

import "errors"

// ErrAIDisabled is returned by Retrier.Post when the gate refuses a call. Callers
// treat it like any other Post failure (extraction skips its tier; categorization
// surfaces the error and the transaction stays in the review queue).
var ErrAIDisabled = errors.New("anthropic: AI disabled")

// Usage is one recorded Anthropic call. Path is "extract" or "categorize".
type Usage struct {
	Path         string
	Model        string
	InputTokens  int64
	OutputTokens int64
	OK           bool
	Detail       string
}

// Recorder persists a Usage. A nil Recorder means "don't record".
type Recorder func(Usage)

// PriceMuUSD is micro-USD (1e-6 USD) per token, per model. $1/Mtok input == 1 muUSD/token.
// Unknown models resolve to {0,0} — tokens are still recorded, cost shows as unknown.
var PriceMuUSD = map[string]struct{ In, Out int64 }{
	"claude-haiku-4-5-20251001": {In: 1, Out: 5},   // $1 / $5 per Mtok
	"claude-haiku-4-5":          {In: 1, Out: 5},
	"claude-opus-4-8":           {In: 5, Out: 25},  // $5 / $25 per Mtok
	"claude-sonnet-5":           {In: 3, Out: 15},  // $3 / $15 per Mtok
}

// CostMuUSD computes exact integer micro-USD cost for a call. Unknown model -> 0.
func CostMuUSD(model string, inTok, outTok int64) int64 {
	p, ok := PriceMuUSD[model]
	if !ok {
		return 0
	}
	return inTok*p.In + outTok*p.Out
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./internal/anthropic/ -run TestCostMuUSD -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/anthropic/usage.go internal/anthropic/usage_test.go
git commit -m "feat(anthropic): AI usage types, price table, cost helper, ErrAIDisabled"
```

---

### Task 2: Egress gate in `Retrier.Post` — the trust anchor (`internal/anthropic`)

Add an optional `Gate func() error` checked before any network I/O. This is the invariant "off means off" rests on.

**Files:**
- Modify: `internal/anthropic/retry.go` (add `Gate` field to `Retrier`; check at top of `Post`, ~line 47)
- Test: `internal/anthropic/retry_test.go` (add cases; file exists)

**Interfaces:**
- Consumes: `ErrAIDisabled` (Task 1).
- Produces: `Retrier.Gate func() error` field. When non-nil and it returns non-nil, `Post` returns that error and makes **zero** HTTP requests.

- [ ] **Step 1: Write the failing test**

```go
// append to internal/anthropic/retry_test.go
func TestPostGateBlocksAllEgress(t *testing.T) {
	var hits int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		w.WriteHeader(200)
	}))
	defer srv.Close()

	r := New(srv.Client())
	r.Gate = func() error { return ErrAIDisabled }

	resp, err := r.Post(context.Background(), srv.URL, "key", []byte(`{}`))
	if !errors.Is(err, ErrAIDisabled) {
		t.Fatalf("err = %v, want ErrAIDisabled", err)
	}
	if resp != nil {
		t.Fatalf("resp = %v, want nil", resp)
	}
	if hits != 0 {
		t.Fatalf("server received %d requests, want 0 — gate must block before any I/O", hits)
	}
}

func TestPostGateAllowsWhenNil(t *testing.T) {
	var hits int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		w.WriteHeader(200)
	}))
	defer srv.Close()

	r := New(srv.Client()) // Gate nil
	resp, err := r.Post(context.Background(), srv.URL, "key", []byte(`{}`))
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	resp.Body.Close()
	if hits != 1 {
		t.Fatalf("server received %d requests, want 1", hits)
	}
}
```

Ensure the test file imports `errors`, `context`, `net/http`, `net/http/httptest` (add any missing to the existing import block).

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/anthropic/ -run TestPostGate -v`
Expected: FAIL — `r.Gate undefined`.

- [ ] **Step 3: Write minimal implementation**

In `internal/anthropic/retry.go`, add the field to the `Retrier` struct (after the `sleep` field):

```go
	// Gate, if non-nil, is consulted at the top of Post before any request is built
	// or sent. A non-nil return aborts the call with no network I/O. This is the
	// single choke point that makes "AI off" mean zero egress.
	Gate func() error
```

Then as the **first statement** inside `func (r *Retrier) Post(...)` (before `backoff := r.Backoff`):

```go
	if r.Gate != nil {
		if err := r.Gate(); err != nil {
			return nil, err
		}
	}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./internal/anthropic/ -v`
Expected: PASS (all, including existing retry tests).

- [ ] **Step 5: Commit**

```bash
git add internal/anthropic/retry.go internal/anthropic/retry_test.go
git commit -m "feat(anthropic): gate Post at the egress boundary (off == zero calls)"
```

---

### Task 3: Store — `ai_usage` table, cap columns, record/sum/stats/latch (`internal/store`)

**Files:**
- Modify: `internal/store/schema.sql` (add `ai_usage` table after `import_log`)
- Modify: `internal/store/store.go` (three `addColumnIfMissing` calls; see below)
- Create: `internal/store/ai_usage.go`
- Modify: `internal/store/settings.go` (add fields + read/write cap columns; clear latch on enable)
- Test: `internal/store/ai_usage_test.go`
- Test: `internal/store/settings_test.go` (extend — file exists)

**Interfaces:**
- Produces:
  - `type AIUsageRow struct { At int64; Path, Model string; InputTokens, OutputTokens, CostMuUSD int64; OK bool; Detail string }`
  - `type AIUsageStats struct { Count30d int; Cost30dMuUSD int64; CountAll int; CostAllMuUSD int64 }`
  - `func (s *Store) RecordAIUsage(row AIUsageRow) (latched bool, err error)` — inserts; if `ai_spend_cap_musd > 0` and trailing-30d sum ≥ cap and not already latched, sets `ai_enabled=0, ai_cap_latched=1` and returns `latched=true`. Uses `s.now()`.
  - `func (s *Store) SumAIUsageMuUSD(since int64) (int64, error)`
  - `func (s *Store) AIUsageStats(now int64) (AIUsageStats, error)`
  - `func (s *Store) RecentAIUsage(limit int) ([]AIUsageRow, error)`
  - `func (s *Store) SetNow(fn func() int64)` — test seam for time (default `time.Now().Unix`).
  - `AppSettings` gains `SpendCapMuUSD int64` and `CapLatched bool`. `SelectAppSettings` reads them; `UpdateAppSettings` writes `ai_spend_cap_musd`; **and** whenever `AIEnabled` is true it clears `ai_cap_latched` (re-enable clears the latch).

- [ ] **Step 1: Add the schema + columns + `now` seam**

In `internal/store/schema.sql`, after the `import_log` table block, add:

```sql
-- Anthropic API usage log — one row per call for cost transparency.
CREATE TABLE IF NOT EXISTS ai_usage (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  at            INTEGER NOT NULL,   -- unix seconds
  path          TEXT    NOT NULL,   -- 'extract' | 'categorize'
  model         TEXT    NOT NULL,
  input_tokens  INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cost_musd     INTEGER NOT NULL,   -- micro-USD (1e-6 USD)
  ok            INTEGER NOT NULL,   -- 1 = 200 response, 0 = error
  detail        TEXT
);
CREATE INDEX IF NOT EXISTS idx_ai_usage_at ON ai_usage(at);
```

In `internal/store/store.go`, change the final migration chain so the last existing call is no longer the `return`, and add the two cap columns. Replace line 95 (`return addColumnIfMissing(db, "transactions", "last4", "TEXT")`) with:

```go
	if err := addColumnIfMissing(db, "transactions", "last4", "TEXT"); err != nil {
		return err
	}
	if err := addColumnIfMissing(db, "app_settings", "ai_spend_cap_musd", "INTEGER NOT NULL DEFAULT 0"); err != nil {
		return err
	}
	return addColumnIfMissing(db, "app_settings", "ai_cap_latched", "INTEGER NOT NULL DEFAULT 0")
```

Add a `now` field + seam to the `Store` struct. Find the `Store` struct definition in `store.go` and add field `now func() int64`; in `Open`, after the struct is constructed, set `s.now = func() int64 { return time.Now().Unix() }` (import `time` if not already). Add:

```go
// SetNow overrides the clock used for usage timestamps and cap windows (tests only).
func (s *Store) SetNow(fn func() int64) { s.now = fn }
```

- [ ] **Step 2: Write the failing test**

```go
// internal/store/ai_usage_test.go
package store

import "testing"

func newTestStore(t *testing.T) *Store {
	t.Helper()
	st, err := Open(t.TempDir())
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	t.Cleanup(func() { st.Close() })
	if err := st.EnsureAppSettings(); err != nil {
		t.Fatalf("ensure settings: %v", err)
	}
	return st
}

func TestRecordAndSumAIUsage(t *testing.T) {
	st := newTestStore(t)
	now := int64(1_000_000)
	st.SetNow(func() int64 { return now })

	if _, err := st.RecordAIUsage(AIUsageRow{Path: "extract", Model: "m", InputTokens: 10, OutputTokens: 2, CostMuUSD: 20, OK: true}); err != nil {
		t.Fatal(err)
	}
	// A row 40 days old must fall outside the 30-day window.
	old := now - 40*24*3600
	if _, err := st.RecordAIUsage(AIUsageRow{At: old, Path: "categorize", Model: "m", CostMuUSD: 500, OK: true}); err != nil {
		t.Fatal(err)
	}
	sum, err := st.SumAIUsageMuUSD(now - 30*24*3600)
	if err != nil {
		t.Fatal(err)
	}
	if sum != 20 {
		t.Fatalf("30d sum = %d, want 20 (old row excluded)", sum)
	}
	stats, err := st.AIUsageStats(now)
	if err != nil {
		t.Fatal(err)
	}
	if stats.CountAll != 2 || stats.Count30d != 1 || stats.CostAllMuUSD != 520 {
		t.Fatalf("stats = %+v", stats)
	}
}

func TestCapLatchDisablesAI(t *testing.T) {
	st := newTestStore(t)
	now := int64(2_000_000)
	st.SetNow(func() int64 { return now })

	s, _ := st.SelectAppSettings()
	s.AIEnabled = true
	s.SpendCapMuUSD = 100
	if err := st.UpdateAppSettings(s); err != nil {
		t.Fatal(err)
	}

	// Under cap: no latch.
	latched, err := st.RecordAIUsage(AIUsageRow{Path: "extract", Model: "m", CostMuUSD: 60, OK: true})
	if err != nil || latched {
		t.Fatalf("latched=%v err=%v, want false/nil", latched, err)
	}
	// Crossing cap: latch, AI disabled.
	latched, err = st.RecordAIUsage(AIUsageRow{Path: "extract", Model: "m", CostMuUSD: 60, OK: true})
	if err != nil {
		t.Fatal(err)
	}
	if !latched {
		t.Fatal("expected latched=true after crossing cap")
	}
	got, _ := st.SelectAppSettings()
	if got.AIEnabled {
		t.Fatal("AIEnabled should be false after latch")
	}
	if !got.CapLatched {
		t.Fatal("CapLatched should be true after latch")
	}
}

func TestReEnableClearsLatch(t *testing.T) {
	st := newTestStore(t)
	s, _ := st.SelectAppSettings()
	s.CapLatched = true
	s.AIEnabled = false
	if err := st.UpdateAppSettings(s); err != nil {
		t.Fatal(err)
	}
	// Turning AI back on clears the latch.
	s.AIEnabled = true
	if err := st.UpdateAppSettings(s); err != nil {
		t.Fatal(err)
	}
	got, _ := st.SelectAppSettings()
	if got.CapLatched {
		t.Fatal("re-enabling AI must clear CapLatched")
	}
}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `go test ./internal/store/ -run 'AIUsage|CapLatch|ReEnable' -v`
Expected: FAIL — `undefined: AIUsageRow` / `RecordAIUsage`.

- [ ] **Step 4: Implement `ai_usage.go`**

```go
// internal/store/ai_usage.go
package store

// AIUsageRow is one recorded Anthropic call. At is unix seconds; if zero on insert
// it defaults to the store clock (s.now()).
type AIUsageRow struct {
	At           int64
	Path         string
	Model        string
	InputTokens  int64
	OutputTokens int64
	CostMuUSD    int64
	OK           bool
	Detail       string
}

// AIUsageStats aggregates usage over all time and the trailing 30 days.
type AIUsageStats struct {
	Count30d     int
	Cost30dMuUSD int64
	CountAll     int
	CostAllMuUSD int64
}

// RecordAIUsage inserts one usage row. It then enforces the monthly spend cap: if
// ai_spend_cap_musd > 0 and the trailing-30-day cost sum has reached the cap and AI
// is not already latched off, it sets ai_enabled=0 and ai_cap_latched=1 and returns
// latched=true. Callers fire a push notification when latched is true.
func (s *Store) RecordAIUsage(row AIUsageRow) (latched bool, err error) {
	at := row.At
	if at == 0 {
		at = s.now()
	}
	oki := 0
	if row.OK {
		oki = 1
	}
	if _, err = s.DB.Exec(
		`INSERT INTO ai_usage (at, path, model, input_tokens, output_tokens, cost_musd, ok, detail)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		at, row.Path, row.Model, row.InputTokens, row.OutputTokens, row.CostMuUSD, oki, row.Detail,
	); err != nil {
		return false, err
	}

	cur, err := s.SelectAppSettings()
	if err != nil {
		return false, err
	}
	if cur.SpendCapMuUSD <= 0 || cur.CapLatched {
		return false, nil
	}
	sum, err := s.SumAIUsageMuUSD(s.now() - 30*24*3600)
	if err != nil {
		return false, err
	}
	if sum < cur.SpendCapMuUSD {
		return false, nil
	}
	if _, err = s.DB.Exec(
		`UPDATE app_settings SET ai_enabled=0, ai_cap_latched=1 WHERE id=1`,
	); err != nil {
		return false, err
	}
	return true, nil
}

// SumAIUsageMuUSD returns total cost_musd for successful+failed rows at or after `since`.
func (s *Store) SumAIUsageMuUSD(since int64) (int64, error) {
	var sum int64
	err := s.DB.QueryRow(
		`SELECT COALESCE(SUM(cost_musd), 0) FROM ai_usage WHERE at >= ?`, since,
	).Scan(&sum)
	return sum, err
}

// AIUsageStats aggregates all-time and trailing-30-day counts and cost.
func (s *Store) AIUsageStats(now int64) (AIUsageStats, error) {
	var a AIUsageStats
	if err := s.DB.QueryRow(
		`SELECT COUNT(*), COALESCE(SUM(cost_musd),0) FROM ai_usage`,
	).Scan(&a.CountAll, &a.CostAllMuUSD); err != nil {
		return a, err
	}
	since := now - 30*24*3600
	if err := s.DB.QueryRow(
		`SELECT COUNT(*), COALESCE(SUM(cost_musd),0) FROM ai_usage WHERE at >= ?`, since,
	).Scan(&a.Count30d, &a.Cost30dMuUSD); err != nil {
		return a, err
	}
	return a, nil
}

// RecentAIUsage returns the most recent `limit` rows, newest first.
func (s *Store) RecentAIUsage(limit int) ([]AIUsageRow, error) {
	rows, err := s.DB.Query(
		`SELECT at, path, model, input_tokens, output_tokens, cost_musd, ok, COALESCE(detail,'')
		 FROM ai_usage ORDER BY at DESC, id DESC LIMIT ?`, limit,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []AIUsageRow
	for rows.Next() {
		var r AIUsageRow
		var oki int
		if err := rows.Scan(&r.At, &r.Path, &r.Model, &r.InputTokens, &r.OutputTokens, &r.CostMuUSD, &oki, &r.Detail); err != nil {
			return nil, err
		}
		r.OK = oki == 1
		out = append(out, r)
	}
	return out, rows.Err()
}
```

- [ ] **Step 5: Extend `settings.go`**

Add fields to `AppSettings`:

```go
	SpendCapMuUSD int64
	CapLatched    bool
```

Update `SelectAppSettings` — extend the SELECT and Scan:

```go
	var auto, aiOn, aiAccept, latched int
	err := s.DB.QueryRow(
		`SELECT auto_categorize, ai_enabled, ai_auto_accept, ai_threshold, ingest_silence_days,
		        ai_spend_cap_musd, ai_cap_latched
		 FROM app_settings WHERE id=1`,
	).Scan(&auto, &aiOn, &aiAccept, &a.AIThreshold, &a.IngestSilenceDays, &a.SpendCapMuUSD, &latched)
	a.AutoCategorize = auto == 1
	a.AIEnabled = aiOn == 1
	a.AIAutoAccept = aiAccept == 1
	a.CapLatched = latched == 1
	return a, err
```

Update `UpdateAppSettings` — write the cap, and clear the latch whenever AI is enabled:

```go
func (s *Store) UpdateAppSettings(a AppSettings) error {
	latched := boolToInt(a.CapLatched)
	if a.AIEnabled {
		latched = 0 // re-enabling AI always clears the cap latch
	}
	_, err := s.DB.Exec(
		`UPDATE app_settings
		   SET auto_categorize=?, ai_enabled=?, ai_auto_accept=?, ai_threshold=?,
		       ingest_silence_days=?, ai_spend_cap_musd=?, ai_cap_latched=?
		 WHERE id=1`,
		boolToInt(a.AutoCategorize), boolToInt(a.AIEnabled), boolToInt(a.AIAutoAccept),
		a.AIThreshold, a.IngestSilenceDays, a.SpendCapMuUSD, latched,
	)
	return err
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `go test ./internal/store/ -v`
Expected: PASS (new AI usage tests + existing settings tests).

- [ ] **Step 7: Commit**

```bash
git add internal/store/schema.sql internal/store/store.go internal/store/ai_usage.go internal/store/settings.go internal/store/ai_usage_test.go internal/store/settings_test.go
git commit -m "feat(store): ai_usage table, spend cap columns, record/sum/stats/latch"
```

---

### Task 4: Wire gate + recording into both AI clients (`internal/parse`, `internal/categorize`)

Both clients must (a) route their `Retrier` through the shared gate, and (b) decode `usage`+`model` from the response and call a `Recorder`. Constructors gain `gate func() error` and `rec anthropic.Recorder` params.

**Files:**
- Modify: `internal/parse/ai.go` (`AnthropicExtractor`, `NewAnthropicExtractor`, `Extract`, `extractResp`)
- Modify: `internal/categorize/ai.go` (`AnthropicCategorizer`, `NewAnthropicCategorizer`, `Categorize`, `anthropicCategResp`)
- Test: `internal/parse/ai_test.go` (extend — file exists)
- Test: `internal/categorize/ai_test.go` (extend — file exists)

**Interfaces:**
- Consumes: `anthropic.Recorder`, `anthropic.Usage`, `anthropic.CostMuUSD` are not needed here (cost computed by the recorder impl in Task 5); this task passes raw tokens+model in `anthropic.Usage`.
- Produces:
  - `func NewAnthropicExtractor(apiKey, model string, gate func() error, rec anthropic.Recorder) *AnthropicExtractor`
  - `func NewAnthropicCategorizer(apiKey, model string, gate func() error, rec anthropic.Recorder) *AnthropicCategorizer`
  - On a 200, each calls `rec(anthropic.Usage{Path, Model, InputTokens, OutputTokens, OK:true, Detail})`. On `ErrAIDisabled` (gated), **no** record. On non-200/decode failure, records `OK:false` with zero tokens.

- [ ] **Step 1: Write the failing tests**

Extractor test (`internal/parse/ai_test.go`, add):

```go
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
```

Categorizer test (`internal/categorize/ai_test.go`, add analogous):

```go
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
```

Add missing imports (`net/http`, `net/http/httptest`, `context`, `ledger/internal/anthropic`) to each test file as needed.

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./internal/parse/ ./internal/categorize/ -run Usage -v`
Expected: FAIL — constructor arity mismatch / `usage` not decoded.

- [ ] **Step 3: Implement extractor changes (`internal/parse/ai.go`)**

Add fields `gate func() error` and `rec anthropic.Recorder` to `AnthropicExtractor`. Change the constructor:

```go
func NewAnthropicExtractor(apiKey, model string, gate func() error, rec anthropic.Recorder) *AnthropicExtractor {
	r := anthropic.New(nil)
	r.Gate = gate
	return &AnthropicExtractor{
		apiKey:   apiKey,
		model:    model,
		endpoint: "https://api.anthropic.com/v1/messages",
		retry:    r,
		gate:     gate,
		rec:      rec,
	}
}
```

Extend `extractResp` to capture usage + model:

```go
type extractResp struct {
	Model   string `json:"model"`
	Content []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	} `json:"content"`
	Usage struct {
		InputTokens  int64 `json:"input_tokens"`
		OutputTokens int64 `json:"output_tokens"`
	} `json:"usage"`
}
```

In `Extract`, after `resp` returns without a gate error and the status is 200, record usage. Add a helper and call it once you have `apiResp` decoded (record even if later validation fails — the call still cost tokens). Concretely, after `json.NewDecoder(resp.Body).Decode(&apiResp)` succeeds, insert:

```go
	if a.rec != nil {
		model := apiResp.Model
		if model == "" {
			model = a.model
		}
		a.rec(anthropic.Usage{
			Path: "extract", Model: model,
			InputTokens: apiResp.Usage.InputTokens, OutputTokens: apiResp.Usage.OutputTokens,
			OK: true, Detail: "",
		})
	}
```

For the non-200 branch (`resp.StatusCode != http.StatusOK`), before returning the error record a failure row:

```go
	if resp.StatusCode != http.StatusOK {
		if a.rec != nil {
			a.rec(anthropic.Usage{Path: "extract", Model: a.model, OK: false})
		}
		return ParsedTxn{}, fmt.Errorf("ai: unexpected status %d", resp.StatusCode)
	}
```

Do **not** record when `a.retry.Post` returns `ErrAIDisabled` — that path returns before the status check, so no record happens (the existing `if err != nil { return ... }` after `Post` already covers it).

- [ ] **Step 4: Implement categorizer changes (`internal/categorize/ai.go`)**

Symmetric. Add `gate func() error`, `rec anthropic.Recorder` fields; constructor:

```go
func NewAnthropicCategorizer(apiKey, model string, gate func() error, rec anthropic.Recorder) *AnthropicCategorizer {
	r := anthropic.New(nil)
	r.Gate = gate
	return &AnthropicCategorizer{
		apiKey:   apiKey,
		model:    model,
		endpoint: "https://api.anthropic.com/v1/messages",
		retry:    r,
		gate:     gate,
		rec:      rec,
	}
}
```

Extend `anthropicCategResp` with `Model string json:"model"` and a `Usage` struct (same shape as above). After decoding the response body successfully, and before returning, record:

```go
	if a.rec != nil {
		model := ar.Model
		if model == "" {
			model = a.model
		}
		a.rec(anthropic.Usage{
			Path: "categorize", Model: model,
			InputTokens: ar.Usage.InputTokens, OutputTokens: ar.Usage.OutputTokens,
			OK: true, Detail: merchant,
		})
	}
```

And in the non-200 branch record `OK:false` (Path "categorize", Model a.model, Detail merchant) before returning the status error.

- [ ] **Step 5: Run tests to verify they pass**

Run: `go test ./internal/parse/ ./internal/categorize/ -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add internal/parse/ai.go internal/categorize/ai.go internal/parse/ai_test.go internal/categorize/ai_test.go
git commit -m "feat(parse,categorize): gate AI clients + record usage per call"
```

---

### Task 5: Wire gate + recorder in `main.go` (`cmd/ledger`)

Build the live gate closure and the recorder closure (store write + cost + cap-latch push), and pass them into both AI client constructors. Reorder so the push sender exists before the recorder is built.

**Files:**
- Modify: `cmd/ledger/main.go` (AI client construction ~lines 124-136; push setup ~lines 201-217)

**Interfaces:**
- Consumes: `anthropic.CostMuUSD`, `anthropic.Usage`, `store.AIUsageRow`, `store.RecordAIUsage`, `push.Sender`, `NewAnthropicExtractor/Categorizer` (Task 4).
- Produces: no new exported symbols — wiring only.

- [ ] **Step 1: Move push-sender setup above AI-client construction**

Cut the `var pushSend *push.Sender { ... }` block (currently ~lines 201-217) and paste it **before** the `// Pick AI clients based on config.` block (~line 124). `srv` is created at line 153 — the block calls `srv.SetPushStore`/`srv.SetPushSender`, so it must stay **after** `srv := server.New(...)`. Therefore place the push block immediately after `srv.SetAIKeyPresent(...)` (line 161) and move the AI-client construction to **after** the push block. Net order: `srv` created → push sender built → gate + recorder built → AI clients built → cascade/processor.

- [ ] **Step 2: Build the gate + recorder and pass to constructors**

Replace the AI-client construction block with:

```go
	// Live gate: the single authority over whether any Anthropic call may leave the
	// box. Consulted at the HTTP boundary (anthropic.Retrier.Post) before every call.
	keyPresent := cfg.AI.APIKey != ""
	aiGate := func() error {
		if !keyPresent {
			return anthropic.ErrAIDisabled
		}
		s, err := st.SelectAppSettings()
		if err != nil {
			// Fail closed: if we can't read settings, don't spend money.
			return anthropic.ErrAIDisabled
		}
		if !s.AIEnabled || s.CapLatched {
			return anthropic.ErrAIDisabled
		}
		return nil
	}

	// Recorder: persist each call's tokens+cost; on cap latch, notify via push.
	aiRecorder := func(u anthropic.Usage) {
		latched, err := st.RecordAIUsage(store.AIUsageRow{
			Path: u.Path, Model: u.Model,
			InputTokens: u.InputTokens, OutputTokens: u.OutputTokens,
			CostMuUSD: anthropic.CostMuUSD(u.Model, u.InputTokens, u.OutputTokens),
			OK:        u.OK, Detail: u.Detail,
		})
		if err != nil {
			log.Printf("ai usage: record failed: %v", err)
			return
		}
		if latched {
			log.Printf("ai: monthly spend cap reached — AI disabled")
			if pushSend != nil {
				subs, _ := st.SelectPushSubs()
				payload, _ := json.Marshal(map[string]string{
					"title": "AI auto-disabled",
					"body":  "Monthly Anthropic spend cap reached. Re-enable in Settings.",
				})
				for _, sub := range subs {
					go func(s store.PushSubRow) {
						_ = pushSend.Send(context.Background(), s.Endpoint, s.P256dh, s.Auth, payload)
					}(sub)
				}
			}
		}
	}

	// Pick AI clients based on config. The gate — not config — is the live on/off.
	var aiCat categorize.AICategorizer = categorize.DisabledAI{}
	var aiExt parse.Extractor = parse.DisabledExtractor{}
	if cfg.AI.Enabled {
		aiCat = categorize.NewAnthropicCategorizer(cfg.AI.APIKey, cfg.AI.Model, aiGate, aiRecorder)
		if cfg.AI.AllowAIExtraction {
			aiExt = parse.NewAnthropicExtractor(cfg.AI.APIKey, cfg.AI.Model, aiGate, aiRecorder)
		}
		log.Printf("ai: clients wired (model=%s); runtime master switch + cap now govern calls", cfg.AI.Model)
	} else {
		log.Printf("ai: disabled (set ai.enabled=true + LEDGER_AI_API_KEY to activate)")
	}
```

Ensure `main.go` imports `ledger/internal/anthropic` (add to the import block if missing).

- [ ] **Step 3: Build and run the full suite**

Run: `CGO_ENABLED=0 go build ./... && go test ./...`
Expected: build OK; all tests PASS. (The config test noted in project memory, `TestAIConfigEnabledRequiresAPIKey`, fails only in the sandbox because `LEDGER_AI_API_KEY` is set — that is a known false failure, not caused by this change.)

- [ ] **Step 4: Commit**

```bash
git add cmd/ledger/main.go
git commit -m "feat(ledger): wire live AI gate + usage recorder + cap-latch push"
```

---

### Task 6: `GET /api/ai/usage` endpoint + settings DTO cap fields (`internal/server`)

**Files:**
- Create: `internal/server/ai_usage.go`
- Modify: `internal/server/server.go` (add `aiUsageStore` field + `SetAIUsageStore`; register route ~line 183)
- Modify: `internal/server/settings.go` (extend `settingsDTO` + PUT)
- Modify: `cmd/ledger/main.go` (call `srv.SetAIUsageStore(st)`)
- Test: `internal/server/ai_usage_test.go`
- Test: `internal/server/settings_test.go` (extend)

**Interfaces:**
- Consumes: `store.AIUsageStats`, `store.RecentAIUsage`, `store.SelectAppSettings/UpdateAppSettings`.
- Produces:
  - `type AIUsageStore interface { AIUsageStats(now int64) (store.AIUsageStats, error); RecentAIUsage(limit int) ([]store.AIUsageRow, error) }`
  - `func (s *Server) SetAIUsageStore(a AIUsageStore)`
  - `GET /api/ai/usage` → JSON `{count_30d, cost_30d_musd, count_all, cost_all_musd, recent:[{at,path,model,input_tokens,output_tokens,cost_musd,ok,detail}]}`
  - `settingsDTO` gains `AISpendCapMuUSD int64 json:"ai_spend_cap_musd"` and read-only `AICapLatched bool json:"ai_cap_latched"`.

- [ ] **Step 1: Write the failing tests**

```go
// internal/server/ai_usage_test.go
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
	s := New(nil, nil)
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
```

Check `server.New` signature first (it is `New(st *store.Store, webFS fs.FS)` — pass `nil, nil` if the handler doesn't touch them; if `New` panics on nil FS, construct with the test's existing helper pattern used by other `*_test.go` in the package). If other server tests build the server differently, mirror that.

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/server/ -run AIUsage -v`
Expected: FAIL — `SetAIUsageStore` / `handleGetAIUsage` undefined.

- [ ] **Step 3: Implement the handler**

```go
// internal/server/ai_usage.go
package server

import (
	"encoding/json"
	"net/http"
	"time"

	"ledger/internal/store"
)

// AIUsageStore is the read surface the AI-usage endpoint needs.
type AIUsageStore interface {
	AIUsageStats(now int64) (store.AIUsageStats, error)
	RecentAIUsage(limit int) ([]store.AIUsageRow, error)
}

// SetAIUsageStore wires the AI-usage store. Required for GET /api/ai/usage.
func (s *Server) SetAIUsageStore(a AIUsageStore) { s.aiUsageStore = a }

type aiUsageRowDTO struct {
	At           int64  `json:"at"`
	Path         string `json:"path"`
	Model        string `json:"model"`
	InputTokens  int64  `json:"input_tokens"`
	OutputTokens int64  `json:"output_tokens"`
	CostMuUSD    int64  `json:"cost_musd"`
	OK           bool   `json:"ok"`
	Detail       string `json:"detail"`
}

func (s *Server) handleGetAIUsage(w http.ResponseWriter, r *http.Request) {
	if s.aiUsageStore == nil {
		http.Error(w, `{"error":"ai usage unavailable"}`, http.StatusServiceUnavailable)
		return
	}
	stats, err := s.aiUsageStore.AIUsageStats(time.Now().Unix())
	if err != nil {
		http.Error(w, `{"error":"db error"}`, http.StatusInternalServerError)
		return
	}
	rows, err := s.aiUsageStore.RecentAIUsage(50)
	if err != nil {
		http.Error(w, `{"error":"db error"}`, http.StatusInternalServerError)
		return
	}
	recent := make([]aiUsageRowDTO, 0, len(rows))
	for _, r := range rows {
		recent = append(recent, aiUsageRowDTO{
			At: r.At, Path: r.Path, Model: r.Model,
			InputTokens: r.InputTokens, OutputTokens: r.OutputTokens,
			CostMuUSD: r.CostMuUSD, OK: r.OK, Detail: r.Detail,
		})
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"count_30d":     stats.Count30d,
		"cost_30d_musd": stats.Cost30dMuUSD,
		"count_all":     stats.CountAll,
		"cost_all_musd": stats.CostAllMuUSD,
		"recent":        recent,
	})
}
```

Add the field to the `Server` struct in `server.go` (near `settingsStore`): `aiUsageStore AIUsageStore`. Register the route after the settings routes (~line 183):

```go
	s.mux.HandleFunc("GET /api/ai/usage", s.handleGetAIUsage)
```

- [ ] **Step 4: Extend the settings DTO + PUT (`internal/server/settings.go`)**

Add to `settingsDTO`:

```go
	AISpendCapMuUSD int64 `json:"ai_spend_cap_musd"`
	AICapLatched    bool  `json:"ai_cap_latched"` // read-only output; ignored on PUT
```

In `handleGetSettings`, include them in the encoded struct:
`AISpendCapMuUSD: a.SpendCapMuUSD, AICapLatched: a.CapLatched,`.

In `handlePutSettings`, carry the cap through to the store write (latch is cleared by the store when AIEnabled is true — do not set it from the client):

```go
	if err := s.settingsStore.UpdateAppSettings(store.AppSettings{
		AutoCategorize: dto.AutoCategorize, AIEnabled: dto.AIEnabled,
		AIAutoAccept: dto.AIAutoAccept, AIThreshold: dto.AIThreshold,
		IngestSilenceDays: dto.IngestSilenceDays,
		SpendCapMuUSD:     dto.AISpendCapMuUSD,
		// CapLatched intentionally omitted — store clears it when AIEnabled is true,
		// and the client cannot set it.
	}); err != nil {
```

- [ ] **Step 5: Wire in `main.go`**

After `srv.SetSettingsStore(st)` add:

```go
	srv.SetAIUsageStore(st)
```

- [ ] **Step 6: Run tests + build**

Run: `go test ./internal/server/ -v && CGO_ENABLED=0 go build ./...`
Expected: PASS + build OK.

- [ ] **Step 7: Commit**

```bash
git add internal/server/ai_usage.go internal/server/server.go internal/server/settings.go internal/server/ai_usage_test.go internal/server/settings_test.go cmd/ledger/main.go
git commit -m "feat(server): GET /api/ai/usage + settings cap fields"
```

---

### Task 7: Frontend pure helpers (`frontend/src/lib`)

**Files:**
- Create: `frontend/src/lib/aiCost.ts`
- Test: `frontend/src/lib/aiCost.test.ts`

**Interfaces:**
- Produces:
  - `formatMuUSD(musd: number): string` — `"$1.90"`, `"< $0.01"` for tiny positive, `"$0.00"` for exactly 0. (Cost is always ≥ 0.)
  - `dollarsToMuUSD(dollars: number): number` — rounds to integer µ$.
  - `muUSDToDollars(musd: number): number`.

- [ ] **Step 1: Write the failing test**

```ts
// frontend/src/lib/aiCost.test.ts
import { describe, it, expect } from "vitest";
import { formatMuUSD, dollarsToMuUSD, muUSDToDollars } from "./aiCost";

describe("aiCost", () => {
  it("formats dollars", () => {
    expect(formatMuUSD(1_900_000)).toBe("$1.90");
    expect(formatMuUSD(190_000_000)).toBe("$190.00");
  });
  it("formats zero and sub-cent", () => {
    expect(formatMuUSD(0)).toBe("$0.00");
    expect(formatMuUSD(1047)).toBe("< $0.01"); // ~$0.001
  });
  it("converts dollars <-> muUSD", () => {
    expect(dollarsToMuUSD(5)).toBe(5_000_000);
    expect(dollarsToMuUSD(0.5)).toBe(500_000);
    expect(muUSDToDollars(2_500_000)).toBe(2.5);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && bunx vitest run src/lib/aiCost.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// frontend/src/lib/aiCost.ts
/** Micro-USD (1e-6 USD) integer money helpers for AI cost display. */
const MU = 1_000_000;

export function muUSDToDollars(musd: number): number {
  return musd / MU;
}

export function dollarsToMuUSD(dollars: number): number {
  return Math.round(dollars * MU);
}

/** Format micro-USD as a dollar string. Values under $0.01 (but > 0) show "< $0.01". */
export function formatMuUSD(musd: number): string {
  if (musd <= 0) return "$0.00";
  const dollars = musd / MU;
  if (dollars < 0.01) return "< $0.01";
  return `$${dollars.toFixed(2)}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && bunx vitest run src/lib/aiCost.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/aiCost.ts frontend/src/lib/aiCost.test.ts
git commit -m "feat(web): aiCost micro-USD formatting helpers"
```

---

### Task 8: AI & API usage settings page + wiring (`frontend/src`)

**Files:**
- Modify: `frontend/src/api/types.ts` (extend `AppSettings`; add `AIUsage` types)
- Modify: `frontend/src/api/client.ts` (add `getAIUsage`)
- Create: `frontend/src/screens/settings/AiUsagePage.tsx`
- Modify: `frontend/src/screens/settings/SettingsHub.tsx` (add `"ai"` to `SettingsPageId`; add a hub row)
- Modify: `frontend/src/screens/Settings.tsx` (render `AiUsagePage` for `page === "ai"`)
- Modify: `frontend/src/screens/settings/CategorizationPage.tsx` (relabel the AI toggle; add cross-link line)
- Test: `frontend/src/screens/settings/AiUsagePage.test.tsx`

**Interfaces:**
- Consumes: `getJSON`, `postJSON`, `formatMuUSD`, `dollarsToMuUSD`, `muUSDToDollars`, `SettingsPage`, `SavedFlash`/`useSavedFlash`, `Switch`, `Card`, `SectionLabel`, `Button`.
- Produces: `AiUsagePage({ onClose }: { onClose: () => void })`; `getAIUsage(): Promise<AIUsage>`.

- [ ] **Step 1: Extend types + client**

In `frontend/src/api/types.ts`, add to `AppSettings`:

```ts
  ai_spend_cap_musd?: number;
  /** Read-only: AI auto-disabled because the monthly cap was hit. */
  ai_cap_latched?: boolean;
```

Add usage types:

```ts
export interface AIUsageRow {
  at: number; path: "extract" | "categorize"; model: string;
  input_tokens: number; output_tokens: number; cost_musd: number; ok: boolean; detail: string;
}
export interface AIUsage {
  count_30d: number; cost_30d_musd: number;
  count_all: number; cost_all_musd: number;
  recent: AIUsageRow[];
}
```

In `frontend/src/api/client.ts`, add:

```ts
export function getAIUsage(): Promise<AIUsage> {
  return getJSON<AIUsage>("/api/ai/usage");
}
```

(and import `AIUsage` in the type import list at the top of `client.ts`).

- [ ] **Step 2: Write the failing page test**

```tsx
// frontend/src/screens/settings/AiUsagePage.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AiUsagePage } from "./AiUsagePage";
import * as client from "../../api/client";

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  // Mock getJSON (used for /api/settings) AND getAIUsage (which calls getJSON via a
  // local reference inside client.ts that a getJSON spy would NOT intercept).
  vi.spyOn(client, "getJSON").mockImplementation(async (url: string) => {
    if (url === "/api/settings")
      return { auto_categorize: true, ai_enabled: false, ai_auto_accept: false, ai_threshold: 0.85, ingest_silence_days: 3, ai_key_present: true, ai_spend_cap_musd: 5_000_000, ai_cap_latched: true } as any;
    return {} as any;
  });
  vi.spyOn(client, "getAIUsage").mockResolvedValue({
    count_30d: 2, cost_30d_musd: 1_900_000, count_all: 5, cost_all_musd: 190_000_000, recent: [],
  } as any);
});

describe("AiUsagePage", () => {
  it("shows the latched banner and 30-day cost", async () => {
    wrap(<AiUsagePage onClose={() => {}} />);
    expect(await screen.findByText(/auto-disabled/i)).toBeInTheDocument();
    expect(await screen.findByText("$1.90")).toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd frontend && bunx vitest run src/screens/settings/AiUsagePage.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `AiUsagePage.tsx`**

```tsx
// frontend/src/screens/settings/AiUsagePage.tsx
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getJSON, postJSON, getAIUsage } from "../../api/client";
import type { AppSettings, AIUsage } from "../../api/types";
import { Switch } from "../../components/ui/Switch";
import { Card } from "../../components/ui/Card";
import { SectionLabel } from "../../components/ui/SectionLabel";
import { Button } from "../../components/ui/Button";
import { useToast } from "../../components/Toast";
import { SettingsPage } from "./SettingsPage";
import { SavedFlash, useSavedFlash } from "./SavedFlash";
import { formatMuUSD, dollarsToMuUSD, muUSDToDollars } from "../../lib/aiCost";

export function AiUsagePage({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const { show } = useToast();
  const { saved, flash } = useSavedFlash();
  const settings = useQuery({ queryKey: ["settings"], queryFn: () => getJSON<AppSettings>("/api/settings") });
  const usage = useQuery({ queryKey: ["ai-usage"], queryFn: getAIUsage });
  const s = settings.data;
  const [capInput, setCapInput] = useState<string>("");

  const save = async (next: AppSettings) => {
    try {
      await postJSON("/api/settings", {
        auto_categorize: next.auto_categorize, ai_enabled: next.ai_enabled,
        ai_auto_accept: next.ai_auto_accept, ai_threshold: next.ai_threshold,
        ingest_silence_days: next.ingest_silence_days,
        ai_spend_cap_musd: next.ai_spend_cap_musd ?? 0,
      }, "PUT");
      qc.invalidateQueries({ queryKey: ["settings"] });
      qc.invalidateQueries({ queryKey: ["ai-usage"] });
      flash();
    } catch { show({ message: "Couldn't save settings", tone: "error" }); }
  };

  const capDollars = s?.ai_spend_cap_musd ? muUSDToDollars(s.ai_spend_cap_musd) : 0;

  return (
    <SettingsPage title="AI & API usage" onClose={onClose} headerRight={<SavedFlash saved={saved} />}>
      {s && (
        <>
          <section className="space-y-1">
            <label className="flex items-center justify-between gap-3 text-sm py-2">
              <span>
                AI features
                <span className="block text-xs text-muted">When off, the app makes zero calls to Anthropic.</span>
              </span>
              <Switch aria-label="AI features"
                checked={s.ai_enabled}
                onChange={(e) => save({ ...s, ai_enabled: e.target.checked })} />
            </label>
            <div className="flex items-center justify-between gap-3 pt-1">
              <span className="text-sm">Anthropic API key</span>
              {s.ai_key_present
                ? <span className="text-xs font-medium text-good">Loaded</span>
                : <span className="text-xs text-muted text-right">Not set · add LEDGER_AI_API_KEY to the env file and restart</span>}
            </div>
          </section>

          {s.ai_cap_latched && (
            <Card className="border border-bad/40">
              <p role="alert" className="text-sm text-bad">
                AI auto-disabled — you hit your monthly spend cap. Turn <strong>AI features</strong> back on to resume.
              </p>
            </Card>
          )}

          <section className="space-y-2">
            <SectionLabel as="h2" className="px-1">Usage</SectionLabel>
            <Card>
              <div className="flex items-center justify-between text-sm">
                <span>Last 30 days</span>
                <span className="tnum">{usage.data?.count_30d ?? 0} calls · {usage.data ? formatMuUSD(usage.data.cost_30d_musd) : "—"}</span>
              </div>
              <div className="flex items-center justify-between text-sm mt-1 text-muted">
                <span>All time</span>
                <span className="tnum">{usage.data?.count_all ?? 0} calls · {usage.data ? formatMuUSD(usage.data.cost_all_musd) : "—"}</span>
              </div>
            </Card>
          </section>

          <section className="space-y-2">
            <SectionLabel as="h2" className="px-1">Monthly spend cap</SectionLabel>
            <Card>
              <div className="flex items-center gap-2">
                <span className="text-sm">$</span>
                <input
                  type="number" inputMode="decimal" min="0" step="1"
                  aria-label="Monthly spend cap in dollars"
                  className="flex-1 text-base border border-border rounded-lg px-3 py-2 bg-surface"
                  placeholder={capDollars ? String(capDollars) : "No cap"}
                  value={capInput}
                  onChange={(e) => setCapInput(e.target.value)} />
                <Button variant="secondary" onClick={() => {
                  const d = parseFloat(capInput);
                  save({ ...s, ai_spend_cap_musd: isNaN(d) || d <= 0 ? 0 : dollarsToMuUSD(d) });
                  setCapInput("");
                }}>Save</Button>
              </div>
              <p className="text-xs text-muted mt-1.5">
                {capDollars > 0
                  ? `At $${capDollars}/month spent, AI auto-disables until you turn it back on. Set 0 for no cap.`
                  : "No cap set. Enter a dollar amount to auto-disable AI when monthly spend crosses it."}
              </p>
            </Card>
          </section>

          <section className="space-y-2">
            <SectionLabel as="h2" className="px-1">Recent calls</SectionLabel>
            <Card className="!p-0 divide-y divide-border overflow-hidden">
              {(usage.data?.recent ?? []).length === 0 && (
                <p className="text-xs text-muted px-4 py-3">No API calls recorded.</p>
              )}
              {(usage.data?.recent ?? []).map((row, i) => (
                <div key={i} className="flex items-center justify-between gap-2 px-4 py-2.5 text-xs">
                  <span className="flex items-center gap-2 min-w-0">
                    <span className={`shrink-0 rounded px-1.5 py-0.5 ${row.path === "extract" ? "bg-surface-2 text-muted" : "bg-surface-2 text-fg"}`}>{row.path}</span>
                    <span className="truncate text-muted">{row.detail || row.model}</span>
                  </span>
                  <span className="tnum text-right shrink-0">
                    {row.input_tokens}/{row.output_tokens} tok · {formatMuUSD(row.cost_musd)}
                  </span>
                </div>
              ))}
            </Card>
          </section>
        </>
      )}
    </SettingsPage>
  );
}
```

If any referenced component import path differs (`Card`, `SectionLabel`, `Button`, `Switch`, `Toast`), match the exact paths used by `CategorizationPage.tsx` (same directory patterns).

- [ ] **Step 5: Wire the hub row + route**

In `SettingsHub.tsx`: add `"ai"` to the `SettingsPageId` union; add a row inside the `Automation` group (or a new group). Use the existing `categorizationSummary`-style value or a simple label:

```tsx
        <HubRow
          label="AI & API usage"
          value={settings.data ? (settings.data.ai_enabled ? "On" : "Off") : undefined}
          onClick={() => onOpen("ai")}
        />
```

In `Settings.tsx`: import `AiUsagePage` and add, alongside the other page conditionals:

```tsx
      {page === "ai" && <AiUsagePage onClose={close} />}
```

- [ ] **Step 6: Relabel the Categorization AI toggle + cross-link**

In `CategorizationPage.tsx`, change the "AI suggestions" `ToggleRow` title/hint to make clear it is the master switch, and add a one-line link. Replace the AI-suggestions `ToggleRow` block (lines ~91-95) with:

```tsx
            <ToggleRow title="AI features (master switch)" hint="Off = zero calls to Anthropic. Manage usage & spend cap under AI & API usage.">
              <Switch aria-label="AI features"
                checked={s.ai_enabled}
                onChange={(e) => saveSettings({ ...s, ai_enabled: e.target.checked })} />
            </ToggleRow>
```

- [ ] **Step 7: Run the page test + full frontend suite**

Run: `cd frontend && bunx vitest run src/screens/settings/AiUsagePage.test.tsx && bun run test`
Expected: PASS (new page test + no regressions).

- [ ] **Step 8: Commit**

```bash
git add frontend/src/api/types.ts frontend/src/api/client.ts frontend/src/screens/settings/AiUsagePage.tsx frontend/src/screens/settings/AiUsagePage.test.tsx frontend/src/screens/settings/SettingsHub.tsx frontend/src/screens/Settings.tsx frontend/src/screens/settings/CategorizationPage.tsx
git commit -m "feat(web): AI & API usage settings page + master-switch relabel"
```

---

### Task 9: Rebuild embedded dist, full verification, catalog update

**Files:**
- Modify: `internal/web/dist/**` (rebuilt artifact)
- Modify: `frontend/src/components/README.md` (only if a new shared component was added — the plan adds none, so likely a no-op; verify)

- [ ] **Step 1: Full test suites**

Run: `go test ./... && cd frontend && bun run test`
Expected: all PASS (except the known sandbox-only `TestAIConfigEnabledRequiresAPIKey` false failure noted in Task 5).

- [ ] **Step 2: Rebuild the embedded bundle**

Run:
```bash
cd frontend && bun install && bun run build
cd .. && CGO_ENABLED=0 go build -o ledger ./cmd/ledger
```
Expected: `internal/web/dist/` regenerated; binary builds.

- [ ] **Step 3: Manual end-to-end verification (the trust claim)**

Start the binary against a scratch data dir with AI config on but the master switch off, and confirm no calls leave the box. Using the running app or a quick check:
- Confirm `GET /api/settings` returns `ai_enabled:false` (default) and `GET /api/ai/usage` returns zeros.
- Toggle AI on via the page, set a $1 cap, and confirm the cap field round-trips (`ai_spend_cap_musd` reflects 1_000_000).
- Confirm the gate: with `ai_enabled:false`, the ingest reprocess path does not append `ai_usage` rows (the `ai_usage` table stays empty). This is the "off means off" check — the zero-egress unit test (Task 2) is the authoritative guarantee; this is the live confirmation.

- [ ] **Step 4: Commit the rebuilt dist**

```bash
git add internal/web/dist frontend/src/components/README.md
git commit -m "chore(web): rebuild embedded dist (AI usage transparency)"
```

- [ ] **Step 5: Re-check main + finish**

Per project convention (parallel sessions on `main`), re-check `main` and ensure the combined dist matches source before merging/deploying. Then hand off to `superpowers:finishing-a-development-branch`.

---

## Notes for the executor

- **cwd:** Agent-tool subagents start in `/root/Coding/ledger` (the main checkout) even if the session uses a worktree — always `cd` to the correct working directory and confirm the branch before editing.
- **Known false test failure:** `internal/config` `TestAIConfigEnabledRequiresAPIKey` fails in this sandbox only because `LEDGER_AI_API_KEY` is set in the environment. Not caused by this work; do not "fix" it.
- **Do not** change the config `ai.enabled` semantics beyond what Task 5 states — the gate is the live authority; config still decides whether real clients are constructed at boot.
