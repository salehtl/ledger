// internal/store/settings.go
package store

// AppSettings is the singleton app_settings row controlling categorization
// and ingest-health thresholds.
type AppSettings struct {
	AutoCategorize    bool
	AIEnabled         bool
	AIAutoAccept      bool
	AIThreshold       float64
	IngestSilenceDays int
	SpendCapMuUSD     int64
	CapLatched        bool
}

// EnsureAppSettings inserts the default singleton row if none exists. It never
// overwrites an existing row.
func (s *Store) EnsureAppSettings() error {
	_, err := s.DB.Exec(
		`INSERT OR IGNORE INTO app_settings
		   (id, auto_categorize, ai_enabled, ai_auto_accept, ai_threshold)
		 VALUES (1, 1, 0, 0, 0.85)`,
	)
	return err
}

// SelectAppSettings reads the singleton row.
func (s *Store) SelectAppSettings() (AppSettings, error) {
	var a AppSettings
	var auto, aiOn, aiAccept, latched int
	err := s.DB.QueryRow(
		`SELECT auto_categorize, ai_enabled, ai_auto_accept, ai_threshold, ingest_silence_days,
		        ai_spend_cap_musd, ai_cap_latched
		 FROM app_settings WHERE id=1`,
	).Scan(&auto, &aiOn, &aiAccept, &a.AIThreshold, &a.IngestSilenceDays, &a.SpendCapMuUSD, &latched)
	a.AutoCategorize = auto == 1
	a.AIEnabled = aiOn == 1
	a.AIAutoAccept = aiAccept == 1
	a.CapLatched = latched == 1
	return a, err
}

// UpdateAppSettings overwrites the singleton row.
func (s *Store) UpdateAppSettings(a AppSettings) error {
	latched := boolToInt(a.CapLatched)
	if a.AIEnabled {
		latched = 0 // re-enabling AI always clears the cap latch
	}
	_, err := s.DB.Exec(
		`UPDATE app_settings
		   SET auto_categorize=?, ai_enabled=?, ai_auto_accept=?, ai_threshold=?,
		       ingest_silence_days=?, ai_spend_cap_musd=?, ai_cap_latched=?
		 WHERE id=1`,
		boolToInt(a.AutoCategorize), boolToInt(a.AIEnabled), boolToInt(a.AIAutoAccept),
		a.AIThreshold, a.IngestSilenceDays, a.SpendCapMuUSD, latched,
	)
	return err
}
