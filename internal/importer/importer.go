package importer

import (
	"context"
	"fmt"
	"math"
	"strings"

	"ledger/internal/categorize"
	"ledger/internal/store"
)

// ruleThreshold is the minimum number of (merchant, category) co-occurrences
// required before the importer writes a derived rule.
const ruleThreshold = 3

// Result summarizes the outcome of an import run.
type Result struct {
	RowsTotal    int
	RowsAdded    int // inserted and confirmed (had a category)
	RowsSkipped  int // fingerprint duplicates OR zero-amount rows
	RowsReview   int // inserted as needs_review (no category resolved)
	RowsError    int // normalization or DB errors
	DerivedRules int // rules written from frequency analysis (wet run only)
}

// Importer runs historical rows through normalize → categorize → insert.
type Importer struct {
	store *store.Store
	cat   *categorize.Categorizer // may be nil; if nil, only CSV-declared categories are used
}

// New creates an Importer. cat may be nil if no live categorizer is wired.
func New(st *store.Store, cat *categorize.Categorizer) *Importer {
	return &Importer{store: st, cat: cat}
}

// Run processes rows and optionally commits them (dryRun=false writes to DB).
// fileName is recorded in import_log for auditability.
func (imp *Importer) Run(ctx context.Context, rows []RawRow, m MapConfig, fileName string, dryRun bool) (Result, error) {
	// Build category-name → ID map from the live store.
	storeCats, err := imp.store.SelectCategories()
	if err != nil {
		return Result{}, fmt.Errorf("select categories: %w", err)
	}
	catIDByName := make(map[string]int64, len(storeCats))
	for _, c := range storeCats {
		catIDByName[strings.ToLower(c.Name)] = c.ID
	}

	// ensureCategory returns (or creates) a category by canonical name.
	ensureCategory := func(name string) (int64, error) {
		key := strings.ToLower(name)
		if id, ok := catIDByName[key]; ok {
			return id, nil
		}
		id, err := imp.store.InsertCategory(store.CategoryRow{
			Name:     name,
			Kind:     "spending",
			Bucket:   "want",
			IsActive: true,
		})
		if err != nil {
			return 0, err
		}
		catIDByName[key] = id
		return id, nil
	}

	// merchantCatKey tracks (merchant_raw, categoryID) frequency for rule derivation.
	type merchantCatKey struct {
		merchant string
		catID    int64
	}
	merchantCounts := make(map[merchantCatKey]int)

	var res Result
	res.RowsTotal = len(rows)

	for i, raw := range rows {
		if ctx.Err() != nil {
			return res, ctx.Err()
		}

		norm := Normalize(raw, m, i+1)
		if norm.Err != nil {
			res.RowsError++
			continue
		}
		if m.SkipZeroAmounts && norm.Txn.AmountFils == 0 {
			res.RowsSkipped++
			continue
		}

		// Resolve category.
		var catID int64
		status := "needs_review"

		if norm.CategoryName != "" {
			id, err := ensureCategory(norm.CategoryName)
			if err == nil {
				catID = id
				status = "confirmed"
				merchantCounts[merchantCatKey{norm.Txn.MerchantRaw, catID}]++
			}
		} else if imp.cat != nil {
			if result, ok := imp.cat.Categorize(ctx, norm.Txn.MerchantRaw); ok {
				catID = result.CategoryID
				if result.AboveThreshold {
					status = "confirmed"
				}
			}
		}

		if dryRun {
			// Dry-run does not check fingerprint dedup; RowsSkipped will be 0 even for already-imported rows.
			if status == "confirmed" {
				res.RowsAdded++
			} else {
				res.RowsReview++
			}
			continue
		}

		// Wet run: insert then set category.
		txID, inserted, err := imp.store.InsertTransaction(norm.Txn)
		if err != nil {
			res.RowsError++
			continue
		}
		if !inserted {
			res.RowsSkipped++
			continue
		}
		if catID != 0 {
			if err := imp.store.UpdateTransactionCategory(txID, catID, status); err != nil {
				res.RowsError++
			} else {
				res.RowsAdded++
			}
		} else {
			res.RowsReview++
		}
	}

	if dryRun {
		return res, nil
	}

	// Derive rules from merchant→category frequency.
	existingRules, _ := imp.store.SelectRules()
	existingKeys := make(map[string]bool, len(existingRules))
	for _, r := range existingRules {
		existingKeys[fmt.Sprintf("%s|%d", strings.ToLower(r.Pattern), r.CategoryID)] = true
	}

	for mc, count := range merchantCounts {
		if count < ruleThreshold {
			continue
		}
		key := fmt.Sprintf("%s|%d", strings.ToLower(mc.merchant), mc.catID)
		if existingKeys[key] {
			continue
		}
		if err := imp.store.InsertRule(store.RuleRow{
			MatchType:  "contains",
			Pattern:    mc.merchant,
			CategoryID: mc.catID,
			Priority:   100,
			Source:     "import_derived",
		}); err == nil {
			res.DerivedRules++
			existingKeys[key] = true
		}
	}

	// Budget seeding (optional).
	if m.Budget != nil {
		_ = imp.store.EnsureBudgetConfig()
		if cfg, err := imp.store.SelectBudgetConfig(); err == nil {
			if m.Budget.MonthlyIncome > 0 {
				cfg.MonthlyIncome = int64(math.Round(m.Budget.MonthlyIncome * 100))
			}
			if m.Budget.NeedPct > 0 {
				cfg.NeedPct = m.Budget.NeedPct
			}
			if m.Budget.WantPct > 0 {
				cfg.WantPct = m.Budget.WantPct
			}
			if m.Budget.SavingPct > 0 {
				cfg.SavingPct = m.Budget.SavingPct
			}
			_ = imp.store.UpdateBudgetConfig(cfg)
		}
	}

	// Record import batch for auditability.
	_, _ = imp.store.InsertImportLog(store.ImportLogRow{
		FileName:    fileName,
		RowsTotal:   res.RowsTotal,
		RowsAdded:   res.RowsAdded,
		RowsSkipped: res.RowsSkipped,
		RowsReview:  res.RowsReview,
		RowsError:   res.RowsError,
	})

	return res, nil
}
