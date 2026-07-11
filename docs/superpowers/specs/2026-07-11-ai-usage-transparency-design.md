# AI usage transparency & trustworthy kill switch — design

**Date:** 2026-07-11
**Status:** approved (design), pending spec review

## Problem

Anthropic API usage accrued cost silently and unexpectedly. Investigation found two
root causes:

1. **No trustworthy off switch.** The app calls Anthropic on two paths — AI
   *extraction* (`internal/parse/ai.go`, parse-cascade fallback) and AI
   *categorization* (`internal/categorize/ai.go`, unknown-merchant fallback). The
   runtime "AI suggestions" setting (`app_settings.ai_enabled`) gates *only*
   categorization, via `buildCategorizer` in `cmd/ledger/main.go`. Extraction is
   gated *only* by the config file (`cfg.AI.Enabled` + `cfg.AI.AllowAIExtraction`)
   at boot, with **no runtime gate at all**. So with every in-app toggle off,
   extraction kept calling the API on any email the bank parsers didn't recognize.
   The user could not be confident that "off" meant off.

2. **No visibility.** Nothing recorded API calls, tokens, or cost. There was no way
   to see spend happening.

Confirmed live state at investigation: config `ai.enabled=true`,
`allow_extraction=true`, model `claude-haiku-4-5-20251001`; runtime
`auto_categorize=0, ai_enabled=0`. Categorization was off; extraction was silently
live.

## Goals

- **"Off" is provably off.** A single master switch that stops *all* Anthropic calls
  (extraction and categorization) at the network boundary, effective immediately with
  no restart, overriding the config file.
- **Transparency.** A running cost + call count, a per-call log, all visible in the
  app settings.
- **A safety net.** A monthly spend cap that hard-latches AI off and notifies the user
  when crossed — so silent over-spend cannot recur.

## Non-goals

- Live per-call push alerts (deferred; the cap already sends a push on latch).
- Auto-reset of the cap each month (explicitly rejected — hard latch + manual re-enable).
- Changing the parse cascade or categorization logic. This work is purely about
  gating and observability around the existing two API paths.

## Core principle

Deterministic parsing does **not** require the API. Tiers 1–2 (bank templates,
heuristic) are pure Go. The API is only ever the *fallback* extraction tier and the
unknown-merchant categorizer. This design does not change that; it makes the fallback
calls gateable and observable.

---

## Architecture

Three pieces, layered so the *guarantee* (no egress when off) is centralized and the
*bookkeeping* sits at the two call sites that already parse responses.

### 1. Egress gate — the trust anchor (`internal/anthropic`)

`anthropic.Retrier` is the single HTTP boundary; both AI paths call `Post`. Add an
optional gate checked before any network I/O:

```go
// ErrAIDisabled is returned by Post when the gate refuses the call. Callers treat
// it like any other Post failure (skip the tier / leave the txn in review).
var ErrAIDisabled = errors.New("anthropic: AI disabled")

type Retrier struct {
    ...
    // Gate, if non-nil, is consulted at the top of Post before any request is
    // built or sent. A non-nil return aborts the call with no network I/O.
    Gate func() error
}
```

In `Post`, first line of the method body:

```go
if r.Gate != nil {
    if err := r.Gate(); err != nil {
        return nil, err
    }
}
```

The gate closure returns `ErrAIDisabled` when **any** of these hold, read live from
the store each call (a sub-millisecond WAL read, negligible against a network call):

- API key not present, **or**
- master switch off (`app_settings.ai_enabled == false`), **or**
- spend cap latched (`app_settings.ai_cap_latched == true`).

Both `parse.NewAnthropicExtractor` and `categorize.NewAnthropicCategorizer` build
their `Retrier` with the **same** gate closure (wired in `main.go`). Result: there is
no code path that reaches `http.Client.Do` without passing the gate. This is the
invariant the "confident off" requirement rests on, and it is directly testable
(below).

Because the gate consults the live store, flipping the master switch in the UI takes
effect on the very next call — no restart.

> Note: `cfg.AI.Enabled` / `cfg.AI.AllowAIExtraction` continue to decide, at boot,
> whether the *real* clients (vs the `Disabled*` no-ops) are constructed. That stays,
> but it is no longer the authority — the gate is. When the real clients are wired,
> the master switch is the live on/off. This satisfies "config just says whether a
> key is wired."

### 2. Usage recording — transparency (`internal/store` + the two call sites)

New table (added idempotently in `schema.sql`, per the existing `CREATE TABLE IF NOT
EXISTS` convention):

```sql
CREATE TABLE IF NOT EXISTS ai_usage (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    at            INTEGER NOT NULL,            -- unix seconds
    path          TEXT    NOT NULL,            -- 'extract' | 'categorize'
    model         TEXT    NOT NULL,
    input_tokens  INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    cost_musd     INTEGER NOT NULL,            -- micro-USD (1e-6 USD), integer money
    ok            INTEGER NOT NULL,            -- 1 = 200 response, 0 = error
    detail        TEXT                         -- merchant / subject snippet, nullable
);
CREATE INDEX IF NOT EXISTS idx_ai_usage_at ON ai_usage(at);
```

**Money stays integer, per the repo rule (never floats for money).** Cost is stored
as int64 **micro-USD** (µ$; $200 = 200,000,000). A price table in the `anthropic`
package maps model → (input µ$/token, output µ$/token):

```go
// PriceMuUSD is micro-USD per token. Extend as models are added; unknown model → {0,0}
// (tokens still recorded, cost shown as "—").
var PriceMuUSD = map[string]struct{ In, Out int64 }{
    "claude-haiku-4-5-20251001": {In: 1, Out: 5},   // $1 / $5 per Mtok
    "claude-haiku-4-5":          {In: 1, Out: 5},
    "claude-opus-4-8":           {In: 5, Out: 25},  // $5 / $25 per Mtok
    "claude-sonnet-5":           {In: 3, Out: 15},
}
// cost_musd = input_tokens*In + output_tokens*Out   (exact integer math)
```

Both `AnthropicExtractor.Extract` and `AnthropicCategorizer.Categorize` already decode
the response body; extend their response structs to also decode
`usage {input_tokens, output_tokens}` and the top-level `model`, then call
`store.RecordAIUsage(row)` after the call. Record only when a request actually left
the box: a 200 records a full row; a non-200 / transport failure records a `0`-cost
`ok=0` row so real failures are visible. A gated call (`ErrAIDisabled`) short-circuits
in `Post` before any I/O and records **nothing** — no call happened, so it is not
"usage". Recording is transparency, not enforcement, so placing it at the two call
sites is acceptable; both are covered and tested.

`store` methods:

- `RecordAIUsage(AIUsageRow) error`
- `SumAIUsageMuUSD(since int64) (int64, error)` — for the cap and the 30-day total.
- `AIUsageStats() (AIUsageStats, error)` — `{count30d, cost30dMuUSD, countAll,
  costAllMuUSD, byPath}`.
- `RecentAIUsage(limit int) ([]AIUsageRow, error)` — for the per-call log.

### 3. Spend cap — hard latch (`internal/store` + recording path)

New `app_settings` columns (via the existing `addColumn` additive helper):

- `ai_spend_cap_musd INTEGER NOT NULL DEFAULT 0` — 0 = no cap.
- `ai_cap_latched   INTEGER NOT NULL DEFAULT 0` — 1 = auto-disabled by the cap.

After each **successful** recording, the recording path checks:
`SumAIUsageMuUSD(now-30d) >= ai_spend_cap_musd` (when cap > 0). If crossed:

1. Set `ai_enabled = 0` and `ai_cap_latched = 1` (single `UPDATE`).
2. Send a Web Push (via the existing `push` package) — "AI auto-disabled: hit your
   $X monthly cap." Best-effort; only if push is configured.

The gate independently refuses when `ai_cap_latched` is set, so concurrent in-flight
calls also stop. The latch clears only when the user manually turns the master switch
back on (the PUT handler clears `ai_cap_latched` whenever it sets `ai_enabled = 1`).

Window is a trailing 30 days (`SUM(cost_musd) WHERE at >= now-30d`).

---

## API surface (`internal/server`)

- **`GET /api/ai/usage`** (new) →
  ```json
  {
    "count_30d": 128, "cost_30d_musd": 4200000,
    "count_all": 512, "cost_all_musd": 190000000,
    "by_path": {"extract": {...}, "categorize": {...}},
    "recent": [
      {"at": 1752..., "path": "extract", "model": "...",
       "input_tokens": 812, "output_tokens": 47, "cost_musd": 1047,
       "ok": true, "detail": "AMAZON.AE"}
    ]
  }
  ```
- **`GET/PUT /api/settings`** — extend `settingsDTO` with `ai_spend_cap_musd`
  (int) and read-only `ai_cap_latched` (bool). PUT writes the cap; PUT ignores
  `ai_cap_latched` on input but clears it server-side whenever `ai_enabled` flips to
  true. Existing fields unchanged.

`main.go` wires the gate closure and passes the store to both AI client constructors
and to the recording path.

---

## UI (`frontend/src/screens/settings/`)

New drill-in page **`AiUsagePage.tsx`**, reached from a new hub row **"AI & API
usage"** in its own `Group` on `SettingsHub.tsx`. Layout top→bottom:

1. **Master switch "AI features"** (writes `ai_enabled`) with sublabel
   *"When off, the app makes zero calls to Anthropic."* This is the single trusted
   control.
2. **Status**: API key loaded (from existing `ai_key_present`) · model.
3. **Latched banner** (only when `ai_cap_latched`): *"AI auto-disabled — hit your
   $X monthly cap. Turn AI back on to resume."*
4. **Usage card**: last 30 days — *N calls · ~$X.XX*; lifetime *N · $Y*.
5. **Spend cap**: dollar input + save (writes `ai_spend_cap_musd`); 0/empty = no cap.
6. **Recent calls** (last ~50): time · path badge (`extract`/`categorize`) · tokens
   in/out · ~cost · merchant/subject snippet.

**Existing Categorization page:** relabel its "AI suggestions" toggle to make clear it
is the master AI switch (same `ai_enabled` setting — single source of truth) and add a
one-line cross-link to the new AI & API usage page. `AIAutoAccept`/`AIThreshold`
stay on the Categorization page. (Decision (b): relabel + cross-link, not a full move.
Revisit here if the user prefers a full move.)

Pure `lib/` helpers (framework-free, unit-tested per the `lib/` convention):

- `lib/aiCost.ts` — `formatMuUSD(musd)` → `"$1.90"`, `"< $0.01"`, `"—"` (unknown);
  `dollarsToMuUSD` / `muUSDToDollars` for the cap input.
- `lib/aiUsage.ts` — usage-summary shaping used by the card.

Follow `frontend/src/components/README.md` conventions (44px targets, 16px inputs,
`.press`, Dialog-only overlays) and update that catalog if any shared component is
added.

---

## Testing

**Go**

- `anthropic`: **gate blocks all egress** — build a `Retrier` with a gate that returns
  `ErrAIDisabled`, point it at an `httptest.Server`, call `Post`, assert the server
  received **zero** requests and `Post` returned `ErrAIDisabled`. This is the
  "off means off" guarantee. Also: gate `nil` → normal behavior; gate allows → request
  sent.
- `anthropic`: price-table cost math, table-driven, integer-exact (Haiku, Opus, unknown
  model → 0).
- `store`: `ai_usage` insert/sum/stats/recent; new `app_settings` columns round-trip;
  `SumAIUsageMuUSD` window boundary.
- `store`/recording: cap crossing sets `ai_enabled=0` + `ai_cap_latched=1`; PUT
  settings with `ai_enabled=1` clears the latch.
- `parse`/`categorize`: on a 200, a usage row is recorded with the decoded tokens; on a
  gated call (`ErrAIDisabled`) extraction skips its tier and categorization surfaces the
  error, and **no** usage row is written at all (the call never left the box).
- `server`: `GET /api/ai/usage` shape; `GET/PUT /api/settings` round-trips the cap and
  never lets the client set `ai_cap_latched`.

**Frontend (vitest)**

- `lib/aiCost.test.ts`, `lib/aiUsage.test.ts` — formatting + conversions incl. edge
  cases (sub-cent, unknown-model dash, cap dollar↔µ$).
- `AiUsagePage` — renders master toggle + usage card + cap input; latched banner shows
  only when `ai_cap_latched`; toggling the master calls the settings PUT.

## Rollout

- `internal/web/dist/` is a committed artifact — rebuild the combined dist before
  finishing the branch (parallel sessions run on `main`).
- No migration tool exists; the additive schema (`CREATE TABLE IF NOT EXISTS` +
  `addColumn`) applies on next `store.Open`. Existing rows get `ai_spend_cap_musd=0`
  (no cap) and `ai_cap_latched=0`.
- Deploy is local on `dinosaur`; after restart, confirm the live process loaded the
  new binary and that flipping the master switch stops calls (watch `ai_usage` stop
  growing).

## Open decision carried to review

(b) Categorization "AI suggestions" toggle: relabel + cross-link (chosen) vs. fully
move it to the new AI page. Default is relabel + cross-link.
