package store

import (
	"path/filepath"
	"testing"
)

func openTestStore(t *testing.T) *Store {
	t.Helper()
	st, err := Open(filepath.Join(t.TempDir(), "data"))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { st.Close() })
	return st
}

func TestEnsureAndSelectBudgetConfig(t *testing.T) {
	st := openTestStore(t)
	if err := st.EnsureBudgetConfig(); err != nil {
		t.Fatalf("EnsureBudgetConfig: %v", err)
	}
	cfg, err := st.SelectBudgetConfig()
	if err != nil {
		t.Fatalf("SelectBudgetConfig: %v", err)
	}
	if cfg.NeedPct != 0.50 || cfg.WantPct != 0.30 || cfg.SavingPct != 0.20 {
		t.Errorf("default pcts = %v/%v/%v", cfg.NeedPct, cfg.WantPct, cfg.SavingPct)
	}
	if cfg.IncomeSource != "config" || cfg.FreezeHistory {
		t.Errorf("defaults: source=%q freeze=%v", cfg.IncomeSource, cfg.FreezeHistory)
	}
}

func TestEnsureBudgetConfigIdempotent(t *testing.T) {
	st := openTestStore(t)
	if err := st.EnsureBudgetConfig(); err != nil {
		t.Fatal(err)
	}
	if err := st.UpdateBudgetConfig(BudgetConfig{
		MonthlyIncome: 2000000, NeedPct: 0.6, WantPct: 0.2, SavingPct: 0.2,
		IncomeSource: "categories", FreezeHistory: true,
	}); err != nil {
		t.Fatalf("UpdateBudgetConfig: %v", err)
	}
	if err := st.EnsureBudgetConfig(); err != nil {
		t.Fatal(err)
	}
	cfg, _ := st.SelectBudgetConfig()
	if cfg.MonthlyIncome != 2000000 || cfg.NeedPct != 0.6 || !cfg.FreezeHistory {
		t.Errorf("Ensure clobbered user values: %+v", cfg)
	}
}
