# Scoped, controllable categorization runs — design

## Problem

Today categorization is a single synchronous `POST /api/recategorize` that runs inline in the HTTP request over the entire *Needs review* backlog. There's no way to scope it to a date range, see progress, or stop it. A large backlog (e.g. a fresh import) blocks the request and fires many AI calls with no user control.

## Goal

Let the user **run, stop, and scope** categorization from Settings:
- **Scope** a run to a **date range** (the existing month / range / all-time `Scope` model). All-time = the whole backlog.
- **Run / Stop** an asynchronous run with **live progress** (`N of M`).
- Pause and Stop are the **same** action (halt, no resume) — pressing Run again simply continues over whatever is still in *Needs review* within scope.

Only *Needs review* transactions are touched (not already-categorized ones).

## Approach

A single **in-memory background job** owned by the server (single-user app). Every transaction is committed as it's categorized, so a server restart mid-run just leaves the rest in *Needs review* to re-run — no persistence needed.

### Backend — `internal/server/categorize_job.go`

A single job on the `Server`:

```go
type categorizeJob struct {
    mu        sync.Mutex
    running   bool
    cancel    context.CancelFunc
    processed int
    total     int
}
```

Behavior:
- **Start(from, to)**: if already running → reject. Else select `needs_review` in `[from,to]` via `catStore.SelectTransactions("needs_review", from, to)`, set `total = len(items)`, `processed = 0`, `running = true`, and spawn a goroutine.
- **Goroutine**: dedupe by merchant (call `recatFn` once per distinct merchant, apply to all matching rows — the logic currently in `handleRecategorize` moves here); check the context between items so Stop halts after the current item; `processed++` per transaction; broadcast progress (throttled). A `defer` sets `running = false` and broadcasts a final event even on panic.
- **Stop()**: cancel the context. (This is both "pause" and "stop".)
- **Status()**: `{running, processed, total}`.

Concurrency: one job at a time, guarded by the mutex.

### Endpoints

- `POST /api/categorize/run` — body `{ "from": "YYYY-MM-DD", "to": "YYYY-MM-DD" }` (both optional; omit for all-time). `200 {"started": true}`; `409 {"error":"already running"}` if a run is in progress; `503` if categorization isn't wired.
- `POST /api/categorize/stop` — `200 {"stopped": true}` (idempotent; no-op if idle).
- `GET /api/categorize/status` — `200 {"status": "idle"|"running", "processed": N, "total": M}`.

**Removes** `POST /api/recategorize` (and its handler/tests). The scoped run with an all-time range fully supersedes it — one code path.

### Live progress (SSE)

The job broadcasts a `categorize` event over the existing `Hub` (`BroadcastEvent("categorize", {status, processed, total})`), **throttled to ≤ ~3/sec** plus a guaranteed broadcast on start and on finish/stop. The frontend's `useLiveEvents` already invalidates the list/summary views on any event; we add `["categorize-status"]` to its invalidation set so the progress line and the views refresh live as rows are categorized.

### Frontend — Settings → Categorization

The existing "Run categorization now" button becomes:
- **Idle:** a **period control** (reusing `PeriodSheet`, seeded from the current global `Scope` passed in from `AppShell`) showing the range label, plus a **Run** button. Subtext: "Categorizes Needs review for {range}."
- **Running:** a live "**{processed} of {total} categorized**" line + a **Stop** button.

State comes from a `["categorize-status"]` query (`GET /api/categorize/status`) for initial load, kept live by the SSE invalidation above. The card has its own period control because the top-bar period picker is hidden on Settings; it uses the same `Scope` model and `scopeBounds()` to derive `from`/`to`.

`AppShell` passes the current `scope` to `<Settings scope={scope} />` so the run seeds from what the user was last looking at.

## Testing

- **Job:** reaches `processed == total`; dedupe = one `recatFn` call per distinct merchant; Stop halts mid-run (deterministic via a `recatFn` that blocks the first call on a channel, then cancel); a second Start while running is rejected.
- **SSE:** a `Hub` subscriber receives a `categorize` event during a run.
- **Endpoints:** run → 200; run-while-running → 409; stop → 200; status reflects idle/running.
- **Frontend:** Settings shows Run when idle and posts `/api/categorize/run` with the seeded `from`/`to`; shows progress + Stop when running; Stop posts `/api/categorize/stop`.

## Out of scope (YAGNI)

Hand-picked transaction selection; re-categorizing already-confirmed rows; resume-after-pause; persisting job state across restarts; explicit inter-call pacing (the new `Retry-After`-aware retry layer already handles 429s).
