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
