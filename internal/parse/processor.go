package parse

import (
	"context"

	"ledger/internal/categorize"
	"ledger/internal/store"
)

// Processor runs the cascade over ingest_log rows and persists results.
// If a Categorizer is set, it runs immediately after each successful extraction.
type Processor struct {
	store       *store.Store
	cascade     *Cascade
	categorizer *categorize.Categorizer
}

func NewProcessor(st *store.Store, c *Cascade) *Processor {
	return &Processor{store: st, cascade: c}
}

// NewProcessorWithCategorizer builds a Processor that also categorizes each
// extracted transaction and auto-confirms rule hits.
func NewProcessorWithCategorizer(st *store.Store, c *Cascade, cat *categorize.Categorizer) *Processor {
	return &Processor{store: st, cascade: c, categorizer: cat}
}

// ProcessPending selects ingest rows per opts, runs the cascade over each, writes
// a transaction when extracted, and stamps ingest_log. Returns the count of rows
// that produced a transaction.
func (p *Processor) ProcessPending(ctx context.Context, opts store.SelectForParseOpts) (int, error) {
	rows, err := p.store.SelectForParse(opts)
	if err != nil {
		return 0, err
	}
	created := 0
	for _, row := range rows {
		text, berr := BodyText(row.RawBody)
		if berr != nil {
			_ = p.store.MarkParsed(row.ID, StatusUnparsed, "", berr.Error())
			continue
		}
		res := p.cascade.Run(ctx, row.FromAddr, row.Subject, text)
		if res.Status == StatusUnparsed {
			_ = p.store.MarkParsed(row.ID, StatusUnparsed, "", res.Err)
			continue
		}
		txID, inserted, ierr := p.store.InsertTransaction(store.TransactionRow{
			PostedAt:    res.Txn.PostedAt,
			AmountFils:  res.Txn.AmountFils,
			Currency:    res.Txn.Currency,
			Direction:   res.Txn.Direction,
			MerchantRaw: res.Txn.MerchantRaw,
			Last4:       res.Txn.Last4,
			Status:      "needs_review",
			Confidence:  res.Txn.Confidence,
			Tier:        res.Tier,
			IngestID:    row.ID,
		})
		if ierr != nil {
			_ = p.store.MarkParsed(row.ID, StatusUnparsed, "", ierr.Error())
			continue
		}
		if inserted && p.categorizer != nil {
			p.categorizeTransaction(ctx, txID, res.Txn.MerchantRaw)
		}
		if err := p.store.MarkParsed(row.ID, res.Status, res.Tier, ""); err != nil {
			return created, err
		}
		created++
	}
	return created, nil
}

func (p *Processor) categorizeTransaction(ctx context.Context, txID int64, merchantRaw string) {
	result, ok := p.categorizer.Categorize(ctx, merchantRaw)
	if !ok {
		return
	}
	status := "needs_review"
	if result.AboveThreshold {
		status = "confirmed"
	}
	_ = p.store.UpdateTransactionCategory(txID, result.CategoryID, status)
	if result.ProposedRule != nil {
		_ = p.store.InsertRule(store.RuleRow{
			MatchType:  result.ProposedRule.MatchType,
			Pattern:    result.ProposedRule.Pattern,
			CategoryID: result.ProposedRule.CategoryID,
			Priority:   result.ProposedRule.Priority,
			Source:     "ai_confirmed",
		})
	}
}
