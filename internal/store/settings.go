// internal/store/settings.go
package store

import "fmt"

// Budgeting methods. 'simple' is monthly budgets — the assignment persists
// month to month (see SeedEnvelopeAssignmentsFromPreviousMonth) while spending
// against it resets, and nothing carries in either direction. 'envelope' is the
// original model where underspend carries forward and overspend is charged to
// the next month; it is sunset behind this setting rather than deleted, so the
// logic stays available if it is ever surfaced again.
const (
	BudgetModeSimple   = "simple"
	BudgetModeEnvelope = "envelope"
)

// NormalizeBudgetMode maps anything that is not exactly BudgetModeEnvelope to
// BudgetModeSimple. A settings row written before this column existed, or
// corrupted to an unknown value, must fall back to the default rather than
// error — a bad settings read should never take the Plan screen down.
func NormalizeBudgetMode(m string) string {
	if m == BudgetModeEnvelope {
		return BudgetModeEnvelope
	}
	return BudgetModeSimple
}

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
	BudgetMode         string
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
	var budgetMode string
	err := s.DB.QueryRow(
		`SELECT auto_categorize, ai_enabled, ai_auto_accept, ai_threshold, ingest_silence_days,
		        ai_spend_cap_musd, ai_cap_latched, notify_thresholds, notify_upcoming_days,
		        COALESCE(budget_mode,'')
		 FROM app_settings WHERE id=1`,
	).Scan(&auto, &aiOn, &aiAccept, &a.AIThreshold, &a.IngestSilenceDays, &a.SpendCapMuUSD,
		&latched, &notifyThr, &a.NotifyUpcomingDays, &budgetMode)
	a.AutoCategorize = auto == 1
	a.AIEnabled = aiOn == 1
	a.AIAutoAccept = aiAccept == 1
	a.CapLatched = latched == 1
	a.NotifyThresholds = notifyThr == 1
	a.BudgetMode = NormalizeBudgetMode(budgetMode)
	return a, err
}

// UpdateBudgetMode switches the budgeting method. Rejects unknown values so a
// typo cannot silently land the user in the default.
func (s *Store) UpdateBudgetMode(mode string) error {
	if mode != BudgetModeSimple && mode != BudgetModeEnvelope {
		return fmt.Errorf("invalid budget_mode %q (want %q or %q)", mode, BudgetModeSimple, BudgetModeEnvelope)
	}
	_, err := s.DB.Exec(`UPDATE app_settings SET budget_mode=? WHERE id=1`, mode)
	return err
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
