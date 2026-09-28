# TypeSafe Categorization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let ledger 1.0 use TypeSafe's Jev model (a Choice question) as the AI fallback for merchant categorization, selectable by config, with an offline eval command that measures it against Saleh's own confirmed history before it is switched on.

**Architecture:** A new `categorize.TypeSafeCategorizer` implements the existing `AICategorizer` interface, so the rules-first `Categorizer`, the `MemoAI` cache, the live gate, the spend cap and the usage recorder all stay as they are. The shared retrying client in `internal/anthropic` gains a pluggable auth-header hook so TypeSafe reuses its 429/529 backoff. A config key `ai.categorize_provider` picks `anthropic` (default, unchanged behaviour) or `typesafe`. AI *extraction* stays on Anthropic: Jev cannot generate text.

**Tech Stack:** Go 1.22 stdlib `net/http`, `httptest`; React 19 + vitest for the settings copy.

**Spec:** No separate spec. This plan is the spec. Source docs (read 2026-09-28):
`https://docs.typesafe.ai/api.md`, `/confidence.md`, `/models.md`, `/model-jaggedness/jev-1.13.md`. Project rules: `CLAUDE.md`, `budgeting-app-build-plan.md` §2.

### Decisions made without the user (Saleh was asleep — confirm these on review)

1. **Opt-in, not a replacement.** Default provider stays `anthropic`. Nothing changes in production until `/etc/ledger/config.toml` says `categorize_provider = "typesafe"` and `LEDGER_TYPESAFE_API_KEY` is in `/etc/ledger/ledger.env`. (Memory rule: sunset, don't delete.)
2. **Extraction stays on Anthropic.** TypeSafe has no text-generation primitive. With `categorize_provider = "typesafe"` and `allow_ai_extraction = false`, the Anthropic key is no longer required.
3. **Only the merchant string leaves the box**, as today. `state` is `{"merchant": "<raw>"}`. No amount, date, direction or account. (Direction would help Jev; it is out of scope because it breaks principle §2 "only a bare merchant string".)
4. **Pin `jev-1.13.0`, not `jev-latest`.** TypeSafe's docs say an alias moves under you; the auto-accept threshold is tuned against one version.
5. **A "no fit" option.** The Choice carries one extra option, `__no_fit__`. When it wins, the categorizer returns the best real category with confidence 0, so the transaction lands in review with a suggestion, same as a low-confidence Anthropic answer today.
6. **The memo is kept.** Merchants Anthropic already answered stay answered from `ai_suggestions`. Only new merchants reach TypeSafe. The eval command bypasses the memo.
7. **Cost unit.** Jev costs $0.042 per million input tokens, output free. That is 0.042 µUSD per token, below the existing integer µUSD-per-token table. The plan adds a milli-µUSD table and rounds each call **up** to a whole µUSD, so the spend cap still counts every call.

## Global Constraints

- Money in the app is `int64` fils; AI cost is `int64` µUSD (`CostMuUSD`). No floats for either.
- Secrets are env-only: `LEDGER_TYPESAFE_API_KEY`, never TOML. (`internal/config` pattern.)
- Every outbound AI call passes the live gate first (`Retrier.Gate`). "AI off" must mean zero egress to **both** providers.
- TypeSafe endpoint: `POST https://api.typesafe.ai/v1/systemone`, header `Authorization: Bearer <key>`, body `{"state", "model", "questions"}`.
- A Choice accepts at most **255** options (TypeSafe API limit). With `__no_fit__`, that is 254 categories.
- Retry on 429 and 5xx (529 included); never on 401/422.
- UI copy: plain and short, one idea per sentence (memory: app-copy-plain-and-short). No sentence may name a provider the code did not call.
- Gate: `go test ./... && cd frontend && bun run test`. Rebuild `internal/web/dist` before finishing.
- Never point a smoke test at `:8080` or `/var/lib/ledger`.

## Review Focus

1. **Provider switch leaves stale copy** — with TypeSafe on, the Settings screens and the spend-cap push must not say "Anthropic". Test in Task 5 (`aiProvider.test.ts`) and a grep step in Task 5.
2. **A 401/422 from TypeSafe** (bad key, malformed question) must fail the call once, not retry four times, and must leave the transaction in review. Test in Task 3 (`TestTypeSafeCategorizerNoRetryOn422`).
3. **More categories than a Choice holds** — a user with 255+ categories must get a clear error, not a 422 loop. Test in Task 3 (`TestTypeSafeCategorizerRejectsTooManyCategories`).
4. **AI master switch off** must mean zero calls to TypeSafe too. Test in Task 3 (`TestTypeSafeCategorizerGateBlocksEgress`).
5. **Unknown model id in usage** (Jev bumps to 1.14 behind a pinned-but-edited config) makes the spend cap blind. Test in Task 2 (`TestCostMuUSDUnknownJevIsZero` documents it) and the log line in Task 4.

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `internal/anthropic/retry.go` | modify | add `SetHeaders` hook; nil keeps Anthropic headers |
| `internal/anthropic/usage.go` | modify | milli-µUSD price table for sub-µUSD models |
| `internal/categorize/typesafe.go` | create | `TypeSafeCategorizer` (HTTP + Choice mapping) |
| `internal/categorize/typesafe_test.go` | create | httptest-driven tests |
| `internal/categorize/eval.go` | create | pure `Evaluate(labels, cats, ai)` report |
| `internal/categorize/eval_test.go` | create | eval math with a fake AI |
| `internal/config/config.go` | modify | `categorize_provider`, `typesafe_model`, env key, validation |
| `internal/store/eval.go` | create | `SelectMerchantLabels()` read-only query |
| `internal/server/settings.go`, `server.go` | modify | expose read-only `ai_provider` |
| `cmd/ledger/main.go` | modify | per-provider gate + wiring; `categorize-eval` subcommand |
| `frontend/src/lib/aiProvider.ts` (+test) | create | provider → label + env var name |
| `frontend/src/api/types.ts`, `screens/settings/AiUsagePage.tsx`, `CategorizationPage.tsx` | modify | provider-neutral copy |
| `CLAUDE.md`, `deploy/README.md` | modify | document provider, env var, rollout |

---

### Task 1: Retrier accepts a custom auth header

**Files:**
- Modify: `internal/anthropic/retry.go` (struct `Retrier`, loop body of `Post`)
- Test: `internal/anthropic/retry_test.go`

**Interfaces:**
- Produces: `Retrier.SetHeaders func(req *http.Request, apiKey string)` — nil means Anthropic headers (`x-api-key`, `anthropic-version`, `content-type`).

- [ ] **Step 1: Write the failing test** (append to `retry_test.go`)

```go
func TestPostUsesCustomHeaders(t *testing.T) {
	var gotAuth, gotXKey string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		gotXKey = r.Header.Get("x-api-key")
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	r := New(srv.Client())
	r.SetHeaders = func(req *http.Request, key string) {
		req.Header.Set("Authorization", "Bearer "+key)
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := r.Post(t.Context(), srv.URL, "ts-key", []byte(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if gotAuth != "Bearer ts-key" {
		t.Errorf("Authorization = %q, want Bearer ts-key", gotAuth)
	}
	if gotXKey != "" {
		t.Errorf("x-api-key leaked to a non-Anthropic endpoint: %q", gotXKey)
	}
}
```

(Add `net/http/httptest` to the imports if the file lacks it.)

- [ ] **Step 2: Run it and see it fail**

Run: `go test ./internal/anthropic/ -run TestPostUsesCustomHeaders -count=1`
Expected: compile FAIL — `r.SetHeaders undefined`.

- [ ] **Step 3: Implement**

In `Retrier`, after `Gate`:

```go
	// SetHeaders, if non-nil, sets auth and content headers on each attempt in
	// place of the Anthropic ones. The TypeSafe client uses it for Bearer auth.
	SetHeaders func(req *http.Request, apiKey string)
```

In `Post`, replace the three `req.Header.Set` lines with:

```go
		if r.SetHeaders != nil {
			r.SetHeaders(req, apiKey)
		} else {
			req.Header.Set("x-api-key", apiKey)
			req.Header.Set("anthropic-version", apiVersion)
			req.Header.Set("content-type", "application/json")
		}
```

Update the package doc comment: "a small retrying HTTP client for the Anthropic Messages API **and the TypeSafe System One API**".

- [ ] **Step 4: Run the package tests**

Run: `go test ./internal/anthropic/ -count=1`
Expected: PASS (existing header tests in `internal/categorize/ai_test.go` still prove the nil path — run `go test ./internal/categorize/ -count=1` too).

- [ ] **Step 5: Prove it bites** — delete the `if r.SetHeaders != nil` branch, re-run, see FAIL, restore.

- [ ] **Step 6: Commit**

```bash
git add internal/anthropic/retry.go internal/anthropic/retry_test.go
git commit -m "feat(ai): retrier takes a custom auth header hook"
```

---

### Task 2: Sub-µUSD pricing for Jev

**Files:**
- Modify: `internal/anthropic/usage.go`
- Test: `internal/anthropic/usage_test.go`

**Interfaces:**
- Produces: `PriceMilliMuUSD map[string]struct{ In, Out int64 }` (milli-µUSD per token). `CostMuUSD(model, in, out)` unchanged signature; checks `PriceMuUSD` first, then `PriceMilliMuUSD` with ceiling division.

- [ ] **Step 1: Write the failing tests**

```go
func TestCostMuUSDJevRoundsUp(t *testing.T) {
	// $0.042/Mtok = 42 milli-µUSD per token. 400 tokens = 16800 milli = 16.8 µUSD → 17.
	if got := CostMuUSD("jev-1.13.0", 400, 65); got != 17 {
		t.Errorf("jev 400 in = %d µUSD, want 17", got)
	}
	// One token still costs one whole µUSD, so the cap counts every call.
	if got := CostMuUSD("jev-1.13.0", 1, 0); got != 1 {
		t.Errorf("jev 1 in = %d, want 1", got)
	}
	if got := CostMuUSD("jev-1.13.0", 0, 0); got != 0 {
		t.Errorf("jev 0 in = %d, want 0", got)
	}
}

// Documents the known gap: a Jev version not in the table records cost 0.
func TestCostMuUSDUnknownJevIsZero(t *testing.T) {
	if got := CostMuUSD("jev-9.0.0", 1000, 0); got != 0 {
		t.Errorf("unknown jev = %d, want 0", got)
	}
}
```

- [ ] **Step 2: Run, see FAIL**

Run: `go test ./internal/anthropic/ -run CostMuUSD -count=1`
Expected: FAIL — `jev 400 in = 0 µUSD, want 17`.

- [ ] **Step 3: Implement** (in `usage.go`)

```go
// PriceMilliMuUSD is milli-µUSD (1e-9 USD) per token, for models priced below
// one µUSD per token. $0.042/Mtok input == 42 milli-µUSD/token.
var PriceMilliMuUSD = map[string]struct{ In, Out int64 }{
	"jev-1.13.0": {In: 42, Out: 0}, // TypeSafe Jev 1.13: $0.042/Mtok input, output free
}

// CostMuUSD computes exact integer micro-USD cost for a call. Sub-µUSD models
// round up to a whole µUSD so every call counts toward the spend cap.
// Unknown model -> 0.
func CostMuUSD(model string, inTok, outTok int64) int64 {
	if p, ok := PriceMuUSD[model]; ok {
		return inTok*p.In + outTok*p.Out
	}
	if p, ok := PriceMilliMuUSD[model]; ok {
		milli := inTok*p.In + outTok*p.Out
		return (milli + 999) / 1000
	}
	return 0
}
```

Change the `Usage` doc: `Path is "extract" or "categorize"` stays; add "Model may be a TypeSafe id".

- [ ] **Step 4: Run, see PASS**

Run: `go test ./internal/anthropic/ -count=1`

- [ ] **Step 5: Commit**

```bash
git add internal/anthropic/usage.go internal/anthropic/usage_test.go
git commit -m "feat(ai): price TypeSafe Jev in milli-µUSD, round up per call"
```

---

### Task 3: `TypeSafeCategorizer`

**Files:**
- Create: `internal/categorize/typesafe.go`
- Test: `internal/categorize/typesafe_test.go`

**Interfaces:**
- Consumes: `anthropic.Retrier.SetHeaders` (Task 1), `anthropic.Usage`, `anthropic.Recorder`, `anthropic.Clamp01`, `anthropic.ErrAIDisabled`.
- Produces:
  - `func NewTypeSafeCategorizer(apiKey, model string, gate func() error, rec anthropic.Recorder) *TypeSafeCategorizer`
  - `(*TypeSafeCategorizer).Categorize(ctx, merchant string, cats []Category) (string, float64, error)` — satisfies `AICategorizer`.
  - `const MaxTypeSafeCategories = 254`
  - `const noFitOption = "__no_fit__"`

- [ ] **Step 1: Write the failing tests** (`typesafe_test.go`)

```go
package categorize

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

	"ledger/internal/anthropic"
)

var tsCats = []Category{
	{ID: 1, Name: "Groceries", Kind: "spending", Bucket: "need"},
	{ID: 2, Name: "Dining", Kind: "spending", Bucket: "want"},
	{ID: 3, Name: "Salary", Kind: "income", Bucket: ""},
}

func newTestTS(t *testing.T, h http.HandlerFunc) (*TypeSafeCategorizer, *[]anthropic.Usage) {
	t.Helper()
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	var rec []anthropic.Usage
	ts := NewTypeSafeCategorizer("ts-key", "jev-1.13.0", nil, func(u anthropic.Usage) { rec = append(rec, u) })
	ts.endpoint = srv.URL + "/v1/systemone"
	ts.retry.HTTP = srv.Client()
	ts.retry.Backoff = func(int) time.Duration { return 0 }
	return ts, &rec
}

func TestTypeSafeCategorizerRequestShape(t *testing.T) {
	var body map[string]any
	ts, _ := newTestTS(t, func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer ts-key" {
			t.Errorf("Authorization = %q", got)
		}
		b, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(b, &body)
		_, _ = w.Write([]byte(`{"model":"jev-1.13.0","answers":{"category":{"type":"choice","choice":"Groceries","confidence":0.9,"probabilities":{"Groceries":0.95,"Dining":0.05,"Salary":0,"__no_fit__":0}}},"usage":{"input_tokens":300,"output_tokens":20}}`))
	})
	if _, _, err := ts.Categorize(t.Context(), "CARREFOUR MOE", tsCats); err != nil {
		t.Fatal(err)
	}
	if body["model"] != "jev-1.13.0" {
		t.Errorf("model = %v", body["model"])
	}
	state, _ := body["state"].(map[string]any)
	if len(state) != 1 || state["merchant"] != "CARREFOUR MOE" {
		t.Errorf("state must hold ONLY the merchant, got %v", body["state"])
	}
	q := body["questions"].(map[string]any)["category"].(map[string]any)
	if q["type"] != "choice" {
		t.Errorf("question type = %v", q["type"])
	}
	crit := q["criteria"].(map[string]any)
	for _, want := range []string{"Groceries", "Dining", "Salary", noFitOption} {
		if _, ok := crit[want]; !ok {
			t.Errorf("criteria missing %q", want)
		}
	}
	if len(crit) != 4 {
		t.Errorf("criteria has %d options, want 4", len(crit))
	}
}

func TestTypeSafeCategorizerSuccessRecordsUsage(t *testing.T) {
	ts, rec := newTestTS(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"model":"jev-1.13.0","answers":{"category":{"type":"choice","choice":"Dining","confidence":0.81,"probabilities":{"Dining":0.88,"Groceries":0.12,"Salary":0,"__no_fit__":0}}},"usage":{"input_tokens":318,"output_tokens":34}}`))
	})
	name, conf, err := ts.Categorize(t.Context(), "TALABAT", tsCats)
	if err != nil {
		t.Fatal(err)
	}
	if name != "Dining" || conf != 0.81 {
		t.Errorf("got (%q, %v), want (Dining, 0.81)", name, conf)
	}
	if len(*rec) != 1 {
		t.Fatalf("recorded %d usages, want 1", len(*rec))
	}
	u := (*rec)[0]
	if !u.OK || u.Path != "categorize" || u.Model != "jev-1.13.0" || u.InputTokens != 318 || u.Detail != "TALABAT" {
		t.Errorf("usage = %+v", u)
	}
}

func TestTypeSafeCategorizerNoFitReturnsBestRealWithZeroConfidence(t *testing.T) {
	ts, _ := newTestTS(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"model":"jev-1.13.0","answers":{"category":{"type":"choice","choice":"__no_fit__","confidence":0.6,"probabilities":{"__no_fit__":0.7,"Dining":0.2,"Groceries":0.1,"Salary":0}}},"usage":{"input_tokens":1,"output_tokens":1}}`))
	})
	name, conf, err := ts.Categorize(t.Context(), "XYZ LLC", tsCats)
	if err != nil {
		t.Fatal(err)
	}
	if name != "Dining" || conf != 0 {
		t.Errorf("got (%q, %v), want (Dining, 0)", name, conf)
	}
}

func TestTypeSafeCategorizerClampsConfidence(t *testing.T) {
	ts, _ := newTestTS(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"model":"jev-1.13.0","answers":{"category":{"type":"choice","choice":"Dining","confidence":1.7,"probabilities":{"Dining":1}}},"usage":{}}`))
	})
	_, conf, err := ts.Categorize(t.Context(), "X", tsCats)
	if err != nil || conf != 1 {
		t.Errorf("conf = %v err = %v, want 1 nil", conf, err)
	}
}

func TestTypeSafeCategorizerNoRetryOn422(t *testing.T) {
	var calls atomic.Int32
	ts, rec := newTestTS(t, func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.WriteHeader(http.StatusUnprocessableEntity)
		_, _ = w.Write([]byte(`{"detail":"bad question"}`))
	})
	_, _, err := ts.Categorize(t.Context(), "X", tsCats)
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

func TestTypeSafeCategorizerRetriesOn529(t *testing.T) {
	var calls atomic.Int32
	ts, _ := newTestTS(t, func(w http.ResponseWriter, r *http.Request) {
		if calls.Add(1) == 1 {
			w.WriteHeader(529)
			return
		}
		_, _ = w.Write([]byte(`{"model":"jev-1.13.0","answers":{"category":{"type":"choice","choice":"Salary","confidence":0.9,"probabilities":{"Salary":1}}},"usage":{}}`))
	})
	name, _, err := ts.Categorize(t.Context(), "ACME PAYROLL", tsCats)
	if err != nil || name != "Salary" || calls.Load() != 2 {
		t.Errorf("name=%q err=%v calls=%d, want Salary nil 2", name, err, calls.Load())
	}
}

func TestTypeSafeCategorizerRejectsTooManyCategories(t *testing.T) {
	var calls atomic.Int32
	ts, _ := newTestTS(t, func(w http.ResponseWriter, r *http.Request) { calls.Add(1) })
	many := make([]Category, MaxTypeSafeCategories+1)
	for i := range many {
		many[i] = Category{ID: int64(i + 1), Name: "c" + strconv.Itoa(i)}
	}
	if _, _, err := ts.Categorize(t.Context(), "X", many); err == nil {
		t.Error("want an error for 255 categories")
	}
	if calls.Load() != 0 {
		t.Error("must not call the API when the category list is too long")
	}
}

func TestTypeSafeCategorizerGateBlocksEgress(t *testing.T) {
	var calls atomic.Int32
	ts, rec := newTestTS(t, func(w http.ResponseWriter, r *http.Request) { calls.Add(1) })
	ts.retry.Gate = func() error { return anthropic.ErrAIDisabled }
	_, _, err := ts.Categorize(t.Context(), "X", tsCats)
	if !errors.Is(err, anthropic.ErrAIDisabled) {
		t.Errorf("err = %v, want ErrAIDisabled", err)
	}
	if calls.Load() != 0 || len(*rec) != 0 {
		t.Errorf("gate off: calls=%d records=%d, want 0 0", calls.Load(), len(*rec))
	}
}

func TestTypeSafeCategorizerMissingAnswer(t *testing.T) {
	ts, _ := newTestTS(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"model":"jev-1.13.0","answers":{},"usage":{}}`))
	})
	if _, _, err := ts.Categorize(t.Context(), "X", tsCats); err == nil {
		t.Error("want an error when the answer is missing")
	}
}
```

(Add `"time"` to the imports.)

- [ ] **Step 2: Run, see FAIL**

Run: `go test ./internal/categorize/ -run TypeSafe -count=1`
Expected: compile FAIL — `undefined: NewTypeSafeCategorizer`.

- [ ] **Step 3: Implement** (`typesafe.go`)

```go
package categorize

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"

	"ledger/internal/anthropic"
)

// MaxTypeSafeCategories is the most categories one Choice can carry: the API
// allows 255 options and one is reserved for noFitOption.
const MaxTypeSafeCategories = 254

// noFitOption lets Jev say "none of these". It is never a real category name.
const noFitOption = "__no_fit__"

// TypeSafeCategorizer asks TypeSafe's Jev model one Choice question per
// merchant. Like AnthropicCategorizer it sends ONLY the merchant string and the
// category list — no amounts, dates, or account details leave the server.
type TypeSafeCategorizer struct {
	apiKey   string
	model    string
	endpoint string // defaults to "https://api.typesafe.ai/v1/systemone"
	retry    *anthropic.Retrier
	rec      anthropic.Recorder
}

// NewTypeSafeCategorizer builds the TypeSafe categorizer. gate is consulted by
// the Retrier before any network I/O; rec records usage (nil = don't record).
func NewTypeSafeCategorizer(apiKey, model string, gate func() error, rec anthropic.Recorder) *TypeSafeCategorizer {
	r := anthropic.New(nil)
	r.Gate = gate
	r.SetHeaders = func(req *http.Request, key string) {
		req.Header.Set("Authorization", "Bearer "+key)
		req.Header.Set("Content-Type", "application/json")
	}
	return &TypeSafeCategorizer{
		apiKey:   apiKey,
		model:    model,
		endpoint: "https://api.typesafe.ai/v1/systemone",
		retry:    r,
		rec:      rec,
	}
}

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

// Jev reads instructions literally (docs: jev-1.13 jaggedness #1), so the
// boundary cases are spelled out here rather than implied.
const tsInstructions = "Which budget category does the card transaction at `merchant` belong to? " +
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

// Categorize implements AICategorizer using a TypeSafe Choice question.
func (t *TypeSafeCategorizer) Categorize(ctx context.Context, merchant string, cats []Category) (string, float64, error) {
	if len(cats) > MaxTypeSafeCategories {
		return "", 0, fmt.Errorf("categorize: %d categories exceed TypeSafe's limit of %d", len(cats), MaxTypeSafeCategories)
	}
	crit := make(map[string]string, len(cats)+1)
	for _, c := range cats {
		crit[c.Name] = criterionFor(c)
	}
	crit[noFitOption] = "None of the other categories fits this merchant"

	body, err := json.Marshal(tsRequest{
		State: map[string]string{"merchant": merchant},
		Model: t.model,
		Questions: map[string]tsQuestion{
			"category": {Type: "choice", Instructions: tsInstructions, Criteria: crit},
		},
	})
	if err != nil {
		return "", 0, fmt.Errorf("categorize: marshal request: %w", err)
	}

	resp, err := t.retry.Post(ctx, t.endpoint, t.apiKey, body)
	if err != nil {
		if !errors.Is(err, anthropic.ErrAIDisabled) && t.rec != nil {
			t.rec(anthropic.Usage{Path: "categorize", Model: t.model, OK: false, Detail: merchant})
		}
		return "", 0, fmt.Errorf("categorize: http request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		if t.rec != nil {
			t.rec(anthropic.Usage{Path: "categorize", Model: t.model, OK: false, Detail: merchant})
		}
		return "", 0, fmt.Errorf("typesafe API status %d", resp.StatusCode)
	}

	var tr tsResponse
	if err := json.NewDecoder(resp.Body).Decode(&tr); err != nil {
		return "", 0, fmt.Errorf("categorize: decode response: %w", err)
	}
	if t.rec != nil {
		model := tr.Model
		if model == "" {
			model = t.model
		}
		t.rec(anthropic.Usage{
			Path: "categorize", Model: model,
			InputTokens: tr.Usage.InputTokens, OutputTokens: tr.Usage.OutputTokens,
			OK: true, Detail: merchant,
		})
	}

	ans, ok := tr.Answers["category"]
	if !ok || ans.Choice == "" {
		return "", 0, fmt.Errorf("categorize: typesafe response has no category answer")
	}
	if ans.Choice == noFitOption {
		// Suggest the best real category, but never let it auto-confirm.
		best, bestP := "", -1.0
		for _, c := range cats {
			if p := ans.Probabilities[c.Name]; p > bestP {
				best, bestP = c.Name, p
			}
		}
		return best, 0, nil
	}
	return ans.Choice, anthropic.Clamp01(ans.Confidence), nil
}
```

Note: when `cats` is empty and Jev picks `__no_fit__`, `best` is `""`; `Categorizer.Categorize` then returns its "unknown category" error and the row stays in review. That is the wanted result.

- [ ] **Step 4: Run, see PASS**

Run: `go test ./internal/categorize/ -count=1`

- [ ] **Step 5: Prove the key tests bite** — (a) change `crit[noFitOption] = ...` to be skipped: `RequestShape` must fail; (b) remove the `len(cats) >` guard: `RejectsTooManyCategories` must fail; (c) put `state` back as the full merchant + `"amount"`: `RequestShape` must fail. Revert each.

- [ ] **Step 6: Commit**

```bash
git add internal/categorize/typesafe.go internal/categorize/typesafe_test.go
git commit -m "feat(categorize): TypeSafe Jev categorizer behind the AICategorizer interface"
```

---

### Task 4: Config, per-provider gate, and wiring

**Files:**
- Modify: `internal/config/config.go` (`AIConfig`, defaults, env, `validate`)
- Test: `internal/config/config_test.go`
- Modify: `cmd/ledger/main.go:137` (`SetAIKeyPresent`), `:174-192` (gate), `:210` (push copy), `:222-238` (client choice)
- Modify: `internal/server/server.go:108,158-161`, `internal/server/settings.go:24-62`

**Interfaces:**
- Produces:
  - `config.AIConfig.CategorizeProvider string` (`toml:"categorize_provider"`, default `"anthropic"`)
  - `config.AIConfig.TypeSafeModel string` (`toml:"typesafe_model"`, default `"jev-1.13.0"`)
  - `config.AIConfig.TypeSafeAPIKey string` (`toml:"-"`, env `LEDGER_TYPESAFE_API_KEY`)
  - `func (c AIConfig) CategorizeKey() string` — the key the chosen provider needs.
  - `server.(*Server).SetAIProvider(p string)`; settings JSON gains read-only `"ai_provider": "anthropic"|"typesafe"`.

- [ ] **Step 1: Write the failing config tests** (use the file's existing `t.Setenv` / temp-file helpers; clear both key env vars in each test, because the sandbox sets `LEDGER_AI_API_KEY` — see memory "config-test-env-false-failure")

```go
func TestAIProviderDefaults(t *testing.T) {
	t.Setenv("LEDGER_AI_API_KEY", "")
	t.Setenv("LEDGER_TYPESAFE_API_KEY", "")
	cfg, err := Load("")
	if err != nil {
		t.Fatal(err)
	}
	if cfg.AI.CategorizeProvider != "anthropic" || cfg.AI.TypeSafeModel != "jev-1.13.0" {
		t.Errorf("defaults = %q %q", cfg.AI.CategorizeProvider, cfg.AI.TypeSafeModel)
	}
}

func TestTypeSafeProviderNeedsTypeSafeKey(t *testing.T) {
	t.Setenv("LEDGER_AI_API_KEY", "")
	t.Setenv("LEDGER_TYPESAFE_API_KEY", "")
	p := writeTOML(t, "[ai]\nenabled = true\ncategorize_provider = \"typesafe\"\nallow_ai_extraction = false\n")
	if _, err := Load(p); err == nil || !strings.Contains(err.Error(), "LEDGER_TYPESAFE_API_KEY") {
		t.Errorf("err = %v, want a LEDGER_TYPESAFE_API_KEY error", err)
	}
	t.Setenv("LEDGER_TYPESAFE_API_KEY", "ts")
	if _, err := Load(p); err != nil {
		t.Errorf("typesafe key alone, no extraction: err = %v, want nil", err)
	}
}

func TestTypeSafeWithExtractionStillNeedsAnthropicKey(t *testing.T) {
	t.Setenv("LEDGER_AI_API_KEY", "")
	t.Setenv("LEDGER_TYPESAFE_API_KEY", "ts")
	p := writeTOML(t, "[ai]\nenabled = true\ncategorize_provider = \"typesafe\"\nallow_ai_extraction = true\n")
	if _, err := Load(p); err == nil || !strings.Contains(err.Error(), "LEDGER_AI_API_KEY") {
		t.Errorf("err = %v, want a LEDGER_AI_API_KEY error", err)
	}
}

func TestUnknownProviderRejected(t *testing.T) {
	t.Setenv("LEDGER_AI_API_KEY", "a")
	p := writeTOML(t, "[ai]\nenabled = true\ncategorize_provider = \"openai\"\n")
	if _, err := Load(p); err == nil {
		t.Error("want an error for an unknown provider")
	}
}

func TestCategorizeKey(t *testing.T) {
	a := AIConfig{CategorizeProvider: "typesafe", APIKey: "a", TypeSafeAPIKey: "t"}
	if a.CategorizeKey() != "t" {
		t.Errorf("typesafe key = %q", a.CategorizeKey())
	}
	a.CategorizeProvider = "anthropic"
	if a.CategorizeKey() != "a" {
		t.Errorf("anthropic key = %q", a.CategorizeKey())
	}
}
```

If `config_test.go` has no `writeTOML` helper, add one:

```go
func writeTOML(t *testing.T, body string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "c.toml")
	if err := os.WriteFile(p, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}
```

- [ ] **Step 2: Run, see FAIL**

Run: `go test ./internal/config/ -count=1`
Expected: compile FAIL — unknown fields.

- [ ] **Step 3: Implement config**

```go
// AIConfig holds settings for the AI clients: Anthropic (extraction fallback,
// and categorization by default) and optionally TypeSafe (categorization only).
// API keys are NEVER read from TOML; they come from LEDGER_AI_API_KEY and
// LEDGER_TYPESAFE_API_KEY.
type AIConfig struct {
	Enabled            bool   `toml:"enabled"`
	Model              string `toml:"model"`
	AllowAIExtraction  bool   `toml:"allow_ai_extraction"`
	CategorizeProvider string `toml:"categorize_provider"` // "anthropic" | "typesafe"
	TypeSafeModel      string `toml:"typesafe_model"`
	APIKey             string `toml:"-"` // env only
	TypeSafeAPIKey     string `toml:"-"` // env only
}

// CategorizeKey is the API key the configured categorization provider needs.
func (c AIConfig) CategorizeKey() string {
	if c.CategorizeProvider == "typesafe" {
		return c.TypeSafeAPIKey
	}
	return c.APIKey
}
```

Defaults block: add `CategorizeProvider: "anthropic", TypeSafeModel: "jev-1.13.0",`.
Env: after the `LEDGER_AI_API_KEY` block add

```go
	if v := os.Getenv("LEDGER_TYPESAFE_API_KEY"); v != "" {
		cfg.AI.TypeSafeAPIKey = v
	}
```

Replace the single `ai.enabled requires LEDGER_AI_API_KEY` check with:

```go
	if c.AI.Enabled {
		switch c.AI.CategorizeProvider {
		case "anthropic":
			if c.AI.APIKey == "" {
				return fmt.Errorf("ai.enabled requires LEDGER_AI_API_KEY env var")
			}
		case "typesafe":
			if c.AI.TypeSafeAPIKey == "" {
				return fmt.Errorf("ai.categorize_provider = \"typesafe\" requires LEDGER_TYPESAFE_API_KEY env var")
			}
			if c.AI.AllowAIExtraction && c.AI.APIKey == "" {
				return fmt.Errorf("ai.allow_ai_extraction requires LEDGER_AI_API_KEY env var (extraction always uses Anthropic)")
			}
		default:
			return fmt.Errorf("ai.categorize_provider must be \"anthropic\" or \"typesafe\" (got %q)", c.AI.CategorizeProvider)
		}
	}
```

Run `go test ./internal/config/ -count=1` → PASS (existing `TestAIConfigEnabledRequiresAPIKey` must still pass).

- [ ] **Step 4: Server field — failing test first** (append to the existing settings handler test file, `internal/server/settings_test.go`; follow its server-construction helper)

```go
func TestSettingsReportsAIProvider(t *testing.T) {
	srv, _ := newTestServer(t) // defined in budget_test.go
	srv.SetAIProvider("typesafe")
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, httptest.NewRequest("GET", "/api/settings", nil))
	var got map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &got)
	if got["ai_provider"] != "typesafe" {
		t.Errorf("ai_provider = %v, want typesafe", got["ai_provider"])
	}
}
```

Run → FAIL. Then implement: `aiProvider string` field beside `aiKeyPresent`; `func (s *Server) SetAIProvider(p string) { s.aiProvider = p }`; in `settings.go` DTO add `AIProvider string \`json:"ai_provider"\`` (read-only output, same comment style as `AIKeyPresent`), set it in the GET mapper. Update the `AIKeyPresent` comment: "whether the key for the categorization provider is loaded". Run → PASS.

- [ ] **Step 5: Wire `main.go`**

Replace the gate with a factory so each provider is gated on its own key:

```go
	// Live gate: the single authority over whether any AI call may leave the
	// box. Consulted at the HTTP boundary (anthropic.Retrier.Post) before every
	// call, for both Anthropic and TypeSafe. keyPresent is per provider.
	gateFor := func(keyPresent bool) func() error {
		return func() error {
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
	}
	anthropicGate := gateFor(cfg.AI.APIKey != "")
	categorizeGate := gateFor(cfg.AI.CategorizeKey() != "")
```

`:137` becomes

```go
	srv.SetAIKeyPresent(cfg.AI.CategorizeKey() != "")
	srv.SetAIProvider(cfg.AI.CategorizeProvider)
```

(Note `:137` runs before the gate block; `cfg` is already loaded there, so order is fine.)

Push body at `:210`: `"Monthly AI spend cap reached. Re-enable in Settings."`

Client choice:

```go
	if cfg.AI.Enabled {
		var inner categorize.AICategorizer
		switch cfg.AI.CategorizeProvider {
		case "typesafe":
			inner = categorize.NewTypeSafeCategorizer(cfg.AI.TypeSafeAPIKey, cfg.AI.TypeSafeModel, categorizeGate, aiRecorder)
		default:
			inner = categorize.NewAnthropicCategorizer(cfg.AI.APIKey, cfg.AI.Model, categorizeGate, aiRecorder)
		}
		// Memo wrapper: a merchant the AI has already categorized is answered
		// from the ai_suggestions table, not paid for again — whichever
		// provider answered it first.
		aiCat = categorize.MemoAI{Inner: inner, Store: st}
		if cfg.AI.AllowAIExtraction {
			aiExt = parse.NewAnthropicExtractor(cfg.AI.APIKey, cfg.AI.Model, anthropicGate, aiRecorder)
		}
		log.Printf("ai: clients wired (categorize=%s, extract model=%s); runtime master switch + cap now govern calls",
			cfg.AI.CategorizeProvider, cfg.AI.Model)
		if cfg.AI.CategorizeProvider == "typesafe" && anthropic.CostMuUSD(cfg.AI.TypeSafeModel, 1, 0) == 0 {
			log.Printf("ai: WARNING no price for %s — the spend cap will not count its calls", cfg.AI.TypeSafeModel)
		}
	}
```

Change the disabled log to `"ai: disabled (set ai.enabled=true + the provider's API key env var to activate)"`.

- [ ] **Step 6: Build + scratch smoke** (never `:8080`, never `/var/lib/ledger`)

```bash
go vet ./... && CGO_ENABLED=0 go build -o /tmp/claude-0/ledger-ts ./cmd/ledger
S=$(mktemp -d)
printf '[server]\nlisten = "127.0.0.1:8098"\ndata_dir = "%s"\n[ai]\nenabled = true\ncategorize_provider = "typesafe"\nallow_ai_extraction = false\n' "$S" > $S/c.toml
LEDGER_AI_API_KEY= LEDGER_TYPESAFE_API_KEY=dummy /tmp/claude-0/ledger-ts -config $S/c.toml > $S/log 2>&1 &
sleep 2; curl -s 127.0.0.1:8098/api/settings; grep "ai:" $S/log; kill %1
```

Expected: JSON has `"ai_provider":"typesafe","ai_key_present":true`; log says `categorize=typesafe`; no WARNING line.

- [ ] **Step 7: Full Go gate, then commit**

```bash
go test ./... -count=1
git add internal/config cmd/ledger/main.go internal/server/server.go internal/server/settings.go internal/server/settings_test.go
git commit -m "feat(ai): ai.categorize_provider selects Anthropic or TypeSafe"
```

---

### Task 5: Settings copy names the real provider

**Files:**
- Create: `frontend/src/lib/aiProvider.ts`, `frontend/src/lib/aiProvider.test.ts`
- Modify: `frontend/src/api/types.ts:16`, `frontend/src/screens/settings/AiUsagePage.tsx:57-75`, `frontend/src/screens/settings/CategorizationPage.tsx:66-69,104,114-119`

**Interfaces:**
- Consumes: settings JSON `ai_provider` (Task 4).
- Produces: `aiProviderInfo(p?: string): { name: string; envVar: string }`.

- [ ] **Step 1: Failing test** (`aiProvider.test.ts`)

```ts
import { describe, expect, it } from "vitest";
import { aiProviderInfo } from "./aiProvider";

describe("aiProviderInfo", () => {
  it("names TypeSafe and its env var", () => {
    expect(aiProviderInfo("typesafe")).toEqual({ name: "TypeSafe", envVar: "LEDGER_TYPESAFE_API_KEY" });
  });
  it("defaults to Anthropic for an old server with no field", () => {
    expect(aiProviderInfo(undefined)).toEqual({ name: "Anthropic", envVar: "LEDGER_AI_API_KEY" });
    expect(aiProviderInfo("anthropic")).toEqual({ name: "Anthropic", envVar: "LEDGER_AI_API_KEY" });
  });
});
```

Run: `cd frontend && bun run test src/lib/aiProvider.test.ts` → FAIL (module missing).

- [ ] **Step 2: Implement** (`aiProvider.ts`)

```ts
/** Display name and key env var for the server's categorization provider. */
export function aiProviderInfo(p?: string): { name: string; envVar: string } {
  return p === "typesafe"
    ? { name: "TypeSafe", envVar: "LEDGER_TYPESAFE_API_KEY" }
    : { name: "Anthropic", envVar: "LEDGER_AI_API_KEY" };
}
```

`types.ts`: add `ai_provider?: "anthropic" | "typesafe";` beside `ai_key_present`.

- [ ] **Step 3: Update the copy.** In both screens, `const prov = aiProviderInfo(s.ai_provider);` (or `settings.data?.ai_provider`), then:

| Where | Old | New |
|---|---|---|
| AiUsagePage hint (key present) | `When off, the app makes zero calls to Anthropic.` | `When off, the app makes no AI calls.` |
| AiUsagePage hint (no key) | `Add an Anthropic API key to the env file and restart to turn this on.` | `` `Add a ${prov.name} API key to the env file. Then restart.` `` |
| both key rows | `Anthropic API key` | `` `${prov.name} API key` `` |
| both "Not set" | `… add LEDGER_AI_API_KEY …` | `` `Not set · add ${prov.envVar} to the env file and restart` `` |
| CategorizationPage run reason | `AI suggestions need the Anthropic API key — add LEDGER_AI_API_KEY …` | `` `AI suggestions need the ${prov.name} API key. Add ${prov.envVar} to the env file and restart.` `` |
| CategorizationPage master hint | `Off = zero calls to Anthropic. …` | `Off = no AI calls. Manage usage & spend cap under AI & API usage.` |

"No AI calls" is true for both providers because Task 4 gates both on the same master switch.

- [ ] **Step 4: Check no stale provider copy is left**

Run: `grep -rn "Anthropic" frontend/src --include=*.tsx | grep -v test`
Expected: no hits except inside `aiProvider.ts`. Then `LC_ALL=C grep -c $'\x00' frontend/src/screens/settings/*.tsx` → all `0` (NUL-byte trap).

- [ ] **Step 5: Run the frontend gate** — `cd frontend && bun run test`. Update any settings test or story snapshot that asserted the old strings (search: `grep -rn "zero calls to Anthropic\|Anthropic API key" frontend/src`).

- [ ] **Step 6: Harness check** — `harness/stack.sh up > /tmp/claude-0/stack.log 2>&1` (never piped), then `node harness/probe.mjs` and look at the Settings → AI screenshots from `node harness/shoot.mjs`. `harness/stack.sh down` after.

- [ ] **Step 7: Rebuild dist and commit**

```bash
cd frontend && bun run build && cd ..
git add frontend/src/lib/aiProvider.ts frontend/src/lib/aiProvider.test.ts frontend/src/api/types.ts frontend/src/screens/settings internal/web/dist
git commit -m "fix(settings): AI copy names the configured provider"
```

---

### Task 6: `ledger categorize-eval` — measure before switching

**Files:**
- Create: `internal/categorize/eval.go`, `internal/categorize/eval_test.go`
- Create: `internal/store/eval.go`, `internal/store/eval_test.go`
- Modify: `cmd/ledger/main.go` (dispatch `case "categorize-eval"` + `runCategorizeEval`)

**Interfaces:**
- Consumes: `NewTypeSafeCategorizer` (Task 3), `config.AIConfig` fields (Task 4).
- Produces:
  - `store.MerchantLabel{Merchant, Category string; N int}`; `func (s *Store) SelectMerchantLabels() ([]MerchantLabel, error)` — one row per normalized merchant, its most-used confirmed category.
  - `categorize.EvalReport{Total, Correct, Errors int; Bands []EvalBand}`; `EvalBand{Min float64; N, Correct int}`
  - `func Evaluate(ctx context.Context, labels []Labeled, cats []Category, ai AICategorizer) EvalReport` with `type Labeled struct{ Merchant, Want string }`.

- [ ] **Step 1: Failing eval test** (`internal/categorize/eval_test.go`)

```go
package categorize

import (
	"context"
	"errors"
	"testing"
)

type fakeAI map[string]struct {
	name string
	conf float64
}

func (f fakeAI) Categorize(_ context.Context, m string, _ []Category) (string, float64, error) {
	r, ok := f[m]
	if !ok {
		return "", 0, errors.New("boom")
	}
	return r.name, r.conf, nil
}

func TestEvaluateBandsAndErrors(t *testing.T) {
	ai := fakeAI{
		"a": {"Dining", 0.95},    // correct, band 0.9
		"b": {"Groceries", 0.92}, // wrong,   band 0.9
		"c": {"Dining", 0.6},     // correct, band 0.5
		"d": {"dining", 0.1},     // correct (case-insensitive), band 0
	}
	labels := []Labeled{{"a", "Dining"}, {"b", "Dining"}, {"c", "Dining"}, {"d", "Dining"}, {"e", "Dining"}}
	r := Evaluate(t.Context(), labels, tsCats, ai)
	if r.Total != 5 || r.Correct != 3 || r.Errors != 1 {
		t.Fatalf("report = %+v, want total 5 correct 3 errors 1", r)
	}
	want := map[float64][2]int{0.9: {2, 1}, 0.85: {0, 0}, 0.7: {0, 0}, 0.5: {1, 1}, 0: {1, 1}}
	for _, b := range r.Bands {
		if w := want[b.Min]; b.N != w[0] || b.Correct != w[1] {
			t.Errorf("band %.2f = %d/%d, want %d/%d", b.Min, b.Correct, b.N, w[1], w[0])
		}
	}
}
```

Run → compile FAIL.

- [ ] **Step 2: Implement** (`eval.go`)

```go
package categorize

import (
	"context"
	"strings"
)

// Labeled is one merchant with the category Saleh confirmed for it.
type Labeled struct{ Merchant, Want string }

// EvalBand counts answers whose confidence is >= Min and below the next band.
type EvalBand struct {
	Min        float64
	N, Correct int
}

// EvalReport is the outcome of Evaluate. Errors are calls that failed; they
// count in Total but in no band.
type EvalReport struct {
	Total, Correct, Errors int
	Bands                  []EvalBand
}

// evalBandMins are descending; 0.85 matches the default auto-accept threshold.
var evalBandMins = []float64{0.9, 0.85, 0.7, 0.5, 0}

// Evaluate asks ai for every labeled merchant and compares the answer with the
// confirmed category. It calls ai directly, never through MemoAI, so every
// answer is fresh.
func Evaluate(ctx context.Context, labels []Labeled, cats []Category, ai AICategorizer) EvalReport {
	r := EvalReport{Bands: make([]EvalBand, len(evalBandMins))}
	for i, m := range evalBandMins {
		r.Bands[i].Min = m
	}
	for _, l := range labels {
		r.Total++
		name, conf, err := ai.Categorize(ctx, l.Merchant, cats)
		if err != nil {
			r.Errors++
			continue
		}
		ok := strings.EqualFold(name, l.Want)
		if ok {
			r.Correct++
		}
		for i, m := range evalBandMins {
			if conf >= m {
				r.Bands[i].N++
				if ok {
					r.Bands[i].Correct++
				}
				break
			}
		}
	}
	return r
}
```

Run `go test ./internal/categorize/ -run Evaluate -count=1` → PASS.

- [ ] **Step 3: Store query, test first** (`internal/store/eval_test.go`; use the package's existing temp-store helper and insert helpers — look at `store_test.go` for their names)

Test: insert confirmed transactions "Carrefour MOE"×2 → Groceries, " carrefour moe "×1 → Dining, "Talabat"×1 → Dining, one `needs_review` "Noon" → Shopping, one confirmed with blank merchant. Assert exactly two labels: `{"carrefour moe","Groceries",2}` and `{"talabat","Dining",1}`, sorted by merchant.

Implementation (`internal/store/eval.go`):

```go
package store

// MerchantLabel is a normalized merchant and the category most often
// confirmed for it. Used only by the offline categorize-eval command.
type MerchantLabel struct {
	Merchant string
	Category string
	N        int
}

// SelectMerchantLabels returns one row per normalized merchant with its
// most-confirmed category. Read-only.
func (s *Store) SelectMerchantLabels() ([]MerchantLabel, error) {
	rows, err := s.DB.Query(`
		SELECT lower(trim(t.merchant_raw)) AS m, c.name, COUNT(*) AS n
		FROM transactions t JOIN categories c ON c.id = t.category_id
		WHERE t.status = 'confirmed' AND trim(coalesce(t.merchant_raw, '')) <> ''
		GROUP BY m, c.name
		ORDER BY m, n DESC, c.name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []MerchantLabel
	for rows.Next() {
		var l MerchantLabel
		if err := rows.Scan(&l.Merchant, &l.Category, &l.N); err != nil {
			return nil, err
		}
		if len(out) > 0 && out[len(out)-1].Merchant == l.Merchant {
			continue // keep only the top category per merchant
		}
		out = append(out, l)
	}
	return out, rows.Err()
}
```

Run the test → PASS.

- [ ] **Step 4: CLI** — in `main.go` add `case "categorize-eval": runCategorizeEval(os.Args[2:]); return` and:

```go
// runCategorizeEval measures TypeSafe against confirmed history. It requires an
// explicit --data-dir so it can never open the production DB by default; point
// it at a restored backup copy. It bypasses the memo and the live gate and
// records no usage (a full run costs well under one US cent).
func runCategorizeEval(args []string) {
	fs := flag.NewFlagSet("categorize-eval", flag.ExitOnError)
	dataDir := fs.String("data-dir", "", "directory holding a COPY of ledger.db (required)")
	model := fs.String("model", "jev-1.13.0", "TypeSafe model id")
	limit := fs.Int("limit", 0, "evaluate at most N merchants (0 = all)")
	if err := fs.Parse(args); err != nil {
		log.Fatalf("categorize-eval flags: %v", err)
	}
	if *dataDir == "" || strings.HasPrefix(filepath.Clean(*dataDir), "/var/lib/ledger") {
		log.Fatalf("categorize-eval: --data-dir must point at a scratch copy, not the live DB")
	}
	key := os.Getenv("LEDGER_TYPESAFE_API_KEY")
	if key == "" {
		log.Fatalf("categorize-eval: set LEDGER_TYPESAFE_API_KEY")
	}
	st, err := store.Open(*dataDir)
	if err != nil {
		log.Fatalf("store: %v", err)
	}
	defer st.Close()
	storeCats, err := st.SelectCategories()
	if err != nil {
		log.Fatalf("categories: %v", err)
	}
	cats := make([]categorize.Category, len(storeCats))
	for i, c := range storeCats {
		cats[i] = categorize.Category{ID: c.ID, Name: c.Name, Kind: c.Kind, Bucket: c.Bucket}
	}
	rows, err := st.SelectMerchantLabels()
	if err != nil {
		log.Fatalf("labels: %v", err)
	}
	if *limit > 0 && len(rows) > *limit {
		rows = rows[:*limit]
	}
	labels := make([]categorize.Labeled, len(rows))
	for i, r := range rows {
		labels[i] = categorize.Labeled{Merchant: r.Merchant, Want: r.Category}
	}
	ai := categorize.NewTypeSafeCategorizer(key, *model, nil, nil)
	rep := categorize.Evaluate(context.Background(), labels, cats, ai)
	fmt.Printf("merchants %d  correct %d (%.1f%%)  errors %d\n",
		rep.Total, rep.Correct, 100*float64(rep.Correct)/float64(max(rep.Total, 1)), rep.Errors)
	for _, b := range rep.Bands {
		fmt.Printf("  conf >= %.2f: %4d answers, %5.1f%% correct\n",
			b.Min, b.N, 100*float64(b.Correct)/float64(max(b.N, 1)))
	}
}
```

Add `path/filepath` and `strings` imports if missing.

- [ ] **Step 5: Smoke on scratch data** — `go build` then run against `frontend/harness`'s scratch DB (seeded by `stack.sh up`) with a dummy key: expect `errors == merchants` and a 401 per call, and no write to `/var/lib/ledger` (`ls -l --time-style=full-iso /var/lib/ledger/ledger.db` unchanged). Also run once with `--data-dir /var/lib/ledger` and confirm it refuses.

- [ ] **Step 6: Commit**

```bash
go test ./... -count=1
git add internal/categorize/eval.go internal/categorize/eval_test.go internal/store/eval.go internal/store/eval_test.go cmd/ledger/main.go
git commit -m "feat(cli): categorize-eval measures TypeSafe against confirmed history"
```

---

### Task 7: Docs and rollout runbook

**Files:**
- Modify: `CLAUDE.md` (principles bullet "Private and least-privilege"; `anthropic` and `categorize` architecture bullets; CLI subcommands list)
- Modify: `deploy/README.md` (env vars + a "Switching categorization to TypeSafe" section)
- Modify: `frontend/src/components/README.md` only if a shared component changed (it should not).

- [ ] **Step 1: CLAUDE.md edits**
  - Principle: "The only data that leaves the box is a bare merchant string (and the category names) to the AI provider — Anthropic, or TypeSafe for categorization when `ai.categorize_provider = "typesafe"` — and that path is disableable."
  - `anthropic` bullet: "shared retrying HTTP client … also used by `categorize/typesafe.go` via `Retrier.SetHeaders`. These are the only network paths data leaves the box on."
  - `categorize` bullet: add "`TypeSafeCategorizer` asks Jev one Choice question (with a `__no_fit__` option) when `ai.categorize_provider = "typesafe"`."
  - CLI list: "`ledger categorize-eval --data-dir <scratch copy> [--limit N]` — measure TypeSafe against confirmed history. Refuses `/var/lib/ledger`."

- [ ] **Step 2: deploy/README.md — rollout section**

```markdown
## Switching categorization to TypeSafe

1. Get a key at https://console.typesafe.ai/keys.
2. Measure first, on a copy:
   sudo sqlite3 /var/lib/ledger/ledger.db ".backup /root/ts-eval/ledger.db"
   LEDGER_TYPESAFE_API_KEY=… ledger categorize-eval --data-dir /root/ts-eval
   Pick the lowest confidence band whose accuracy you accept. Set that as the
   auto-accept threshold in Settings → Categorization.
3. Add `LEDGER_TYPESAFE_API_KEY=…` to /etc/ledger/ledger.env.
4. In /etc/ledger/config.toml under [ai]: `categorize_provider = "typesafe"`.
5. Restart ledger.service. Log must say `categorize=typesafe`.
6. Roll back: set `categorize_provider = "anthropic"` and restart.
   Cached suggestions in ai_suggestions stay valid either way.
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md deploy/README.md
git commit -m "docs: TypeSafe categorization provider and rollout"
```

---

### Task 8: Final gate (no deploy)

- [ ] `go test ./... -count=1 && go test ./... -race -count=1`
- [ ] `cd frontend && bun run test && bun run build` — then `git status` must show no dist change (dist already committed in Task 5).
- [ ] Re-check `main` for parallel-session commits (memory: parallel-agents-on-main); merge and rebuild dist if it moved.
- [ ] **Do not deploy.** The switch in production needs Saleh's TypeSafe key and his eval result (Task 7 runbook). A deploy of this branch alone changes nothing in behaviour, because the default provider stays `anthropic`.

---

## Out of scope (recorded, not planned)

- Batching several merchants into one TypeSafe call (fan-out). One call per new merchant is already cheap, and the memo makes repeats free.
- Sending `direction` (debit/credit) as state. It would help Jev tell income from spending, but it widens what leaves the box; needs Saleh's say.
- Using TypeSafe for extraction or for the review-queue "is this a transaction?" check (a Noul). Possible later.
- Renaming `internal/anthropic` to a neutral name.
