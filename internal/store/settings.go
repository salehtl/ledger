// internal/store/settings.go
package store

// AppSettings is the singleton app_settings row controlling categorization
// and ingest-health thresholds.
//
// The notify fields are read here but written only via UpdateNotifySettings —
// UpdateAppSettings deliberately does not touch them, so an older settings PUT
// (which round-trips only the categorization fields) can never zero them.
type AppSettings struct {
	AutoCategorize     bool
	AIEnabled          bool
	AIAutoAccept       bool
	AIThreshold        float64
	IngestSilenceDays  int
	SpendCapMuUSD      int64
	CapLatched         bool
	NotifyThresholds   bool // push when an envelope/bucket crosses 80%/100%
	NotifyUpcomingDays int  // push for bills due within N days; 0 = off
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
	var auto, aiOn, aiAccept, latched, notifyThr int
	err := s.DB.QueryRow(
		`SELECT auto_categorize, ai_enabled, ai_auto_accept, ai_threshold, ingest_silence_days,
		        ai_spend_cap_musd, ai_cap_latched, notify_thresholds, notify_upcoming_days
		 FROM app_settings WHERE id=1`,
	).Scan(&auto, &aiOn, &aiAccept, &a.AIThreshold, &a.IngestSilenceDays, &a.SpendCapMuUSD,
		&latched, &notifyThr, &a.NotifyUpcomingDays)
	a.AutoCategorize = auto == 1
	a.AIEnabled = aiOn == 1
	a.AIAutoAccept = aiAccept == 1
	a.CapLatched = latched == 1
	a.NotifyThresholds = notifyThr == 1
	return a, err
}

// UpdateNotifySettings writes only the notification preferences. Kept separate
// from UpdateAppSettings so the categorization settings PUT and the
// notifications PUT cannot clobber each other's fields.
func (s *Store) UpdateNotifySettings(thresholds bool, upcomingDays int) error {
	if upcomingDays < 0 {
		upcomingDays = 0
	}
	_, err := s.DB.Exec(
		`UPDATE app_settings SET notify_thresholds=?, notify_upcoming_days=? WHERE id=1`,
		boolToInt(thresholds), upcomingDays,
	)
	return err
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
