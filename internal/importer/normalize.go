package importer

import (
	"fmt"
	"strings"

	"ledger/internal/store"
)

// NormalizedRow is a source row after field resolution. Err is non-nil for rows
// that failed to parse; they are counted as rows_error and skipped by the importer.
type NormalizedRow struct {
	Txn          store.TransactionRow
	CategoryName string // resolved canonical category name; empty when no category column
	RowIndex     int    // 1-based row number (for error messages)
	Err          error
}

// Normalize converts one RawRow to a NormalizedRow using the column/format config.
// The returned Txn always has Source="import" and Status="needs_review"; category
// assignment and status promotion happen in the Importer after a successful insert.
func Normalize(raw RawRow, m MapConfig, rowIndex int) NormalizedRow {
	n := NormalizedRow{RowIndex: rowIndex}

	// Date
	dateStr := strings.TrimSpace(raw[m.Columns.Date])
	if dateStr == "" {
		n.Err = fmt.Errorf("row %d: date column %q is empty", rowIndex, m.Columns.Date)
		return n
	}
	t, err := m.ParseDate(dateStr)
	if err != nil {
		n.Err = fmt.Errorf("row %d: %w", rowIndex, err)
		return n
	}
	n.Txn.PostedAt = t

	// Description / merchant
	desc := strings.TrimSpace(raw[m.Columns.Description])
	if desc == "" {
		n.Err = fmt.Errorf("row %d: description column %q is empty", rowIndex, m.Columns.Description)
		return n
	}
	n.Txn.MerchantRaw = desc

	// Amount + direction
	amountFils, direction, err := m.ParseAmount(raw)
	if err != nil {
		n.Err = fmt.Errorf("row %d: %w", rowIndex, err)
		return n
	}
	n.Txn.AmountFils = amountFils
	n.Txn.Direction = direction

	// Fixed fields
	n.Txn.Currency = m.Currency
	n.Txn.Source = "import"
	n.Txn.Status = "needs_review" // promoted by Importer.Run after category assignment

	// Optional category column
	if m.Columns.Category != "" {
		if catName := strings.TrimSpace(raw[m.Columns.Category]); catName != "" {
			n.CategoryName = m.ResolveCategory(catName)
		}
	}

	return n
}
