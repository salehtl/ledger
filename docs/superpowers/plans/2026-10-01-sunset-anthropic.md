# Sunset Anthropic: one classifier for every AI question

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove Anthropic from the running system. TypeSafe's Jev answers both AI questions ("which category?" and "is this email a transaction?") through one provider-neutral `classify.Classifier` interface, so a later move to another classification API is one adapter file plus a config value.

**Architecture:** `internal/anthropic` becomes the neutral `internal/aihttp` (retry, gate, usage, cost). A new `internal/classify` package defines the provider seam and its only adapter, TypeSafe. `categorize.ClassifierCategorizer` and a new parse tier, the **AI check**, sit on that seam. The AI check only classifies: a confident "not a transaction" sets the email aside (`ignored`, raw body kept), and anything else stays `unparsed` with the verdict stored on the row. No AI ever writes a transaction again. The Anthropic categorizer and extractor stay in the repo, wired only when `ai.provider = "anthropic"`.

**Tech Stack:** Go 1.25 stdlib `net/http`, `httptest`, SQLite (`modernc`), React 19 + vitest.

**Spec:** No separate spec. Saleh asked for the plan directly on 2026-10-01, so this plan is the spec. Decisions he made in the brainstorm:
1. "Another provider" means **another classification API** (choice questions with confidence), not a general LLM.
2. A "not a transaction" verdict sets an email aside **only at or above a confidence threshold**. Below it, the email stays unparsed with a label.
3. Structure **A**: one shared classifier interface. Both jobs use it.
4. "Sunset" follows the standing rule (memory: sunset, don't delete): the Anthropic code stays, behind `ai.provider = "anthropic"`.

### Decisions made in this plan (confirm on review)

- **Config:** `ai.provider` (`"typesafe"` default, `"anthropic"` sunset). The old key `categorize_provider` is still read as an alias, because production's `/etc/ledger/config.toml` uses it and the TOML decoder is not strict.
- **Threshold** lives in the config, `ai.txn_ignore_threshold`, default **0.97**, valid range (0.5, 1]. The operator sets it from `ledger txncheck-eval`. There is no UI control.
- **What the AI check sends:** `from`, `subject`, and the email text truncated to 8 KB (the same bound the Anthropic extractor used). This is new egress to TypeSafe: until now TypeSafe saw only merchant strings.
- **Verdicts are stored** (`ingest_log.ai_verdict`, `ai_verdict_conf`) and replayed on reprocess under the current threshold, with no second call.
- **Visibility:** `/api/health` gains `ingest.unread` counts, and Settings → Email ingest shows them. There is no per-email list in this plan.
- **Recovery** of wrongly set-aside emails is a runbook SQL step plus a reprocess.

## Global Constraints

- Money is `int64` fils; AI cost is `int64` µUSD (`CostMuUSD`). No floats for either.
- Secrets are env-only: `LEDGER_TYPESAFE_API_KEY`, `LEDGER_AI_API_KEY`. Never TOML.
- Every outbound AI call passes the live gate (`Retrier.Gate`). "AI off" means zero egress.
- TypeSafe endpoint: `POST https://api.typesafe.ai/v1/systemone`, header `Authorization: Bearer <key>`, body `{"state", "model", "questions"}`. A choice question carries at most **255** options.
- Retry on 429 and 5xx (529 included); never on 401/422.
- Nothing is ever silently dropped: an AI-set-aside email keeps its raw body in `ingest_log` and can be returned to `unparsed`.
- The AI check never sets aside a row that already produced a transaction.
- UI copy: plain and short, one idea per sentence (memory: app-copy-plain-and-short). No sentence names a provider the code did not call.
- Gate: `go test ./... && cd frontend && bun run test`. Rebuild `internal/web/dist` before finishing.
- Never point a smoke test at `:8080` or `/var/lib/ledger`. Never run the installed `/usr/local/bin/ledger` with a subcommand it may not know: an unknown subcommand starts the server (memory: ledger-smoke-test-uses-prod-by-default).
- NUL-byte check, where a step asks for one: `for f in FILES; do [ "$(tr -d '\000' <"$f" | wc -c)" = "$(wc -c <"$f")" ] || echo "NUL: $f"; done`. Do **not** use `grep $'\x00'` or `grep -P '\x00'`; both were proven unable to fail on 2026-09-29.

## Review Focus

1. **A row that already holds a transaction** (an old AI extraction, `low_confidence`, or one demoted to `unparsed` by a failed reprocess) must never be set aside by the AI check. Tests: `TestProcessorNeverChecksLowConfidenceRows`, `TestProcessorAICheckNeverHidesRowWithTransaction` (Task 6).
2. **AI off or no key:** the check returns `ErrAIDisabled`. The row stays `unparsed` with no verdict, `parse_error` does not claim a verdict, and a later reprocess asks again. Test: `TestCascadeAICheckDisabledIsBenign` (Task 5).
3. **Reprocess must not pay twice,** and a threshold change must re-apply a stored verdict. Tests: `TestProcessorReusesStoredVerdict`, `TestProcessorReappliesStoredVerdictUnderNewThreshold` (Task 6).
4. **Production's existing config** (`[ai] enabled = true` / `categorize_provider = "typesafe"`, no `provider`) must load as provider `typesafe` with no Anthropic key required. Test: `TestCategorizeProviderAliasStillRead` (Task 7).
5. **A provider answer outside the options** (a typo, a casing change, an empty string) must be an error, never read as "not a transaction" or as a category. Tests: `TestTypeSafeRejectsUnknownChoice` (Task 2), `TestTxnCheckerRejectsUnexpectedChoice` (Task 5).

---

## File Structure

| File | Responsibility |
|---|---|
| `internal/aihttp/` (renamed from `internal/anthropic/`) | Retrying POST client, gate, `Usage`/`Recorder`, `CostMuUSD`, `Clamp01`, `ExtractJSON`, `ErrAIDisabled`. No provider logic. |
| `internal/classify/classify.go` (new) | The provider seam: `Option`, `Question`, `Request`, `Answer`, `Classifier`, `ErrTooManyOptions`. |
| `internal/classify/typesafe.go` (new) | TypeSafe adapter: request building, auth, usage records, answer validation. |
| `internal/categorize/classifier.go` (new) | `ClassifierCategorizer`: category question, `__no_fit__` rule, option limit. |
| `internal/categorize/typesafe.go` (deleted) | Replaced by the two files above. |
| `internal/parse/txncheck.go` (new) | `TxnChecker`, `ClassifierTxnChecker`, verdict constants, `storedVerdict`. |
| `internal/parse/txncheck_eval.go` (new) | `EvaluateTxnCheck` for the offline eval. |
| `internal/parse/cascade.go` | New AI-check tier; `Result.Verdict`. |
| `internal/parse/processor.go` | Verdict replay, low-confidence guard, has-transaction guard, verdict persistence. |
| `internal/store/store.go`, `transactions.go`, `ingest.go`, `eval.go` | Verdict columns, `SetIngestVerdict`, `UnparsedVerdictCounts`, `SelectTxnCheckSamples`. |
| `internal/config/config.go` | `Provider`, alias, `TxnIgnoreThreshold`, `ProviderKey`. |
| `internal/server/health.go` | `ingest.unread` counts. |
| `cmd/ledger/main.go` | Provider wiring; `txncheck-eval` command; shared eval data-dir guard. |
| `frontend/src/lib/ingestHealth.ts`, `screens/settings/IngestHealthPage.tsx`, `AiUsagePage.tsx`, `api/types.ts` | Unread counts on screen; `txn_check` usage path; master-switch hint. |
| `CLAUDE.md`, `deploy/README.md` | Docs and rollout runbook. |

---

### Task 1: Rename `internal/anthropic` to `internal/aihttp`

**Files:**
- Move: `internal/anthropic/*` → `internal/aihttp/*`
- Modify: every importer (`cmd/ledger/main.go`, `internal/parse/ai.go`, `internal/parse/ai_test.go`, `internal/categorize/ai.go`, `internal/categorize/ai_test.go`, `internal/categorize/typesafe.go`, `internal/categorize/typesafe_test.go`)
- Create: `internal/aihttp/errors_test.go`

**Interfaces:**
- Produces: package `aihttp` with the same exported names as `anthropic` had: `Retrier`, `New`, `DefaultBackoff`, `Usage`, `Recorder`, `ErrAIDisabled`, `CostMuUSD`, `PriceMuUSD`, `PriceMilliMuUSD`, `ExtractJSON`, `Clamp01`.

- [ ] **Step 1: Move the package and rewrite importers**

```bash
git mv internal/anthropic internal/aihttp
sed -i 's/^package anthropic$/package aihttp/' internal/aihttp/*.go
grep -rl '"ledger/internal/anthropic"' --include=*.go . | xargs sed -i 's#"ledger/internal/anthropic"#"ledger/internal/aihttp"#'
grep -rl 'anthropic\.' --include=*.go internal cmd | xargs sed -i -E 's/\banthropic\.(Retrier|New|Usage|Recorder|ErrAIDisabled|CostMuUSD|ExtractJSON|Clamp01|DefaultBackoff|PriceMuUSD|PriceMilliMuUSD)\b/aihttp.\1/g'
gofmt -w cmd internal
go build ./... && go vet ./...
```

Expected: build and vet clean. `grep -rn 'internal/anthropic\|anthropic\.\(Retrier\|Usage\|New\)' --include=*.go .` prints nothing. (`api.anthropic.com` URLs in the sunset files stay.)

- [ ] **Step 2: Rewrite the package doc comment** at the top of `internal/aihttp/retry.go`:

```go
// Package aihttp is the shared HTTP plumbing for every AI provider: a retrying
// POST client that honors Retry-After on 429 and 5xx (529 included), the live
// gate that makes "AI off" mean zero egress, and usage and cost accounting. It
// holds no provider logic; adapters set auth headers through SetHeaders.
package aihttp
```

- [ ] **Step 3: Failing test** (`internal/aihttp/errors_test.go`)

```go
package aihttp

import (
	"strings"
	"testing"
)

// The gate's error can surface in the categorize run status. It must not name
// a provider the code may not be calling.
func TestErrAIDisabledNamesNoProvider(t *testing.T) {
	if msg := ErrAIDisabled.Error(); strings.Contains(strings.ToLower(msg), "anthropic") {
		t.Errorf("ErrAIDisabled = %q, must not name a provider", msg)
	}
}
```

Run: `go test ./internal/aihttp/ -run ErrAIDisabled -count=1`
Expected: FAIL (`"anthropic: AI disabled"`).

- [ ] **Step 4: Fix the message** in `internal/aihttp/usage.go`:

```go
var ErrAIDisabled = errors.New("ai: disabled")
```

Also change the `Usage` doc comment to: `// Usage is one recorded AI call. Path is "categorize", "txn_check", or (sunset) "extract".`

Run: `go test ./... -count=1`
Expected: PASS. If a test asserted the old string, update it to `"ai: disabled"`.

- [ ] **Step 5: Commit**

```bash
git add -A internal/aihttp internal/anthropic cmd internal/parse internal/categorize
git commit -m "refactor(ai): internal/anthropic becomes provider-neutral internal/aihttp"
```

---

### Task 2: `internal/classify` — the provider seam and its TypeSafe adapter

**Files:**
- Create: `internal/classify/classify.go`, `internal/classify/typesafe.go`, `internal/classify/typesafe_test.go`

**Interfaces:**
- Consumes: `aihttp.New`, `aihttp.Retrier` (`Gate`, `SetHeaders`, `HTTP`, `Backoff`), `aihttp.Usage`, `aihttp.Recorder`, `aihttp.ErrAIDisabled`, `aihttp.Clamp01` (Task 1).
- Produces:
  - `classify.Option{Name, Criterion string}`
  - `classify.Question{ID, Instructions string; Options []Option}`
  - `classify.Request{Path, Detail string; State map[string]string; Question Question}`
  - `classify.Answer{Choice string; Confidence float64; Probs map[string]float64}`
  - `type Classifier interface { Classify(ctx context.Context, req Request) (Answer, error); MaxOptions() int }`
  - `var ErrTooManyOptions error`
  - `func NewTypeSafe(apiKey, model string, gate func() error, rec aihttp.Recorder) *TypeSafe` (implements `Classifier`; `MaxOptions()` = 255)

- [ ] **Step 1: Write the seam** (`internal/classify/classify.go`). It has no behaviour, so it needs no test of its own.

```go
// Package classify is the seam between ledger and an AI classification
// provider. A provider answers one choice question about a small text state
// with one of the offered options and a confidence. It never generates text.
// To add a provider, write one adapter that implements Classifier and add a
// case to the provider switch in cmd/ledger/main.go.
package classify

import (
	"context"
	"errors"
)

// Option is one allowed answer. Criterion tells the provider when it applies.
type Option struct {
	Name      string
	Criterion string
}

// Question is one choice question. ID names it in the request and the answer.
type Question struct {
	ID           string
	Instructions string
	Options      []Option
}

// Request is one call. Path and Detail label the usage record (for example
// "categorize" and the merchant); they are never sent to the provider. State
// is everything the provider sees besides the question.
type Request struct {
	Path     string
	Detail   string
	State    map[string]string
	Question Question
}

// Answer is the provider's choice. Choice is always one of the option names;
// Confidence is in [0, 1]; Probs maps option names to probabilities and may be
// empty.
type Answer struct {
	Choice     string
	Confidence float64
	Probs      map[string]float64
}

// Classifier is an AI classification provider.
type Classifier interface {
	Classify(ctx context.Context, req Request) (Answer, error)
	// MaxOptions is the most options one question may carry.
	MaxOptions() int
}

// ErrTooManyOptions is returned, before any network call, when a question has
// more options than the provider allows.
var ErrTooManyOptions = errors.New("classify: too many options")
```

- [ ] **Step 2: Failing tests** (`internal/classify/typesafe_test.go`)

```go
package classify

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"ledger/internal/aihttp"
)

var testQ = Question{
	ID:           "category",
	Instructions: "Pick one.",
	Options: []Option{
		{Name: "Groceries", Criterion: "Spending (need)"},
		{Name: "Dining", Criterion: "Spending (want)"},
		{Name: "__no_fit__", Criterion: "None fits"},
	},
}

func testReq() Request {
	return Request{Path: "categorize", Detail: "TALABAT", State: map[string]string{"merchant": "TALABAT"}, Question: testQ}
}

// newTestTS passes gate through the constructor, so a test proves the
// constructor wires it (setting retry.Gate afterwards would not).
func newTestTS(t *testing.T, gate func() error, h http.HandlerFunc) (*TypeSafe, *[]aihttp.Usage) {
	t.Helper()
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	var rec []aihttp.Usage
	ts := NewTypeSafe("ts-key", "jev-1.13.0", gate, func(u aihttp.Usage) { rec = append(rec, u) })
	ts.endpoint = srv.URL + "/v1/systemone"
	ts.retry.HTTP = srv.Client()
	ts.retry.Backoff = func(int) time.Duration { return 0 }
	return ts, &rec
}

func answer(choice string, conf float64) string {
	return `{"model":"jev-1.13.0","answers":{"category":{"type":"choice","choice":"` + choice +
		`","confidence":` + strconv.FormatFloat(conf, 'f', -1, 64) +
		`,"probabilities":{"Groceries":0.1,"Dining":0.9,"__no_fit__":0}}},"usage":{"input_tokens":318,"output_tokens":34}}`
}

func TestTypeSafeRequestShape(t *testing.T) {
	var body map[string]any
	ts, _ := newTestTS(t, nil, func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer ts-key" {
			t.Errorf("Authorization = %q", got)
		}
		b, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(b, &body)
		_, _ = w.Write([]byte(answer("Dining", 0.9)))
	})
	if _, err := ts.Classify(t.Context(), testReq()); err != nil {
		t.Fatal(err)
	}
	if body["model"] != "jev-1.13.0" {
		t.Errorf("model = %v", body["model"])
	}
	state, _ := body["state"].(map[string]any)
	if len(state) != 1 || state["merchant"] != "TALABAT" {
		t.Errorf("state = %v, want exactly the request's state", body["state"])
	}
	q := body["questions"].(map[string]any)["category"].(map[string]any)
	if q["type"] != "choice" || q["instructions"] != "Pick one." {
		t.Errorf("question = %v", q)
	}
	crit := q["criteria"].(map[string]any)
	if len(crit) != 3 || crit["Dining"] != "Spending (want)" {
		t.Errorf("criteria = %v", crit)
	}
}

func TestTypeSafeSuccessRecordsUsage(t *testing.T) {
	ts, rec := newTestTS(t, nil, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(answer("Dining", 0.81)))
	})
	ans, err := ts.Classify(t.Context(), testReq())
	if err != nil {
		t.Fatal(err)
	}
	if ans.Choice != "Dining" || ans.Confidence != 0.81 || ans.Probs["Dining"] != 0.9 {
		t.Errorf("answer = %+v", ans)
	}
	if len(*rec) != 1 {
		t.Fatalf("recorded %d usages, want 1", len(*rec))
	}
	u := (*rec)[0]
	if !u.OK || u.Path != "categorize" || u.Model != "jev-1.13.0" || u.InputTokens != 318 || u.Detail != "TALABAT" {
		t.Errorf("usage = %+v", u)
	}
}

func TestTypeSafeClampsConfidence(t *testing.T) {
	ts, _ := newTestTS(t, nil, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(answer("Dining", 1.7)))
	})
	ans, err := ts.Classify(t.Context(), testReq())
	if err != nil || ans.Confidence != 1 {
		t.Errorf("conf = %v err = %v, want 1 nil", ans.Confidence, err)
	}
}

func TestTypeSafeNoRetryOn422(t *testing.T) {
	var calls atomic.Int32
	ts, rec := newTestTS(t, nil, func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.WriteHeader(http.StatusUnprocessableEntity)
	})
	_, err := ts.Classify(t.Context(), testReq())
	if err == nil || !strings.Contains(err.Error(), "422") {
		t.Errorf("err = %v, want a 422 error", err)
	}
	if calls.Load() != 1 {
		t.Errorf("server hit %d times, want 1 (422 must not retry)", calls.Load())
	}
	if len(*rec) != 1 || (*rec)[0].OK {
		t.Errorf("want one failed usage record, got %+v", *rec)
	}
}

func TestTypeSafeRetriesOn529(t *testing.T) {
	var calls atomic.Int32
	ts, _ := newTestTS(t, nil, func(w http.ResponseWriter, r *http.Request) {
		if calls.Add(1) == 1 {
			w.WriteHeader(529)
			return
		}
		_, _ = w.Write([]byte(answer("Groceries", 0.9)))
	})
	ans, err := ts.Classify(t.Context(), testReq())
	if err != nil || ans.Choice != "Groceries" || calls.Load() != 2 {
		t.Errorf("choice=%q err=%v calls=%d, want Groceries nil 2", ans.Choice, err, calls.Load())
	}
}

func TestTypeSafeRejectsTooManyOptions(t *testing.T) {
	var calls atomic.Int32
	ts, _ := newTestTS(t, nil, func(w http.ResponseWriter, r *http.Request) { calls.Add(1) })
	q := Question{ID: "category"}
	for i := 0; i <= ts.MaxOptions(); i++ {
		q.Options = append(q.Options, Option{Name: "c" + strconv.Itoa(i)})
	}
	req := testReq()
	req.Question = q
	if _, err := ts.Classify(t.Context(), req); !errors.Is(err, ErrTooManyOptions) {
		t.Errorf("err = %v, want ErrTooManyOptions", err)
	}
	if calls.Load() != 0 {
		t.Error("must not call the API when the question has too many options")
	}
	if ts.MaxOptions() != 255 {
		t.Errorf("MaxOptions = %d, want 255", ts.MaxOptions())
	}
}

func TestTypeSafeGateBlocksEgress(t *testing.T) {
	var calls atomic.Int32
	ts, rec := newTestTS(t, func() error { return aihttp.ErrAIDisabled },
		func(w http.ResponseWriter, r *http.Request) { calls.Add(1) })
	_, err := ts.Classify(t.Context(), testReq())
	if !errors.Is(err, aihttp.ErrAIDisabled) {
		t.Errorf("err = %v, want ErrAIDisabled", err)
	}
	if calls.Load() != 0 || len(*rec) != 0 {
		t.Errorf("gate off: calls=%d records=%d, want 0 0", calls.Load(), len(*rec))
	}
}

func TestTypeSafeMissingAnswer(t *testing.T) {
	ts, _ := newTestTS(t, nil, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"model":"jev-1.13.0","answers":{},"usage":{}}`))
	})
	if _, err := ts.Classify(t.Context(), testReq()); err == nil {
		t.Error("want an error when the answer is missing")
	}
}

// An answer outside the options is an error. Callers must never read it as a
// real option, such as "not a transaction".
func TestTypeSafeRejectsUnknownChoice(t *testing.T) {
	for _, choice := range []string{"dining", "Takeaway", " Dining"} {
		ts, _ := newTestTS(t, nil, func(w http.ResponseWriter, r *http.Request) {
			_, _ = w.Write([]byte(answer(choice, 0.99)))
		})
		if ans, err := ts.Classify(t.Context(), testReq()); err == nil {
			t.Errorf("choice %q: got %+v, want an error", choice, ans)
		}
	}
}

// The spend cap prices usage by model id, and startup checks only the
// configured id. A response naming another id must not make calls cost 0.
func TestTypeSafeRecordsRequestedModel(t *testing.T) {
	ts, rec := newTestTS(t, nil, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(strings.Replace(answer("Dining", 0.9), `"model":"jev-1.13.0"`, `"model":"jev-1.13"`, 1)))
	})
	if _, err := ts.Classify(t.Context(), testReq()); err != nil {
		t.Fatal(err)
	}
	if len(*rec) != 1 || (*rec)[0].Model != "jev-1.13.0" {
		t.Fatalf("usage = %+v, want one record priced as jev-1.13.0", *rec)
	}
	if aihttp.CostMuUSD((*rec)[0].Model, 318, 0) == 0 {
		t.Error("recorded call costs 0; the spend cap would not count it")
	}
}

// A body that fails to decode still costs a call; the record says it failed.
func TestTypeSafeDecodeFailureRecordsFailedUsage(t *testing.T) {
	ts, rec := newTestTS(t, nil, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`not json`))
	})
	if _, err := ts.Classify(t.Context(), testReq()); err == nil {
		t.Fatal("want a decode error")
	}
	if len(*rec) != 1 || (*rec)[0].OK {
		t.Errorf("want one failed usage record, got %+v", *rec)
	}
}
```

Run: `go test ./internal/classify/ -count=1`
Expected: compile FAIL (`NewTypeSafe` undefined).

- [ ] **Step 3: Implement** (`internal/classify/typesafe.go`)

```go
package classify

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"

	"ledger/internal/aihttp"
)

// typeSafeMaxOptions is TypeSafe's limit on options in one choice question.
const typeSafeMaxOptions = 255

// TypeSafe answers choice questions with TypeSafe's System One API (Jev models).
type TypeSafe struct {
	apiKey   string
	model    string
	endpoint string // defaults to "https://api.typesafe.ai/v1/systemone"
	retry    *aihttp.Retrier
	rec      aihttp.Recorder
}

// NewTypeSafe builds the adapter. gate is consulted by the Retrier before any
// network I/O; rec records usage (nil = don't record).
func NewTypeSafe(apiKey, model string, gate func() error, rec aihttp.Recorder) *TypeSafe {
	r := aihttp.New(nil)
	r.Gate = gate
	r.SetHeaders = func(req *http.Request, key string) {
		req.Header.Set("Authorization", "Bearer "+key)
		req.Header.Set("Content-Type", "application/json")
	}
	return &TypeSafe{
		apiKey:   apiKey,
		model:    model,
		endpoint: "https://api.typesafe.ai/v1/systemone",
		retry:    r,
		rec:      rec,
	}
}

// MaxOptions implements Classifier.
func (t *TypeSafe) MaxOptions() int { return typeSafeMaxOptions }

type tsQuestion struct {
	Type         string            `json:"type"`
	Instructions string            `json:"instructions"`
	Criteria     map[string]string `json:"criteria"`
}

type tsRequest struct {
	State     map[string]string     `json:"state"`
	Model     string                `json:"model"`
	Questions map[string]tsQuestion `json:"questions"`
}

type tsResponse struct {
	Model   string `json:"model"`
	Answers map[string]struct {
		Type          string             `json:"type"`
		Choice        string             `json:"choice"`
		Confidence    float64            `json:"confidence"`
		Probabilities map[string]float64 `json:"probabilities"`
	} `json:"answers"`
	Usage struct {
		InputTokens  int64 `json:"input_tokens"`
		OutputTokens int64 `json:"output_tokens"`
	} `json:"usage"`
}

// Classify implements Classifier.
func (t *TypeSafe) Classify(ctx context.Context, req Request) (Answer, error) {
	q := req.Question
	if len(q.Options) > typeSafeMaxOptions {
		return Answer{}, fmt.Errorf("%w: %d > %d", ErrTooManyOptions, len(q.Options), typeSafeMaxOptions)
	}
	crit := make(map[string]string, len(q.Options))
	for _, o := range q.Options {
		crit[o.Name] = o.Criterion
	}
	body, err := json.Marshal(tsRequest{
		State:     req.State,
		Model:     t.model,
		Questions: map[string]tsQuestion{q.ID: {Type: "choice", Instructions: q.Instructions, Criteria: crit}},
	})
	if err != nil {
		return Answer{}, fmt.Errorf("classify: marshal request: %w", err)
	}

	resp, err := t.retry.Post(ctx, t.endpoint, t.apiKey, body)
	if err != nil {
		if !errors.Is(err, aihttp.ErrAIDisabled) {
			t.record(req, 0, 0, false)
		}
		return Answer{}, fmt.Errorf("classify: http request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.record(req, 0, 0, false)
		return Answer{}, fmt.Errorf("classify: typesafe API status %d", resp.StatusCode)
	}
	var tr tsResponse
	if err := json.NewDecoder(resp.Body).Decode(&tr); err != nil {
		t.record(req, 0, 0, false)
		return Answer{}, fmt.Errorf("classify: decode response: %w", err)
	}
	t.record(req, tr.Usage.InputTokens, tr.Usage.OutputTokens, true)

	ans, ok := tr.Answers[q.ID]
	if !ok || ans.Choice == "" {
		return Answer{}, fmt.Errorf("classify: typesafe response has no %q answer", q.ID)
	}
	if _, ok := crit[ans.Choice]; !ok {
		return Answer{}, fmt.Errorf("classify: answer %q is not an option", ans.Choice)
	}
	return Answer{Choice: ans.Choice, Confidence: aihttp.Clamp01(ans.Confidence), Probs: ans.Probabilities}, nil
}

// record writes one usage row. It prices on the requested (pinned) model id,
// not the id the response names: cost is looked up by this id, and startup
// checks only the configured one.
func (t *TypeSafe) record(req Request, in, out int64, ok bool) {
	if t.rec == nil {
		return
	}
	t.rec(aihttp.Usage{Path: req.Path, Model: t.model, InputTokens: in, OutputTokens: out, OK: ok, Detail: req.Detail})
}
```

Run: `go test ./internal/classify/ -count=1 -v 2>&1 | grep -E '^(---|ok|FAIL)'`
Expected: all PASS.

- [ ] **Step 4: Prove the gate and choice tests bite.** Change `r.Gate = gate` to `_ = gate` and run `go test ./internal/classify/ -run GateBlocks -count=1` → FAIL. Revert. Delete the `if _, ok := crit[ans.Choice]` block and run `-run UnknownChoice` → FAIL. Revert. Rerun the package → PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/classify
git commit -m "feat(classify): provider-neutral classifier seam with a TypeSafe adapter"
```

---

### Task 3: `categorize.ClassifierCategorizer` replaces `TypeSafeCategorizer`

**Files:**
- Create: `internal/categorize/classifier.go`, `internal/categorize/classifier_test.go`
- Delete: `internal/categorize/typesafe.go`, `internal/categorize/typesafe_test.go`
- Modify: `cmd/ledger/main.go` (two call sites of `NewTypeSafeCategorizer`)

**Interfaces:**
- Consumes: `classify.Classifier`, `classify.Request`, `classify.Question`, `classify.Option`, `classify.NewTypeSafe` (Task 2).
- Produces: `func NewClassifierCategorizer(c classify.Classifier) *ClassifierCategorizer` (implements `AICategorizer`). The unexported `noFitOption` and `criterionFor` move here. **`tsCats` moves to `classifier_test.go`**, because `eval_test.go` uses it.

- [ ] **Step 1: Failing tests** (`internal/categorize/classifier_test.go`)

```go
package categorize

import (
	"context"
	"errors"
	"strconv"
	"testing"

	"ledger/internal/aihttp"
	"ledger/internal/classify"
)

// tsCats is shared with eval_test.go.
var tsCats = []Category{
	{ID: 1, Name: "Groceries", Kind: "spending", Bucket: "need"},
	{ID: 2, Name: "Dining", Kind: "spending", Bucket: "want"},
	{ID: 3, Name: "Salary", Kind: "income", Bucket: ""},
}

type fakeClassifier struct {
	ans   classify.Answer
	err   error
	max   int
	calls int
	got   classify.Request
}

func (f *fakeClassifier) Classify(_ context.Context, r classify.Request) (classify.Answer, error) {
	f.calls++
	f.got = r
	return f.ans, f.err
}

func (f *fakeClassifier) MaxOptions() int {
	if f.max == 0 {
		return 255
	}
	return f.max
}

func TestClassifierCategorizerQuestionShape(t *testing.T) {
	f := &fakeClassifier{ans: classify.Answer{Choice: "Groceries", Confidence: 0.9}}
	if _, _, err := NewClassifierCategorizer(f).Categorize(t.Context(), "CARREFOUR MOE", tsCats); err != nil {
		t.Fatal(err)
	}
	r := f.got
	if len(r.State) != 1 || r.State["merchant"] != "CARREFOUR MOE" {
		t.Errorf("state must hold ONLY the merchant, got %v", r.State)
	}
	if r.Path != "categorize" || r.Detail != "CARREFOUR MOE" || r.Question.ID != "category" {
		t.Errorf("request = %+v", r)
	}
	crit := map[string]string{}
	for _, o := range r.Question.Options {
		crit[o.Name] = o.Criterion
	}
	if len(crit) != 4 || crit["Salary"] != "Money received" || crit["Dining"] != "Spending (want)" {
		t.Errorf("options = %v", crit)
	}
	if _, ok := crit[noFitOption]; !ok {
		t.Errorf("options missing %q", noFitOption)
	}
}

func TestClassifierCategorizerReturnsChoice(t *testing.T) {
	f := &fakeClassifier{ans: classify.Answer{Choice: "Dining", Confidence: 0.81}}
	name, conf, err := NewClassifierCategorizer(f).Categorize(t.Context(), "TALABAT", tsCats)
	if err != nil || name != "Dining" || conf != 0.81 {
		t.Errorf("got (%q, %v, %v), want (Dining, 0.81, nil)", name, conf, err)
	}
}

func TestClassifierCategorizerNoFitReturnsBestRealWithZeroConfidence(t *testing.T) {
	f := &fakeClassifier{ans: classify.Answer{Choice: noFitOption, Confidence: 0.6,
		Probs: map[string]float64{noFitOption: 0.7, "Dining": 0.2, "Groceries": 0.1}}}
	name, conf, err := NewClassifierCategorizer(f).Categorize(t.Context(), "XYZ LLC", tsCats)
	if err != nil || name != "Dining" || conf != 0 {
		t.Errorf("got (%q, %v, %v), want (Dining, 0, nil)", name, conf, err)
	}
}

// A no-fit answer with no usable probabilities has no best category. Picking
// the first one would be cached in ai_suggestions for good.
func TestClassifierCategorizerNoFitWithoutProbabilitiesErrors(t *testing.T) {
	for _, probs := range []map[string]float64{nil, {noFitOption: 1, "Dining": 0}} {
		f := &fakeClassifier{ans: classify.Answer{Choice: noFitOption, Confidence: 0.9, Probs: probs}}
		if name, _, err := NewClassifierCategorizer(f).Categorize(t.Context(), "X", tsCats); err == nil {
			t.Errorf("probs %v: got %q, want an error", probs, name)
		}
	}
}

func TestClassifierCategorizerRejectsTooManyCategories(t *testing.T) {
	f := &fakeClassifier{max: 4} // room for 3 categories + no-fit
	many := make([]Category, 4)
	for i := range many {
		many[i] = Category{ID: int64(i + 1), Name: "c" + strconv.Itoa(i)}
	}
	if _, _, err := NewClassifierCategorizer(f).Categorize(t.Context(), "X", many); err == nil {
		t.Error("want an error for 4 categories with MaxOptions 4")
	}
	if f.calls != 0 {
		t.Error("must not call the provider when the category list is too long")
	}
	if _, _, err := NewClassifierCategorizer(f).Categorize(t.Context(), "X", many[:3]); err != nil {
		t.Errorf("3 categories must fit: %v", err)
	}
}

func TestClassifierCategorizerKeepsErrorChain(t *testing.T) {
	f := &fakeClassifier{err: aihttp.ErrAIDisabled}
	if _, _, err := NewClassifierCategorizer(f).Categorize(t.Context(), "X", tsCats); !errors.Is(err, aihttp.ErrAIDisabled) {
		t.Errorf("err = %v, want it to wrap ErrAIDisabled", err)
	}
}
```

Then delete the old files and run:

```bash
git rm -q internal/categorize/typesafe.go internal/categorize/typesafe_test.go
go test ./internal/categorize/ -count=1
```

Expected: compile FAIL (`NewClassifierCategorizer`, `noFitOption`, `criterionFor` undefined).

- [ ] **Step 2: Implement** (`internal/categorize/classifier.go`)

```go
package categorize

import (
	"context"
	"fmt"

	"ledger/internal/classify"
)

// noFitOption lets the classifier say "none of these". It is never a real
// category name.
const noFitOption = "__no_fit__"

// Jev reads instructions literally (docs: jev-1.13 jaggedness #1), so the
// boundary cases are spelled out rather than implied.
const categoryInstructions = "Which budget category does the card transaction at `merchant` belong to? " +
	"`merchant` is the raw merchant text from a UAE bank alert. " +
	"Choose " + noFitOption + " when no category clearly fits."

func criterionFor(c Category) string {
	switch c.Kind {
	case "income":
		return "Money received"
	case "excluded":
		return "Not counted in the budget, such as transfers between own accounts"
	}
	if c.Bucket != "" {
		return "Spending (" + c.Bucket + ")"
	}
	return "Spending"
}

// ClassifierCategorizer implements AICategorizer with one choice question to a
// classification provider. It sends ONLY the merchant string and the category
// list: no amounts, dates or account details leave the server.
type ClassifierCategorizer struct {
	C classify.Classifier
}

// NewClassifierCategorizer wraps a provider.
func NewClassifierCategorizer(c classify.Classifier) *ClassifierCategorizer {
	return &ClassifierCategorizer{C: c}
}

// Categorize implements AICategorizer.
func (cc *ClassifierCategorizer) Categorize(ctx context.Context, merchant string, cats []Category) (string, float64, error) {
	if limit := cc.C.MaxOptions() - 1; len(cats) > limit {
		return "", 0, fmt.Errorf("categorize: %d categories exceed the provider's limit of %d", len(cats), limit)
	}
	opts := make([]classify.Option, 0, len(cats)+1)
	for _, c := range cats {
		opts = append(opts, classify.Option{Name: c.Name, Criterion: criterionFor(c)})
	}
	opts = append(opts, classify.Option{Name: noFitOption, Criterion: "None of the other categories fits this merchant"})

	ans, err := cc.C.Classify(ctx, classify.Request{
		Path:     "categorize",
		Detail:   merchant,
		State:    map[string]string{"merchant": merchant},
		Question: classify.Question{ID: "category", Instructions: categoryInstructions, Options: opts},
	})
	if err != nil {
		return "", 0, fmt.Errorf("categorize: %w", err)
	}
	if ans.Choice == noFitOption {
		// Suggest the best real category, but never let it auto-confirm.
		best, bestP := "", -1.0
		for _, c := range cats {
			if p := ans.Probs[c.Name]; p > bestP {
				best, bestP = c.Name, p
			}
		}
		if bestP <= 0 {
			// No real category has any weight. A guess would be cached in
			// ai_suggestions for good, so fail and leave the row in review.
			return "", 0, fmt.Errorf("categorize: provider answered no fit with no usable probabilities")
		}
		return best, 0, nil
	}
	return ans.Choice, ans.Confidence, nil
}
```

- [ ] **Step 3: Update `cmd/ledger/main.go`.** Add the import `"ledger/internal/classify"`, then replace the two constructors:

```go
// in the provider switch (Task 7 rewrites this block again):
		case "typesafe":
			inner = categorize.NewClassifierCategorizer(
				classify.NewTypeSafe(cfg.AI.TypeSafeAPIKey, cfg.AI.TypeSafeModel, categorizeGate, aiRecorder))
// in runCategorizeEval:
	ai := categorize.NewClassifierCategorizer(classify.NewTypeSafe(key, *model, nil, nil))
```

Run: `go build ./... && go test ./internal/categorize/ ./cmd/... -count=1`
Expected: PASS.

- [ ] **Step 4: Prove the tests bite.** Replace `if bestP <= 0 {` with `if false {` → `-run NoFitWithout` FAILS. Revert. Change `cc.C.MaxOptions() - 1` to `cc.C.MaxOptions()` → `-run TooMany` FAILS. Revert.

- [ ] **Step 5: Commit**

```bash
git add internal/categorize cmd/ledger/main.go
git commit -m "refactor(categorize): categorization asks any classify.Classifier"
```

---

### Task 4: Store — verdict columns, verdict counts, eval samples

**Files:**
- Modify: `internal/store/store.go` (`migrate`), `internal/store/transactions.go` (`IngestForParse`, `SelectForParse`), `internal/store/ingest.go` (new methods), `internal/store/eval.go` (samples)
- Test: `internal/store/verdict_test.go`

**Interfaces:**
- Produces:
  - `IngestForParse.AIVerdict string`, `IngestForParse.AIVerdictConf float64`
  - `func (s *Store) SetIngestVerdict(ingestID int64, verdict string, conf float64) error`
  - `type VerdictCounts struct{ Transaction, NotTransaction, Unchecked, SetAside int }`
  - `func (s *Store) UnparsedVerdictCounts() (VerdictCounts, error)`
  - `type TxnCheckSample struct{ FromAddr, Subject string; RawBody []byte; IsTxn bool }`
  - `func (s *Store) SelectTxnCheckSamples(perClass int) ([]TxnCheckSample, error)`

- [ ] **Step 1: Failing tests** (`internal/store/verdict_test.go`)

```go
package store

import (
	"testing"
	"time"
)

func ingestRow(t *testing.T, st *Store, uid, status string) int64 {
	t.Helper()
	if _, err := st.InsertIngest(IngestRecord{MessageUID: uid, FromAddr: "a@dib.ae", Subject: "s-" + uid,
		ParseStatus: status, RawBody: []byte("body " + uid), ReceivedAt: time.Now(), CreatedAt: time.Now()}); err != nil {
		t.Fatal(err)
	}
	var id int64
	if err := st.DB.QueryRow(`SELECT id FROM ingest_log WHERE message_uid=?`, uid).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

func TestIngestVerdictRoundTrip(t *testing.T) {
	st := newTestStore(t)
	id := ingestRow(t, st, "u1", "unparsed")
	if err := st.SetIngestVerdict(id, "transaction", 0.93); err != nil {
		t.Fatal(err)
	}
	// MarkParsed must not clear the stored verdict.
	if err := st.MarkParsed(id, "unparsed", "", "template: no match"); err != nil {
		t.Fatal(err)
	}
	rows, err := st.SelectForParse(SelectForParseOpts{OnlyUnparsed: true})
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 || rows[0].AIVerdict != "transaction" || rows[0].AIVerdictConf != 0.93 {
		t.Fatalf("rows = %+v, want one row with verdict transaction 0.93", rows)
	}
}

func TestUnparsedVerdictCounts(t *testing.T) {
	st := newTestStore(t)
	a := ingestRow(t, st, "a", "unparsed")
	b := ingestRow(t, st, "b", "unparsed")
	ingestRow(t, st, "c", "unparsed") // unchecked
	d := ingestRow(t, st, "d", "unparsed")
	e := ingestRow(t, st, "e", "unparsed")
	ingestRow(t, st, "f", "parsed")
	_ = st.SetIngestVerdict(a, "transaction", 0.9)
	_ = st.SetIngestVerdict(b, "not_transaction", 0.8)
	_ = st.SetIngestVerdict(d, "not_transaction", 0.99)
	_ = st.MarkParsed(d, "ignored", "ai_check", "") // set aside
	_ = st.MarkParsed(e, "ignored", "template", "") // a parser's ignore, not the AI's
	got, err := st.UnparsedVerdictCounts()
	if err != nil {
		t.Fatal(err)
	}
	want := VerdictCounts{Transaction: 1, NotTransaction: 1, Unchecked: 1, SetAside: 1}
	if got != want {
		t.Errorf("counts = %+v, want %+v", got, want)
	}
}

func TestSelectTxnCheckSamples(t *testing.T) {
	st := newTestStore(t)
	for _, uid := range []string{"p1", "p2", "p3"} {
		ingestRow(t, st, uid, "parsed")
	}
	for _, uid := range []string{"i1", "i2"} {
		id := ingestRow(t, st, uid, "unparsed")
		_ = st.MarkParsed(id, "ignored", "template", "")
	}
	ai := ingestRow(t, st, "ai", "unparsed")
	_ = st.MarkParsed(ai, "ignored", "ai_check", "") // labelled by the classifier: excluded
	ingestRow(t, st, "u", "unparsed")                 // no label: excluded

	got, err := st.SelectTxnCheckSamples(2)
	if err != nil {
		t.Fatal(err)
	}
	txn, not := 0, 0
	for _, s := range got {
		if s.Subject == "s-ai" || s.Subject == "s-u" {
			t.Errorf("unexpected sample %q", s.Subject)
		}
		if len(s.RawBody) == 0 {
			t.Errorf("sample %q has no body", s.Subject)
		}
		if s.IsTxn {
			txn++
		} else {
			not++
		}
	}
	if txn != 2 || not != 2 {
		t.Errorf("perClass 2: %d txn / %d not, want 2 / 2", txn, not)
	}
	all, _ := st.SelectTxnCheckSamples(10)
	if len(all) != 5 {
		t.Errorf("perClass 10: %d samples, want 5", len(all))
	}
	again, _ := st.SelectTxnCheckSamples(2)
	for i := range got {
		if got[i].Subject != again[i].Subject {
			t.Fatal("sampling must be repeatable")
		}
	}
}
```

Run: `go test ./internal/store/ -run 'Verdict|TxnCheckSamples' -count=1`
Expected: compile FAIL.

- [ ] **Step 2: Migration.** In `internal/store/store.go` `migrate`, add before its final `return nil`:

```go
	// AI transaction check (2026-10): the classifier's verdict on an email no
	// parser read. Kept so a reprocess re-applies it without another call.
	if err := addColumnIfMissing(db, "ingest_log", "ai_verdict", "TEXT"); err != nil {
		return err
	}
	if err := addColumnIfMissing(db, "ingest_log", "ai_verdict_conf", "REAL"); err != nil {
		return err
	}
```

- [ ] **Step 3: `SelectForParse` carries the verdict.** In `internal/store/transactions.go`, add to `IngestForParse`:

```go
	AIVerdict     string  // "" when the AI check has not answered
	AIVerdictConf float64
```

Change the query's column list to:

```go
	q := `SELECT id, from_addr, subject, parse_status, received_at, raw_body,
	             COALESCE(ai_verdict,''), COALESCE(ai_verdict_conf,0)
	        FROM ingest_log WHERE parse_status IN ` + statuses
```

and the scan to `rows.Scan(&r.ID, &r.FromAddr, &r.Subject, &r.ParseStatus, &recv, &raw, &r.AIVerdict, &r.AIVerdictConf)`.

- [ ] **Step 4: New store methods.** Append to `internal/store/ingest.go`:

```go
// SetIngestVerdict stores the AI transaction check's answer for one row.
func (s *Store) SetIngestVerdict(ingestID int64, verdict string, conf float64) error {
	_, err := s.DB.Exec(`UPDATE ingest_log SET ai_verdict=?, ai_verdict_conf=? WHERE id=?`, verdict, conf, ingestID)
	return err
}

// VerdictCounts summarizes emails no parser read, by AI verdict, plus the
// emails the AI check set aside as not transactions.
type VerdictCounts struct {
	Transaction    int // unparsed; the AI says it is a transaction
	NotTransaction int // unparsed; the AI says not, below the set-aside threshold
	Unchecked      int // unparsed; no verdict yet
	SetAside       int // ignored by the AI check (parse_tier 'ai_check')
}

// UnparsedVerdictCounts returns VerdictCounts over all of ingest_log.
func (s *Store) UnparsedVerdictCounts() (VerdictCounts, error) {
	var v VerdictCounts
	err := s.DB.QueryRow(`SELECT
		COALESCE(SUM(parse_status='unparsed' AND ai_verdict='transaction'),0),
		COALESCE(SUM(parse_status='unparsed' AND ai_verdict='not_transaction'),0),
		COALESCE(SUM(parse_status='unparsed' AND ai_verdict IS NULL),0),
		COALESCE(SUM(parse_status='ignored' AND parse_tier='ai_check'),0)
		FROM ingest_log`).Scan(&v.Transaction, &v.NotTransaction, &v.Unchecked, &v.SetAside)
	return v, err
}
```

Append to `internal/store/eval.go`:

```go
// TxnCheckSample is one labelled email for the offline txncheck-eval command.
type TxnCheckSample struct {
	FromAddr string
	Subject  string
	RawBody  []byte
	IsTxn    bool
}

// SelectTxnCheckSamples returns up to perClass parsed emails (labelled
// transactions) and up to perClass emails a parser rejected as
// non-transactional (labelled not). Rows the AI check set aside are excluded:
// their label came from the classifier being measured. Rows are picked by a
// fixed hash of id, so a rerun picks the same ones. Read-only.
func (s *Store) SelectTxnCheckSamples(perClass int) ([]TxnCheckSample, error) {
	rows, err := s.DB.Query(`
		SELECT COALESCE(from_addr,''), COALESCE(subject,''), raw_body, is_txn FROM (
			SELECT * FROM (SELECT id, from_addr, subject, raw_body, 1 AS is_txn FROM ingest_log
				WHERE parse_status='parsed' ORDER BY (id*2654435761)%4294967296 LIMIT ?)
			UNION ALL
			SELECT * FROM (SELECT id, from_addr, subject, raw_body, 0 AS is_txn FROM ingest_log
				WHERE parse_status='ignored' AND COALESCE(parse_tier,'')<>'ai_check'
				ORDER BY (id*2654435761)%4294967296 LIMIT ?))
		ORDER BY id`, perClass, perClass)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []TxnCheckSample
	for rows.Next() {
		var smp TxnCheckSample
		var raw []byte
		if err := rows.Scan(&smp.FromAddr, &smp.Subject, &raw, &smp.IsTxn); err != nil {
			return nil, err
		}
		body, derr := decodeBody(raw)
		if derr != nil {
			body = raw
		}
		smp.RawBody = body
		out = append(out, smp)
	}
	return out, rows.Err()
}
```

Run: `go test ./internal/store/ -count=1`
Expected: PASS.

- [ ] **Step 5: Prove the tests bite.** Remove `AND COALESCE(parse_tier,'')<>'ai_check'` → `-run TxnCheckSamples` FAILS. Revert. Change `ai_verdict IS NULL` to `1` → `-run UnparsedVerdictCounts` FAILS. Revert.

- [ ] **Step 6: Commit**

```bash
git add internal/store
git commit -m "feat(store): ingest_log keeps the AI check's verdict; counts and eval samples"
```

---

### Task 5: The AI check — `TxnChecker` and the new cascade tier

**Files:**
- Create: `internal/parse/txncheck.go`, `internal/parse/txncheck_test.go`
- Modify: `internal/parse/cascade.go`

**Interfaces:**
- Consumes: `classify.Classifier`, `classify.Request`, `classify.Option` (Task 2); `aihttp.ErrAIDisabled` (Task 1); `truncateBody` (exists in `internal/parse/ai.go`, bounds at `maxExtractBodyBytes` = 8 KB).
- Produces:
  - constants `VerdictTxn = "transaction"`, `VerdictNotTxn = "not_transaction"`, `TierAICheck = "ai_check"`
  - `type TxnVerdict struct{ Verdict string; Confidence float64 }`
  - `type TxnChecker interface { Check(ctx context.Context, from, subject, body string) (TxnVerdict, error) }`
  - `func NewClassifierTxnChecker(c classify.Classifier) *ClassifierTxnChecker`
  - `type storedVerdict TxnVerdict` (implements `TxnChecker`; used by Task 6)
  - `Cascade.Check TxnChecker`, `Cascade.IgnoreAt float64`, `Result.Verdict *TxnVerdict`

- [ ] **Step 1: Failing tests** (`internal/parse/txncheck_test.go`)

```go
package parse

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"ledger/internal/aihttp"
	"ledger/internal/classify"
)

type fakeClf struct {
	ans classify.Answer
	err error
	got classify.Request
}

func (f *fakeClf) Classify(_ context.Context, r classify.Request) (classify.Answer, error) {
	f.got = r
	return f.ans, f.err
}
func (f *fakeClf) MaxOptions() int { return 255 }

type stubCheck struct {
	v     TxnVerdict
	err   error
	calls *int
}

func (s stubCheck) Check(context.Context, string, string, string) (TxnVerdict, error) {
	if s.calls != nil {
		*s.calls++
	}
	return s.v, s.err
}

type stubIgnoreParser struct{}

func (stubIgnoreParser) Bank() string                      { return "stub" }
func (stubIgnoreParser) Matches(from, subject string) bool { return from == "stub@bank.com" }
func (stubIgnoreParser) Parse(string, string) (ParsedTxn, error) {
	return ParsedTxn{}, ErrIgnoreEmail
}

const junk = "totally unparseable content"

func TestTxnCheckerRequestShape(t *testing.T) {
	f := &fakeClf{ans: classify.Answer{Choice: VerdictTxn, Confidence: 0.9}}
	long := strings.Repeat("a", 20000)
	v, err := NewClassifierTxnChecker(f).Check(t.Context(), "alerts@dib.ae", "Card used", long)
	if err != nil || v.Verdict != VerdictTxn || v.Confidence != 0.9 {
		t.Fatalf("verdict = %+v err = %v", v, err)
	}
	r := f.got
	if r.Path != "txn_check" || r.Detail != "Card used" || r.Question.ID != "is_transaction" {
		t.Errorf("request = %+v", r)
	}
	if len(r.State) != 3 || r.State["from"] != "alerts@dib.ae" || r.State["subject"] != "Card used" {
		t.Errorf("state = %v, want from, subject, body only", r.State)
	}
	if n := len(r.State["body"]); n == 0 || n > maxExtractBodyBytes {
		t.Errorf("body is %d bytes, want 1..%d", n, maxExtractBodyBytes)
	}
	names := []string{}
	for _, o := range r.Question.Options {
		names = append(names, o.Name)
	}
	if strings.Join(names, ",") != VerdictTxn+","+VerdictNotTxn {
		t.Errorf("options = %v", names)
	}
}

// A provider answer outside the two options is an error, never "not a
// transaction".
func TestTxnCheckerRejectsUnexpectedChoice(t *testing.T) {
	f := &fakeClf{ans: classify.Answer{Choice: "maybe", Confidence: 1}}
	if v, err := NewClassifierTxnChecker(f).Check(t.Context(), "a", "b", "c"); err == nil {
		t.Errorf("got %+v, want an error", v)
	}
}

func run(c *Cascade) Result {
	return c.Run(context.Background(), "x@y.com", "s", junk, time.Time{})
}

func TestCascadeAICheckIgnoresConfidentNotTxn(t *testing.T) {
	res := run(&Cascade{Heuristic: HeuristicParser{}, IgnoreAt: 0.95,
		Check: stubCheck{v: TxnVerdict{VerdictNotTxn, 0.99}}})
	if res.Status != StatusIgnored || res.Tier != TierAICheck || res.Verdict == nil {
		t.Fatalf("res = %+v, want ignored by ai_check with a verdict", res)
	}
}

func TestCascadeAICheckBelowThresholdStaysUnparsed(t *testing.T) {
	res := run(&Cascade{Heuristic: HeuristicParser{}, IgnoreAt: 0.95,
		Check: stubCheck{v: TxnVerdict{VerdictNotTxn, 0.9}}})
	if res.Status != StatusUnparsed || res.Verdict == nil || res.Verdict.Confidence != 0.9 {
		t.Fatalf("res = %+v, want unparsed with the verdict", res)
	}
	if !strings.Contains(res.Err, "ai_check: not_transaction (0.90)") {
		t.Errorf("Err = %q, want the verdict noted", res.Err)
	}
}

func TestCascadeAICheckTransactionStaysUnparsed(t *testing.T) {
	res := run(&Cascade{Heuristic: HeuristicParser{}, IgnoreAt: 0.95,
		Check: stubCheck{v: TxnVerdict{VerdictTxn, 0.99}}})
	if res.Status != StatusUnparsed || res.Verdict == nil || res.Verdict.Verdict != VerdictTxn {
		t.Fatalf("res = %+v, want unparsed with verdict transaction", res)
	}
}

func TestCascadeAICheckZeroThresholdNeverIgnores(t *testing.T) {
	res := run(&Cascade{Heuristic: HeuristicParser{}, Check: stubCheck{v: TxnVerdict{VerdictNotTxn, 1}}})
	if res.Status != StatusUnparsed {
		t.Fatalf("status = %s, want unparsed when IgnoreAt is unset", res.Status)
	}
}

// AI off is a benign skip: no verdict, nothing claimed in parse_error.
func TestCascadeAICheckDisabledIsBenign(t *testing.T) {
	res := run(&Cascade{Heuristic: HeuristicParser{}, IgnoreAt: 0.95,
		Check: stubCheck{err: fmt.Errorf("txn check: %w", aihttp.ErrAIDisabled)}})
	if res.Status != StatusUnparsed || res.Verdict != nil {
		t.Fatalf("res = %+v, want unparsed with no verdict", res)
	}
	if strings.Contains(res.Err, TierAICheck) {
		t.Errorf("Err = %q, must not report the disabled check", res.Err)
	}
}

func TestCascadeAICheckErrorRecorded(t *testing.T) {
	res := run(&Cascade{Heuristic: HeuristicParser{}, IgnoreAt: 0.95,
		Check: stubCheck{err: errors.New("boom")}})
	if res.Status != StatusUnparsed || res.Verdict != nil || !strings.Contains(res.Err, "ai_check: boom") {
		t.Fatalf("res = %+v, want unparsed noting the check error", res)
	}
}

func TestCascadeTemplateIgnoreSkipsAICheck(t *testing.T) {
	calls := 0
	c := &Cascade{Parsers: []BankParser{stubIgnoreParser{}}, Heuristic: HeuristicParser{}, IgnoreAt: 0.95,
		Check: stubCheck{v: TxnVerdict{VerdictNotTxn, 1}, calls: &calls}}
	res := c.Run(context.Background(), "stub@bank.com", "s", junk, time.Time{})
	if res.Status != StatusIgnored || res.Tier != TierTemplate || calls != 0 {
		t.Fatalf("res = %+v calls = %d, want a template ignore with no check", res, calls)
	}
}
```

Run: `go test ./internal/parse/ -run 'TxnChecker|AICheck' -count=1`
Expected: compile FAIL.

- [ ] **Step 2: Implement the checker** (`internal/parse/txncheck.go`)

```go
package parse

import (
	"context"
	"fmt"

	"ledger/internal/classify"
)

// The AI check's two answers, and the parse tier it stamps on an email it sets
// aside.
const (
	VerdictTxn    = "transaction"
	VerdictNotTxn = "not_transaction"
	TierAICheck   = "ai_check"
)

// TxnVerdict is the AI check's answer for one email.
type TxnVerdict struct {
	Verdict    string // VerdictTxn | VerdictNotTxn
	Confidence float64
}

// TxnChecker answers "is this email a transaction?". It never extracts fields.
type TxnChecker interface {
	Check(ctx context.Context, from, subject, body string) (TxnVerdict, error)
}

const txnCheckInstructions = "Is this email from a UAE bank a notice of one completed transaction: " +
	"money taken from, or paid into, the customer's account or card, with an amount? " +
	"`from` is the sender, `subject` the subject line, `body` the email text."

var txnCheckOptions = []classify.Option{
	{Name: VerdictTxn, Criterion: "Reports one completed purchase, debit, credit, transfer or withdrawal, with its amount"},
	{Name: VerdictNotTxn, Criterion: "Anything else: a promotion, a one-time password, a statement, " +
		"a balance or due-date reminder, a login or security alert, or a declined or pending payment"},
}

// ClassifierTxnChecker asks a classification provider. It sends the sender,
// the subject and at most maxExtractBodyBytes of the email text.
type ClassifierTxnChecker struct {
	C classify.Classifier
}

// NewClassifierTxnChecker wraps a provider.
func NewClassifierTxnChecker(c classify.Classifier) *ClassifierTxnChecker {
	return &ClassifierTxnChecker{C: c}
}

// Check implements TxnChecker.
func (k *ClassifierTxnChecker) Check(ctx context.Context, from, subject, body string) (TxnVerdict, error) {
	ans, err := k.C.Classify(ctx, classify.Request{
		Path:     "txn_check",
		Detail:   subject,
		State:    map[string]string{"from": from, "subject": subject, "body": truncateBody(body)},
		Question: classify.Question{ID: "is_transaction", Instructions: txnCheckInstructions, Options: txnCheckOptions},
	})
	if err != nil {
		return TxnVerdict{}, fmt.Errorf("txn check: %w", err)
	}
	if ans.Choice != VerdictTxn && ans.Choice != VerdictNotTxn {
		return TxnVerdict{}, fmt.Errorf("txn check: unexpected answer %q", ans.Choice)
	}
	return TxnVerdict{Verdict: ans.Choice, Confidence: ans.Confidence}, nil
}

// storedVerdict replays a verdict saved on the ingest row, with no provider
// call. The processor uses it so a reprocess never pays twice.
type storedVerdict TxnVerdict

func (s storedVerdict) Check(context.Context, string, string, string) (TxnVerdict, error) {
	return TxnVerdict(s), nil
}
```

- [ ] **Step 3: The cascade tier** (`internal/parse/cascade.go`). Add `"fmt"` and `"ledger/internal/aihttp"` to the imports. Extend the types:

```go
// Cascade runs the extraction tiers in order. AI may be a DisabledExtractor.
// Check, when set, classifies an email no tier could read; IgnoreAt is the
// confidence at or above which a "not a transaction" verdict sets the email
// aside (0 = never).
type Cascade struct {
	Parsers   []BankParser
	Heuristic HeuristicParser
	AI        Extractor
	Check     TxnChecker
	IgnoreAt  float64
}

type Result struct {
	Txn     ParsedTxn
	Status  string      // parsed | low_confidence | unparsed | ignored
	Tier    string      // template | heuristic | ai | ai_check | "" (none)
	Err     string      // last tier error, for ingest_log.parse_error (optional)
	Verdict *TxnVerdict // the AI check's answer, when it gave one
}
```

Insert this block in `Run` between the AI-extraction tier and the `// Floor: nothing resolved.` line:

```go
	// Tier 4: AI check. It only classifies; it never writes a transaction. A
	// confident "not a transaction" sets the email aside (ignored; the raw body
	// stays in ingest_log). Anything else stays unparsed, carrying the verdict.
	if c.Check != nil {
		v, err := c.Check.Check(ctx, from, subject, textBody)
		switch {
		case err == nil && v.Verdict == VerdictNotTxn && c.IgnoreAt > 0 && v.Confidence >= c.IgnoreAt:
			return Result{Status: StatusIgnored, Tier: TierAICheck, Verdict: &v}
		case err == nil:
			fail(TierAICheck, fmt.Errorf("%s (%.2f)", v.Verdict, v.Confidence))
			return Result{Status: StatusUnparsed, Err: strings.Join(errs, "; "), Verdict: &v}
		case !errors.Is(err, aihttp.ErrAIDisabled):
			fail(TierAICheck, err)
		}
	}
```

Run: `go test ./internal/parse/ -count=1`
Expected: PASS (new tests and all existing cascade tests).

- [ ] **Step 4: Prove the tests bite.** Remove `c.IgnoreAt > 0 &&` → `-run ZeroThreshold` FAILS. Revert. Change `case !errors.Is(err, aihttp.ErrAIDisabled):` to `default:` → `-run DisabledIsBenign` FAILS. Revert.

- [ ] **Step 5: Commit**

```bash
git add internal/parse/txncheck.go internal/parse/txncheck_test.go internal/parse/cascade.go
git commit -m "feat(parse): AI check tier classifies unread emails; never writes a transaction"
```

---

### Task 6: Processor — replay stored verdicts and guard rows with transactions

**Files:**
- Modify: `internal/parse/processor.go`
- Test: `internal/parse/processor_txncheck_test.go`

**Interfaces:**
- Consumes: `storedVerdict`, `TierAICheck`, `Result.Verdict` (Task 5); `IngestForParse.AIVerdict`/`AIVerdictConf`, `SetIngestVerdict` (Task 4); `simpleEmail` (exists in `processor_ai_skip_test.go`).

- [ ] **Step 1: Failing tests** (`internal/parse/processor_txncheck_test.go`)

```go
package parse

import (
	"context"
	"testing"
	"time"

	"ledger/internal/store"
)

func openStore(t *testing.T) *store.Store {
	t.Helper()
	st, err := store.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	return st
}

func addIngest(t *testing.T, st *store.Store, uid, status string) int64 {
	t.Helper()
	if _, err := st.InsertIngest(store.IngestRecord{MessageUID: uid, FromAddr: "x@y.z", Subject: "s",
		ParseStatus: status, RawBody: simpleEmail("hello " + uid), ReceivedAt: time.Now(), CreatedAt: time.Now()}); err != nil {
		t.Fatal(err)
	}
	var id int64
	if err := st.DB.QueryRow(`SELECT id FROM ingest_log WHERE message_uid=?`, uid).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

func rowState(t *testing.T, st *store.Store, id int64) (status, tier, verdict string) {
	t.Helper()
	if err := st.DB.QueryRow(`SELECT parse_status, COALESCE(parse_tier,''), COALESCE(ai_verdict,'')
		FROM ingest_log WHERE id=?`, id).Scan(&status, &tier, &verdict); err != nil {
		t.Fatal(err)
	}
	return
}

var manual = store.SelectForParseOpts{OnlyUnparsed: false}

func TestProcessorStoresVerdictAndIgnores(t *testing.T) {
	st := openStore(t)
	id := addIngest(t, st, "u1", "unparsed")
	p := NewProcessor(st, &Cascade{Heuristic: HeuristicParser{}, IgnoreAt: 0.95,
		Check: stubCheck{v: TxnVerdict{VerdictNotTxn, 0.99}}})
	if _, err := p.ProcessPending(context.Background(), manual); err != nil {
		t.Fatal(err)
	}
	if s, tier, v := rowState(t, st, id); s != StatusIgnored || tier != TierAICheck || v != VerdictNotTxn {
		t.Errorf("row = %s/%s/%s, want ignored/ai_check/not_transaction", s, tier, v)
	}
}

func TestProcessorReusesStoredVerdict(t *testing.T) {
	st := openStore(t)
	id := addIngest(t, st, "u1", "unparsed")
	calls := 0
	p := NewProcessor(st, &Cascade{Heuristic: HeuristicParser{}, IgnoreAt: 0.95,
		Check: stubCheck{v: TxnVerdict{VerdictTxn, 0.9}, calls: &calls}})
	for i := 0; i < 2; i++ {
		if _, err := p.ProcessPending(context.Background(), manual); err != nil {
			t.Fatal(err)
		}
	}
	if calls != 1 {
		t.Errorf("provider asked %d times, want 1 (the second run replays the stored verdict)", calls)
	}
	if s, _, v := rowState(t, st, id); s != StatusUnparsed || v != VerdictTxn {
		t.Errorf("row = %s/%s, want unparsed/transaction", s, v)
	}
}

func TestProcessorReappliesStoredVerdictUnderNewThreshold(t *testing.T) {
	st := openStore(t)
	id := addIngest(t, st, "u1", "unparsed")
	calls := 0
	casc := &Cascade{Heuristic: HeuristicParser{}, IgnoreAt: 0.95,
		Check: stubCheck{v: TxnVerdict{VerdictNotTxn, 0.9}, calls: &calls}}
	p := NewProcessor(st, casc)
	if _, err := p.ProcessPending(context.Background(), manual); err != nil {
		t.Fatal(err)
	}
	if s, _, _ := rowState(t, st, id); s != StatusUnparsed {
		t.Fatalf("0.90 under a 0.95 threshold: status %s, want unparsed", s)
	}
	casc.IgnoreAt = 0.85
	if _, err := p.ProcessPending(context.Background(), manual); err != nil {
		t.Fatal(err)
	}
	if s, tier, _ := rowState(t, st, id); s != StatusIgnored || tier != TierAICheck {
		t.Errorf("0.90 under a 0.85 threshold: %s/%s, want ignored/ai_check", s, tier)
	}
	if calls != 1 {
		t.Errorf("provider asked %d times, want 1", calls)
	}
}

func TestProcessorNeverChecksLowConfidenceRows(t *testing.T) {
	st := openStore(t)
	id := addIngest(t, st, "u1", "low_confidence")
	calls := 0
	p := NewProcessor(st, &Cascade{Heuristic: HeuristicParser{}, IgnoreAt: 0.95,
		Check: stubCheck{v: TxnVerdict{VerdictNotTxn, 1}, calls: &calls}})
	if _, err := p.ProcessPending(context.Background(), manual); err != nil {
		t.Fatal(err)
	}
	if calls != 0 {
		t.Errorf("checked a low_confidence row %d times, want 0", calls)
	}
	if s, _, _ := rowState(t, st, id); s == StatusIgnored {
		t.Error("a low_confidence row was set aside")
	}
}

// A row demoted to unparsed after an old AI extraction still owns a
// transaction. The AI check must never hide it.
func TestProcessorAICheckNeverHidesRowWithTransaction(t *testing.T) {
	st := openStore(t)
	id := addIngest(t, st, "u1", "unparsed")
	if _, _, err := st.InsertTransaction(store.TransactionRow{
		PostedAt: time.Date(2026, 6, 1, 9, 0, 0, 0, time.UTC), AmountFils: 5000, Currency: "AED",
		Direction: "debit", MerchantRaw: "SPINNEYS", Status: "needs_review", Source: "email", IngestID: id,
	}); err != nil {
		t.Fatal(err)
	}
	p := NewProcessor(st, &Cascade{Heuristic: HeuristicParser{}, IgnoreAt: 0.95,
		Check: stubCheck{v: TxnVerdict{VerdictNotTxn, 1}}})
	if _, err := p.ProcessPending(context.Background(), manual); err != nil {
		t.Fatal(err)
	}
	if s, _, _ := rowState(t, st, id); s == StatusIgnored {
		t.Error("a row with a transaction was set aside")
	}
}
```

Run: `go test ./internal/parse/ -run Processor -count=1`
Expected: FAIL. `ReusesStoredVerdict` sees 2 calls, `NeverChecksLowConfidence` sees 1 call, `NeverHidesRowWithTransaction` finds the row ignored, and the verdict is never stored.

- [ ] **Step 2: Implement** in `internal/parse/processor.go`. Replace the `casc := p.cascade` … `res := casc.Run(...)` block with:

```go
		// A low_confidence row was already extracted by the AI tier once —
		// re-running AI would just re-bill for the same guess, and the row
		// already owns a transaction the AI check must never set aside.
		// Reprocess exists so a *fixed deterministic parser* can upgrade it.
		casc := p.cascade
		if row.ParseStatus == StatusLowConfidence {
			c := *p.cascade
			c.AI = nil
			c.Check = nil
			casc = &c
		} else if row.AIVerdict != "" && p.cascade.Check != nil {
			// Replay the stored verdict under today's threshold, with no
			// provider call.
			c := *p.cascade
			c.Check = storedVerdict{Verdict: row.AIVerdict, Confidence: row.AIVerdictConf}
			casc = &c
		}
		res := casc.Run(ctx, from, subject, text, fallback)
		if res.Verdict != nil {
			_ = p.store.SetIngestVerdict(row.ID, res.Verdict.Verdict, res.Verdict.Confidence)
		}
```

At the top of the `if res.Status == StatusIgnored {` branch, before its `MarkParsed`, add:

```go
			if res.Tier == TierAICheck {
				// A row that already produced a transaction (an old AI
				// extraction, demoted by a failed reprocess) must never be
				// hidden by a classifier. Leave it as it is.
				if _, exists, xerr := p.store.TransactionIDByIngest(row.ID); xerr != nil || exists {
					continue
				}
			}
```

Run: `go test ./internal/parse/ -count=1`
Expected: PASS, including `TestReprocessSkipsAITierForLowConfidenceRows`.

- [ ] **Step 3: Prove the guards bite.** Delete `c.Check = nil` → `-run NeverChecksLowConfidence` FAILS. Revert. Delete the `TransactionIDByIngest` guard → `-run NeverHidesRow` FAILS. Revert.

- [ ] **Step 4: Commit**

```bash
git add internal/parse/processor.go internal/parse/processor_txncheck_test.go
git commit -m "feat(parse): processor stores and replays AI-check verdicts; never hides a row with a transaction"
```

---

### Task 7: Config `ai.provider` and the wiring that sunsets Anthropic

**Files:**
- Modify: `internal/config/config.go`, `internal/config/config_test.go`, `cmd/ledger/main.go`

**Interfaces:**
- Consumes: `classify.NewTypeSafe` (Task 2), `categorize.NewClassifierCategorizer` (Task 3), `parse.NewClassifierTxnChecker`, `Cascade.Check`/`IgnoreAt` (Task 5).
- Produces: `AIConfig.Provider string`, `AIConfig.TxnIgnoreThreshold float64`, `func (c AIConfig) ProviderKey() string`. `CategorizeKey()` is removed.

- [ ] **Step 1: Failing tests.** In `internal/config/config_test.go`, **replace** `TestAIProviderDefaults`, `TestTypeSafeProviderNeedsTypeSafeKey`, `TestTypeSafeWithExtractionStillNeedsAnthropicKey`, `TestUnknownProviderRejected` and `TestCategorizeKey` with:

```go
func TestAIProviderDefaults(t *testing.T) {
	clearLedgerEnv(t)
	cfg, err := Load("")
	if err != nil {
		t.Fatal(err)
	}
	if cfg.AI.Provider != "typesafe" || cfg.AI.TypeSafeModel != "jev-1.13.0" || cfg.AI.TxnIgnoreThreshold != 0.97 {
		t.Errorf("defaults = %q %q %v", cfg.AI.Provider, cfg.AI.TypeSafeModel, cfg.AI.TxnIgnoreThreshold)
	}
}

func TestTypeSafeProviderNeedsTypeSafeKey(t *testing.T) {
	clearLedgerEnv(t)
	p := writeTOML(t, "[ai]\nenabled = true\nprovider = \"typesafe\"\n")
	if _, err := Load(p); err == nil || !strings.Contains(err.Error(), "LEDGER_TYPESAFE_API_KEY") {
		t.Errorf("err = %v, want a LEDGER_TYPESAFE_API_KEY error", err)
	}
}

// Anthropic is sunset: the TypeSafe provider never needs its key, whatever
// allow_ai_extraction says.
func TestTypeSafeNeverNeedsAnthropicKey(t *testing.T) {
	clearLedgerEnv(t)
	t.Setenv("LEDGER_TYPESAFE_API_KEY", "ts")
	p := writeTOML(t, "[ai]\nenabled = true\nprovider = \"typesafe\"\nallow_ai_extraction = true\n")
	if _, err := Load(p); err != nil {
		t.Errorf("err = %v, want nil", err)
	}
}

func TestAnthropicProviderNeedsAnthropicKey(t *testing.T) {
	clearLedgerEnv(t)
	p := writeTOML(t, "[ai]\nenabled = true\nprovider = \"anthropic\"\n")
	if _, err := Load(p); err == nil || !strings.Contains(err.Error(), "LEDGER_AI_API_KEY") {
		t.Errorf("err = %v, want a LEDGER_AI_API_KEY error", err)
	}
}

func TestUnknownProviderRejected(t *testing.T) {
	clearLedgerEnv(t)
	t.Setenv("LEDGER_AI_API_KEY", "a")
	t.Setenv("LEDGER_TYPESAFE_API_KEY", "ts")
	p := writeTOML(t, "[ai]\nenabled = true\nprovider = \"openai\"\n")
	if _, err := Load(p); err == nil {
		t.Error("want an error for an unknown provider")
	}
}

// Production's /etc/ledger/config.toml as of 2026-10-01, verbatim [ai] block.
func TestCategorizeProviderAliasStillRead(t *testing.T) {
	clearLedgerEnv(t)
	t.Setenv("LEDGER_TYPESAFE_API_KEY", "ts")
	p := writeTOML(t, "[ai]\nenabled = true\ncategorize_provider = \"typesafe\"\n")
	cfg, err := Load(p)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.AI.Provider != "typesafe" {
		t.Errorf("Provider = %q, want typesafe from the old key", cfg.AI.Provider)
	}
}

func TestProviderWinsOverAlias(t *testing.T) {
	clearLedgerEnv(t)
	t.Setenv("LEDGER_AI_API_KEY", "a")
	p := writeTOML(t, "[ai]\nenabled = true\nprovider = \"anthropic\"\ncategorize_provider = \"typesafe\"\n")
	cfg, err := Load(p)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.AI.Provider != "anthropic" {
		t.Errorf("Provider = %q, want anthropic", cfg.AI.Provider)
	}
}

func TestTxnIgnoreThresholdBounds(t *testing.T) {
	clearLedgerEnv(t)
	for _, v := range []string{"0.5", "0", "1.01"} {
		p := writeTOML(t, "[ai]\ntxn_ignore_threshold = "+v+"\n")
		if _, err := Load(p); err == nil {
			t.Errorf("threshold %s: want an error", v)
		}
	}
	p := writeTOML(t, "[ai]\ntxn_ignore_threshold = 0.9\n")
	if cfg, err := Load(p); err != nil || cfg.AI.TxnIgnoreThreshold != 0.9 {
		t.Errorf("threshold 0.9: cfg %v err %v", cfg.AI.TxnIgnoreThreshold, err)
	}
}

func TestProviderKey(t *testing.T) {
	c := AIConfig{Provider: "typesafe", APIKey: "a", TypeSafeAPIKey: "ts"}
	if c.ProviderKey() != "ts" {
		t.Errorf("typesafe key = %q", c.ProviderKey())
	}
	c.Provider = "anthropic"
	if c.ProviderKey() != "a" {
		t.Errorf("anthropic key = %q", c.ProviderKey())
	}
}
```

Keep `TestAIConfigDefaults`, `TestAIConfigEnvAPIKey` and `TestAIConfigEnabledRequiresAPIKey` unchanged; they stay true. (The last one still errors: `enabled = true` with no key now fails on the missing `LEDGER_TYPESAFE_API_KEY`.)

Run: `go test ./internal/config/ -count=1`
Expected: compile FAIL (`Provider`, `TxnIgnoreThreshold`, `ProviderKey` undefined).

- [ ] **Step 2: Implement** (`internal/config/config.go`). Replace `AIConfig` and `CategorizeKey`:

```go
// AIConfig holds settings for the AI provider. API keys are NEVER read from
// TOML; they come from LEDGER_TYPESAFE_API_KEY and LEDGER_AI_API_KEY.
type AIConfig struct {
	Enabled bool `toml:"enabled"`
	// Provider answers every AI question: "typesafe" (default), or "anthropic"
	// (sunset 2026-10: Anthropic categorization and extraction, kept only so
	// it can come back).
	Provider string `toml:"provider"`
	// CategorizeProvider is the pre-2026-10 name for Provider, still read.
	CategorizeProvider string `toml:"categorize_provider"`
	TypeSafeModel      string `toml:"typesafe_model"`
	// TxnIgnoreThreshold: a "not a transaction" verdict at or above this sets
	// the email aside. Pick it from `ledger txncheck-eval`.
	TxnIgnoreThreshold float64 `toml:"txn_ignore_threshold"`
	Model              string  `toml:"model"`               // Anthropic model; sunset path only
	AllowAIExtraction  bool    `toml:"allow_ai_extraction"` // sunset path only
	APIKey             string  `toml:"-"`                   // LEDGER_AI_API_KEY, env only
	TypeSafeAPIKey     string  `toml:"-"`                   // LEDGER_TYPESAFE_API_KEY, env only
}

// ProviderKey is the API key the configured provider needs.
func (c AIConfig) ProviderKey() string {
	if c.Provider == "anthropic" {
		return c.APIKey
	}
	return c.TypeSafeAPIKey
}
```

In `defaults()`, set the AI block to:

```go
		AI: AIConfig{
			Model:              "claude-haiku-4-5-20251001",
			AllowAIExtraction:  true,
			TypeSafeModel:      "jev-1.13.0",
			TxnIgnoreThreshold: 0.97,
		},
```

In `Load`, directly before `if err := cfg.validate(); err != nil {`:

```go
	if cfg.AI.Provider == "" {
		cfg.AI.Provider = cfg.AI.CategorizeProvider
	}
	if cfg.AI.Provider == "" {
		cfg.AI.Provider = "typesafe"
	}
```

In `validate`, replace the `if c.AI.Enabled { switch c.AI.CategorizeProvider … }` block with:

```go
	if c.AI.Enabled {
		switch c.AI.Provider {
		case "typesafe":
			if c.AI.TypeSafeAPIKey == "" {
				return fmt.Errorf("ai.provider = \"typesafe\" requires LEDGER_TYPESAFE_API_KEY env var")
			}
		case "anthropic":
			if c.AI.APIKey == "" {
				return fmt.Errorf("ai.provider = \"anthropic\" requires LEDGER_AI_API_KEY env var")
			}
		default:
			return fmt.Errorf("ai.provider must be \"typesafe\" or \"anthropic\" (got %q)", c.AI.Provider)
		}
	}
	if t := c.AI.TxnIgnoreThreshold; t <= 0.5 || t > 1 {
		return fmt.Errorf("ai.txn_ignore_threshold must be above 0.5 and at most 1 (got %v)", t)
	}
```

Run: `go test ./internal/config/ -count=1`
Expected: PASS.

- [ ] **Step 3: Wiring** (`cmd/ledger/main.go`).

Replace the two server calls:

```go
	srv.SetAIKeyPresent(cfg.AI.ProviderKey() != "")
	srv.SetAIProvider(cfg.AI.Provider)
```

Replace the two gate lines with one:

```go
	aiGate := gateFor(cfg.AI.ProviderKey() != "")
```

Replace the whole block from `// Pick AI clients based on config.` through the closing `}` of its `else { log.Printf("ai: disabled …") }` with:

```go
	// Pick AI clients based on config. The gate — not config — is the live on/off.
	var aiCat categorize.AICategorizer = categorize.DisabledAI{}
	var aiExt parse.Extractor = parse.DisabledExtractor{}
	var txnCheck parse.TxnChecker // nil: no AI check tier
	if cfg.AI.Enabled {
		var inner categorize.AICategorizer
		model := cfg.AI.TypeSafeModel
		switch cfg.AI.Provider {
		case "anthropic":
			// Sunset 2026-10. Kept so Anthropic can come back by config alone.
			model = cfg.AI.Model
			inner = categorize.NewAnthropicCategorizer(cfg.AI.APIKey, cfg.AI.Model, aiGate, aiRecorder)
			if cfg.AI.AllowAIExtraction {
				aiExt = parse.NewAnthropicExtractor(cfg.AI.APIKey, cfg.AI.Model, aiGate, aiRecorder)
			}
		default: // "typesafe"; config validation rejects anything else
			clf := classify.NewTypeSafe(cfg.AI.TypeSafeAPIKey, cfg.AI.TypeSafeModel, aiGate, aiRecorder)
			inner = categorize.NewClassifierCategorizer(clf)
			txnCheck = parse.NewClassifierTxnChecker(clf)
		}
		// Memo wrapper: a merchant the AI has already categorized is answered
		// from the ai_suggestions table, not paid for again.
		aiCat = categorize.MemoAI{Inner: inner, Store: st}
		log.Printf("ai: clients wired (provider=%s, model=%s, txn check=%t, set aside at >= %.2f); runtime master switch + cap now govern calls",
			cfg.AI.Provider, model, txnCheck != nil, cfg.AI.TxnIgnoreThreshold)
		if aihttp.CostMuUSD(model, 1, 0) == 0 {
			log.Printf("ai: WARNING no price for %s — the spend cap will not count its calls", model)
		}
	} else {
		log.Printf("ai: disabled (set ai.enabled=true + the provider's API key env var to activate)")
	}
```

Extend the cascade literal:

```go
	cascade := &parse.Cascade{
		Parsers:   []parse.BankParser{parse.DIBParser{}, parse.ENBDParser{}, parse.ENBDAlertParser{}},
		Heuristic: parse.HeuristicParser{},
		AI:        aiExt,
		Check:     txnCheck,
		IgnoreAt:  cfg.AI.TxnIgnoreThreshold,
	}
```

Also update the gate comment above `gateFor`: it now governs "every provider", and the HTTP boundary is `aihttp.Retrier.Post`.

Run: `gofmt -l cmd internal; go vet ./... && go build ./... && go test ./... -count=1`
Expected: no gofmt output, PASS.

- [ ] **Step 4: Smoke on scratch** (never `:8080`, never `/var/lib/ledger`):

```bash
W=$(mktemp -d); printf '[server]\nlisten = "127.0.0.1:8098"\ndata_dir = "%s"\n[ai]\nenabled = true\ncategorize_provider = "typesafe"\n' "$W" > $W/c.toml
CGO_ENABLED=0 go build -o $W/ledger ./cmd/ledger
LEDGER_TYPESAFE_API_KEY=dummy $W/ledger -config $W/c.toml > $W/log 2>&1 & PID=$!
for i in $(seq 20); do curl -sf http://127.0.0.1:8098/api/health >/dev/null && break; sleep 0.5; done
grep 'ai: clients wired' $W/log; curl -s http://127.0.0.1:8098/api/settings; echo
kill $PID; rm -rf $W
```

Expected: the log says `provider=typesafe, model=jev-1.13.0, txn check=true, set aside at >= 0.97`, and settings show `"ai_provider":"typesafe"` and `"ai_key_present":true`. No `LEDGER_AI_API_KEY` is needed.

- [ ] **Step 5: Commit**

```bash
git add internal/config cmd/ledger/main.go
git commit -m "feat(ai): ai.provider; TypeSafe answers both questions and Anthropic is sunset"
```

---

### Task 8: Show the unread emails — health counts and the Email ingest screen

**Files:**
- Modify: `internal/server/health.go`, `internal/server/server_test.go`
- Modify: `frontend/src/api/types.ts`, `frontend/src/lib/ingestHealth.ts`, `frontend/src/lib/ingestHealth.test.ts`, `frontend/src/screens/settings/IngestHealthPage.tsx`, `frontend/src/screens/settings/IngestHealthPage.test.tsx`, `frontend/src/screens/settings/AiUsagePage.tsx`

**Interfaces:**
- Consumes: `store.VerdictCounts`, `(*Store).UnparsedVerdictCounts` (Task 4).
- Produces: `/api/health` → `ingest.unread {transaction, not_transaction, unchecked, set_aside}` (omitted when the store cannot count); TS `unreadRows(u?: UnreadCounts): { label: string; value: number }[]`.

- [ ] **Step 1: Failing Go test** (append to `internal/server/server_test.go`; add `"strings"` and `"ledger/internal/store"` to its imports)

```go
type fakeIngestVerdicts struct {
	fakeIngest
	v store.VerdictCounts
}

func (f fakeIngestVerdicts) UnparsedVerdictCounts() (store.VerdictCounts, error) { return f.v, nil }

func TestHealthReportsUnreadVerdicts(t *testing.T) {
	srv := New(fakeChecker{err: nil}, testFS())
	srv.SetIngest(fakeIngestVerdicts{fakeIngest: fakeIngest{count: 9},
		v: store.VerdictCounts{Transaction: 2, NotTransaction: 3, Unchecked: 4, SetAside: 5}}, true)
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/health", nil))
	var body struct {
		Ingest struct {
			Unread *struct {
				Transaction    int `json:"transaction"`
				NotTransaction int `json:"not_transaction"`
				Unchecked      int `json:"unchecked"`
				SetAside       int `json:"set_aside"`
			} `json:"unread"`
		} `json:"ingest"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	u := body.Ingest.Unread
	if u == nil || u.Transaction != 2 || u.NotTransaction != 3 || u.Unchecked != 4 || u.SetAside != 5 {
		t.Errorf("unread = %+v", u)
	}

	plain := New(fakeChecker{err: nil}, testFS())
	plain.SetIngest(fakeIngest{count: 9}, true)
	rec = httptest.NewRecorder()
	plain.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/health", nil))
	if strings.Contains(rec.Body.String(), `"unread"`) {
		t.Error("a store that cannot count must not report unread")
	}
}
```

Run: `go test ./internal/server/ -run UnreadVerdicts -count=1`
Expected: FAIL (`unread` absent).

- [ ] **Step 2: Implement** (`internal/server/health.go`; import `"ledger/internal/store"`)

```go
type unreadHealth struct {
	Transaction    int `json:"transaction"`
	NotTransaction int `json:"not_transaction"`
	Unchecked      int `json:"unchecked"`
	SetAside       int `json:"set_aside"`
}

// verdictCounter is optional: the store has it, test fakes need not.
type verdictCounter interface {
	UnparsedVerdictCounts() (store.VerdictCounts, error)
}
```

Add `Unread *unreadHealth `json:"unread,omitempty"`` as the last field of `ingestHealth`. In `handleHealth`, right after the `CountIngest` block:

```go
		if vc, ok := s.ingest.(verdictCounter); ok {
			if v, err := vc.UnparsedVerdictCounts(); err == nil {
				ih.Unread = &unreadHealth{Transaction: v.Transaction, NotTransaction: v.NotTransaction,
					Unchecked: v.Unchecked, SetAside: v.SetAside}
			}
		}
```

Run: `go test ./internal/server/ -count=1` → PASS.

- [ ] **Step 3: Failing frontend tests.** In `frontend/src/lib/ingestHealth.test.ts`, add `unreadRows` to the import and append:

```ts
describe("unreadRows", () => {
  it("is empty when the server sends nothing or all zeros", () => {
    expect(unreadRows(undefined)).toEqual([]);
    expect(unreadRows({ transaction: 0, not_transaction: 0, unchecked: 0, set_aside: 0 })).toEqual([]);
  });
  it("lists every count in a fixed order once any is non-zero", () => {
    expect(unreadRows({ transaction: 2, not_transaction: 0, unchecked: 7, set_aside: 40 })).toEqual([
      { label: "Look like transactions", value: 2 },
      { label: "Probably not transactions", value: 0 },
      { label: "Not checked yet", value: 7 },
      { label: "Set aside as not transactions", value: 40 },
    ]);
  });
});
```

In `IngestHealthPage.test.tsx`, add `unread: { transaction: 3, not_transaction: 1, unchecked: 0, set_aside: 12 }` to `warnHealth.ingest`, and append inside the `describe`:

```tsx
  it("shows the emails no parser read", async () => {
    wrap();
    expect(await screen.findByText("Emails no parser read")).toBeInTheDocument();
    expect(screen.getByText("Look like transactions")).toBeInTheDocument();
    expect(screen.getByText("Set aside as not transactions")).toBeInTheDocument();
    expect(screen.getByText("12")).toBeInTheDocument();
  });
```

Run: `cd frontend && bun run test src/lib/ingestHealth.test.ts src/screens/settings/IngestHealthPage.test.tsx`
Expected: FAIL (`unreadRows` missing; heading absent).

- [ ] **Step 4: Implement the frontend.**

`frontend/src/api/types.ts`: add above `IngestHealth`

```ts
export interface UnreadCounts { transaction: number; not_transaction: number; unchecked: number; set_aside: number; }
```

add `unread?: UnreadCounts;` as the last field of `IngestHealth`, and widen the usage path union on line 24 to `path: "extract" | "categorize" | "txn_check";`.

`frontend/src/lib/ingestHealth.ts` (import `UnreadCounts` from `../api/types`):

```ts
/** Rows for the "Emails no parser read" card; empty when there is nothing to show. */
export function unreadRows(u?: UnreadCounts): { label: string; value: number }[] {
  if (!u || u.transaction + u.not_transaction + u.unchecked + u.set_aside === 0) return [];
  return [
    { label: "Look like transactions", value: u.transaction },
    { label: "Probably not transactions", value: u.not_transaction },
    { label: "Not checked yet", value: u.unchecked },
    { label: "Set aside as not transactions", value: u.set_aside },
  ];
}
```

`IngestHealthPage.tsx`: import `unreadRows`, compute `const unread = unreadRows(ih?.unread);` beside `const ih = …`, and insert this between the facts `Card` and the silence `<section>`:

```tsx
          {unread.length > 0 && (
            <section>
              <p className="text-sm mb-1">Emails no parser read</p>
              <p className="text-xs text-muted mb-3">
                AI sorts these while AI features are on. A transaction here needs a parser update.
              </p>
              <Card className="!py-2 divide-y divide-border">
                {unread.map((r) => <FactRow key={r.label} label={r.label} value={String(r.value)} />)}
              </Card>
            </section>
          )}
```

`AiUsagePage.tsx`: change the key-present hint to

```tsx
                    ? "Suggests categories and sorts emails no parser could read. When off, the app makes no AI calls."
```

Run: `cd frontend && bun run test` → all PASS. Update any story or test that asserted the old AiUsagePage hint (search: `grep -rn "makes no AI calls" frontend/src`).

- [ ] **Step 5: Harness check.** Run `harness/stack.sh up > "$SCRATCH/stack.log" 2>&1` (never piped; memory: harness-stack-pipe-hang). Then run `node harness/shoot.mjs` and `node harness/probe.mjs`, and read the `settings-ingest*` and `settings-ai*` shots. The seed has no verdicts, so the card is hidden there; the vitest above covers it. Expected: 0 audit issues, 0 probe bugs. Run `harness/stack.sh down` after.

- [ ] **Step 6: Rebuild the dist and commit**

```bash
cd frontend && bun run build && cd ..
git add internal/server frontend/src internal/web/dist
git commit -m "feat(ingest): health and Settings show emails no parser read, by AI verdict"
```

---

### Task 9: `ledger txncheck-eval` — measure before setting a threshold

**Files:**
- Create: `internal/parse/txncheck_eval.go`, `internal/parse/txncheck_eval_test.go`
- Modify: `cmd/ledger/main.go`

**Interfaces:**
- Consumes: `TxnChecker`, `NewClassifierTxnChecker`, `VerdictNotTxn` (Task 5); `SelectTxnCheckSamples` (Task 4); `classify.NewTypeSafe` (Task 2); `parse.BodyText`, `parse.Unwrap` (existing).
- Produces: `parse.TxnSample{From, Subject, Body string; IsTxn bool}`, `parse.TxnCut{Min float64; SetAside, Hidden int}`, `parse.TxnCheckReport{Total, Txns, NonTxns, Errors int; FirstErr error; Cuts []TxnCut}`, `func EvaluateTxnCheck(ctx context.Context, samples []TxnSample, chk TxnChecker) TxnCheckReport`.

- [ ] **Step 1: Failing test** (`internal/parse/txncheck_eval_test.go`)

```go
package parse

import (
	"context"
	"errors"
	"testing"
)

type subjCheck map[string]TxnVerdict

func (m subjCheck) Check(_ context.Context, _, subject, _ string) (TxnVerdict, error) {
	v, ok := m[subject]
	if !ok {
		return TxnVerdict{}, errors.New("boom")
	}
	return v, nil
}

func TestEvaluateTxnCheckCuts(t *testing.T) {
	chk := subjCheck{
		"promo":  {VerdictNotTxn, 0.995}, // non-txn, set aside at every cut
		"otp":    {VerdictNotTxn, 0.92},  // non-txn, set aside at 0.90 and 0.80
		"spend":  {VerdictTxn, 0.99},     // txn, never set aside
		"refund": {VerdictNotTxn, 0.96},  // txn wrongly called not: hidden at 0.95 and below
	}
	samples := []TxnSample{
		{Subject: "promo"}, {Subject: "otp"},
		{Subject: "spend", IsTxn: true}, {Subject: "refund", IsTxn: true},
		{Subject: "broken", IsTxn: true},
	}
	r := EvaluateTxnCheck(t.Context(), samples, chk)
	if r.Total != 5 || r.Txns != 3 || r.NonTxns != 2 || r.Errors != 1 || r.FirstErr == nil {
		t.Fatalf("report = %+v", r)
	}
	want := map[float64][2]int{0.99: {1, 0}, 0.97: {1, 0}, 0.95: {1, 1}, 0.9: {2, 1}, 0.8: {2, 1}}
	if len(r.Cuts) != len(want) {
		t.Fatalf("cuts = %+v", r.Cuts)
	}
	for _, c := range r.Cuts {
		if w := want[c.Min]; c.SetAside != w[0] || c.Hidden != w[1] {
			t.Errorf("cut %.2f = set aside %d hidden %d, want %d %d", c.Min, c.SetAside, c.Hidden, w[0], w[1])
		}
	}
}
```

Run: `go test ./internal/parse/ -run EvaluateTxnCheck -count=1` → compile FAIL.

- [ ] **Step 2: Implement** (`internal/parse/txncheck_eval.go`)

```go
package parse

import "context"

// TxnSample is one labelled email for EvaluateTxnCheck.
type TxnSample struct {
	From, Subject, Body string
	IsTxn               bool
}

// TxnCut is what one set-aside threshold would do: SetAside non-transactions
// it would clear from the queue, and Hidden real transactions it would hide.
type TxnCut struct {
	Min            float64
	SetAside, Hidden int
}

// TxnCheckReport is the outcome of EvaluateTxnCheck. Errors count in Total
// and in Txns/NonTxns, but in no cut.
type TxnCheckReport struct {
	Total, Txns, NonTxns, Errors int
	FirstErr                     error
	Cuts                         []TxnCut
}

// txnCutMins are the thresholds the eval reports; 0.97 is the default.
var txnCutMins = []float64{0.99, 0.97, 0.95, 0.9, 0.8}

// EvaluateTxnCheck asks chk about every sample directly (no stored verdicts)
// and reports, per threshold, how many emails a "not a transaction" answer at
// or above it would set aside, split by the true label.
func EvaluateTxnCheck(ctx context.Context, samples []TxnSample, chk TxnChecker) TxnCheckReport {
	r := TxnCheckReport{Cuts: make([]TxnCut, len(txnCutMins))}
	for i, m := range txnCutMins {
		r.Cuts[i].Min = m
	}
	for _, s := range samples {
		r.Total++
		if s.IsTxn {
			r.Txns++
		} else {
			r.NonTxns++
		}
		v, err := chk.Check(ctx, s.From, s.Subject, s.Body)
		if err != nil {
			r.Errors++
			if r.FirstErr == nil {
				r.FirstErr = err
			}
			continue
		}
		if v.Verdict != VerdictNotTxn {
			continue
		}
		for i := range r.Cuts {
			if v.Confidence >= r.Cuts[i].Min {
				if s.IsTxn {
					r.Cuts[i].Hidden++
				} else {
					r.Cuts[i].SetAside++
				}
			}
		}
	}
	return r
}
```

Run: `go test ./internal/parse/ -run EvaluateTxnCheck -count=1` → PASS.

- [ ] **Step 3: CLI** (`cmd/ledger/main.go`). First move the `--data-dir` checks out of `runCategorizeEval` into a shared helper, and call it from there (`dir := evalDataDir("categorize-eval", *dataDir)`):

```go
// evalDataDir resolves --data-dir for an offline eval command. It refuses the
// live DB (after resolving relative paths and symlinks) and a directory with
// no ledger.db, and exits on failure.
func evalDataDir(cmd, dataDir string) string {
	if dataDir == "" {
		log.Fatalf("%s: --data-dir is required (a directory holding a copy of ledger.db)", cmd)
	}
	dir, err := filepath.Abs(dataDir)
	if err == nil {
		dir, err = filepath.EvalSymlinks(dir)
	}
	if err != nil {
		log.Fatalf("%s: --data-dir: %v", cmd, err)
	}
	if dir == "/var/lib/ledger" || strings.HasPrefix(dir, "/var/lib/ledger/") {
		log.Fatalf("%s: --data-dir must point at a scratch copy, not the live DB", cmd)
	}
	// store.Open creates a missing DB, which would evaluate nothing.
	if _, err := os.Stat(filepath.Join(dir, "ledger.db")); err != nil {
		log.Fatalf("%s: no ledger.db in %s: %v", cmd, dir, err)
	}
	return dir
}
```

Add the dispatch `case "txncheck-eval": runTxnCheckEval(os.Args[2:]); return` beside `categorize-eval`, and:

```go
// runTxnCheckEval measures the AI check against emails the parsers already
// labelled. It sends each sample's sender, subject and up to 8 KB of text to
// TypeSafe; it bypasses the gate and records no usage. Point it at a copy.
func runTxnCheckEval(args []string) {
	fs := flag.NewFlagSet("txncheck-eval", flag.ExitOnError)
	dataDir := fs.String("data-dir", "", "directory holding a COPY of ledger.db (required)")
	model := fs.String("model", "jev-1.13.0", "TypeSafe model id")
	perClass := fs.Int("per-class", 200, "emails per label: transactions, and non-transactions")
	if err := fs.Parse(args); err != nil {
		log.Fatalf("txncheck-eval flags: %v", err)
	}
	dir := evalDataDir("txncheck-eval", *dataDir)
	key := os.Getenv("LEDGER_TYPESAFE_API_KEY")
	if key == "" {
		log.Fatalf("txncheck-eval: set LEDGER_TYPESAFE_API_KEY")
	}
	st, err := store.Open(dir)
	if err != nil {
		log.Fatalf("store: %v", err)
	}
	defer st.Close()
	rows, err := st.SelectTxnCheckSamples(*perClass)
	if err != nil {
		log.Fatalf("samples: %v", err)
	}
	samples := make([]parse.TxnSample, 0, len(rows))
	unreadable := 0
	for _, r := range rows {
		text, err := parse.BodyText(r.RawBody)
		if err != nil {
			unreadable++
			continue
		}
		from, subject, _, text := parse.Unwrap(r.FromAddr, r.Subject, text)
		samples = append(samples, parse.TxnSample{From: from, Subject: subject, Body: text, IsTxn: r.IsTxn})
	}
	chk := parse.NewClassifierTxnChecker(classify.NewTypeSafe(key, *model, nil, nil))
	rep := parse.EvaluateTxnCheck(context.Background(), samples, chk)
	fmt.Printf("emails %d (%d transactions, %d not)  errors %d  unreadable %d\n",
		rep.Total, rep.Txns, rep.NonTxns, rep.Errors, unreadable)
	if rep.FirstErr != nil {
		fmt.Printf("  first error: %v\n", rep.FirstErr)
	}
	for _, c := range rep.Cuts {
		fmt.Printf("  set aside at >= %.2f: %d of %d non-transactions, hides %d of %d transactions\n",
			c.Min, c.SetAside, rep.NonTxns, c.Hidden, rep.Txns)
	}
}
```

- [ ] **Step 4: Smoke on scratch data.** Bring up the harness stack (`frontend/harness/stack.sh up > "$SCRATCH/stack.log" 2>&1`), then copy its DB with `sqlite3 /tmp/ledger-ui-harness/db/ledger.db ".backup $SCRATCH/evaldb/ledger.db"` and run `harness/stack.sh down`. Build the binary to `$SCRATCH`, then run:
  - `LEDGER_TYPESAFE_API_KEY=dummy $SCRATCH/ledger txncheck-eval --data-dir $SCRATCH/evaldb --per-class 2` → `errors` equals `emails`, and `first error:` shows `401`.
  - The same with `--data-dir /var/lib/ledger` → refused.
  - With no `ledger.db` in the dir → refused.

  Check that `ls -l --time-style=full-iso /var/lib/ledger/ledger.db` is unchanged before and after.

- [ ] **Step 5: Commit**

```bash
go test ./... -count=1
git add internal/parse/txncheck_eval.go internal/parse/txncheck_eval_test.go cmd/ledger/main.go
git commit -m "feat(cli): txncheck-eval measures the AI check against labelled email"
```

---

### Task 10: Docs and the rollout runbook

**Files:**
- Modify: `CLAUDE.md`, `deploy/README.md`, `frontend/src/components/README.md` (only if a shared component changed; it should not)

- [ ] **Step 1: `CLAUDE.md`.**
  - **Principles.** In the deterministic-first bullet, replace the AI extraction sentence with: "The cascade runs per-bank template → generic heuristic → **AI check** (classify only). The AI check never extracts fields or writes a transaction: a confident 'not a transaction' sets the email aside as `ignored` (raw body kept), and anything else stays `unparsed` with its verdict stored. The sunset Anthropic extractor runs only when `ai.provider = "anthropic"`."
  - **Privacy principle.** Replace the AI sentences with: "Data leaves the box only on the AI path, behind one master switch. With `ai.provider = "typesafe"` (the default), categorization sends a bare merchant string plus the category names, and the AI check sends an unread email's sender, subject and up to 8 KB of its text. Both go to TypeSafe. Anthropic is sunset: it is called only when `ai.provider = "anthropic"`."
  - **Architecture.** Replace the `anthropic` bullet with an `aihttp` bullet (retry, gate, usage, cost; no provider logic) and a `classify` bullet (the provider seam: `Classifier` with `Classify(ctx, Request) (Answer, error)` and `MaxOptions()`; TypeSafe is the only adapter; a new provider means one adapter plus one case in `main.go`). Update the `parse` bullet (tier 4 is the AI check; verdicts live in `ingest_log.ai_verdict`/`ai_verdict_conf` and are replayed on reprocess) and the `categorize` bullet (`ClassifierCategorizer`; `AnthropicCategorizer` is sunset).
  - **CLI.** Add the line "`ledger txncheck-eval --data-dir <copy> [--per-class N]` — measure the AI check against parser-labelled email, by threshold. Sends each sample's sender, subject and up to 8 KB of text to TypeSafe."

- [ ] **Step 2: `deploy/README.md`.** Replace the "Switching categorization to TypeSafe" section with:

````markdown
## AI provider (TypeSafe; Anthropic is sunset)

TypeSafe's Jev answers both AI questions: "which category?" and "is this unread
email a transaction?". The second one is the **AI check**. It never writes a
transaction. A confident "not a transaction" sets the email aside (`ignored`,
raw body kept). Anything else stays unparsed, with its verdict stored.

### Roll out (from categorize_provider)

1. Back up the DB as root:
   `sudo sqlite3 /var/lib/ledger/ledger.db ".backup '/var/backups/ledger-$(date +%F-%H%M).db'"`
2. Deploy the binary (sections 1–2). The old `categorize_provider = "typesafe"`
   still works. For clarity, rename it to `provider = "typesafe"` in
   `/etc/ledger/config.toml` under `[ai]`.
3. Measure the AI check on a copy. This sends each sample's sender, subject and
   up to 8 KB of text to TypeSafe (about 400 emails, a few US cents):

   ```bash
   sudo mkdir -p /root/ts-eval
   sudo sqlite3 /var/lib/ledger/ledger.db ".backup /root/ts-eval/ledger.db"
   sudo sh -c 'set -a; . /etc/ledger/ledger.env; /usr/local/bin/ledger txncheck-eval --data-dir /root/ts-eval'
   ```

   Pick the lowest threshold whose "hides" count is 0. Set it under `[ai]` as
   `txn_ignore_threshold = 0.97` (the default; valid range above 0.5 up to 1).
4. `sudo systemctl restart ledger`. The log must say `provider=typesafe` and
   `txn check=true`: `journalctl -u ledger -n 50 | grep 'clients wired'`.
5. Turn on **AI features** in Settings.
6. Sort the backlog. Old unread emails have used up their automatic retries,
   so only a manual reprocess reaches them. It runs one call per unread email
   and can take a few minutes:
   `curl -s --max-time 1800 -X POST http://127.0.0.1:8080/api/reprocess`
   Settings → Email ingest then shows the counts.

### Undo set-asides

If the threshold hid real transactions, return them to unparsed and reprocess.
Stored verdicts are replayed under the new threshold, with no new calls. Run
the SQL as the `ledger` user, so no root-owned WAL files appear:

```bash
sudo -u ledger sqlite3 /var/lib/ledger/ledger.db \
  "UPDATE ingest_log SET parse_status='unparsed', parse_tier=NULL WHERE parse_status='ignored' AND parse_tier='ai_check'"
# raise txn_ignore_threshold in /etc/ledger/config.toml, restart, then:
curl -s --max-time 1800 -X POST http://127.0.0.1:8080/api/reprocess
```

### Bring Anthropic back

Set `provider = "anthropic"` under `[ai]`, keep `LEDGER_AI_API_KEY` in
`/etc/ledger/ledger.env`, and restart. That restores Anthropic categorization,
and Anthropic extraction while `allow_ai_extraction` is true. The AI check is
off under that provider.
````

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md deploy/README.md
git commit -m "docs: TypeSafe is the AI provider; AI check; Anthropic sunset runbook"
```

---

### Task 11: Final gate (no deploy)

- [ ] `go test ./... -count=1 && go test ./... -race -count=1`
- [ ] `cd frontend && bun run test && bun run build`. Afterwards `git status` must show no dist change (the dist was committed in Task 8).
- [ ] `grep -rn 'internal/anthropic' --include=*.go .` prints nothing. Run the NUL-byte check (Global Constraints) over every file this branch changed: `git diff --name-only $(git merge-base main HEAD) -- '*.go' '*.ts' '*.tsx' '*.md'`.
- [ ] Re-check `main` for parallel-session commits (memory: parallel-agents-on-main). If it moved, merge it and rebuild the dist.
- [ ] **Do not deploy.** The rollout in `deploy/README.md` needs Saleh's go-ahead. It changes production behaviour: TypeSafe starts seeing email text, and emails get set aside.

---

## Out of scope (recorded, not planned)

- A per-email list of unread emails in the app, with a "not a transaction" / "is a transaction" override. Today's visibility is counts plus `parse_error`.
- An LLM adapter (OpenAI, Gemini, a local model) behind `classify.Classifier`. Saleh chose classification APIs only.
- Deleting the sunset Anthropic code (`parse/ai.go`, `categorize/ai.go`). The standing rule is to keep it.
- Sending `direction` or amount with the category question.
- Using the AI check's "transaction" verdict to page Saleh about a parser break. The drift monitor still counts AI-set-aside emails as successes, the same as template ignores.
