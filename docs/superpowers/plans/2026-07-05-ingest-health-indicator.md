# Ingest Health Indicator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface ingest failures in the PWA — silent when healthy: a warning banner appears app-wide only when ingest looks broken, and a Settings → "Email ingest" page shows full detail (last email, last successful poll, errors, configurable silence threshold).

**Architecture:** The ingest `Worker` keeps a mutex-guarded in-memory `HealthSnapshot` updated after every poll. The server combines it with `LastIngestAt()` and a new `ingest_silence_days` app setting in a pure `deriveIngestStatus` function, and reports `status` + `reasons` in the existing `GET /api/health` ingest block. The frontend polls that endpoint via a `useIngestHealth` react-query hook; `AppShell` shows a dismissable banner on `warn`, and a new Settings drill-in page shows facts + the threshold control. Spec: `docs/superpowers/specs/2026-07-05-ingest-health-indicator-design.md`.

**Tech Stack:** Go stdlib (`net/http` method+pattern routing), pure-Go SQLite (`modernc.org/sqlite`), React 18 + TypeScript + TanStack Query + vitest.

## Global Constraints

- **In-app only.** No push, no SSE for health. Health is observe-only — never change ingest behavior.
- Money rules are untouched by this plan; never touch money code.
- Schema changes are additive only: `addColumnIfMissing` in `internal/store/store.go` (`migrate`). No migration tool. Do NOT edit `schema.sql` for the new column — follow the `amount_aed` precedent (column added only via `migrate`).
- Frontend vitest is pinned to a single non-parallel fork in `vite.config.ts` (`fileParallelism: false`, `singleFork: true`) — do not change.
- Frontend convention: decision/format logic goes in pure `lib/` functions with co-located `*.test.ts`.
- Run Go tests per package: `go test ./internal/<pkg>/`. Known sandbox false failure: `go test ./internal/config/` fails `TestAIConfigEnabledRequiresAPIKey` because `LEDGER_AI_API_KEY` is set in this environment — ignore that one failure only.
- Frontend tests: `cd frontend && bunx vitest run <file>` for one file, `bun run test` for all.
- `internal/web/dist/` is a **committed** build artifact. Rebuild it (Task 7) after frontend changes; before rebuilding, re-check `main` for parallel-session commits (`git pull --rebase` if remote exists, else `git log` sanity check).
- Production runs on this same box as systemd unit `ledger` on `127.0.0.1:8080` — never bind test servers to 8080.
- Reason keys (exact strings everywhere): `polls_failing`, `poll_stale`, `mail_silent`. Status values: `ok`, `warn`, `starting`, `off`.
- Thresholds: polls_failing = `ConsecutiveFailures >= 3` AND (>15 min since last success OR no success ever); staleness window = `max(3 × poll interval, 5 min)`; mail_silent = last email older than `ingest_silence_days` days (only when at least one email was ever ingested).

---

### Task 1: Worker health snapshot (`internal/ingest`)

**Files:**
- Modify: `internal/ingest/ingest.go`
- Create: `internal/ingest/health_test.go`

**Interfaces:**
- Consumes: existing `Worker`, `fakeDialer`/`mailboxWith`/`newTestStore`/`quietLogger` test helpers in `internal/ingest/ingest_test.go`.
- Produces: `type HealthSnapshot struct { StartedAt, LastAttemptAt, LastSuccessAt time.Time; ConsecutiveFailures int; LastError string; Interval time.Duration }` and `func (w *Worker) Health() HealthSnapshot`. Task 3 imports both.

- [ ] **Step 1: Write the failing test**

Create `internal/ingest/health_test.go` (helpers `fakeDialer`, `mailboxWith`, `msg`, `newTestStore`, `quietLogger` already exist in `ingest_test.go`, same package):

```go
package ingest

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

func TestHealthBeforeFirstPoll(t *testing.T) {
	w := New(&fakeDialer{mb: mailboxWith(1)}, newTestStore(t), time.Minute, quietLogger())
	h := w.Health()
	if !h.LastAttemptAt.IsZero() || !h.LastSuccessAt.IsZero() {
		t.Errorf("expected zero attempt/success before first poll, got %+v", h)
	}
	if h.StartedAt.IsZero() {
		t.Error("StartedAt should be set at construction")
	}
	if h.Interval != time.Minute {
		t.Errorf("Interval = %s, want 1m", h.Interval)
	}
}

func TestHealthRecordsSuccessFailureAndRecovery(t *testing.T) {
	d := &fakeDialer{mb: mailboxWith(1, msg(100, "a@bank.com"))}
	w := New(d, newTestStore(t), time.Minute, quietLogger())
	w.now = func() time.Time { return time.Date(2026, 7, 5, 10, 0, 0, 0, time.UTC) }

	if _, err := w.pollOnce(context.Background()); err != nil {
		t.Fatalf("pollOnce: %v", err)
	}
	h := w.Health()
	if h.LastSuccessAt.IsZero() || h.ConsecutiveFailures != 0 || h.LastError != "" {
		t.Errorf("after success: %+v", h)
	}
	firstSuccess := h.LastSuccessAt

	d.dialErr = errors.New("imap login failed")
	w.pollOnce(context.Background())
	w.pollOnce(context.Background())
	h = w.Health()
	if h.ConsecutiveFailures != 2 {
		t.Errorf("failures = %d, want 2", h.ConsecutiveFailures)
	}
	if !strings.Contains(h.LastError, "imap login failed") {
		t.Errorf("LastError = %q, want dial error", h.LastError)
	}
	if !h.LastSuccessAt.Equal(firstSuccess) {
		t.Errorf("LastSuccessAt moved on failure: %s", h.LastSuccessAt)
	}

	d.dialErr = nil
	w.pollOnce(context.Background())
	h = w.Health()
	if h.ConsecutiveFailures != 0 || h.LastError != "" {
		t.Errorf("after recovery: %+v", h)
	}
}

func TestHealthIgnoresCancelledContext(t *testing.T) {
	w := New(&fakeDialer{mb: mailboxWith(1)}, newTestStore(t), time.Minute, quietLogger())
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	w.pollOnce(ctx)
	if h := w.Health(); !h.LastAttemptAt.IsZero() {
		t.Errorf("cancelled poll must not be recorded as a failure: %+v", h)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/ingest/ -run TestHealth -v`
Expected: FAIL — `w.Health undefined`, `w.pollOnce undefined`.

- [ ] **Step 3: Implement snapshot, recording, and `pollOnce`**

In `internal/ingest/ingest.go`:

Add `"sync"` to imports. After the `Message` type, add:

```go
// HealthSnapshot is a point-in-time view of the worker's polling health,
// read by /api/health. All state is in-memory: it rebuilds within one poll
// of a restart, so it is deliberately not persisted.
type HealthSnapshot struct {
	StartedAt           time.Time     // when the worker was constructed; anchors the "starting" grace window
	LastAttemptAt       time.Time     // zero until the first poll completes or fails
	LastSuccessAt       time.Time     // zero until the first successful poll
	ConsecutiveFailures int
	LastError           string // "" when the last poll succeeded
	Interval            time.Duration
}
```

Add two fields to `Worker`:

```go
	healthMu    sync.Mutex
	health      HealthSnapshot
```

In `New`, initialize the snapshot (add before the `return`… i.e. build the struct then set health):

```go
func New(d Dialer, st *store.Store, interval time.Duration, logger *log.Logger) *Worker {
	w := &Worker{
		dialer:   d,
		store:    st,
		interval: interval,
		log:      logger,
		now:      time.Now,
	}
	w.health = HealthSnapshot{StartedAt: w.now().UTC(), Interval: interval}
	return w
}
```

Add after `SetPostProcess`:

```go
// Health returns a copy of the current poll-health snapshot. Safe for
// concurrent use with the polling loop.
func (w *Worker) Health() HealthSnapshot {
	w.healthMu.Lock()
	defer w.healthMu.Unlock()
	return w.health
}

// recordPoll updates the snapshot after one poll. A success resets the
// failure streak and error; a failure increments the streak.
func (w *Worker) recordPoll(err error) {
	w.healthMu.Lock()
	defer w.healthMu.Unlock()
	now := w.now().UTC()
	w.health.LastAttemptAt = now
	if err == nil {
		w.health.LastSuccessAt = now
		w.health.ConsecutiveFailures = 0
		w.health.LastError = ""
		return
	}
	w.health.ConsecutiveFailures++
	w.health.LastError = err.Error()
}

// pollOnce runs one sync and records its outcome in the health snapshot.
// Shutdown cancellation is not recorded — it is not a mailbox failure.
func (w *Worker) pollOnce(ctx context.Context) (int, error) {
	n, err := w.syncOnce(ctx)
	if ctx.Err() == nil {
		w.recordPoll(err)
	}
	return n, err
}
```

In `Run`, change the call `w.syncOnce(ctx)` to `w.pollOnce(ctx)` (one line; the surrounding switch is unchanged).

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./internal/ingest/ -v`
Expected: PASS (all package tests, including the pre-existing ones that call `syncOnce` directly).

- [ ] **Step 5: Commit**

```bash
git add internal/ingest/ingest.go internal/ingest/health_test.go
git commit -m "feat(ingest): track poll-health snapshot on the worker"
```

---

### Task 2: `ingest_silence_days` setting (store + settings API)

**Files:**
- Modify: `internal/store/store.go` (the `migrate` function)
- Modify: `internal/store/settings.go`
- Modify: `internal/store/settings_test.go`
- Modify: `internal/server/settings.go`
- Modify: `internal/server/settings_test.go`

**Interfaces:**
- Consumes: `addColumnIfMissing(db, table, column, ddl)` in `internal/store/store.go`; existing `AppSettings` struct and `settingsDTO`.
- Produces: `store.AppSettings.IngestSilenceDays int` (default 3) and the `ingest_silence_days` JSON field on `GET/PUT /api/settings`. Tasks 3 and 6 rely on both.

- [ ] **Step 1: Write the failing store test**

In `internal/store/settings_test.go`, append:

```go
func TestAppSettingsIngestSilenceDays(t *testing.T) {
	st := openTestStore(t)
	if err := st.EnsureAppSettings(); err != nil {
		t.Fatalf("ensure: %v", err)
	}
	got, err := st.SelectAppSettings()
	if err != nil {
		t.Fatalf("select: %v", err)
	}
	if got.IngestSilenceDays != 3 {
		t.Fatalf("default IngestSilenceDays = %d, want 3", got.IngestSilenceDays)
	}
	got.IngestSilenceDays = 7
	if err := st.UpdateAppSettings(got); err != nil {
		t.Fatalf("update: %v", err)
	}
	got2, _ := st.SelectAppSettings()
	if got2.IngestSilenceDays != 7 {
		t.Fatalf("round-trip IngestSilenceDays = %d, want 7", got2.IngestSilenceDays)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/store/ -run TestAppSettingsIngestSilenceDays -v`
Expected: FAIL — `got.IngestSilenceDays undefined`.

- [ ] **Step 3: Implement the store side**

In `internal/store/store.go`, `migrate` currently ends with:

```go
	// AED snapshot of amount; NULL when the currency has no fx rate yet.
	return addColumnIfMissing(db, "transactions", "amount_aed", "INTEGER")
```

Change to:

```go
	// AED snapshot of amount; NULL when the currency has no fx rate yet.
	if err := addColumnIfMissing(db, "transactions", "amount_aed", "INTEGER"); err != nil {
		return err
	}
	// Days of mailbox silence before /api/health reports mail_silent.
	return addColumnIfMissing(db, "app_settings", "ingest_silence_days", "INTEGER NOT NULL DEFAULT 3")
```

In `internal/store/settings.go`:

```go
// AppSettings is the singleton app_settings row controlling categorization
// and ingest-health thresholds.
type AppSettings struct {
	AutoCategorize    bool
	AIEnabled         bool
	AIAutoAccept      bool
	AIThreshold       float64
	IngestSilenceDays int
}
```

`EnsureAppSettings` stays as-is (the column's `DEFAULT 3` covers the insert). Update the queries:

```go
// SelectAppSettings reads the singleton row.
func (s *Store) SelectAppSettings() (AppSettings, error) {
	var a AppSettings
	var auto, aiOn, aiAccept int
	err := s.DB.QueryRow(
		`SELECT auto_categorize, ai_enabled, ai_auto_accept, ai_threshold, ingest_silence_days
		 FROM app_settings WHERE id=1`,
	).Scan(&auto, &aiOn, &aiAccept, &a.AIThreshold, &a.IngestSilenceDays)
	a.AutoCategorize = auto == 1
	a.AIEnabled = aiOn == 1
	a.AIAutoAccept = aiAccept == 1
	return a, err
}

// UpdateAppSettings overwrites the singleton row.
func (s *Store) UpdateAppSettings(a AppSettings) error {
	_, err := s.DB.Exec(
		`UPDATE app_settings
		   SET auto_categorize=?, ai_enabled=?, ai_auto_accept=?, ai_threshold=?, ingest_silence_days=?
		 WHERE id=1`,
		boolToInt(a.AutoCategorize), boolToInt(a.AIEnabled), boolToInt(a.AIAutoAccept), a.AIThreshold, a.IngestSilenceDays,
	)
	return err
}
```

- [ ] **Step 4: Run store tests**

Run: `go test ./internal/store/ -v -run TestAppSettings`
Expected: PASS (both the new test and `TestAppSettingsRoundTrip`).

- [ ] **Step 5: Write the failing server settings tests**

In `internal/server/settings_test.go`, append:

```go
func TestSettingsIngestSilenceDaysRoundTrip(t *testing.T) {
	stub := &stubSettings{s: store.AppSettings{AIThreshold: 0.85, IngestSilenceDays: 3}}
	srv := New(nil, fstest())
	srv.SetSettingsStore(stub)

	body := `{"auto_categorize":true,"ai_enabled":false,"ai_auto_accept":false,"ai_threshold":0.85,"ingest_silence_days":7}`
	req := httptest.NewRequest("PUT", "/api/settings", strings.NewReader(body))
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("code=%d body=%s", rec.Code, rec.Body.String())
	}
	if stub.s.IngestSilenceDays != 7 {
		t.Fatalf("IngestSilenceDays=%d, want 7", stub.s.IngestSilenceDays)
	}

	req = httptest.NewRequest("GET", "/api/settings", nil)
	rec = httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	var got map[string]any
	json.Unmarshal(rec.Body.Bytes(), &got)
	if got["ingest_silence_days"] != float64(7) {
		t.Fatalf("GET ingest_silence_days=%v, want 7: %s", got["ingest_silence_days"], rec.Body.String())
	}
}

// A PUT that omits ingest_silence_days (older client) must not clobber the
// stored value back to the default.
func TestPutSettingsOmittedSilenceDaysPreserved(t *testing.T) {
	stub := &stubSettings{s: store.AppSettings{AIThreshold: 0.85, IngestSilenceDays: 7}}
	srv := New(nil, fstest())
	srv.SetSettingsStore(stub)

	body := `{"auto_categorize":true,"ai_enabled":false,"ai_auto_accept":false,"ai_threshold":0.85}`
	req := httptest.NewRequest("PUT", "/api/settings", strings.NewReader(body))
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("code=%d body=%s", rec.Code, rec.Body.String())
	}
	if stub.s.IngestSilenceDays != 7 {
		t.Fatalf("IngestSilenceDays=%d, want preserved 7", stub.s.IngestSilenceDays)
	}
}
```

- [ ] **Step 6: Run to verify they fail**

Run: `go test ./internal/server/ -run TestSettingsIngestSilenceDaysRoundTrip -v`
Expected: FAIL — `ingest_silence_days` missing from GET body / not stored.

- [ ] **Step 7: Implement the server side**

In `internal/server/settings.go`, extend the DTO:

```go
type settingsDTO struct {
	AutoCategorize    bool    `json:"auto_categorize"`
	AIEnabled         bool    `json:"ai_enabled"`
	AIAutoAccept      bool    `json:"ai_auto_accept"`
	AIThreshold       float64 `json:"ai_threshold"`
	IngestSilenceDays int     `json:"ingest_silence_days"`
	// AIKeyPresent is read-only output: whether an Anthropic key is loaded
	// (env-only). It is ignored on PUT.
	AIKeyPresent bool `json:"ai_key_present"`
}
```

In `handleGetSettings`, add `IngestSilenceDays: a.IngestSilenceDays,` to the encoded DTO literal.

In `handlePutSettings`, after the threshold clamp, add:

```go
	if dto.IngestSilenceDays < 1 {
		// Omitted (older client) or invalid: preserve the stored value.
		if cur, err := s.settingsStore.SelectAppSettings(); err == nil && cur.IngestSilenceDays >= 1 {
			dto.IngestSilenceDays = cur.IngestSilenceDays
		} else {
			dto.IngestSilenceDays = 3
		}
	}
```

and add `IngestSilenceDays: dto.IngestSilenceDays,` to the `store.AppSettings{...}` literal passed to `UpdateAppSettings`.

- [ ] **Step 8: Run tests**

Run: `go test ./internal/server/ -run TestSettings -v && go test ./internal/server/ -run TestPutSettings -v`
Expected: PASS (new tests plus all pre-existing settings tests).

- [ ] **Step 9: Commit**

```bash
git add internal/store/store.go internal/store/settings.go internal/store/settings_test.go internal/server/settings.go internal/server/settings_test.go
git commit -m "feat(settings): ingest_silence_days threshold (store + API, additive column)"
```

---

### Task 3: Status derivation + enriched `/api/health` + wiring

**Files:**
- Create: `internal/server/ingesthealth.go`
- Create: `internal/server/ingesthealth_test.go`
- Modify: `internal/server/server.go` (one field + nothing else)
- Modify: `internal/server/health.go`
- Modify: `cmd/ledger/main.go` (one line)

**Interfaces:**
- Consumes: `ingest.HealthSnapshot` and `(*ingest.Worker).Health` from Task 1; `AppSettings.IngestSilenceDays` from Task 2; existing `s.settingsStore`, `s.ingest`, `s.imapConfigured`.
- Produces: `func (s *Server) SetIngestHealth(fn IngestHealthFunc)` with `type IngestHealthFunc func() ingest.HealthSnapshot`; the enriched JSON ingest block on `GET /api/health` (fields: `status`, `reasons`, `last_poll_success_at`, `last_poll_attempt_at`, `consecutive_failures`, `last_error`, `poll_interval_seconds`, `silence_days`). Tasks 4–6 consume the JSON.

- [ ] **Step 1: Write the failing derivation tests**

Create `internal/server/ingesthealth_test.go`:

```go
package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"
	"time"

	"ledger/internal/ingest"
)

var t0 = time.Date(2026, 7, 5, 12, 0, 0, 0, time.UTC)

func snap(mod func(*ingest.HealthSnapshot)) ingest.HealthSnapshot {
	// Baseline: healthy worker, 60s interval, started an hour ago,
	// successful poll one minute ago.
	s := ingest.HealthSnapshot{
		StartedAt:     t0.Add(-time.Hour),
		LastAttemptAt: t0.Add(-time.Minute),
		LastSuccessAt: t0.Add(-time.Minute),
		Interval:      time.Minute,
	}
	if mod != nil {
		mod(&s)
	}
	return s
}

func TestDeriveIngestStatus(t *testing.T) {
	cases := []struct {
		name        string
		snap        ingest.HealthSnapshot
		lastMail    time.Time
		haveMail    bool
		silenceDays int
		wantStatus  string
		wantReasons []string
	}{
		{
			name: "healthy", snap: snap(nil),
			lastMail: t0.Add(-2 * time.Hour), haveMail: true, silenceDays: 3,
			wantStatus: "ok", wantReasons: []string{},
		},
		{
			name: "starting within grace",
			snap: snap(func(s *ingest.HealthSnapshot) {
				s.StartedAt = t0.Add(-time.Minute)
				s.LastAttemptAt = time.Time{}
				s.LastSuccessAt = time.Time{}
			}),
			haveMail: false, silenceDays: 3,
			wantStatus: "starting", wantReasons: []string{},
		},
		{
			name: "starting expired becomes poll_stale (hung first poll)",
			snap: snap(func(s *ingest.HealthSnapshot) {
				s.StartedAt = t0.Add(-time.Hour)
				s.LastAttemptAt = time.Time{}
				s.LastSuccessAt = time.Time{}
			}),
			haveMail: false, silenceDays: 3,
			wantStatus: "warn", wantReasons: []string{"poll_stale"},
		},
		{
			name: "polls failing after streak and 15m",
			snap: snap(func(s *ingest.HealthSnapshot) {
				s.ConsecutiveFailures = 3
				s.LastSuccessAt = t0.Add(-20 * time.Minute)
				s.LastAttemptAt = t0.Add(-time.Minute)
			}),
			lastMail: t0.Add(-2 * time.Hour), haveMail: true, silenceDays: 3,
			wantStatus: "warn", wantReasons: []string{"polls_failing", "poll_stale"},
		},
		{
			name: "failure streak with recent success is stale but not polls_failing",
			snap: snap(func(s *ingest.HealthSnapshot) {
				s.ConsecutiveFailures = 3
				s.LastSuccessAt = t0.Add(-10 * time.Minute)
			}),
			lastMail: t0.Add(-2 * time.Hour), haveMail: true, silenceDays: 3,
			// 10m > 3×interval(=5m min window)? window = max(3m, 5m) = 5m → stale.
			wantStatus: "warn", wantReasons: []string{"poll_stale"},
		},
		{
			name: "two failures below streak threshold",
			snap: snap(func(s *ingest.HealthSnapshot) {
				s.ConsecutiveFailures = 2
				s.LastError = "dial: timeout"
			}),
			lastMail: t0.Add(-2 * time.Hour), haveMail: true, silenceDays: 3,
			wantStatus: "ok", wantReasons: []string{},
		},
		{
			name: "mail silent",
			snap: snap(nil),
			lastMail: t0.Add(-4 * 24 * time.Hour), haveMail: true, silenceDays: 3,
			wantStatus: "warn", wantReasons: []string{"mail_silent"},
		},
		{
			name: "no mail ever does not fire mail_silent",
			snap: snap(nil),
			haveMail: false, silenceDays: 3,
			wantStatus: "ok", wantReasons: []string{},
		},
		{
			name: "custom silence threshold respected",
			snap: snap(nil),
			lastMail: t0.Add(-4 * 24 * time.Hour), haveMail: true, silenceDays: 7,
			wantStatus: "ok", wantReasons: []string{},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			status, reasons := deriveIngestStatus(tc.snap, tc.lastMail, tc.haveMail, tc.silenceDays, t0)
			if status != tc.wantStatus || !reflect.DeepEqual(reasons, tc.wantReasons) {
				t.Errorf("got (%s, %v), want (%s, %v)", status, reasons, tc.wantStatus, tc.wantReasons)
			}
		})
	}
}

func TestHealthEndpointReportsIngestStatus(t *testing.T) {
	srv := New(fakeChecker{err: nil}, testFS())
	srv.SetIngest(fakeIngest{count: 9, last: t0.Add(-2 * time.Hour), ok: true}, true)
	srv.SetIngestHealth(func() ingest.HealthSnapshot {
		return ingest.HealthSnapshot{
			StartedAt:           time.Now().UTC().Add(-time.Hour),
			LastAttemptAt:       time.Now().UTC().Add(-30 * time.Second),
			LastSuccessAt:       time.Now().UTC().Add(-30 * time.Second),
			ConsecutiveFailures: 0,
			Interval:            time.Minute,
		}
	})

	req := httptest.NewRequest(http.MethodGet, "/api/health", nil)
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)

	var body struct {
		Ingest *struct {
			Status              string   `json:"status"`
			Reasons             []string `json:"reasons"`
			LastPollSuccessAt   string   `json:"last_poll_success_at"`
			ConsecutiveFailures int      `json:"consecutive_failures"`
			PollIntervalSeconds int      `json:"poll_interval_seconds"`
			SilenceDays         int      `json:"silence_days"`
		} `json:"ingest"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body.Ingest == nil {
		t.Fatal("expected ingest section")
	}
	if body.Ingest.Status != "ok" {
		t.Errorf("status = %q, want ok (body=%s)", body.Ingest.Status, rec.Body.String())
	}
	if body.Ingest.Reasons == nil {
		t.Error("reasons must be [] not null")
	}
	if body.Ingest.LastPollSuccessAt == "" {
		t.Error("last_poll_success_at missing")
	}
	if body.Ingest.PollIntervalSeconds != 60 {
		t.Errorf("poll_interval_seconds = %d, want 60", body.Ingest.PollIntervalSeconds)
	}
	if body.Ingest.SilenceDays != 3 {
		t.Errorf("silence_days = %d, want default 3 (no settings store wired)", body.Ingest.SilenceDays)
	}
}

func TestHealthEndpointOffWhenNotConfigured(t *testing.T) {
	srv := New(fakeChecker{err: nil}, testFS())
	srv.SetIngest(fakeIngest{count: 0}, false)

	req := httptest.NewRequest(http.MethodGet, "/api/health", nil)
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)

	var body struct {
		Ingest *struct {
			Status string `json:"status"`
		} `json:"ingest"`
	}
	json.Unmarshal(rec.Body.Bytes(), &body)
	if body.Ingest == nil || body.Ingest.Status != "off" {
		t.Fatalf("want ingest.status=off, body=%s", rec.Body.String())
	}
}
```

- [ ] **Step 2: Run to verify failure**

Run: `go test ./internal/server/ -run 'TestDeriveIngestStatus|TestHealthEndpoint' -v`
Expected: FAIL — `deriveIngestStatus` and `SetIngestHealth` undefined.

- [ ] **Step 3: Implement derivation + setter**

Create `internal/server/ingesthealth.go`:

```go
package server

import (
	"time"

	"ledger/internal/ingest"
)

// IngestHealthFunc returns the ingest worker's current poll-health snapshot.
type IngestHealthFunc func() ingest.HealthSnapshot

// SetIngestHealth wires the worker's health snapshot into /api/health.
func (s *Server) SetIngestHealth(fn IngestHealthFunc) { s.ingestHealthFn = fn }

// Reason keys reported for a warn status. The PWA switches copy on these.
const (
	reasonPollsFailing = "polls_failing"
	reasonPollStale    = "poll_stale"
	reasonMailSilent   = "mail_silent"
)

// deriveIngestStatus turns the worker snapshot + mail recency into the
// verdict the PWA renders. Pure: table-tested without HTTP.
//
//   - polls_failing: ≥3 consecutive failures and no success in 15 min
//     (or no success ever) — IMAP auth/network is broken.
//   - poll_stale: no successful poll in max(3×interval, 5 min); anchors on
//     worker start when no poll ever succeeded (covers a hung first poll).
//   - mail_silent: polls fine but no email in silenceDays days — catches a
//     broken auto-forward rule. Never fires before the first email ever.
func deriveIngestStatus(snap ingest.HealthSnapshot, lastMailAt time.Time, haveMail bool, silenceDays int, now time.Time) (string, []string) {
	reasons := []string{}

	window := 3 * snap.Interval
	if window < 5*time.Minute {
		window = 5 * time.Minute
	}

	if snap.LastAttemptAt.IsZero() && now.Sub(snap.StartedAt) <= window {
		return "starting", reasons
	}

	if snap.ConsecutiveFailures >= 3 &&
		(snap.LastSuccessAt.IsZero() || now.Sub(snap.LastSuccessAt) > 15*time.Minute) {
		reasons = append(reasons, reasonPollsFailing)
	}

	anchor := snap.LastSuccessAt
	if anchor.IsZero() {
		anchor = snap.StartedAt
	}
	if now.Sub(anchor) > window {
		reasons = append(reasons, reasonPollStale)
	}

	if haveMail && now.Sub(lastMailAt) > time.Duration(silenceDays)*24*time.Hour {
		reasons = append(reasons, reasonMailSilent)
	}

	if len(reasons) > 0 {
		return "warn", reasons
	}
	return "ok", reasons
}
```

In `internal/server/server.go`, add one field to the `Server` struct (after `driftMon`):

```go
	ingestHealthFn  IngestHealthFunc    // optional worker poll-health for /api/health
```

- [ ] **Step 4: Enrich the health handler**

In `internal/server/health.go`, replace the `ingestHealth` type and the ingest block of `handleHealth`:

```go
type ingestHealth struct {
	Configured          bool     `json:"configured"`
	Count               int      `json:"count"`
	LastAt              string   `json:"last_at,omitempty"`
	Status              string   `json:"status"`
	Reasons             []string `json:"reasons"`
	LastPollSuccessAt   string   `json:"last_poll_success_at,omitempty"`
	LastPollAttemptAt   string   `json:"last_poll_attempt_at,omitempty"`
	ConsecutiveFailures int      `json:"consecutive_failures"`
	LastError           string   `json:"last_error,omitempty"`
	PollIntervalSeconds int      `json:"poll_interval_seconds"`
	SilenceDays         int      `json:"silence_days"`
}
```

and in `handleHealth`, replace the existing `if s.ingest != nil { ... }` block with:

```go
	if s.ingest != nil {
		ih := &ingestHealth{Configured: s.imapConfigured, Status: "off", Reasons: []string{}}
		if count, err := s.ingest.CountIngest(); err == nil {
			ih.Count = count
		}
		var lastMail time.Time
		haveMail := false
		if at, ok, err := s.ingest.LastIngestAt(); err == nil && ok {
			lastMail, haveMail = at, true
			ih.LastAt = at.UTC().Format(time.RFC3339)
		}
		if s.imapConfigured && s.ingestHealthFn != nil {
			snap := s.ingestHealthFn()
			silence := 3
			if s.settingsStore != nil {
				if a, err := s.settingsStore.SelectAppSettings(); err == nil && a.IngestSilenceDays >= 1 {
					silence = a.IngestSilenceDays
				}
			}
			ih.Status, ih.Reasons = deriveIngestStatus(snap, lastMail, haveMail, silence, time.Now().UTC())
			if !snap.LastSuccessAt.IsZero() {
				ih.LastPollSuccessAt = snap.LastSuccessAt.UTC().Format(time.RFC3339)
			}
			if !snap.LastAttemptAt.IsZero() {
				ih.LastPollAttemptAt = snap.LastAttemptAt.UTC().Format(time.RFC3339)
			}
			ih.ConsecutiveFailures = snap.ConsecutiveFailures
			ih.LastError = snap.LastError
			ih.PollIntervalSeconds = int(snap.Interval / time.Second)
			ih.SilenceDays = silence
		}
		resp.Ingest = ih
	}
```

- [ ] **Step 5: Run server tests**

Run: `go test ./internal/server/ -v`
Expected: PASS — new tests plus all pre-existing ones (`TestHealthIncludesIngestWhenSet` still passes: it only asserts `configured` and `count`).

- [ ] **Step 6: Wire the worker in `main.go`**

In `cmd/ledger/main.go`, inside the `if cfg.IMAP.Enabled() { ... }` block, after `worker.SetPostProcess(...)` and before `go worker.Run(ctx)`, add:

```go
		srv.SetIngestHealth(worker.Health)
```

- [ ] **Step 7: Build + full Go suite**

Run: `CGO_ENABLED=0 go build -o /dev/null ./cmd/ledger && go test ./...`
Expected: build OK; all packages PASS except the known `internal/config` sandbox false failure (`TestAIConfigEnabledRequiresAPIKey` — ignore that one only).

- [ ] **Step 8: Commit**

```bash
git add internal/server/ingesthealth.go internal/server/ingesthealth_test.go internal/server/server.go internal/server/health.go cmd/ledger/main.go
git commit -m "feat(server): derive ingest health status on /api/health"
```

---

### Task 4: Frontend types, `lib/ingestHealth`, `useIngestHealth` hook

**Files:**
- Modify: `frontend/src/api/types.ts`
- Create: `frontend/src/lib/ingestHealth.ts`
- Create: `frontend/src/lib/ingestHealth.test.ts`
- Create: `frontend/src/hooks/useIngestHealth.ts`

**Interfaces:**
- Consumes: the `/api/health` JSON from Task 3; `getJSON` from `api/client`.
- Produces (used by Tasks 5–6):
  - types `IngestHealth`, `Health`; `AppSettings.ingest_silence_days: number`
  - `relTime(iso: string | undefined, now: Date): string`
  - `bannerMessage(h: IngestHealth, now: Date): string | null`
  - `reasonText(reason: string, h: IngestHealth): string`
  - `dismissKey(reasons: string[]): string`
  - `ingestStatusLabel(status: IngestHealth["status"]): string`
  - `useIngestHealth(): UseQueryResult<Health>`

- [ ] **Step 1: Add the types**

In `frontend/src/api/types.ts`, add `ingest_silence_days: number;` to `AppSettings` (after `ai_threshold`), and append:

```ts
export interface IngestHealth {
  configured: boolean;
  count: number;
  last_at?: string;
  status: "ok" | "warn" | "starting" | "off";
  reasons: string[];
  last_poll_success_at?: string;
  last_poll_attempt_at?: string;
  consecutive_failures: number;
  last_error?: string;
  poll_interval_seconds: number;
  silence_days: number;
}
export interface Health { status: string; db: string; ingest?: IngestHealth; }
```

- [ ] **Step 2: Write the failing lib test**

Create `frontend/src/lib/ingestHealth.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import type { IngestHealth } from "../api/types";
import { relTime, bannerMessage, dismissKey, ingestStatusLabel, reasonText } from "./ingestHealth";

const NOW = new Date("2026-07-05T12:00:00Z");

function health(overrides: Partial<IngestHealth> = {}): IngestHealth {
  return {
    configured: true, count: 10, last_at: "2026-07-05T10:00:00Z",
    status: "warn", reasons: ["poll_stale"],
    last_poll_success_at: "2026-07-05T11:00:00Z",
    last_poll_attempt_at: "2026-07-05T11:59:00Z",
    consecutive_failures: 0, poll_interval_seconds: 60, silence_days: 3,
    ...overrides,
  };
}

describe("relTime", () => {
  it("formats seconds/minutes/hours/days", () => {
    expect(relTime("2026-07-05T11:59:30Z", NOW)).toBe("just now");
    expect(relTime("2026-07-05T11:55:00Z", NOW)).toBe("5m ago");
    expect(relTime("2026-07-05T09:00:00Z", NOW)).toBe("3h ago");
    expect(relTime("2026-07-01T12:00:00Z", NOW)).toBe("4d ago");
  });
  it("handles missing and invalid values", () => {
    expect(relTime(undefined, NOW)).toBe("never");
    expect(relTime("garbage", NOW)).toBe("never");
  });
});

describe("bannerMessage", () => {
  it("is null when not warning", () => {
    expect(bannerMessage(health({ status: "ok", reasons: [] }), NOW)).toBeNull();
  });
  it("prioritizes polls_failing over the rest", () => {
    const h = health({ reasons: ["poll_stale", "polls_failing"], consecutive_failures: 4 });
    expect(bannerMessage(h, NOW)).toContain("failing");
    expect(bannerMessage(h, NOW)).toContain("4");
  });
  it("describes staleness with the last success time", () => {
    expect(bannerMessage(health(), NOW)).toContain("1h ago");
  });
  it("describes mail silence with the threshold", () => {
    const h = health({ reasons: ["mail_silent"], silence_days: 3 });
    expect(bannerMessage(h, NOW)).toContain("3 days");
  });
});

describe("dismissKey", () => {
  it("is order-independent", () => {
    expect(dismissKey(["b", "a"])).toBe(dismissKey(["a", "b"]));
  });
  it("differs for different reason sets", () => {
    expect(dismissKey(["poll_stale"])).not.toBe(dismissKey(["poll_stale", "mail_silent"]));
  });
});

describe("labels", () => {
  it("maps statuses to human labels", () => {
    expect(ingestStatusLabel("ok")).toBe("Healthy");
    expect(ingestStatusLabel("warn")).toBe("Warning");
    expect(ingestStatusLabel("starting")).toBe("Starting…");
    expect(ingestStatusLabel("off")).toBe("Off");
  });
  it("spells out each reason", () => {
    const h = health({ consecutive_failures: 5, silence_days: 3 });
    expect(reasonText("polls_failing", h)).toContain("5");
    expect(reasonText("poll_stale", h).length).toBeGreaterThan(0);
    expect(reasonText("mail_silent", h)).toContain("3 day");
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `cd frontend && bunx vitest run src/lib/ingestHealth.test.ts`
Expected: FAIL — module `./ingestHealth` not found.

- [ ] **Step 4: Implement the lib**

Create `frontend/src/lib/ingestHealth.ts`:

```ts
import type { IngestHealth } from "../api/types";

/** Compact relative time for health facts: "just now", "5m ago", "3h ago", "4d ago". */
export function relTime(iso: string | undefined, now: Date): string {
  if (!iso) return "never";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "never";
  const s = Math.max(0, Math.floor((now.getTime() - t) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

const dayWord = (n: number) => `${n} day${n === 1 ? "" : "s"}`;

/** One-line banner copy for a warn status; null when there is nothing to show.
 *  Hard failures (polls) outrank the soft mail-silence signal. */
export function bannerMessage(h: IngestHealth, now: Date): string | null {
  if (h.status !== "warn" || h.reasons.length === 0) return null;
  if (h.reasons.includes("polls_failing")) {
    return `Email checks failing (${h.consecutive_failures} in a row) — last success ${relTime(h.last_poll_success_at, now)}`;
  }
  if (h.reasons.includes("poll_stale")) {
    return `Email checks may be stuck — last success ${relTime(h.last_poll_success_at, now)}`;
  }
  return `No bank email in over ${dayWord(h.silence_days)} — check the forwarding rule`;
}

/** Plain-language explanation of one reason key, for the status page. */
export function reasonText(reason: string, h: IngestHealth): string {
  switch (reason) {
    case "polls_failing":
      return `Mailbox checks are failing (${h.consecutive_failures} in a row).`;
    case "poll_stale":
      return "No recent successful mailbox check — the worker may be stuck.";
    case "mail_silent":
      return `No bank email in over ${dayWord(h.silence_days)} — check the auto-forward rule.`;
    default:
      return reason;
  }
}

/** Stable key for "dismissed until the situation changes" banner state. */
export function dismissKey(reasons: string[]): string {
  return [...reasons].sort().join(",");
}

export function ingestStatusLabel(status: IngestHealth["status"]): string {
  switch (status) {
    case "ok": return "Healthy";
    case "warn": return "Warning";
    case "starting": return "Starting…";
    case "off": return "Off";
  }
}
```

Create `frontend/src/hooks/useIngestHealth.ts`:

```ts
import { useQuery } from "@tanstack/react-query";
import { getJSON } from "../api/client";
import type { Health } from "../api/types";

/** Polls /api/health so the banner notices problems while the app is open.
 *  refetchOnWindowFocus (react-query default) covers the reopen case. */
export function useIngestHealth() {
  return useQuery({
    queryKey: ["health"],
    queryFn: () => getJSON<Health>("/api/health"),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
}
```

- [ ] **Step 5: Run tests**

Run: `cd frontend && bunx vitest run src/lib/ingestHealth.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/api/types.ts frontend/src/lib/ingestHealth.ts frontend/src/lib/ingestHealth.test.ts frontend/src/hooks/useIngestHealth.ts
git commit -m "feat(web): ingest-health types, formatting lib, and polling hook"
```

---

### Task 5: Warning banner + AppShell/Settings navigation

**Files:**
- Create: `frontend/src/components/IngestHealthBanner.tsx`
- Create: `frontend/src/components/IngestHealthBanner.test.tsx`
- Modify: `frontend/src/app/AppShell.tsx`
- Modify: `frontend/src/screens/Settings.tsx`

**Interfaces:**
- Consumes: `useIngestHealth`, `bannerMessage`, `dismissKey` from Task 4; `SettingsPageId` from `screens/settings/SettingsHub`.
- Produces: `IngestHealthBanner({ onView })` component; `SettingsIntent { page: SettingsPageId; nonce: number }` exported from `Settings.tsx`; `Settings` accepts optional `intent` prop. This task also adds `"ingest"` to the `SettingsPageId` union (the banner needs the value); Task 6 adds the page component behind it. Until Task 6 lands, an `"ingest"` page value renders no drill-in — harmless.

- [ ] **Step 1: Write the failing banner test**

Create `frontend/src/components/IngestHealthBanner.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { IngestHealthBanner } from "./IngestHealthBanner";

function healthPayload(ingest: object | null) {
  return { status: "ok", db: "ok", ...(ingest ? { ingest } : {}) };
}

const warnIngest = {
  configured: true, count: 5, last_at: "2026-07-05T08:00:00Z",
  status: "warn", reasons: ["poll_stale"],
  last_poll_success_at: "2026-07-05T06:00:00Z",
  last_poll_attempt_at: "2026-07-05T09:00:00Z",
  consecutive_failures: 0, poll_interval_seconds: 60, silence_days: 3,
};

function renderBanner(payload: unknown, onView = () => {}) {
  vi.stubGlobal("fetch", vi.fn(async () =>
    new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } }),
  ));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <IngestHealthBanner onView={onView} />
    </QueryClientProvider>,
  );
}

beforeEach(() => sessionStorage.clear());

describe("IngestHealthBanner", () => {
  it("renders nothing when healthy", async () => {
    renderBanner(healthPayload({ ...warnIngest, status: "ok", reasons: [] }));
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows a warning and navigates on tap", async () => {
    const onView = vi.fn();
    renderBanner(healthPayload(warnIngest), onView);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/stuck|failing|no bank email/i);
    fireEvent.click(screen.getByRole("button", { name: /details/i }));
    expect(onView).toHaveBeenCalled();
  });

  it("dismisses and stays dismissed for the same reasons", async () => {
    const view = renderBanner(healthPayload(warnIngest));
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));
    expect(screen.queryByRole("alert")).toBeNull();
    // Re-mount with the same warn payload: still dismissed (sessionStorage).
    view.unmount();
    renderBanner(healthPayload(warnIngest));
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("reappears when the reason set changes", async () => {
    const view = renderBanner(healthPayload(warnIngest));
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));
    view.unmount();
    renderBanner(healthPayload({ ...warnIngest, reasons: ["poll_stale", "mail_silent"] }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && bunx vitest run src/components/IngestHealthBanner.test.tsx`
Expected: FAIL — module `./IngestHealthBanner` not found.

- [ ] **Step 3: Implement the banner**

Create `frontend/src/components/IngestHealthBanner.tsx`:

```tsx
import { useEffect, useState } from "react";
import { TriangleAlert, X } from "lucide-react";
import { useIngestHealth } from "../hooks/useIngestHealth";
import { bannerMessage, dismissKey } from "../lib/ingestHealth";

const STORAGE_KEY = "ingest-banner-dismissed";

/** App-wide warning strip, visible only when ingest looks broken. Dismissal
 *  sticks (sessionStorage) until the reason set changes or health recovers. */
export function IngestHealthBanner({ onView }: { onView: () => void }) {
  const { data } = useIngestHealth();
  const [dismissed, setDismissed] = useState<string | null>(
    () => sessionStorage.getItem(STORAGE_KEY),
  );
  const ih = data?.ingest;

  // Recovery clears the dismissal so the next (identical) warning shows again.
  useEffect(() => {
    if (ih && ih.status === "ok" && dismissed !== null) {
      sessionStorage.removeItem(STORAGE_KEY);
      setDismissed(null);
    }
  }, [ih, dismissed]);

  if (!ih || ih.status !== "warn") return null;
  const key = dismissKey(ih.reasons);
  if (dismissed === key) return null;
  const msg = bannerMessage(ih, new Date());
  if (!msg) return null;

  const dismiss = () => {
    sessionStorage.setItem(STORAGE_KEY, key);
    setDismissed(key);
  };

  return (
    <div role="alert" className="shrink-0 bg-warn/15 text-warn text-sm flex items-center gap-2 pl-3 pr-1">
      <TriangleAlert size={14} aria-hidden className="shrink-0" />
      <button aria-label="Ingest details" onClick={onView} className="flex-1 text-left py-1 truncate">
        {msg}
      </button>
      <button aria-label="Dismiss" onClick={dismiss} className="shrink-0 p-1.5 press">
        <X size={14} aria-hidden />
      </button>
    </div>
  );
}
```

- [ ] **Step 4: Run banner tests**

Run: `cd frontend && bunx vitest run src/components/IngestHealthBanner.test.tsx`
Expected: PASS.

- [ ] **Step 5: Wire into AppShell + Settings intent**

In `frontend/src/screens/settings/SettingsHub.tsx`, add `"ingest"` to the union:

```ts
export type SettingsPageId =
  | "budget"
  | "categorization"
  | "swipe"
  | "currencies"
  | "categories"
  | "rules"
  | "textsize"
  | "ingest";
```

In `frontend/src/screens/Settings.tsx`:

- Add to imports: `import { useEffect, useState } from "react";` (replacing the existing `useState`-only import).
- Export the intent type and accept the prop:

```tsx
/** Cross-tab deep link into a settings drill-in (e.g. banner → Email ingest).
 *  nonce forces re-navigation when Settings is already mounted. */
export interface SettingsIntent { page: SettingsPageId; nonce: number }

export function Settings({ scope, intent }: { scope?: Scope; intent?: SettingsIntent | null }) {
```

- Inside the component, after the `page` state declaration:

```tsx
  useEffect(() => {
    if (intent) setPage(intent.page);
  }, [intent]);
```

In `frontend/src/app/AppShell.tsx`:

- Imports: add

```tsx
import { IngestHealthBanner } from "../components/IngestHealthBanner";
import type { SettingsIntent } from "../screens/Settings";
```

- State, next to `tab`:

```tsx
  const [settingsIntent, setSettingsIntent] = useState<SettingsIntent | null>(null);
  const openIngestHealth = () => {
    setSettingsIntent((p) => ({ page: "ingest", nonce: (p?.nonce ?? 0) + 1 }));
    setTab("settings");
  };
```

- Render the banner directly under the offline banner:

```tsx
      {!online && (
        <div role="status" className="shrink-0 bg-warn/15 text-warn text-sm text-center py-1">Offline — showing last loaded data</div>
      )}
      <IngestHealthBanner onView={openIngestHealth} />
```

- Pass the intent: change `{tab === "settings" && <Settings scope={scope} />}` to `{tab === "settings" && <Settings scope={scope} intent={settingsIntent} />}`.

- [ ] **Step 6: Run the shell + settings tests**

Run: `cd frontend && bunx vitest run src/app/AppShell.test.tsx src/screens/Settings.test.tsx src/components/IngestHealthBanner.test.tsx`
Expected: PASS. (AppShell's fetch stub returns `[]` for unknown URLs, so `/api/health` yields no `ingest` field and the banner stays hidden — no stub changes needed.)

- [ ] **Step 7: Commit**

```bash
git add frontend/src/components/IngestHealthBanner.tsx frontend/src/components/IngestHealthBanner.test.tsx frontend/src/app/AppShell.tsx frontend/src/screens/Settings.tsx frontend/src/screens/settings/SettingsHub.tsx
git commit -m "feat(web): ingest-health warning banner with deep link into Settings"
```

---

### Task 6: Settings → "Email ingest" page + hub row + writable-fields fix

**Files:**
- Create: `frontend/src/screens/settings/IngestHealthPage.tsx`
- Create: `frontend/src/screens/settings/IngestHealthPage.test.tsx`
- Modify: `frontend/src/screens/settings/SettingsHub.tsx`
- Modify: `frontend/src/screens/Settings.tsx`
- Modify: `frontend/src/screens/settings/CategorizationPage.tsx`

**Interfaces:**
- Consumes: `useIngestHealth`, `relTime`, `reasonText`, `ingestStatusLabel` (Task 4); `SettingsPage`, `SavedFlash`/`useSavedFlash`, `SegmentedControl`, `useToast` (existing); `ingest_silence_days` on `/api/settings` (Task 2).
- Produces: `IngestHealthPage({ onClose })`; hub row "Email ingest" opening it.

- [ ] **Step 1: Write the failing page test**

Create `frontend/src/screens/settings/IngestHealthPage.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "../../components/Toast";
import { IngestHealthPage } from "./IngestHealthPage";

const settingsPayload = {
  auto_categorize: true, ai_enabled: false, ai_auto_accept: false,
  ai_threshold: 0.85, ingest_silence_days: 3, ai_key_present: false,
};

const warnHealth = {
  status: "ok", db: "ok",
  ingest: {
    configured: true, count: 42, last_at: "2026-07-01T08:00:00Z",
    status: "warn", reasons: ["mail_silent"],
    last_poll_success_at: "2026-07-05T11:00:00Z",
    last_poll_attempt_at: "2026-07-05T11:59:00Z",
    consecutive_failures: 0, poll_interval_seconds: 60, silence_days: 3,
  },
};

let putBodies: string[];

beforeEach(() => {
  putBodies = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("/api/health")) return new Response(JSON.stringify(warnHealth));
    if (u.includes("/api/settings")) {
      if (init?.method === "PUT") {
        putBodies.push(String(init.body));
        return new Response("{}");
      }
      return new Response(JSON.stringify(settingsPayload));
    }
    return new Response("[]");
  }));
});

function wrap() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider><IngestHealthPage onClose={() => {}} /></ToastProvider>
    </QueryClientProvider>,
  );
}

describe("IngestHealthPage", () => {
  it("shows the status headline, reason, and facts", async () => {
    wrap();
    expect(await screen.findByText("Warning")).toBeInTheDocument();
    expect(screen.getByText(/forward/i)).toBeInTheDocument();      // mail_silent reason copy
    expect(screen.getByText(/last email seen/i)).toBeInTheDocument();
    expect(screen.getByText(/last successful check/i)).toBeInTheDocument();
  });

  it("saves the silence threshold with all writable fields", async () => {
    wrap();
    await screen.findByText("Warning");
    fireEvent.click(screen.getByRole("radio", { name: "7d" }));
    await waitFor(() => expect(putBodies.length).toBe(1));
    const body = JSON.parse(putBodies[0]);
    expect(body.ingest_silence_days).toBe(7);
    expect(body.auto_categorize).toBe(true);   // other settings preserved
    expect(body.ai_threshold).toBe(0.85);
  });
});
```

> If `SegmentedControl` renders buttons rather than radios, the `getByRole("radio", ...)` query will fail — check `frontend/src/components/ui/SegmentedControl.tsx` and use the role it actually renders (`radio` or `button`) with name `"7d"`.

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && bunx vitest run src/screens/settings/IngestHealthPage.test.tsx`
Expected: FAIL — module `./IngestHealthPage` not found.

- [ ] **Step 3: Implement the page**

Create `frontend/src/screens/settings/IngestHealthPage.tsx`:

```tsx
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getJSON, postJSON } from "../../api/client";
import type { AppSettings } from "../../api/types";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { useToast } from "../../components/Toast";
import { SettingsPage } from "./SettingsPage";
import { SavedFlash, useSavedFlash } from "./SavedFlash";
import { useIngestHealth } from "../../hooks/useIngestHealth";
import { ingestStatusLabel, reasonText, relTime } from "../../lib/ingestHealth";

const DAY_OPTIONS = [1, 2, 3, 5, 7, 14].map((n) => ({ value: String(n), label: `${n}d` }));

function FactRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 text-sm py-2">
      <span className="text-muted">{label}</span>
      <span className="text-right tnum">{value}</span>
    </div>
  );
}

export function IngestHealthPage({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const { show } = useToast();
  const { saved, flash } = useSavedFlash();
  const health = useIngestHealth();
  const settings = useQuery({ queryKey: ["settings"], queryFn: () => getJSON<AppSettings>("/api/settings") });

  const ih = health.data?.ingest;
  const s = settings.data;
  const now = new Date();

  const saveDays = async (days: number) => {
    if (!s) return;
    try {
      // Send every writable field — a partial PUT would clobber the rest.
      await postJSON("/api/settings", {
        auto_categorize: s.auto_categorize, ai_enabled: s.ai_enabled,
        ai_auto_accept: s.ai_auto_accept, ai_threshold: s.ai_threshold,
        ingest_silence_days: days,
      }, "PUT");
      qc.invalidateQueries({ queryKey: ["settings"] });
      qc.invalidateQueries({ queryKey: ["health"] });
      flash();
    } catch { show({ message: "Couldn't save settings", tone: "error" }); }
  };

  return (
    <SettingsPage title="Email ingest" onClose={onClose} headerRight={<SavedFlash saved={saved} />}>
      {ih && (
        <>
          <section className="bg-surface rounded-[var(--radius-card)] shadow-1 p-4 space-y-1">
            <p className="text-sm font-semibold">{ingestStatusLabel(ih.status)}</p>
            {ih.status === "warn" && ih.reasons.map((r) => (
              <p key={r} className="text-xs text-warn">{reasonText(r, ih)}</p>
            ))}
            {ih.status === "ok" && (
              <p className="text-xs text-muted">Mailbox checks are running and mail is arriving.</p>
            )}
            {ih.status === "starting" && (
              <p className="text-xs text-muted">The mailbox worker just started — first check pending.</p>
            )}
            {ih.status === "off" && (
              <p className="text-xs text-muted">No IMAP mailbox is configured.</p>
            )}
          </section>

          <section className="bg-surface rounded-[var(--radius-card)] shadow-1 px-4 py-2 divide-y divide-border">
            <FactRow label="Last email seen" value={relTime(ih.last_at, now)} />
            <FactRow label="Last successful check" value={relTime(ih.last_poll_success_at, now)} />
            <FactRow label="Last attempted check" value={relTime(ih.last_poll_attempt_at, now)} />
            {ih.consecutive_failures > 0 && (
              <FactRow label="Failed checks in a row" value={String(ih.consecutive_failures)} />
            )}
            {ih.last_error && (
              <p role="alert" className="text-bad text-xs py-2 break-words">{ih.last_error}</p>
            )}
          </section>

          <section>
            <p className="text-sm mb-1">Warn when no email for</p>
            <p className="text-xs text-muted mb-3">
              Catches a broken auto-forward rule even when mailbox checks succeed.
            </p>
            <div className="overflow-x-auto -mx-1 px-1">
              <SegmentedControl
                value={String(s?.ingest_silence_days ?? ih.silence_days)}
                onChange={(v) => saveDays(Number(v))}
                options={DAY_OPTIONS}
              />
            </div>
          </section>
        </>
      )}
    </SettingsPage>
  );
}
```

- [ ] **Step 4: Run page tests**

Run: `cd frontend && bunx vitest run src/screens/settings/IngestHealthPage.test.tsx`
Expected: PASS (adjust the segmented-control role query per the note in Step 1 if needed).

- [ ] **Step 5: Hub row, page routing, and CategorizationPage fix**

In `frontend/src/screens/settings/SettingsHub.tsx`:

- Add imports:

```tsx
import { useIngestHealth } from "../../hooks/useIngestHealth";
import { ingestStatusLabel } from "../../lib/ingestHealth";
```

- Inside `SettingsHub`, next to the other queries: `const health = useIngestHealth();`
- In the `Automation` group, after the "Swipe actions" row:

```tsx
        <HubRow
          label="Email ingest"
          value={health.data?.ingest ? ingestStatusLabel(health.data.ingest.status) : undefined}
          onClick={() => onOpen("ingest")}
        />
```

In `frontend/src/screens/Settings.tsx`:

- Import: `import { IngestHealthPage } from "./settings/IngestHealthPage";`
- Add to the drill-in list (after the `textsize` line):

```tsx
      {page === "ingest" && <IngestHealthPage onClose={close} />}
```

In `frontend/src/screens/settings/CategorizationPage.tsx`, `saveSettings` sends only writable fields; it must now include the new one so saving categorization settings doesn't reset the silence threshold. Change the `postJSON` body to:

```tsx
      await postJSON("/api/settings", {
        auto_categorize: next.auto_categorize, ai_enabled: next.ai_enabled,
        ai_auto_accept: next.ai_auto_accept, ai_threshold: next.ai_threshold,
        ingest_silence_days: next.ingest_silence_days,
      }, "PUT");
```

(`next` is spread from the fetched settings, so `ingest_silence_days` is present on it via the updated `AppSettings` type.)

- [ ] **Step 6: Run the full frontend suite**

Run: `cd frontend && bun run test`
Expected: PASS — all files. Pre-existing `Settings.test.tsx` / `Settings.categorization.test.tsx` stub settings payloads without `ingest_silence_days`; the field is then `undefined` in the PUT body, which the server treats as "preserve current", so their assertions should hold. If any test asserts the exact PUT body and fails, fix it by adding `ingest_silence_days: 3` to that test's stubbed settings payload.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/screens/settings/IngestHealthPage.tsx frontend/src/screens/settings/IngestHealthPage.test.tsx frontend/src/screens/settings/SettingsHub.tsx frontend/src/screens/Settings.tsx frontend/src/screens/settings/CategorizationPage.tsx
git commit -m "feat(web): Email ingest status page + silence-days setting"
```

---

### Task 7: Rebuild embedded dist, full verification, deploy-ready commit

**Files:**
- Modify: `internal/web/dist/` (committed build artifact)

**Interfaces:**
- Consumes: everything above.
- Produces: a `main` where the embedded PWA matches frontend source and all suites pass.

- [ ] **Step 1: Re-check main for parallel-session commits**

```bash
git log --oneline -5
git status --short
```

Expected: only this plan's commits since `f1fb9af` (spec commit) plus any parallel-session commits. If parallel commits touched `frontend/` or `internal/web/dist/`, note them — the rebuild below folds them in automatically because it builds from current source.

- [ ] **Step 2: Rebuild the frontend into the embedded dist**

```bash
cd frontend && bun install && bun run build
```

Expected: Vite build succeeds, output lands in `internal/web/dist/`.

- [ ] **Step 3: Build the binary and run the full Go suite**

```bash
cd /root/Coding/ledger
CGO_ENABLED=0 go build -o ledger ./cmd/ledger
go test ./...
```

Expected: build OK; all packages PASS except the known `internal/config` sandbox false failure.

- [ ] **Step 4: Full frontend suite**

```bash
cd frontend && bun run test
```

Expected: PASS.

- [ ] **Step 5: Smoke-test the running binary**

```bash
cd /root/Coding/ledger && ./ledger -config /dev/null &
sleep 1
curl -s http://127.0.0.1:8080/api/health | head -c 400; echo
kill %1
```

> If the default listen address conflicts with the production service on 8080, create a one-line config instead: `printf '[server]\nlisten = "127.0.0.1:8099"\n' > /tmp/claude-0/-root-Coding-ledger/92fb19ae-4fed-4f9c-8ca4-34ce52467655/scratchpad/health-smoke.toml` and run `./ledger -config <that file>`, then curl `127.0.0.1:8099`.

Expected: JSON containing `"ingest":{"configured":false,...,"status":"off"` (no IMAP in the smoke config).

- [ ] **Step 6: Commit the dist**

```bash
git add internal/web/dist
git commit -m "chore(web): rebuild embedded dist (ingest health indicator)"
```

---

## Self-Review Notes (already applied)

- Spec coverage: worker snapshot (T1), silence setting (T2), derivation + API (T3), types/lib/hook (T4), banner + navigation (T5), status page + threshold control + partial-PUT clobber fix (T6), dist rebuild (T7). Push/SSE explicitly out of scope per spec.
- `"ingest"` is added to `SettingsPageId` in Task 5 (the banner needs it) while the page component arrives in Task 6; between the two, the value renders no drill-in — harmless.
- The `starting`-expires-to-`poll_stale` edge from the spec self-review is covered by the "starting expired" table case in Task 3.
