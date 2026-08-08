// internal/store/settings_test.go
package store

import "testing"

func TestAppSettingsRoundTrip(t *testing.T) {
	st := openTestStore(t)
	if err := st.EnsureAppSettings(); err != nil {
		t.Fatalf("ensure: %v", err)
	}
	got, err := st.SelectAppSettings()
	if err != nil {
		t.Fatalf("select: %v", err)
	}
	// Defaults: auto-categorize on, AI off, suggestion-only, 0.85.
	if !got.AutoCategorize || got.AIEnabled || got.AIAutoAccept || got.AIThreshold != 0.85 {
		t.Fatalf("defaults wrong: %+v", got)
	}
	got.AutoCategorize = false
	got.AIEnabled = true
	got.AIAutoAccept = true
	got.AIThreshold = 0.9
	if err := st.UpdateAppSettings(got); err != nil {
		t.Fatalf("update: %v", err)
	}
	got2, _ := st.SelectAppSettings()
	if got2.AutoCategorize || !got2.AIEnabled || !got2.AIAutoAccept || got2.AIThreshold != 0.9 {
		t.Fatalf("round-trip wrong: %+v", got2)
	}
}

func TestEnsureAppSettingsIdempotent(t *testing.T) {
	st := openTestStore(t)
	for i := 0; i < 3; i++ {
		if err := st.EnsureAppSettings(); err != nil {
			t.Fatalf("ensure %d: %v", i, err)
		}
	}
	s, _ := st.SelectAppSettings()
	if !s.AutoCategorize {
		t.Fatalf("ensure overwrote an existing row")
	}
}

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

func TestBudgetMode_DefaultsToSimple(t *testing.T) {
	st := newTestStore(t)
	if err := st.EnsureAppSettings(); err != nil {
		t.Fatal(err)
	}
	a, err := st.SelectAppSettings()
	if err != nil {
		t.Fatal(err)
	}
	if a.BudgetMode != BudgetModeSimple {
		t.Errorf("BudgetMode = %q, want %q", a.BudgetMode, BudgetModeSimple)
	}
}

func TestUpdateBudgetMode_RoundTrips(t *testing.T) {
	st := newTestStore(t)
	if err := st.EnsureAppSettings(); err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{BudgetModeEnvelope, BudgetModeSimple} {
		if err := st.UpdateBudgetMode(want); err != nil {
			t.Fatalf("UpdateBudgetMode(%q): %v", want, err)
		}
		a, err := st.SelectAppSettings()
		if err != nil {
			t.Fatal(err)
		}
		if a.BudgetMode != want {
			t.Errorf("BudgetMode = %q, want %q", a.BudgetMode, want)
		}
	}
}

// An unrecognised or empty stored value must behave as simple, never error —
// a bad settings row must not be able to take the Plan screen down.
func TestNormalizeBudgetMode(t *testing.T) {
	for in, want := range map[string]string{
		"":         BudgetModeSimple,
		"simple":   BudgetModeSimple,
		"envelope": BudgetModeEnvelope,
		"ENVELOPE": BudgetModeSimple, // exact match only
		"nonsense": BudgetModeSimple,
	} {
		if got := NormalizeBudgetMode(in); got != want {
			t.Errorf("NormalizeBudgetMode(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestUpdateBudgetMode_RejectsUnknown(t *testing.T) {
	st := newTestStore(t)
	if err := st.EnsureAppSettings(); err != nil {
		t.Fatal(err)
	}
	if err := st.UpdateBudgetMode("nonsense"); err == nil {
		t.Error("UpdateBudgetMode accepted an unknown mode")
	}
}

// A row written before this column existed reads back as simple, not "".
func TestBudgetMode_LegacyRowReadsAsSimple(t *testing.T) {
	st := newTestStore(t)
	if err := st.EnsureAppSettings(); err != nil {
		t.Fatal(err)
	}
	if _, err := st.DB.Exec(`UPDATE app_settings SET budget_mode='' WHERE id=1`); err != nil {
		t.Fatal(err)
	}
	a, err := st.SelectAppSettings()
	if err != nil {
		t.Fatal(err)
	}
	if a.BudgetMode != BudgetModeSimple {
		t.Errorf("BudgetMode = %q, want %q", a.BudgetMode, BudgetModeSimple)
	}
}
