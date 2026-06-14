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
