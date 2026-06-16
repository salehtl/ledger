# Milestone 8 — Hardening & Monitoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden the live system with drift monitoring (per-bank parse-success alerting), self-transfer detection, a live SSE event stream, and web push notifications, so a format change raises an alert and internal transfers never count as spend.

**Architecture:** Four independent additions. (1) A new `internal/monitor` package runs a background goroutine that queries `ingest_log` parse-success rates per sender and emits `DriftAlert` structs when a bank's rate drops below a configurable threshold. (2) The parse processor honours `ParsedTxn.IsTransfer` (already set by the DIB parser) to mark internal transfers as `status='transfer'` at insert time, and does a cross-transaction look-up to auto-match the opposite leg. (3) An SSE hub in `internal/server/events.go` lets the PWA receive live `new_transaction` and `drift_alert` events — if M7 already created this file, skip Task 3. (4) An `internal/push` package wraps `webpush-go` for VAPID push, activated by two env vars.

**Tech Stack:** Go 1.25, `modernc.org/sqlite`, `github.com/SherClockHolmes/webpush-go` (new), stdlib `net/http`, `sync`.

> **M7 note:** The M7 (PWA) plan also creates `internal/server/events.go`. If M7 is implemented before M8, **skip Task 3** and use the existing `Hub` / `BroadcastEvent` already in place. Everything else in this plan is independent of M7.

---

## File Map

| File | Status | Responsibility |
|---|---|---|
| `internal/config/config.go` | Modify | Add `MonitoringConfig`; `ParseDriftWindow()` helper |
| `config.example.toml` | Modify | Add `[monitoring]` section |
| `internal/store/monitor.go` | Create | `DriftStat`, `SelectDriftStats()` |
| `internal/store/monitor_test.go` | Create | 3 tests for the drift-stat query |
| `internal/store/push.go` | Create | `PushSubRow`, `InsertPushSub`, `SelectPushSubs`, `DeletePushSub` |
| `internal/store/push_test.go` | Create | 3 tests for push-sub CRUD |
| `internal/monitor/monitor.go` | Create | `DriftAlert`, `Monitor`, `New()`, `Start()`, `Check()`, `Alerts()` |
| `internal/monitor/monitor_test.go` | Create | 4 tests using a fake store |
| `internal/server/events.go` | Create (skip if M7 done) | `Hub`, `BroadcastEvent()`, `handleEvents` |
| `internal/server/events_test.go` | Create (skip if M7 done) | Hub fan-out + SSE content-type test |
| `internal/server/push.go` | Create | `handlePushSubscribe`, `handlePushUnsubscribe`, `handleVapidPublicKey` |
| `internal/server/push_test.go` | Create | 3 handler tests |
| `internal/server/server.go` | Modify | Add `hub`, `driftMon`, `pushStore`, `pushSender` fields; 4 new routes |
| `internal/server/health.go` | Modify | Add `drift []driftHealth` to health response |
| `internal/parse/processor.go` | Modify | Honour `IsTransfer`; add `SetOnInsert` callback; call `FindTransferMatch` |
| `internal/parse/processor_test.go` | Modify | 2 new tests: IsTransfer sets status=transfer; cross-match marks both legs |
| `internal/store/transactions.go` | Modify | Add `FindTransferMatch()` |
| `internal/push/push.go` | Create | `Sender`, `New()`, `GenerateKeys()`, `PublicKey()`, `Send()` |
| `internal/push/push_test.go` | Create | 3 tests: key gen, New() validation, PublicKey() round-trip |
| `cmd/ledger/main.go` | Modify | `vapid-keys` subcommand; start monitor; wire hub + push sender; broadcast on insert |

---

## Task 1: MonitoringConfig + DriftStats store query

**Files:**
- Modify: `internal/config/config.go`
- Modify: `config.example.toml`
- Create: `internal/store/monitor.go`
- Create: `internal/store/monitor_test.go`

- [ ] **Step 1: Write the failing store tests**

Create `internal/store/monitor_test.go`:

```go
package store

import (
	"fmt"
	"testing"
	"time"
)

func TestSelectDriftStats_EmptyDB(t *testing.T) {
	st, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	stats, err := st.SelectDriftStats(time.Now().Add(-7*24*time.Hour), 1)
	if err != nil {
		t.Fatal(err)
	}
	if len(stats) != 0 {
		t.Errorf("got %d stats, want 0", len(stats))
	}
}

func TestSelectDriftStats_ComputesRate(t *testing.T) {
	st, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	now := time.Now()
	statuses := []string{"parsed", "parsed", "parsed", "unparsed"}
	for i, status := range statuses {
		if _, err := st.InsertIngest(IngestRecord{
			MessageUID:  fmt.Sprintf("uid-%d", i),
			FromAddr:    "alerts@bank.com",
			Subject:     "txn",
			ParseStatus: status,
			RawBody:     []byte("body"),
			CreatedAt:   now,
		}); err != nil {
			t.Fatal(err)
		}
	}

	stats, err := st.SelectDriftStats(now.Add(-time.Hour), 1)
	if err != nil {
		t.Fatal(err)
	}
	if len(stats) != 1 {
		t.Fatalf("got %d stats, want 1", len(stats))
	}
	if stats[0].FromAddr != "alerts@bank.com" {
		t.Errorf("from_addr = %q, want alerts@bank.com", stats[0].FromAddr)
	}
	if stats[0].Total != 4 {
		t.Errorf("total = %d, want 4", stats[0].Total)
	}
	if stats[0].Parsed != 3 {
		t.Errorf("parsed = %d, want 3", stats[0].Parsed)
	}
	if got := stats[0].SuccessRate(); got < 0.74 || got > 0.76 {
		t.Errorf("success rate = %.2f, want 0.75", got)
	}
}

func TestSelectDriftStats_FiltersMinVolume(t *testing.T) {
	st, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	now := time.Now()
	// Only 1 email — below minVolume of 2
	if _, err := st.InsertIngest(IngestRecord{
		MessageUID: "uid-1", FromAddr: "rare@bank.com",
		Subject: "txn", ParseStatus: "unparsed",
		RawBody: []byte("body"), CreatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}

	stats, err := st.SelectDriftStats(now.Add(-time.Hour), 2)
	if err != nil {
		t.Fatal(err)
	}
	if len(stats) != 0 {
		t.Errorf("got %d stats with minVolume=2, want 0", len(stats))
	}
}
```

- [ ] **Step 2: Run to confirm failure**

```bash
cd /root/Coding/ledger && go test ./internal/store/... -run TestSelectDriftStats -v 2>&1 | head -10
```

Expected: FAIL — `SelectDriftStats` undefined.

- [ ] **Step 3: Create `internal/store/monitor.go`**

```go
package store

import "time"

// DriftStat is the parse-success record for one sender within a query window.
type DriftStat struct {
	FromAddr string
	Total    int
	Parsed   int
}

// SuccessRate returns Parsed/Total, or 1.0 when Total is 0.
func (d DriftStat) SuccessRate() float64 {
	if d.Total == 0 {
		return 1.0
	}
	return float64(d.Parsed) / float64(d.Total)
}

// SelectDriftStats returns per-from_addr parse stats for emails received after
// `since`. Only senders with at least `minVolume` emails are included.
func (s *Store) SelectDriftStats(since time.Time, minVolume int) ([]DriftStat, error) {
	rows, err := s.DB.Query(`
		SELECT from_addr,
		       COUNT(*) AS total,
		       SUM(CASE WHEN parse_status = 'parsed' THEN 1 ELSE 0 END) AS parsed
		FROM ingest_log
		WHERE created_at >= ? AND from_addr IS NOT NULL
		GROUP BY from_addr
		HAVING total >= ?
	`, since.UTC().Format(time.RFC3339Nano), minVolume)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []DriftStat
	for rows.Next() {
		var d DriftStat
		if err := rows.Scan(&d.FromAddr, &d.Total, &d.Parsed); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}
```

- [ ] **Step 4: Add `MonitoringConfig` to `internal/config/config.go`**

Read the file first. Add to the `Config` struct (after `AI AIConfig`):

```go
Monitoring MonitoringConfig `toml:"monitoring"`
```

Add the new type (after `AIConfig`):

```go
// MonitoringConfig controls the drift detection window and threshold.
type MonitoringConfig struct {
	DriftWindow string  `toml:"drift_window"` // e.g. "7d", "24h"
	DriftMin    float64 `toml:"drift_min"`    // 0.0–1.0; alert if success rate drops below this
}

// ParseDriftWindow parses the drift_window string. Supports "Nd" for days in
// addition to standard time.ParseDuration formats.
func (c MonitoringConfig) ParseDriftWindow() (time.Duration, error) {
	s := strings.TrimSpace(c.DriftWindow)
	if strings.HasSuffix(s, "d") {
		n, err := strconv.Atoi(strings.TrimSuffix(s, "d"))
		if err != nil {
			return 0, fmt.Errorf("drift_window %q: expected integer days", s)
		}
		return time.Duration(n) * 24 * time.Hour, nil
	}
	return time.ParseDuration(s)
}
```

Add to `defaults()`:

```go
Monitoring: MonitoringConfig{
    DriftWindow: "7d",
    DriftMin:    0.80,
},
```

Add `"strconv"` and `"strings"` to the imports.

- [ ] **Step 5: Update `config.example.toml`**

Add after the `[ai]` block:

```toml
[monitoring]
drift_window = "7d"   # rolling window for per-sender parse-success tracking
drift_min    = 0.80   # alert if a sender's parse-success drops below this fraction
```

- [ ] **Step 6: Run tests**

```bash
cd /root/Coding/ledger && go test ./internal/store/... ./internal/config/... -count=1 -v 2>&1 | tail -20
```

Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add internal/config/config.go config.example.toml internal/store/monitor.go internal/store/monitor_test.go
git commit -m "feat(monitor): MonitoringConfig + SelectDriftStats per-sender parse-success query"
```

---

## Task 2: DriftMonitor goroutine

**Files:**
- Create: `internal/monitor/monitor.go`
- Create: `internal/monitor/monitor_test.go`

- [ ] **Step 1: Write the failing tests**

Create `internal/monitor/monitor_test.go`:

```go
package monitor_test

import (
	"testing"
	"time"

	"ledger/internal/monitor"
	"ledger/internal/store"
)

type fakeDriftStore struct {
	stats []store.DriftStat
}

func (f *fakeDriftStore) SelectDriftStats(since time.Time, minVolume int) ([]store.DriftStat, error) {
	return f.stats, nil
}

func TestMonitor_NoAlerts_HighRate(t *testing.T) {
	fake := &fakeDriftStore{stats: []store.DriftStat{
		{FromAddr: "alerts@bank.com", Total: 10, Parsed: 9},
	}}
	m := monitor.New(fake, 7*24*time.Hour, 0.80, nil)
	alerts := m.Check()
	if len(alerts) != 0 {
		t.Errorf("got %d alerts, want 0 (rate 0.90 > threshold 0.80)", len(alerts))
	}
}

func TestMonitor_Alert_LowRate(t *testing.T) {
	fake := &fakeDriftStore{stats: []store.DriftStat{
		{FromAddr: "alerts@bank.com", Total: 10, Parsed: 5},
	}}
	m := monitor.New(fake, 7*24*time.Hour, 0.80, nil)
	alerts := m.Check()
	if len(alerts) != 1 {
		t.Fatalf("got %d alerts, want 1", len(alerts))
	}
	if alerts[0].FromAddr != "alerts@bank.com" {
		t.Errorf("from_addr = %q, want alerts@bank.com", alerts[0].FromAddr)
	}
	if alerts[0].SuccessRate != 0.5 {
		t.Errorf("success_rate = %.2f, want 0.50", alerts[0].SuccessRate)
	}
	if alerts[0].Threshold != 0.80 {
		t.Errorf("threshold = %.2f, want 0.80", alerts[0].Threshold)
	}
}

func TestMonitor_OnChange_FiredOnlyWhenAlertListChanges(t *testing.T) {
	fired := 0
	fake := &fakeDriftStore{stats: []store.DriftStat{
		{FromAddr: "alerts@bank.com", Total: 10, Parsed: 5},
	}}
	m := monitor.New(fake, 7*24*time.Hour, 0.80, func(a []monitor.DriftAlert) { fired++ })

	m.Check() // first check: empty → 1 alert → changed
	if fired != 1 {
		t.Errorf("onChange fired %d times after first change, want 1", fired)
	}
	m.Check() // second check: same alert → no change
	if fired != 1 {
		t.Errorf("onChange fired %d times with unchanged alerts, want still 1", fired)
	}
	// Clear alerts
	fake.stats = nil
	m.Check() // now cleared: 1 alert → 0 alerts → changed
	if fired != 2 {
		t.Errorf("onChange fired %d times after clearing, want 2", fired)
	}
}

func TestMonitor_Alerts_ThreadSafe(t *testing.T) {
	fake := &fakeDriftStore{stats: []store.DriftStat{
		{FromAddr: "a@b.com", Total: 5, Parsed: 2},
	}}
	m := monitor.New(fake, time.Hour, 0.80, nil)
	m.Check()
	got := m.Alerts()
	if len(got) != 1 {
		t.Errorf("Alerts() = %d, want 1", len(got))
	}
}
```

- [ ] **Step 2: Run to confirm failure**

```bash
cd /root/Coding/ledger && go test ./internal/monitor/... -v 2>&1 | head -10
```

Expected: FAIL — package `ledger/internal/monitor` not found.

- [ ] **Step 3: Create `internal/monitor/monitor.go`**

```go
package monitor

import (
	"context"
	"sync"
	"time"

	"ledger/internal/store"
)

// checkInterval is how often the background goroutine re-evaluates drift.
const checkInterval = 5 * time.Minute

// DriftStore is the subset of the store the monitor needs.
type DriftStore interface {
	SelectDriftStats(since time.Time, minVolume int) ([]store.DriftStat, error)
}

// DriftAlert is raised when a sender's parse-success rate drops below the threshold.
type DriftAlert struct {
	FromAddr    string
	Total       int
	Parsed      int
	SuccessRate float64
	Threshold   float64
}

// Monitor runs drift checks in the background and maintains the current alert list.
type Monitor struct {
	store     DriftStore
	window    time.Duration
	threshold float64
	alerts    []DriftAlert
	mu        sync.RWMutex
	onChange  func([]DriftAlert)
}

// New creates a Monitor. onChange is called (without the lock held) whenever the
// alert list changes. onChange may be nil.
func New(st DriftStore, window time.Duration, threshold float64, onChange func([]DriftAlert)) *Monitor {
	return &Monitor{
		store:     st,
		window:    window,
		threshold: threshold,
		onChange:  onChange,
	}
}

// Start runs the drift-check loop until ctx is cancelled. Call as a goroutine.
func (m *Monitor) Start(ctx context.Context) {
	m.check()
	ticker := time.NewTicker(checkInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			m.check()
		}
	}
}

// Alerts returns a snapshot of the current alerts (thread-safe).
func (m *Monitor) Alerts() []DriftAlert {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]DriftAlert, len(m.alerts))
	copy(out, m.alerts)
	return out
}

// Check runs a single drift evaluation and returns the current alerts.
// Exported for testing; in production, Start() calls this on a ticker.
func (m *Monitor) Check() []DriftAlert {
	m.check()
	return m.Alerts()
}

func (m *Monitor) check() {
	since := time.Now().Add(-m.window)
	stats, err := m.store.SelectDriftStats(since, 3) // ignore senders with < 3 emails
	if err != nil {
		return
	}
	var alerts []DriftAlert
	for _, s := range stats {
		rate := s.SuccessRate()
		if rate < m.threshold {
			alerts = append(alerts, DriftAlert{
				FromAddr:    s.FromAddr,
				Total:       s.Total,
				Parsed:      s.Parsed,
				SuccessRate: rate,
				Threshold:   m.threshold,
			})
		}
	}
	m.mu.Lock()
	changed := !alertsEqual(m.alerts, alerts)
	m.alerts = alerts
	m.mu.Unlock()
	if changed && m.onChange != nil {
		m.onChange(alerts)
	}
}

func alertsEqual(a, b []DriftAlert) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i].FromAddr != b[i].FromAddr || a[i].SuccessRate != b[i].SuccessRate {
			return false
		}
	}
	return true
}
```

- [ ] **Step 4: Run tests**

```bash
cd /root/Coding/ledger && go test ./internal/monitor/... -v -count=1 2>&1
```

Expected: 4 tests PASS.

- [ ] **Step 5: Run full suite**

```bash
cd /root/Coding/ledger && go test ./... -count=1 2>&1 | tail -15
```

Expected: all packages PASS.

- [ ] **Step 6: Commit**

```bash
git add internal/monitor/monitor.go internal/monitor/monitor_test.go
git commit -m "feat(monitor): DriftMonitor goroutine — per-sender parse-success alerting"
```

---

## Task 3: SSE hub + `/api/events`

> **Skip this task if M7 has already been implemented** — check whether `internal/server/events.go` exists. If it does, the `Hub` type and `handleEvents` are already in place. Jump to Task 4.

**Files:**
- Create: `internal/server/events.go`
- Create: `internal/server/events_test.go`

- [ ] **Step 1: Check whether M7 already created events.go**

```bash
ls /root/Coding/ledger/internal/server/events.go 2>/dev/null && echo "EXISTS — skip Task 3" || echo "NOT FOUND — continue"
```

If output is `EXISTS — skip Task 3`, jump directly to Task 4.

- [ ] **Step 2: Write the failing tests**

Create `internal/server/events_test.go`:

```go
package server_test

import (
	"context"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"ledger/internal/server"
)

func TestHub_BroadcastReachesSubscriber(t *testing.T) {
	hub := server.NewHub()
	ch, unsub := hub.Subscribe()
	defer unsub()

	hub.BroadcastEvent("test_event", map[string]any{"key": "value"})

	select {
	case data := <-ch:
		if !strings.Contains(string(data), "test_event") {
			t.Errorf("broadcast data = %q, want to contain 'test_event'", data)
		}
	case <-time.After(100 * time.Millisecond):
		t.Fatal("timed out waiting for broadcast")
	}
}

func TestHub_SlowClientDropped(t *testing.T) {
	hub := server.NewHub()
	// Fill the channel buffer without reading
	ch, unsub := hub.Subscribe()
	defer unsub()
	for i := 0; i < 20; i++ { // more than the buffer size of 16
		hub.BroadcastEvent("event", nil)
	}
	// Should not block (slow clients are dropped)
	_ = ch
}

func TestHandleEvents_SetsSSEContentType(t *testing.T) {
	st := newTestServerStore(t)
	srv := newTestServerWithStore(t, st)
	hub := server.NewHub()
	srv.SetHub(hub)

	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	req := httptest.NewRequest("GET", "/api/events", nil).WithContext(ctx)
	w := httptest.NewRecorder()
	srv.ServeHTTP(w, req)

	ct := w.Header().Get("Content-Type")
	if ct != "text/event-stream" {
		t.Errorf("Content-Type = %q, want text/event-stream", ct)
	}
}

func TestHandleEvents_SendsHeartbeat(t *testing.T) {
	st := newTestServerStore(t)
	srv := newTestServerWithStore(t, st)
	hub := server.NewHub()
	srv.SetHub(hub)

	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	req := httptest.NewRequest("GET", "/api/events", nil).WithContext(ctx)
	w := httptest.NewRecorder()
	srv.ServeHTTP(w, req)

	body := w.Body.String()
	if !strings.Contains(body, "heartbeat") {
		t.Errorf("SSE body = %q, expected heartbeat event", body)
	}
}
```

- [ ] **Step 3: Run to confirm failure**

```bash
cd /root/Coding/ledger && go test ./internal/server/... -run "TestHub|TestHandleEvents" -v 2>&1 | head -10
```

Expected: FAIL — `server.NewHub` undefined.

- [ ] **Step 4: Create `internal/server/events.go`**

```go
package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"time"
)

// Hub maintains a set of SSE subscriber channels and fan-outs JSON payloads.
type Hub struct {
	mu      sync.RWMutex
	clients map[chan []byte]struct{}
}

// NewHub creates an empty Hub.
func NewHub() *Hub { return &Hub{clients: make(map[chan []byte]struct{})} }

// Subscribe registers a new client. Returns the event channel and an unsubscribe
// function the caller must invoke (typically via defer) when done.
func (h *Hub) Subscribe() (chan []byte, func()) {
	ch := make(chan []byte, 16)
	h.mu.Lock()
	h.clients[ch] = struct{}{}
	h.mu.Unlock()
	return ch, func() {
		h.mu.Lock()
		delete(h.clients, ch)
		close(ch)
		h.mu.Unlock()
	}
}

// Broadcast sends data to all connected clients. Slow clients that haven't
// drained their channel are silently skipped rather than blocking the sender.
func (h *Hub) Broadcast(data []byte) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	for ch := range h.clients {
		select {
		case ch <- data:
		default:
		}
	}
}

// BroadcastEvent serialises {type, data} and broadcasts it to all subscribers.
func (h *Hub) BroadcastEvent(eventType string, data any) {
	payload, err := json.Marshal(map[string]any{"type": eventType, "data": data})
	if err != nil {
		return
	}
	h.Broadcast(payload)
}

// handleEvents serves GET /api/events as a Server-Sent Events stream.
func (s *Server) handleEvents(w http.ResponseWriter, r *http.Request) {
	if s.hub == nil {
		http.Error(w, "events not configured", http.StatusServiceUnavailable)
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "SSE not supported", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")

	ch, unsub := s.hub.Subscribe()
	defer unsub()

	fmt.Fprintf(w, "event: heartbeat\ndata: {}\n\n")
	flusher.Flush()

	heartbeat := time.NewTicker(30 * time.Second)
	defer heartbeat.Stop()

	for {
		select {
		case <-r.Context().Done():
			return
		case <-heartbeat.C:
			fmt.Fprintf(w, "event: heartbeat\ndata: {}\n\n")
			flusher.Flush()
		case data, ok := <-ch:
			if !ok {
				return
			}
			fmt.Fprintf(w, "data: %s\n\n", data)
			flusher.Flush()
		}
	}
}
```

- [ ] **Step 5: Add hub field + SetHub + BroadcastEvent + route to `internal/server/server.go`**

Read `internal/server/server.go`. Add to the `Server` struct:

```go
hub      *Hub
driftMon DriftStatusProvider
```

Add interfaces + setter + convenience method (after existing `SetRecategorizeFn`):

```go
// DriftStatusProvider surfaces the monitor's current alert list for /api/health.
type DriftStatusProvider interface {
	Alerts() []monitor.DriftAlert
}

// SetHub wires the SSE hub. Required for GET /api/events.
func (s *Server) SetHub(h *Hub) { s.hub = h }

// SetDriftMonitor wires the drift monitor into /api/health.
func (s *Server) SetDriftMonitor(m DriftStatusProvider) { s.driftMon = m }

// BroadcastEvent is a convenience wrapper over the hub (no-op if hub is nil).
func (s *Server) BroadcastEvent(eventType string, data any) {
	if s.hub != nil {
		s.hub.BroadcastEvent(eventType, data)
	}
}
```

Add import `"ledger/internal/monitor"` to server.go.

Add to `routes()` (before the `/api/` catch-all):

```go
s.mux.HandleFunc("GET /api/events", s.handleEvents)
```

- [ ] **Step 6: Run tests**

```bash
cd /root/Coding/ledger && go test ./internal/server/... -v -count=1 2>&1 | tail -20
```

Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add internal/server/events.go internal/server/events_test.go internal/server/server.go
git commit -m "feat(server): SSE hub + GET /api/events; DriftStatusProvider interface"
```

---

## Task 4: Self-transfer detection

**Files:**
- Modify: `internal/store/transactions.go`
- Modify: `internal/parse/processor.go`
- Modify: `internal/parse/processor_test.go`

- [ ] **Step 1: Write the failing tests**

Add to `internal/parse/processor_test.go` (after the existing tests):

```go
func TestProcessorSetsTransferStatusFromIsTransfer(t *testing.T) {
	st := procTestStore(t)

	// Insert a DIB transfer email: the DIB parser sets IsTransfer=true
	// Simulate by injecting an ingest row where the parsed result will be IsTransfer.
	// Here we directly test the processor's handling by crafting a cascade stub.
	cascade := &Cascade{
		Parsers: []BankParser{stubTransferParser{}},
		Heuristic: HeuristicParser{},
		AI:        DisabledExtractor{},
	}
	if _, err := st.InsertIngest(store.IngestRecord{
		MessageUID:  "xfer-1",
		FromAddr:    "stub@bank.com",
		Subject:     "transfer",
		ParseStatus: "unparsed",
		RawBody:     []byte("From: stub@bank.com\r\nSubject: transfer\r\n\r\ntransfer"),
		CreatedAt:   time.Now(),
	}); err != nil {
		t.Fatal(err)
	}

	p := NewProcessor(st, cascade)
	if _, err := p.ProcessPending(context.Background(), store.SelectForParseOpts{OnlyUnparsed: true}); err != nil {
		t.Fatal(err)
	}

	var status string
	if err := st.DB.QueryRow(`SELECT status FROM transactions LIMIT 1`).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != "transfer" {
		t.Errorf("status = %q, want transfer (IsTransfer=true should set status=transfer)", status)
	}
}

// stubTransferParser is a BankParser that always returns IsTransfer=true.
type stubTransferParser struct{}

func (stubTransferParser) Bank() string { return "stub" }
func (stubTransferParser) Matches(from, subject string) bool {
	return from == "stub@bank.com"
}
func (stubTransferParser) Parse(_ string) (ParsedTxn, error) {
	return ParsedTxn{
		PostedAt:    time.Date(2025, 8, 19, 0, 0, 0, 0, time.UTC),
		AmountFils:  10000,
		Currency:    "AED",
		Direction:   "debit",
		MerchantRaw: "Internal Transfer",
		IsTransfer:  true,
		Confidence:  1.0,
	}, nil
}

func TestProcessorCrossMatchTransfer(t *testing.T) {
	st := procTestStore(t)

	// Insert a credit "leg" transaction directly as needs_review.
	_, _, err := st.InsertTransaction(store.TransactionRow{
		PostedAt:    time.Date(2025, 8, 19, 12, 0, 0, 0, time.UTC),
		AmountFils:  50000,
		Currency:    "AED",
		Direction:   "credit",
		MerchantRaw: "DIB Transfer",
		Status:      "needs_review",
		Source:      "email",
	})
	if err != nil {
		t.Fatal(err)
	}

	// Now insert the debit leg via the processor; it should cross-match the credit.
	cascade := &Cascade{
		Parsers:   []BankParser{stubDebitLegParser{}},
		Heuristic: HeuristicParser{},
		AI:        DisabledExtractor{},
	}
	if _, err := st.InsertIngest(store.IngestRecord{
		MessageUID:  "debit-leg",
		FromAddr:    "debit@bank.com",
		Subject:     "transfer",
		ParseStatus: "unparsed",
		RawBody:     []byte("From: debit@bank.com\r\nSubject: transfer\r\n\r\nbody"),
		CreatedAt:   time.Now(),
	}); err != nil {
		t.Fatal(err)
	}

	p := NewProcessor(st, cascade)
	if _, err := p.ProcessPending(context.Background(), store.SelectForParseOpts{OnlyUnparsed: true}); err != nil {
		t.Fatal(err)
	}

	// Both the credit leg and the new debit should be status=transfer.
	var count int
	if err := st.DB.QueryRow(`SELECT COUNT(*) FROM transactions WHERE status = 'transfer'`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 2 {
		t.Errorf("transfer-status count = %d, want 2 (both legs auto-matched)", count)
	}
}

// stubDebitLegParser returns a debit transaction matching the credit leg above (same amount, within 2h).
type stubDebitLegParser struct{}

func (stubDebitLegParser) Bank() string { return "debit" }
func (stubDebitLegParser) Matches(from, _ string) bool {
	return from == "debit@bank.com"
}
func (stubDebitLegParser) Parse(_ string) (ParsedTxn, error) {
	return ParsedTxn{
		PostedAt:    time.Date(2025, 8, 19, 12, 30, 0, 0, time.UTC), // 30 min after credit
		AmountFils:  50000,
		Currency:    "AED",
		Direction:   "debit",
		MerchantRaw: "DIB Transfer",
		Confidence:  1.0,
	}, nil
}
```

- [ ] **Step 2: Run to confirm failure**

```bash
cd /root/Coding/ledger && go test ./internal/parse/... -run "TestProcessorSetsTransfer|TestProcessorCrossMatch" -v 2>&1 | head -20
```

Expected: FAIL — tests fail because processor always uses `status="needs_review"`.

- [ ] **Step 3: Add `FindTransferMatch` to `internal/store/transactions.go`**

Read `internal/store/transactions.go`. Add after `nullableID`:

```go
// FindTransferMatch looks for an existing transaction that could be the other leg
// of a self-transfer: same amount, opposite direction, within `window` of `postedAt`,
// and not already marked as a transfer. Returns (matchID, true, nil) on hit.
func (s *Store) FindTransferMatch(txID, amountFils int64, direction string, postedAt time.Time, window time.Duration) (int64, bool, error) {
	opp := "credit"
	if direction == "credit" {
		opp = "debit"
	}
	start := postedAt.Add(-window).UTC().Format(time.RFC3339Nano)
	end := postedAt.Add(window).UTC().Format(time.RFC3339Nano)
	postedStr := postedAt.UTC().Format(time.RFC3339Nano)

	var matchID int64
	err := s.DB.QueryRow(`
		SELECT id FROM transactions
		 WHERE id != ?
		   AND amount = ?
		   AND direction = ?
		   AND posted_at >= ?
		   AND posted_at <= ?
		   AND status != 'transfer'
		 ORDER BY ABS(CAST((julianday(posted_at) - julianday(?)) * 86400 AS INTEGER))
		 LIMIT 1
	`, txID, amountFils, opp, start, end, postedStr).Scan(&matchID)
	if err == sql.ErrNoRows {
		return 0, false, nil
	}
	if err != nil {
		return 0, false, err
	}
	return matchID, true, nil
}
```

Add `"database/sql"` to the import block in `transactions.go` (it already imports `"crypto/sha256"` etc; check it doesn't already have sql — if it does, skip).

- [ ] **Step 4: Modify `internal/parse/processor.go`**

Read `internal/parse/processor.go`. Make three changes:

**Change 1** — add `onInsert` callback field and setter:

```go
type Processor struct {
	store       *store.Store
	cascade     *Cascade
	categorizer *categorize.Categorizer
	onInsert    func(txID, amountFils int64, merchant, direction string)
}

// SetOnInsert registers a callback invoked after each successful transaction
// insert. Used by main.go to broadcast SSE events.
func (p *Processor) SetOnInsert(fn func(txID, amountFils int64, merchant, direction string)) {
	p.onInsert = fn
}
```

**Change 2** — in `ProcessPending`, replace the hardcoded `Status: "needs_review"` with transfer-aware status:

```go
		txStatus := "needs_review"
		if res.Txn.IsTransfer {
			txStatus = "transfer"
		}
		txID, inserted, ierr := p.store.InsertTransaction(store.TransactionRow{
			PostedAt:    res.Txn.PostedAt,
			AmountFils:  res.Txn.AmountFils,
			Currency:    res.Txn.Currency,
			Direction:   res.Txn.Direction,
			MerchantRaw: res.Txn.MerchantRaw,
			Last4:       res.Txn.Last4,
			Status:      txStatus,
			Confidence:  res.Txn.Confidence,
			Tier:        res.Tier,
			IngestID:    row.ID,
		})
```

**Change 3** — after the `if inserted` block (after categorizeTransaction), add cross-match logic and the onInsert callback:

```go
		if inserted {
			if p.categorizer != nil {
				p.categorizeTransaction(ctx, txID, res.Txn.MerchantRaw)
			}
			// Auto-match opposite transfer leg within 2 hours.
			if txStatus != "transfer" {
				if matchID, found, _ := p.store.FindTransferMatch(
					txID, res.Txn.AmountFils, res.Txn.Direction, res.Txn.PostedAt, 2*time.Hour,
				); found {
					_ = p.store.UpdateTransactionStatus(txID, "transfer")
					_ = p.store.UpdateTransactionStatus(matchID, "transfer")
				}
			}
			if p.onInsert != nil {
				p.onInsert(txID, res.Txn.AmountFils, res.Txn.MerchantRaw, res.Txn.Direction)
			}
		}
```

Add `"time"` to the imports in processor.go.

- [ ] **Step 5: Run tests**

```bash
cd /root/Coding/ledger && go test ./internal/parse/... ./internal/store/... -v -count=1 2>&1 | tail -25
```

Expected: all PASS.

- [ ] **Step 6: Run full suite**

```bash
cd /root/Coding/ledger && go test ./... -count=1 2>&1 | tail -10
```

Expected: all packages PASS.

- [ ] **Step 7: Commit**

```bash
git add internal/store/transactions.go internal/parse/processor.go internal/parse/processor_test.go
git commit -m "feat(parse): self-transfer detection — IsTransfer flag + 2h cross-match; SetOnInsert callback"
```

---

## Task 5: Push subscription store + server API

**Files:**
- Create: `internal/store/push.go`
- Create: `internal/store/push_test.go`
- Create: `internal/server/push.go`
- Create: `internal/server/push_test.go`
- Modify: `internal/server/server.go`

- [ ] **Step 1: Write the failing store tests**

Create `internal/store/push_test.go`:

```go
package store

import (
	"testing"
)

func TestInsertAndSelectPushSub(t *testing.T) {
	st, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	err = st.InsertPushSub(PushSubRow{
		Endpoint: "https://push.example.com/12345",
		P256dh:   "key_p256dh",
		Auth:     "key_auth",
	})
	if err != nil {
		t.Fatalf("InsertPushSub: %v", err)
	}

	subs, err := st.SelectPushSubs()
	if err != nil {
		t.Fatalf("SelectPushSubs: %v", err)
	}
	if len(subs) != 1 {
		t.Fatalf("got %d subs, want 1", len(subs))
	}
	if subs[0].Endpoint != "https://push.example.com/12345" {
		t.Errorf("endpoint = %q", subs[0].Endpoint)
	}
}

func TestInsertPushSub_Idempotent(t *testing.T) {
	st, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	sub := PushSubRow{Endpoint: "https://push.example.com/abc", P256dh: "k", Auth: "a"}
	if err := st.InsertPushSub(sub); err != nil {
		t.Fatal(err)
	}
	// INSERT OR REPLACE: second call updates (upsert) — should not error
	if err := st.InsertPushSub(sub); err != nil {
		t.Fatalf("second InsertPushSub: %v", err)
	}
	subs, _ := st.SelectPushSubs()
	if len(subs) != 1 {
		t.Errorf("got %d subs after upsert, want 1", len(subs))
	}
}

func TestDeletePushSub(t *testing.T) {
	st, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	_ = st.InsertPushSub(PushSubRow{Endpoint: "https://push.example.com/del", P256dh: "k", Auth: "a"})
	if err := st.DeletePushSub("https://push.example.com/del"); err != nil {
		t.Fatal(err)
	}
	subs, _ := st.SelectPushSubs()
	if len(subs) != 0 {
		t.Errorf("got %d subs after delete, want 0", len(subs))
	}
}
```

- [ ] **Step 2: Run to confirm failure**

```bash
cd /root/Coding/ledger && go test ./internal/store/... -run TestInsertAndSelectPushSub -v 2>&1 | head -10
```

Expected: FAIL — `PushSubRow` undefined.

- [ ] **Step 3: Create `internal/store/push.go`**

```go
package store

import "time"

// PushSubRow is one web push subscription stored in push_subscriptions.
type PushSubRow struct {
	ID        int64
	Endpoint  string
	P256dh    string
	Auth      string
	CreatedAt string
}

// InsertPushSub stores (or replaces) a web push subscription keyed by endpoint.
func (s *Store) InsertPushSub(r PushSubRow) error {
	_, err := s.DB.Exec(
		`INSERT OR REPLACE INTO push_subscriptions (endpoint, p256dh, auth, created_at)
		 VALUES (?, ?, ?, ?)`,
		r.Endpoint, r.P256dh, r.Auth, time.Now().UTC().Format(time.RFC3339Nano),
	)
	return err
}

// SelectPushSubs returns all stored push subscriptions.
func (s *Store) SelectPushSubs() ([]PushSubRow, error) {
	rows, err := s.DB.Query(
		`SELECT id, endpoint, p256dh, auth, created_at FROM push_subscriptions ORDER BY id`,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []PushSubRow
	for rows.Next() {
		var r PushSubRow
		if err := rows.Scan(&r.ID, &r.Endpoint, &r.P256dh, &r.Auth, &r.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// DeletePushSub removes the subscription with the given endpoint (no-op if not found).
func (s *Store) DeletePushSub(endpoint string) error {
	_, err := s.DB.Exec(`DELETE FROM push_subscriptions WHERE endpoint = ?`, endpoint)
	return err
}
```

- [ ] **Step 4: Write failing server push tests**

Create `internal/server/push_test.go`:

```go
package server_test

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"ledger/internal/server"
	"ledger/internal/store"
)

func TestHandlePushSubscribe_StoresSubscription(t *testing.T) {
	st := newTestServerStore(t)
	srv := newTestServerWithStore(t, st)
	srv.SetPushStore(st)

	body, _ := json.Marshal(map[string]any{
		"endpoint": "https://push.example.com/test",
		"keys": map[string]string{
			"p256dh": "fake_p256dh_key",
			"auth":   "fake_auth_key",
		},
	})
	req := httptest.NewRequest("POST", "/api/push/subscribe", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	srv.ServeHTTP(w, req)

	if w.Code != http.StatusNoContent {
		t.Errorf("status = %d, want 204; body: %s", w.Code, w.Body)
	}

	subs, _ := st.SelectPushSubs()
	if len(subs) != 1 {
		t.Errorf("got %d subs in DB, want 1", len(subs))
	}
}

func TestHandlePushSubscribe_MissingField_Returns400(t *testing.T) {
	st := newTestServerStore(t)
	srv := newTestServerWithStore(t, st)
	srv.SetPushStore(st)

	body, _ := json.Marshal(map[string]any{"endpoint": ""})
	req := httptest.NewRequest("POST", "/api/push/subscribe", bytes.NewReader(body))
	w := httptest.NewRecorder()
	srv.ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", w.Code)
	}
}

func TestHandlePushUnsubscribe_RemovesSub(t *testing.T) {
	st := newTestServerStore(t)
	_ = st.InsertPushSub(store.PushSubRow{
		Endpoint: "https://push.example.com/del",
		P256dh:   "k",
		Auth:     "a",
	})
	srv := newTestServerWithStore(t, st)
	srv.SetPushStore(st)

	body, _ := json.Marshal(map[string]string{"endpoint": "https://push.example.com/del"})
	req := httptest.NewRequest("DELETE", "/api/push/subscribe", bytes.NewReader(body))
	w := httptest.NewRecorder()
	srv.ServeHTTP(w, req)

	if w.Code != http.StatusNoContent {
		t.Errorf("status = %d, want 204", w.Code)
	}
	subs, _ := st.SelectPushSubs()
	if len(subs) != 0 {
		t.Errorf("got %d subs after delete, want 0", len(subs))
	}
}
```

- [ ] **Step 5: Add `PushStore` + `PushSender` interfaces + setters to `internal/server/server.go`**

Read the file. Add interfaces and fields:

```go
// PushStore is the subset of the store needed by push-subscription handlers.
type PushStore interface {
	InsertPushSub(store.PushSubRow) error
	SelectPushSubs() ([]store.PushSubRow, error)
	DeletePushSub(endpoint string) error
}

// PushSender delivers web push notifications.
type PushSender interface {
	Send(ctx context.Context, endpoint, p256dh, auth string, payload []byte) error
	PublicKey() string
}
```

Add `pushStore PushStore` and `pushSender PushSender` to the `Server` struct.

Add setters:

```go
func (s *Server) SetPushStore(ps PushStore)    { s.pushStore = ps }
func (s *Server) SetPushSender(ps PushSender)  { s.pushSender = ps }
```

Add `"context"` to server.go imports.

Add to `routes()`:

```go
s.mux.HandleFunc("POST /api/push/subscribe", s.handlePushSubscribe)
s.mux.HandleFunc("DELETE /api/push/subscribe", s.handlePushUnsubscribe)
s.mux.HandleFunc("GET /api/push/vapid-public", s.handleVapidPublicKey)
```

- [ ] **Step 6: Create `internal/server/push.go`**

```go
package server

import (
	"encoding/json"
	"net/http"

	"ledger/internal/store"
)

type pushSubReq struct {
	Endpoint string `json:"endpoint"`
	Keys     struct {
		P256dh string `json:"p256dh"`
		Auth   string `json:"auth"`
	} `json:"keys"`
}

type deletePushReq struct {
	Endpoint string `json:"endpoint"`
}

func (s *Server) handlePushSubscribe(w http.ResponseWriter, r *http.Request) {
	if s.pushStore == nil {
		http.Error(w, "push not configured", http.StatusServiceUnavailable)
		return
	}
	var req pushSubReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid body", http.StatusBadRequest)
		return
	}
	if req.Endpoint == "" || req.Keys.P256dh == "" || req.Keys.Auth == "" {
		http.Error(w, "endpoint, keys.p256dh, keys.auth required", http.StatusBadRequest)
		return
	}
	if err := s.pushStore.InsertPushSub(store.PushSubRow{
		Endpoint: req.Endpoint,
		P256dh:   req.Keys.P256dh,
		Auth:     req.Keys.Auth,
	}); err != nil {
		http.Error(w, "store error", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handlePushUnsubscribe(w http.ResponseWriter, r *http.Request) {
	if s.pushStore == nil {
		http.Error(w, "push not configured", http.StatusServiceUnavailable)
		return
	}
	var req deletePushReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid body", http.StatusBadRequest)
		return
	}
	if req.Endpoint == "" {
		http.Error(w, "endpoint required", http.StatusBadRequest)
		return
	}
	if err := s.pushStore.DeletePushSub(req.Endpoint); err != nil {
		http.Error(w, "store error", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleVapidPublicKey(w http.ResponseWriter, r *http.Request) {
	if s.pushSender == nil {
		http.Error(w, "push not configured", http.StatusServiceUnavailable)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{"public_key": s.pushSender.PublicKey()})
}
```

- [ ] **Step 7: Run all tests**

```bash
cd /root/Coding/ledger && go test ./internal/store/... ./internal/server/... -v -count=1 2>&1 | tail -30
```

Expected: all PASS.

- [ ] **Step 8: Commit**

```bash
git add internal/store/push.go internal/store/push_test.go internal/server/push.go internal/server/push_test.go internal/server/server.go
git commit -m "feat(push): push subscription store + POST/DELETE /api/push/subscribe; PushStore + PushSender interfaces"
```

---

## Task 6: VAPID push sender

**Files:**
- Create: `internal/push/push.go`
- Create: `internal/push/push_test.go`

- [ ] **Step 1: Add `webpush-go` dependency**

```bash
cd /root/Coding/ledger && go get github.com/SherClockHolmes/webpush-go@latest
```

Expected: updates `go.mod` and `go.sum`.

- [ ] **Step 2: Write the failing tests**

Create `internal/push/push_test.go`:

```go
package push_test

import (
	"testing"

	"ledger/internal/push"
)

func TestGenerateKeys_ProducesNonEmptyPair(t *testing.T) {
	priv, pub, err := push.GenerateKeys()
	if err != nil {
		t.Fatalf("GenerateKeys: %v", err)
	}
	if priv == "" || pub == "" {
		t.Error("expected non-empty VAPID key pair")
	}
	if priv == pub {
		t.Error("private and public keys must differ")
	}
}

func TestNew_EmptyKeys_ReturnsError(t *testing.T) {
	_, err := push.New("", "", "")
	if err == nil {
		t.Error("expected error for empty VAPID keys")
	}
}

func TestNew_ValidKeys_PublicKeyRoundTrip(t *testing.T) {
	priv, pub, err := push.GenerateKeys()
	if err != nil {
		t.Fatalf("GenerateKeys: %v", err)
	}
	s, err := push.New(priv, pub, "mailto:test@example.com")
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if s.PublicKey() != pub {
		t.Errorf("PublicKey() = %q, want %q", s.PublicKey(), pub)
	}
}
```

- [ ] **Step 3: Run to confirm failure**

```bash
cd /root/Coding/ledger && go test ./internal/push/... -v 2>&1 | head -10
```

Expected: FAIL — package `ledger/internal/push` not found.

- [ ] **Step 4: Create `internal/push/push.go`**

```go
package push

import (
	"context"
	"fmt"

	webpush "github.com/SherClockHolmes/webpush-go"
)

// Sender sends web push notifications using VAPID.
type Sender struct {
	privateKey string
	publicKey  string
	subscriber string
}

// New creates a Sender. subscriber is the mailto: contact for VAPID (e.g.
// "mailto:owner@example.com"). Both keys are required; returns an error if empty.
func New(privateKey, publicKey, subscriber string) (*Sender, error) {
	if privateKey == "" || publicKey == "" {
		return nil, fmt.Errorf("LEDGER_VAPID_PRIVATE and LEDGER_VAPID_PUBLIC are required")
	}
	if subscriber == "" {
		subscriber = "mailto:admin@localhost"
	}
	return &Sender{privateKey: privateKey, publicKey: publicKey, subscriber: subscriber}, nil
}

// GenerateKeys generates a new VAPID key pair. Call once; store as
// LEDGER_VAPID_PRIVATE and LEDGER_VAPID_PUBLIC environment variables.
func GenerateKeys() (private, public string, err error) {
	return webpush.GenerateVAPIDKeys()
}

// PublicKey returns the VAPID public key for the browser's PushManager.subscribe().
func (s *Sender) PublicKey() string { return s.publicKey }

// Send delivers a push notification to one subscription endpoint.
// Returns nil on 201/202 from the push service; error otherwise.
func (s *Sender) Send(ctx context.Context, endpoint, p256dh, auth string, payload []byte) error {
	sub := &webpush.Subscription{
		Endpoint: endpoint,
		Keys:     webpush.Keys{Auth: auth, P256dh: p256dh},
	}
	resp, err := webpush.SendNotificationWithContext(ctx, payload, sub, &webpush.Options{
		Subscriber:      s.subscriber,
		VAPIDPublicKey:  s.publicKey,
		VAPIDPrivateKey: s.privateKey,
		TTL:             30,
	})
	if err != nil {
		return fmt.Errorf("webpush send: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return fmt.Errorf("push service returned %d for %s", resp.StatusCode, endpoint)
	}
	return nil
}
```

- [ ] **Step 5: Run push tests**

```bash
cd /root/Coding/ledger && go test ./internal/push/... -v -count=1 2>&1
```

Expected: 3 tests PASS.

- [ ] **Step 6: Run full suite**

```bash
cd /root/Coding/ledger && go test ./... -count=1 2>&1 | tail -15
```

Expected: all packages PASS.

- [ ] **Step 7: Commit**

```bash
git add internal/push/push.go internal/push/push_test.go go.mod go.sum
git commit -m "feat(push): VAPID push sender — GenerateKeys, New, Send via webpush-go"
```

---

## Task 7: Wire everything in `main.go` + enhanced `/api/health` + deploy

**Files:**
- Modify: `internal/server/health.go`
- Modify: `cmd/ledger/main.go`

- [ ] **Step 1: Update `internal/server/health.go` to include drift status**

Read the file. Replace the `healthResponse` struct and `handleHealth` with:

```go
package server

import (
	"encoding/json"
	"net/http"
	"time"
)

type healthResponse struct {
	Status string        `json:"status"`
	DB     string        `json:"db"`
	Ingest *ingestHealth `json:"ingest,omitempty"`
	Drift  []driftHealth `json:"drift,omitempty"`
}

type ingestHealth struct {
	Configured bool   `json:"configured"`
	Count      int    `json:"count"`
	LastAt     string `json:"last_at,omitempty"`
}

type driftHealth struct {
	FromAddr    string  `json:"from_addr"`
	SuccessRate float64 `json:"success_rate"`
	Threshold   float64 `json:"threshold"`
	Alert       bool    `json:"alert"`
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	resp := healthResponse{Status: "ok", DB: "ok"}
	code := http.StatusOK
	if err := s.store.Ping(); err != nil {
		resp.Status = "degraded"
		resp.DB = "unreachable"
		code = http.StatusServiceUnavailable
	}
	if s.ingest != nil {
		ih := &ingestHealth{Configured: s.imapConfigured}
		if count, err := s.ingest.CountIngest(); err == nil {
			ih.Count = count
		}
		if at, ok, err := s.ingest.LastIngestAt(); err == nil && ok {
			ih.LastAt = at.UTC().Format(time.RFC3339)
		}
		resp.Ingest = ih
	}
	if s.driftMon != nil {
		for _, a := range s.driftMon.Alerts() {
			resp.Drift = append(resp.Drift, driftHealth{
				FromAddr:    a.FromAddr,
				SuccessRate: a.SuccessRate,
				Threshold:   a.Threshold,
				Alert:       true,
			})
		}
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(resp)
}
```

- [ ] **Step 2: Wire the monitor, hub, and push sender into `cmd/ledger/main.go`**

Read `cmd/ledger/main.go`. Make the following additions:

**a) Add a `vapid-keys` subcommand** at the top of `main()`, alongside the existing `import` check:

```go
if len(os.Args) > 1 {
    switch os.Args[1] {
    case "import":
        runImport(os.Args[2:])
        return
    case "vapid-keys":
        priv, pub, err := push.GenerateKeys()
        if err != nil {
            log.Fatalf("vapid-keys: %v", err)
        }
        fmt.Printf("LEDGER_VAPID_PRIVATE=%s\nLEDGER_VAPID_PUBLIC=%s\n", priv, pub)
        return
    }
}
```

Replace the existing `if len(os.Args) > 1 && os.Args[1] == "import"` block with this switch.

**b) Add these imports** (check which are new):

```go
"encoding/json"

"ledger/internal/monitor"
"ledger/internal/push"
```

**c) After `srv.SetRecategorizeFn(...)`, add the hub, monitor, and push wiring:**

```go
	// SSE hub — broadcasts new transactions and drift alerts.
	hub := server.NewHub()
	srv.SetHub(hub)

	// Wire processor to broadcast SSE events on successful inserts.
	processor.SetOnInsert(func(txID, amountFils int64, merchant, direction string) {
		hub.BroadcastEvent("new_transaction", map[string]any{
			"id":          txID,
			"merchant_raw": merchant,
			"amount":      amountFils,
			"direction":   direction,
		})
		// Send push to all subscribers (fire-and-forget per subscriber).
		if pushSend != nil {
			subs, _ := st.SelectPushSubs()
			payload, _ := json.Marshal(map[string]string{
				"title": "New transaction",
				"body":  merchant,
			})
			for _, sub := range subs {
				go func(s store.PushSubRow) {
					_ = pushSend.Send(context.Background(), s.Endpoint, s.P256dh, s.Auth, payload)
				}(sub)
			}
		}
	})

	// Drift monitor — check parse-success rates and alert on drift.
	var driftWindow time.Duration
	if dw, err := cfg.Monitoring.ParseDriftWindow(); err == nil {
		driftWindow = dw
	} else {
		driftWindow = 7 * 24 * time.Hour
		log.Printf("monitoring: bad drift_window config (%v), defaulting to 7d", err)
	}
	mon := monitor.New(st, driftWindow, cfg.Monitoring.DriftMin, func(alerts []monitor.DriftAlert) {
		hub.BroadcastEvent("drift_alert", alerts)
		if pushSend != nil && len(alerts) > 0 {
			subs, _ := st.SelectPushSubs()
			payload, _ := json.Marshal(map[string]string{
				"title": "Parse drift alert",
				"body":  alerts[0].FromAddr + " parse-success dropped",
			})
			for _, sub := range subs {
				go func(s store.PushSubRow) {
					_ = pushSend.Send(context.Background(), s.Endpoint, s.P256dh, s.Auth, payload)
				}(sub)
			}
		}
	})
	srv.SetDriftMonitor(mon)

	// VAPID push sender (optional — only enabled when both keys are set).
	var pushSend *push.Sender
	if priv := os.Getenv("LEDGER_VAPID_PRIVATE"); priv != "" {
		pub := os.Getenv("LEDGER_VAPID_PUBLIC")
		subscriber := "mailto:" + cfg.IMAP.Username
		if s, err := push.New(priv, pub, subscriber); err == nil {
			pushSend = s
			srv.SetPushStore(st)
			srv.SetPushSender(pushSend)
			log.Printf("push: VAPID enabled (public key starts: %s...)", pub[:min(8, len(pub))])
		} else {
			log.Printf("push: disabled (%v)", err)
		}
	} else {
		log.Printf("push: disabled (set LEDGER_VAPID_PRIVATE + LEDGER_VAPID_PUBLIC to enable)")
	}
```

> **Important:** Declare `pushSend` BEFORE the `processor.SetOnInsert` block (Go closures capture variables, not values). Move the `var pushSend *push.Sender` declaration above `processor.SetOnInsert`.

Add a `min` helper at the bottom of main.go if not already present:

```go
func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
```

Note: Go 1.21+ has a built-in `min`; this is safe to include conditionally.

**d) Start the monitor goroutine** just before `<-ctx.Done()`:

```go
	go mon.Start(ctx)
```

- [ ] **Step 3: Build**

```bash
cd /root/Coding/ledger && go build ./... 2>&1
```

Expected: clean.

- [ ] **Step 4: Run full test suite**

```bash
cd /root/Coding/ledger && go test ./... -count=1 2>&1 | tail -15
```

Expected: all packages PASS.

- [ ] **Step 5: Smoke-test the `vapid-keys` subcommand**

```bash
cd /root/Coding/ledger && go run ./cmd/ledger vapid-keys
```

Expected:
```
LEDGER_VAPID_PRIVATE=<base64url key>
LEDGER_VAPID_PUBLIC=<base64url key>
```

Two distinct non-empty base64url strings.

- [ ] **Step 6: Commit**

```bash
git add cmd/ledger/main.go internal/server/health.go
git commit -m "feat(main): wire hub + monitor + push; vapid-keys subcommand; drift status in /api/health"
```

- [ ] **Step 7: Deploy to dinosaur**

```bash
CGO_ENABLED=0 go build -o /usr/local/bin/ledger ./cmd/ledger && \
  systemctl restart ledger && sleep 2 && \
  systemctl status ledger --no-pager
```

Expected: `active (running)`.

- [ ] **Step 8: Smoke-test /api/health**

```bash
curl -s http://localhost:8080/api/health | python3 -m json.tool
```

Expected JSON includes `"status": "ok"` and a `drift` key (empty array when no data):

```json
{
  "status": "ok",
  "db": "ok",
  "ingest": { ... },
  "drift": []
}
```

- [ ] **Step 9: Verify self-transfer netting**

```bash
# Check any existing "transfer" status transactions
curl -s "http://localhost:8080/api/transactions?status=transfer" | python3 -c \
  "import sys,json; d=json.load(sys.stdin); print(f'{len(d)} transfer transactions')"

# Verify /api/summary excludes them (transfers should not appear in spend)
curl -s "http://localhost:8080/api/summary" | python3 -m json.tool
```

Expected: summary totals exclude transfer-status rows.

- [ ] **Step 10: Tag**

```bash
git tag m8-hardening && git log --oneline -5
```

---

## Self-Review

### Spec Coverage

| Spec requirement | Task |
|---|---|
| Dedup (exact fingerprint) | Already works via INSERT OR IGNORE — no new code needed |
| Self-transfers net to zero | Task 4: `IsTransfer` → `status='transfer'`; cross-match marks both legs |
| Refunds/reversals | Budget engine already skips non-confirmed and direction=credit for spending categories — no extra handling needed for basic case |
| Drift monitoring | Tasks 1 + 2: `SelectDriftStats` + `Monitor` goroutine |
| Drift alerts to SSE | Task 7: monitor `onChange` calls `hub.BroadcastEvent("drift_alert", ...)` |
| Push alerts | Tasks 5 + 6: VAPID push on new confirmed tx and drift alerts |
| `/api/health` per-bank drift | Task 7: `driftHealth` section added |
| `GET /api/events` SSE | Task 3: `Hub` + `handleEvents` |
| `POST /api/push/subscribe` | Task 5: `handlePushSubscribe` |
| VAPID key generation | Task 7: `ledger vapid-keys` subcommand |
| Deploy + verify | Task 7, steps 7–10 |

### Verify criteria from §10

- **"a self-transfer nets to zero"** → Task 4 sets `status='transfer'`; `SelectMonthSpend` only includes `status='confirmed'`. ✓
- **"a duplicate email doesn't double-count"** → `INSERT OR IGNORE` on `fingerprint` unique index — already worked; no regression. ✓
- **"simulating a format change raises a drift alert"** → inject emails with `parse_status='unparsed'` from a known sender, call `mon.Check()`, see alert in `/api/health`. ✓

### Placeholder scan

None. All code blocks are complete.

### Type consistency

- `monitor.DriftAlert` defined in Task 2, consumed by Task 7 (server.go `DriftStatusProvider` interface) ✓
- `store.PushSubRow` defined in Task 5, used in Task 5 handler and Task 7 push loop ✓
- `push.Sender` defined in Task 6, referenced as `*push.Sender` in Task 7 ✓
- `Hub.BroadcastEvent(eventType string, data any)` defined in Task 3, called in Task 7 ✓
- `Processor.SetOnInsert(fn func(int64, int64, string, string))` defined in Task 4, called in Task 7 ✓
