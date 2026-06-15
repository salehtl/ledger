package monitor

import (
	"context"
	"log"
	"strings"
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
	senders   []string // from_addr substrings to evaluate; empty = all
	alerts    []DriftAlert
	mu        sync.RWMutex
	onChange  func([]DriftAlert)
}

// New creates a Monitor. senders is an allowlist of from_addr substrings to
// drift-check (empty/nil = every sender). onChange is called (without the lock
// held) whenever the alert list changes. onChange may be nil.
func New(st DriftStore, window time.Duration, threshold float64, senders []string, onChange func([]DriftAlert)) *Monitor {
	return &Monitor{
		store:     st,
		window:    window,
		threshold: threshold,
		senders:   senders,
		onChange:  onChange,
	}
}

// senderAllowed reports whether a sender should be drift-checked. With no
// allowlist configured, every sender is checked.
func (m *Monitor) senderAllowed(from string) bool {
	if len(m.senders) == 0 {
		return true
	}
	f := strings.ToLower(from)
	for _, sub := range m.senders {
		if strings.Contains(f, strings.ToLower(sub)) {
			return true
		}
	}
	return false
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
		log.Printf("monitor: drift stats query failed: %v", err)
		return
	}
	var alerts []DriftAlert
	for _, s := range stats {
		if !m.senderAllowed(s.FromAddr) {
			continue
		}
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
