package store

// BudgetConfig is the singleton budget_config row (§5).
type BudgetConfig struct {
	MonthlyIncome int64
	NeedPct       float64
	WantPct       float64
	SavingPct     float64
	IncomeSource  string // "config" | "categories"
	FreezeHistory bool
}

// EnsureBudgetConfig inserts the default singleton row if none exists. It never
// overwrites an existing row (INSERT OR IGNORE on the fixed id=1).
func (s *Store) EnsureBudgetConfig() error {
	_, err := s.DB.Exec(
		`INSERT OR IGNORE INTO budget_config
		   (id, monthly_income, need_pct, want_pct, saving_pct, income_source, freeze_history)
		 VALUES (1, 0, 0.50, 0.30, 0.20, 'config', 0)`,
	)
	return err
}

// SelectBudgetConfig reads the singleton row.
func (s *Store) SelectBudgetConfig() (BudgetConfig, error) {
	var c BudgetConfig
	var freeze int
	err := s.DB.QueryRow(
		`SELECT monthly_income, need_pct, want_pct, saving_pct, income_source, freeze_history
		 FROM budget_config WHERE id=1`,
	).Scan(&c.MonthlyIncome, &c.NeedPct, &c.WantPct, &c.SavingPct, &c.IncomeSource, &freeze)
	c.FreezeHistory = freeze == 1
	return c, err
}

// UpdateBudgetConfig overwrites the singleton row.
func (s *Store) UpdateBudgetConfig(c BudgetConfig) error {
	_, err := s.DB.Exec(
		`UPDATE budget_config
		   SET monthly_income=?, need_pct=?, want_pct=?, saving_pct=?, income_source=?, freeze_history=?
		 WHERE id=1`,
		c.MonthlyIncome, c.NeedPct, c.WantPct, c.SavingPct, c.IncomeSource, boolToInt(c.FreezeHistory),
	)
	return err
}
