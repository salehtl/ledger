# Ingest Health Indicator — Design

**Date:** 2026-07-05
**Status:** Approved for planning

## Problem

The scariest failure mode for an email-sourced ledger is silence. Today a dead
IMAP login, a wedged worker, or a broken auto-forward rule in the primary
mailbox all look identical to a quiet spending day: the worker only *logs*
sync errors, `/api/health` can't distinguish "no new mail" from "can't reach
the mailbox", and the PWA never surfaces any of it.

## Goal

Make ingest failures visible in the app, silently when healthy:

- **Ambient warning banner** across the app only when ingest looks broken.
- **Settings → "Email ingest" status page** with full detail on demand.
- No push notifications, no SSE — in-app only (explicit decision; push can be
  added later).

## Failure signals (all three trigger the banner)

| Reason key | Meaning | Trigger |
|---|---|---|
| `polls_failing` | IMAP checks erroring | ≥3 consecutive sync failures **and** >15 min since last successful poll |
| `poll_stale` | Worker wedged/dead (no error, no success) | No successful poll in `max(3×poll interval, 5 min)` |
| `mail_silent` | Polls fine but no mail arriving (e.g. broken forward rule) | No email ingested in `ingest_silence_days` days (setting, default 3) |

`polls_failing` requires *both* conditions so a single network blip never
nags. A freshly started worker that hasn't completed a poll yet reports
"starting", not a warning.

## Architecture

Poll state is **in-memory on the worker** (approach chosen over persisting to
SQLite — the state is ephemeral and rebuilds within one poll of a restart;
persisting it would write a row per poll forever for no benefit).

### `internal/ingest`

`Worker` gains a mutex-guarded health snapshot, updated by `Run` after every
`syncOnce`:

```go
type HealthSnapshot struct {
    StartedAt           time.Time // when Run began; anchors the "starting" grace window
    LastAttemptAt       time.Time // zero until first poll completes/fails
    LastSuccessAt       time.Time // zero until first success
    ConsecutiveFailures int
    LastError           string    // "" when last poll succeeded
    Interval            time.Duration
}

func (w *Worker) Health() HealthSnapshot
```

A success resets `ConsecutiveFailures` and `LastError`. Context-cancellation
"errors" during shutdown do not count as failures.

### `internal/store`

- `addColumnIfMissing(db, "app_settings", "ingest_silence_days", "INTEGER NOT NULL DEFAULT 3")`
- `AppSettings` gains `IngestSilenceDays int` (select/update in the singleton
  row functions; `EnsureAppSettings` default 3).
- Existing `LastIngestAt()` supplies the mail-recency signal — no new queries.

### `internal/server`

Enrich the existing `GET /api/health` ingest block (no new endpoint). The
server derives the verdict so the frontend stays a thin renderer:

```json
"ingest": {
  "configured": true,
  "count": 1234,
  "last_at": "2026-07-05T09:12:00Z",          // existing: last email ingested
  "status": "ok",                              // "ok" | "warn" | "starting" | "off"
  "reasons": [],                               // subset of the three reason keys, warn only
  "last_poll_success_at": "2026-07-05T09:30:00Z",
  "last_poll_attempt_at": "2026-07-05T09:30:00Z",
  "consecutive_failures": 0,
  "last_error": "",
  "poll_interval_seconds": 60,
  "silence_days": 3
}
```

- `off` = IMAP not configured (`configured: false`).
- `starting` = configured but no poll attempt has completed yet, and the
  worker started less than the staleness window ago. If the first poll never
  completes (e.g. a hung dial), `starting` expires into `warn`/`poll_stale`
  after `max(3×interval, 5 min)` from `StartedAt`.
- `warn` = any reason fires; `reasons` lists which.
- The server needs access to the worker's `Health()`: `main.go` passes the
  worker (behind a small interface, e.g. `server.SetIngestWorker(healthFn)`)
  when IMAP is enabled. Status derivation lives in a pure function
  (`deriveIngestStatus(snapshot, lastMailAt, now, silenceDays)`) so it
  table-tests without HTTP.
- Settings API (`GET/PUT /api/settings`) carries `ingest_silence_days`
  (validated ≥1).

## Frontend

### Data

- `useIngestHealth` hook: react-query on `GET /api/health`, `refetchInterval`
  ~60 s, refetch on window focus. Types added to `api/types`.

### Ambient banner (`AppShell`)

- Renders only when `status === "warn"`.
- Compact single line, e.g. ⚠️ "Email ingest may be broken — no successful
  check in 4 h", tappable → navigates to the status page.
- Dismissable; dismissal is remembered (in-memory + sessionStorage) keyed by
  the current `reasons` set, so the banner stays hidden until the reason set
  changes or the app restarts. Recovery (status back to `ok`) clears the
  dismissal key.

### Settings → "Email ingest" page

New drill-in page in the Settings hub (`screens/settings/IngestHealthPage.tsx`):

- Status headline (Healthy / Warning / Starting / Not configured) with reasons
  spelled out in plain language.
- Facts list: last email seen (relative + absolute), last successful check,
  last attempted check, consecutive failures and the last error message when
  non-zero.
- Control: "Warn when no email for N days" (the `ingest_silence_days`
  setting), following the existing autosave settings-page pattern.

### `lib/`

Per the repo convention, decision/format logic is pure and unit-tested:

- `lib/ingestHealth.ts` — relative-time formatting ("2 h ago", "3 d ago") and
  banner-message selection from `reasons`. Co-located `*.test.ts`.

## Testing

- **Go, `internal/ingest`:** health snapshot under scripted dialer
  failures/successes — counts, reset-on-success, zero-values before first
  poll, shutdown cancellation not counted as failure.
- **Go, `internal/server`:** table-tests for `deriveIngestStatus` covering
  each reason, boundary times, `starting`, and `off`; handler test asserting
  the JSON shape; settings round-trip for `ingest_silence_days`.
- **Frontend:** `lib/ingestHealth` formatter/selector tests; banner
  shows-on-warn / hidden-on-ok / dismiss-and-reappear-on-reason-change tests;
  status page render test with mocked query data.

## Non-goals

- No push or SSE notification on unhealthy transitions.
- No persistence of poll history (no charts of uptime).
- No changes to drift monitoring (separate, per-sender parse quality).
- No changes to ingest behavior itself — health is observe-only.

## Build note

Frontend changes require rebuilding `frontend` and the embedded
`internal/web/dist` before `go build` (committed artifact; re-check `main`
first — parallel sessions).
