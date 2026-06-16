# Milestone 6 — Historical Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `ledger import` CLI subcommand that reads a CSV/XLSX export of historical transactions, normalizes them into the same shape as email-parsed transactions, deduplicates via the same sha256 fingerprint, and bootstraps the rules engine from historical category assignments.

**Architecture:** A new `internal/importer` package handles column-mapping (`map.toml`), row normalization (amount→fils, date parsing, direction), and batch insertion using the existing `store.InsertTransaction` (same fingerprint = same dedup). The `ledger` binary checks `os.Args[1] == "import"` before the server path and dispatches to a self-contained import runner. Rule derivation happens post-insert: merchants with ≥3 historical category assignments generate `import_derived` rules that seed the live categorizer.

**Tech Stack:** Go 1.25, stdlib `encoding/csv`, `github.com/xuri/excelize/v2` for XLSX, `github.com/BurntSushi/toml` (already in go.mod), SQLite via existing `store` package.

**Known limitation:** Imported transactions use an empty `last4` in the fingerprint. Email-parsed transactions that captured a real last4 will have a different fingerprint for the same purchase — they will not dedup against each other. Recommend importing history up to the date IMAP ingest started.

---

## File Map

| File | Status | Responsibility |
|---|---|---|
| `internal/store/transactions.go` | Modify | Add `Source string` field to `TransactionRow`; use it in INSERT (default `"email"`) |
| `internal/store/import.go` | **Create** | `ImportLogRow`, `InsertImportLog()`, `SelectImportLogs()` |
| `internal/store/import_test.go` | **Create** | Tests for import_log methods |
| `internal/importer/mapping.go` | **Create** | `MapConfig`, `LoadMap()`, `ParseDate()`, `ParseAmount()`, `ResolveCategory()` |
| `internal/importer/reader.go` | **Create** | `RawRow`, `ReadCSV()`, `ReadXLSX()`, `ReadFile()` |
| `internal/importer/normalize.go` | **Create** | `NormalizedRow`, `Normalize()` |
| `internal/importer/importer.go` | **Create** | `Importer`, `Result`, `New()`, `Run()` |
| `internal/importer/importer_test.go` | **Create** | End-to-end tests against a temp store |
| `cmd/ledger/main.go` | Modify | Add `import` subcommand dispatch + `runImport()` |
| `docs/map.example.toml` | **Create** | Documented example mapping file |

---

## Task 1: Store — `Source` field on `TransactionRow` + import_log methods

**Files:**
- Modify: `internal/store/transactions.go`
- Create: `internal/store/import.go`
- Create: `internal/store/import_test.go`
- Modify: `internal/store/transactions_test.go` (update callers if needed)

- [ ] **Step 1: Write the failing tests**

Add to `internal/store/import_test.go`:

```go
package store

import (
	"testing"
)

func TestInsertAndSelectImportLog(t *testing.T) {
	st, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	id, err := st.InsertImportLog(ImportLogRow{
		FileName:    "all-transactions.csv",
		RowsTotal:   100,
		RowsAdded:   90,
		RowsSkipped: 5,
		RowsReview:  3,
		RowsError:   2,
	})
	if err != nil {
		t.Fatalf("InsertImportLog: %v", err)
	}
	if id == 0 {
		t.Error("expected non-zero id")
	}

	logs, err := st.SelectImportLogs()
	if err != nil {
		t.Fatalf("SelectImportLogs: %v", err)
	}
	if len(logs) != 1 {
		t.Fatalf("got %d logs, want 1", len(logs))
	}
	if logs[0].FileName != "all-transactions.csv" {
		t.Errorf("file_name = %q, want all-transactions.csv", logs[0].FileName)
	}
	if logs[0].RowsAdded != 90 {
		t.Errorf("rows_added = %d, want 90", logs[0].RowsAdded)
	}
}

func TestInsertTransactionSourceField(t *testing.T) {
	st, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	r := TransactionRow{
		PostedAt:    mustParseTime("2025-08-19T00:00:00Z"),
		AmountFils:  3825,
		Currency:    "AED",
		Direction:   "debit",
		MerchantRaw: "Amazon.ae",
		Status:      "needs_review",
		Source:      "import",
	}
	_, created, err := st.InsertTransaction(r)
	if err != nil {
		t.Fatal(err)
	}
	if !created {
		t.Error("expected row to be created")
	}
	var src string
	st.DB.QueryRow("SELECT source FROM transactions LIMIT 1").Scan(&src)
	if src != "import" {
		t.Errorf("source = %q, want import", src)
	}
}

func TestInsertTransactionDefaultsSourceToEmail(t *testing.T) {
	st, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	r := TransactionRow{
		PostedAt:    mustParseTime("2025-08-19T00:00:00Z"),
		AmountFils:  1000,
		Currency:    "AED",
		Direction:   "debit",
		MerchantRaw: "DAPPER DAN",
		Status:      "needs_review",
		// Source intentionally empty
	}
	_, _, err = st.InsertTransaction(r)
	if err != nil {
		t.Fatal(err)
	}
	var src string
	st.DB.QueryRow("SELECT source FROM transactions LIMIT 1").Scan(&src)
	if src != "email" {
		t.Errorf("source = %q, want email (default)", src)
	}
}
```

Add `mustParseTime` helper to `transactions_test.go` if it doesn't exist:

```go
import "time"

func mustParseTime(s string) time.Time {
	t, err := time.Parse(time.RFC3339, s)
	if err != nil {
		panic(err)
	}
	return t
}
```

- [ ] **Step 2: Run to confirm failure**

```bash
cd /root/Coding/ledger && go test ./internal/store/... -run "TestInsertAndSelectImportLog|TestInsertTransactionSourceField|TestInsertTransactionDefaultsSourceToEmail" -v 2>&1 | head -20
```

Expected: FAIL — `ImportLogRow` undefined, `Source` field missing.

- [ ] **Step 3: Add `Source` field to `TransactionRow` and update `InsertTransaction`**

In `internal/store/transactions.go`, add `Source string` to the struct:

```go
type TransactionRow struct {
	PostedAt    time.Time
	AmountFils  int64
	Currency    string
	Direction   string
	MerchantRaw string
	Last4       string
	Status      string
	Confidence  float64
	Tier        string
	Source      string // "email" | "import" | "manual"; defaults to "email" if empty
	IngestID    int64
}
```

Update `InsertTransaction` to use `r.Source` (replacing the hardcoded `'email'`):

```go
func (s *Store) InsertTransaction(r TransactionRow) (int64, bool, error) {
	source := r.Source
	if source == "" {
		source = "email"
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	res, err := s.DB.Exec(
		`INSERT OR IGNORE INTO transactions
		   (posted_at, amount, currency, direction, merchant_raw, status, confidence,
		    fingerprint, source, ingest_id, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		r.PostedAt.UTC().Format(time.RFC3339Nano), r.AmountFils, r.Currency, r.Direction,
		r.MerchantRaw, r.Status, r.Confidence, r.Fingerprint(), source, nullableID(r.IngestID), now, now,
	)
	if err != nil {
		return 0, false, err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return 0, false, err
	}
	if n == 0 {
		return 0, false, nil
	}
	id, err := res.LastInsertId()
	return id, true, err
}
```

- [ ] **Step 4: Create `internal/store/import.go`**

```go
package store

import "time"

// ImportLogRow records one completed import batch for auditability.
type ImportLogRow struct {
	ID          int64
	FileName    string
	RowsTotal   int
	RowsAdded   int
	RowsSkipped int
	RowsReview  int
	RowsError   int
	CreatedAt   string
}

// InsertImportLog records a completed import batch and returns the new row ID.
func (s *Store) InsertImportLog(r ImportLogRow) (int64, error) {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	res, err := s.DB.Exec(
		`INSERT INTO import_log
		   (file_name, rows_total, rows_added, rows_skipped, rows_review, rows_error, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		nullableStr(r.FileName), r.RowsTotal, r.RowsAdded, r.RowsSkipped, r.RowsReview, r.RowsError, now,
	)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

// SelectImportLogs returns all import_log rows, newest first.
func (s *Store) SelectImportLogs() ([]ImportLogRow, error) {
	rows, err := s.DB.Query(
		`SELECT id, COALESCE(file_name,''), rows_total, rows_added, rows_skipped,
		        rows_review, rows_error, created_at
		 FROM import_log ORDER BY id DESC`,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []ImportLogRow
	for rows.Next() {
		var r ImportLogRow
		if err := rows.Scan(
			&r.ID, &r.FileName, &r.RowsTotal, &r.RowsAdded,
			&r.RowsSkipped, &r.RowsReview, &r.RowsError, &r.CreatedAt,
		); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}
```

- [ ] **Step 5: Run tests to confirm pass**

```bash
cd /root/Coding/ledger && go test ./internal/store/... -count=1 -v 2>&1 | tail -20
```

Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add internal/store/transactions.go internal/store/import.go internal/store/import_test.go internal/store/transactions_test.go
git commit -m "feat(store): Source field on TransactionRow; import_log methods"
```

---

## Task 2: `internal/importer/mapping.go` — `MapConfig` and field parsers

**Files:**
- Create: `internal/importer/mapping.go`
- Create: `internal/importer/mapping_test.go`

- [ ] **Step 1: Write the failing tests**

Create `internal/importer/mapping_test.go`:

```go
package importer

import (
	"os"
	"path/filepath"
	"testing"
)

func writeMapTOML(t *testing.T, content string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "map.toml")
	if err := os.WriteFile(p, []byte(content), 0644); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestLoadMap_Defaults(t *testing.T) {
	p := writeMapTOML(t, `
[columns]
date        = "Date"
description = "Description"
amount      = "Amount"
`)
	m, err := LoadMap(p)
	if err != nil {
		t.Fatalf("LoadMap: %v", err)
	}
	if m.Currency != "AED" {
		t.Errorf("currency default = %q, want AED", m.Currency)
	}
	if m.DateFormat != "02/01/2006" {
		t.Errorf("date_format default = %q, want 02/01/2006", m.DateFormat)
	}
	if m.DirectionMode != "sign" {
		t.Errorf("direction_mode default = %q, want sign", m.DirectionMode)
	}
}

func TestLoadMap_MissingRequiredColumns(t *testing.T) {
	p := writeMapTOML(t, `[columns]`)
	_, err := LoadMap(p)
	if err == nil {
		t.Error("expected error for missing required columns")
	}
}

func TestParseDate(t *testing.T) {
	m := MapConfig{DateFormat: "02/01/2006"}
	got, err := m.ParseDate("19/08/2025")
	if err != nil {
		t.Fatal(err)
	}
	if got.Year() != 2025 || got.Month() != 8 || got.Day() != 19 {
		t.Errorf("got %v, want 2025-08-19", got)
	}
}

func TestParseAmount_SignMode_Debit(t *testing.T) {
	m := MapConfig{
		DirectionMode: "sign",
		Columns:       ColumnMap{Amount: "Amount"},
	}
	fils, dir, err := m.ParseAmount(map[string]string{"Amount": "-38.25"})
	if err != nil {
		t.Fatal(err)
	}
	if fils != 3825 {
		t.Errorf("fils = %d, want 3825", fils)
	}
	if dir != "debit" {
		t.Errorf("direction = %q, want debit", dir)
	}
}

func TestParseAmount_SignMode_Credit(t *testing.T) {
	m := MapConfig{
		DirectionMode: "sign",
		Columns:       ColumnMap{Amount: "Amount"},
	}
	fils, dir, err := m.ParseAmount(map[string]string{"Amount": "10000.00"})
	if err != nil {
		t.Fatal(err)
	}
	if fils != 1000000 {
		t.Errorf("fils = %d, want 1000000", fils)
	}
	if dir != "credit" {
		t.Errorf("direction = %q, want credit", dir)
	}
}

func TestParseAmount_ColumnsMode(t *testing.T) {
	m := MapConfig{
		DirectionMode: "columns",
		Columns:       ColumnMap{Debit: "Debit", Credit: "Credit"},
	}
	fils, dir, err := m.ParseAmount(map[string]string{"Debit": "215.00", "Credit": ""})
	if err != nil {
		t.Fatal(err)
	}
	if fils != 21500 {
		t.Errorf("fils = %d, want 21500", fils)
	}
	if dir != "debit" {
		t.Errorf("direction = %q, want debit", dir)
	}
}

func TestParseAmount_ThousandsSeparator(t *testing.T) {
	m := MapConfig{
		DirectionMode: "sign",
		Columns:       ColumnMap{Amount: "Amount"},
	}
	fils, _, err := m.ParseAmount(map[string]string{"Amount": "-1,234.56"})
	if err != nil {
		t.Fatal(err)
	}
	if fils != 123456 {
		t.Errorf("fils = %d, want 123456", fils)
	}
}

func TestResolveCategory_Mapped(t *testing.T) {
	m := MapConfig{Categories: map[string]string{"Food & Dining": "Dining"}}
	if got := m.ResolveCategory("Food & Dining"); got != "Dining" {
		t.Errorf("got %q, want Dining", got)
	}
}

func TestResolveCategory_Passthrough(t *testing.T) {
	m := MapConfig{}
	if got := m.ResolveCategory("Shopping"); got != "Shopping" {
		t.Errorf("got %q, want Shopping (passthrough)", got)
	}
}
```

- [ ] **Step 2: Run to confirm failure**

```bash
cd /root/Coding/ledger && go test ./internal/importer/... -v 2>&1 | head -10
```

Expected: FAIL — package not found.

- [ ] **Step 3: Create `internal/importer/mapping.go`**

```go
package importer

import (
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/BurntSushi/toml"
)

// MapConfig declares how to map source file columns to ledger fields.
// It is loaded from a map.toml file provided by the user.
type MapConfig struct {
	Columns         ColumnMap         `toml:"columns"`
	Categories      map[string]string `toml:"categories"`
	Budget          *BudgetSeed       `toml:"budget"`
	DateFormat      string            `toml:"date_format"`
	Currency        string            `toml:"currency"`
	DirectionMode   string            `toml:"direction_mode"` // "sign" | "columns"
	DirectionValues DirectionValues   `toml:"direction_values"`
	SkipZeroAmounts bool              `toml:"skip_zero_amounts"`
}

// ColumnMap declares which header in the source file maps to each ledger field.
type ColumnMap struct {
	Date        string `toml:"date"`        // required
	Description string `toml:"description"` // required
	Amount      string `toml:"amount"`      // required when direction_mode="sign"
	Debit       string `toml:"debit"`       // required when direction_mode="columns"
	Credit      string `toml:"credit"`      // required when direction_mode="columns"
	Category    string `toml:"category"`    // optional
}

// DirectionValues declares what the direction column contains (when direction_mode="columns").
type DirectionValues struct {
	Debit  string `toml:"debit"`
	Credit string `toml:"credit"`
}

// BudgetSeed optionally seeds budget_config from the map file.
type BudgetSeed struct {
	MonthlyIncome float64 `toml:"monthly_income"` // AED decimal
	NeedPct       float64 `toml:"need_pct"`
	WantPct       float64 `toml:"want_pct"`
	SavingPct     float64 `toml:"saving_pct"`
}

// LoadMap reads and validates a map.toml file.
func LoadMap(path string) (MapConfig, error) {
	m := MapConfig{
		Currency:      "AED",
		DateFormat:    "02/01/2006",
		DirectionMode: "sign",
		DirectionValues: DirectionValues{
			Debit:  "Debit",
			Credit: "Credit",
		},
	}
	if _, err := toml.DecodeFile(path, &m); err != nil {
		return MapConfig{}, fmt.Errorf("decode map %q: %w", path, err)
	}
	if m.Columns.Date == "" {
		return MapConfig{}, fmt.Errorf("columns.date is required in %s", path)
	}
	if m.Columns.Description == "" {
		return MapConfig{}, fmt.Errorf("columns.description is required in %s", path)
	}
	switch m.DirectionMode {
	case "sign":
		if m.Columns.Amount == "" {
			return MapConfig{}, fmt.Errorf("columns.amount is required when direction_mode=sign")
		}
	case "columns":
		if m.Columns.Debit == "" || m.Columns.Credit == "" {
			return MapConfig{}, fmt.Errorf("columns.debit and columns.credit are required when direction_mode=columns")
		}
	default:
		return MapConfig{}, fmt.Errorf("direction_mode must be \"sign\" or \"columns\", got %q", m.DirectionMode)
	}
	return m, nil
}

// ResolveCategory maps a source category name to a canonical ledger category name.
// Returns the source name unchanged if no mapping exists.
func (m MapConfig) ResolveCategory(sourceName string) string {
	if canonical, ok := m.Categories[sourceName]; ok {
		return canonical
	}
	return sourceName
}

// ParseDate parses a date string using the configured date_format.
func (m MapConfig) ParseDate(s string) (time.Time, error) {
	s = strings.TrimSpace(s)
	t, err := time.Parse(m.DateFormat, s)
	if err != nil {
		return time.Time{}, fmt.Errorf("parse date %q with format %q: %w", s, m.DateFormat, err)
	}
	return t.UTC(), nil
}

// ParseAmount parses the amount and direction from a raw row.
// Returns (amountFils, direction, error). amountFils is always positive.
func (m MapConfig) ParseAmount(raw map[string]string) (int64, string, error) {
	clean := func(s string) string {
		return strings.ReplaceAll(strings.TrimSpace(s), ",", "")
	}
	round := func(f float64) int64 {
		if f < 0 {
			return int64(-f*100 + 0.5)
		}
		return int64(f*100 + 0.5)
	}

	switch m.DirectionMode {
	case "sign":
		v := clean(raw[m.Columns.Amount])
		if v == "" {
			return 0, "", fmt.Errorf("amount column %q is empty", m.Columns.Amount)
		}
		f, err := strconv.ParseFloat(v, 64)
		if err != nil {
			return 0, "", fmt.Errorf("parse amount %q: %w", v, err)
		}
		if f < 0 {
			return round(f), "debit", nil
		}
		return round(f), "credit", nil

	case "columns":
		dv := clean(raw[m.Columns.Debit])
		cv := clean(raw[m.Columns.Credit])
		if dv != "" && dv != "0" && dv != "0.00" {
			f, err := strconv.ParseFloat(dv, 64)
			if err != nil {
				return 0, "", fmt.Errorf("parse debit column %q: %w", dv, err)
			}
			return round(f), "debit", nil
		}
		if cv != "" && cv != "0" && cv != "0.00" {
			f, err := strconv.ParseFloat(cv, 64)
			if err != nil {
				return 0, "", fmt.Errorf("parse credit column %q: %w", cv, err)
			}
			return round(f), "credit", nil
		}
		return 0, "", fmt.Errorf("both debit (%q) and credit (%q) columns are empty or zero", m.Columns.Debit, m.Columns.Credit)

	default:
		return 0, "", fmt.Errorf("unknown direction_mode %q", m.DirectionMode)
	}
}
```

- [ ] **Step 4: Run tests**

```bash
cd /root/Coding/ledger && go test ./internal/importer/... -v -count=1 2>&1
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/importer/mapping.go internal/importer/mapping_test.go
git commit -m "feat(importer): MapConfig — column mapping, amount/date parsing"
```

---

## Task 3: `internal/importer/reader.go` — CSV + XLSX reading

**Files:**
- Create: `internal/importer/reader.go`
- Modify: `go.mod` / `go.sum` (add excelize for XLSX)
- Modify: `internal/importer/mapping_test.go` → no, add to `importer_test.go`... actually create `internal/importer/reader_test.go`

- [ ] **Step 1: Write the failing tests**

Create `internal/importer/reader_test.go`:

```go
package importer

import (
	"strings"
	"testing"
)

func TestReadCSV_Basic(t *testing.T) {
	input := "Date,Description,Amount,Category\n19/08/2025,Amazon.ae,-38.25,Shopping\n20/08/2025,Salary,10000.00,Salary\n"
	rows, err := ReadCSV(strings.NewReader(input))
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 2 {
		t.Fatalf("got %d rows, want 2", len(rows))
	}
	if rows[0]["Description"] != "Amazon.ae" {
		t.Errorf("description = %q, want Amazon.ae", rows[0]["Description"])
	}
	if rows[1]["Amount"] != "10000.00" {
		t.Errorf("amount = %q, want 10000.00", rows[1]["Amount"])
	}
}

func TestReadCSV_EmptyFile(t *testing.T) {
	rows, err := ReadCSV(strings.NewReader(""))
	if err == nil && len(rows) == 0 {
		// either an error or empty slice is acceptable for header-only input
	}
	// at minimum: should not panic
}

func TestReadCSV_HeaderOnly(t *testing.T) {
	rows, err := ReadCSV(strings.NewReader("Date,Description,Amount\n"))
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 0 {
		t.Errorf("got %d rows, want 0 for header-only CSV", len(rows))
	}
}

func TestReadCSV_TrimsLeadingSpace(t *testing.T) {
	input := " Date , Description , Amount \n19/08/2025,Amazon.ae,-38.25\n"
	rows, err := ReadCSV(strings.NewReader(input))
	if err != nil {
		t.Fatal(err)
	}
	if rows[0]["Date"] != "19/08/2025" {
		t.Errorf("Date key not found or wrong; row = %v", rows[0])
	}
}
```

- [ ] **Step 2: Run to confirm failure**

```bash
cd /root/Coding/ledger && go test ./internal/importer/... -run TestReadCSV -v 2>&1 | head -10
```

Expected: FAIL — `ReadCSV` undefined.

- [ ] **Step 3: Add excelize dependency**

```bash
cd /root/Coding/ledger && go get github.com/xuri/excelize/v2
```

Expected: updates go.mod and go.sum.

- [ ] **Step 4: Create `internal/importer/reader.go`**

```go
package importer

import (
	"encoding/csv"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/xuri/excelize/v2"
)

// RawRow is a single source row keyed by the header name as it appears in the file.
type RawRow = map[string]string

// ReadCSV reads all data rows from a CSV reader, returning header-keyed maps.
// The first row is treated as the header. Header names are trimmed of whitespace.
func ReadCSV(r io.Reader) ([]RawRow, error) {
	cr := csv.NewReader(r)
	cr.TrimLeadingSpace = true
	headers, err := cr.Read()
	if err == io.EOF {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read CSV headers: %w", err)
	}
	for i, h := range headers {
		headers[i] = strings.TrimSpace(h)
	}
	var rows []RawRow
	for {
		record, err := cr.Read()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("read CSV row: %w", err)
		}
		row := make(RawRow, len(headers))
		for i, h := range headers {
			if i < len(record) {
				row[h] = record[i]
			}
		}
		rows = append(rows, row)
	}
	return rows, nil
}

// ReadXLSX reads all rows from the first sheet of an XLSX file.
// The first row is treated as the header. Header names are trimmed of whitespace.
func ReadXLSX(path string) ([]RawRow, error) {
	f, err := excelize.OpenFile(path)
	if err != nil {
		return nil, fmt.Errorf("open xlsx %q: %w", path, err)
	}
	defer f.Close()

	sheets := f.GetSheetList()
	if len(sheets) == 0 {
		return nil, fmt.Errorf("xlsx file has no sheets")
	}
	allRows, err := f.GetRows(sheets[0])
	if err != nil {
		return nil, fmt.Errorf("read sheet %q: %w", sheets[0], err)
	}
	if len(allRows) == 0 {
		return nil, nil
	}
	headers := allRows[0]
	for i, h := range headers {
		headers[i] = strings.TrimSpace(h)
	}
	var out []RawRow
	for _, row := range allRows[1:] {
		r := make(RawRow, len(headers))
		for i, h := range headers {
			if i < len(row) {
				r[h] = row[i]
			}
		}
		out = append(out, r)
	}
	return out, nil
}

// ReadFile reads CSV or XLSX rows based on file extension (.csv or .xlsx).
func ReadFile(path string) ([]RawRow, error) {
	switch strings.ToLower(filepath.Ext(path)) {
	case ".csv":
		f, err := os.Open(path)
		if err != nil {
			return nil, fmt.Errorf("open %q: %w", path, err)
		}
		defer f.Close()
		return ReadCSV(f)
	case ".xlsx":
		return ReadXLSX(path)
	default:
		return nil, fmt.Errorf("unsupported file type %q; use .csv or .xlsx", filepath.Ext(path))
	}
}
```

- [ ] **Step 5: Run tests**

```bash
cd /root/Coding/ledger && go test ./internal/importer/... -v -count=1 2>&1 | tail -15
```

Expected: all PASS (mapping + reader tests).

- [ ] **Step 6: Commit**

```bash
git add internal/importer/reader.go internal/importer/reader_test.go go.mod go.sum
git commit -m "feat(importer): CSV + XLSX reader"
```

---

## Task 4: `internal/importer/normalize.go` — row normalization

**Files:**
- Create: `internal/importer/normalize.go`
- Create: `internal/importer/normalize_test.go`

- [ ] **Step 1: Write the failing tests**

Create `internal/importer/normalize_test.go`:

```go
package importer

import (
	"testing"
)

func baseMap() MapConfig {
	return MapConfig{
		Columns: ColumnMap{
			Date:        "Date",
			Description: "Description",
			Amount:      "Amount",
			Category:    "Category",
		},
		DateFormat:    "02/01/2006",
		Currency:      "AED",
		DirectionMode: "sign",
	}
}

func TestNormalize_HappyPath(t *testing.T) {
	m := baseMap()
	row := RawRow{"Date": "19/08/2025", "Description": "Amazon.ae", "Amount": "-38.25", "Category": "Shopping"}
	n := Normalize(row, m, 1)
	if n.Err != nil {
		t.Fatalf("unexpected error: %v", n.Err)
	}
	if n.Txn.AmountFils != 3825 {
		t.Errorf("amount = %d, want 3825", n.Txn.AmountFils)
	}
	if n.Txn.Direction != "debit" {
		t.Errorf("direction = %q, want debit", n.Txn.Direction)
	}
	if n.Txn.MerchantRaw != "Amazon.ae" {
		t.Errorf("merchant = %q, want Amazon.ae", n.Txn.MerchantRaw)
	}
	if n.CategoryName != "Shopping" {
		t.Errorf("category = %q, want Shopping", n.CategoryName)
	}
	if n.Txn.Source != "import" {
		t.Errorf("source = %q, want import", n.Txn.Source)
	}
	if n.Txn.Currency != "AED" {
		t.Errorf("currency = %q, want AED", n.Txn.Currency)
	}
	if n.Txn.PostedAt.Year() != 2025 {
		t.Errorf("year = %d, want 2025", n.Txn.PostedAt.Year())
	}
}

func TestNormalize_CategoryMapping(t *testing.T) {
	m := baseMap()
	m.Categories = map[string]string{"Food & Dining": "Dining"}
	row := RawRow{"Date": "19/08/2025", "Description": "Restaurant", "Amount": "-50.00", "Category": "Food & Dining"}
	n := Normalize(row, m, 1)
	if n.Err != nil {
		t.Fatal(n.Err)
	}
	if n.CategoryName != "Dining" {
		t.Errorf("category = %q, want Dining after mapping", n.CategoryName)
	}
}

func TestNormalize_NoCategoryColumn(t *testing.T) {
	m := baseMap()
	m.Columns.Category = "" // no category column
	row := RawRow{"Date": "19/08/2025", "Description": "Amazon.ae", "Amount": "-38.25"}
	n := Normalize(row, m, 1)
	if n.Err != nil {
		t.Fatal(n.Err)
	}
	if n.CategoryName != "" {
		t.Errorf("category = %q, want empty when no category column", n.CategoryName)
	}
}

func TestNormalize_EmptyDate(t *testing.T) {
	m := baseMap()
	row := RawRow{"Date": "", "Description": "Amazon.ae", "Amount": "-38.25"}
	n := Normalize(row, m, 1)
	if n.Err == nil {
		t.Error("expected error for empty date")
	}
}

func TestNormalize_BadDate(t *testing.T) {
	m := baseMap()
	row := RawRow{"Date": "not-a-date", "Description": "Amazon.ae", "Amount": "-38.25"}
	n := Normalize(row, m, 5)
	if n.Err == nil {
		t.Error("expected error for unparseable date")
	}
}

func TestNormalize_EmptyDescription(t *testing.T) {
	m := baseMap()
	row := RawRow{"Date": "19/08/2025", "Description": "", "Amount": "-38.25"}
	n := Normalize(row, m, 1)
	if n.Err == nil {
		t.Error("expected error for empty description")
	}
}

func TestNormalize_StatusAlwaysNeedsReview(t *testing.T) {
	m := baseMap()
	row := RawRow{"Date": "19/08/2025", "Description": "Amazon.ae", "Amount": "-38.25", "Category": "Shopping"}
	n := Normalize(row, m, 1)
	if n.Txn.Status != "needs_review" {
		t.Errorf("status = %q, want needs_review (category/status set post-insert)", n.Txn.Status)
	}
}
```

- [ ] **Step 2: Run to confirm failure**

```bash
cd /root/Coding/ledger && go test ./internal/importer/... -run TestNormalize -v 2>&1 | head -10
```

Expected: FAIL — `Normalize` undefined.

- [ ] **Step 3: Create `internal/importer/normalize.go`**

```go
package importer

import (
	"fmt"
	"strings"

	"ledger/internal/store"
)

// NormalizedRow is a source row after field resolution. Err is non-nil for rows
// that failed to parse; they are counted as rows_error and skipped.
type NormalizedRow struct {
	Txn          store.TransactionRow
	CategoryName string // resolved canonical category name; empty when no category column
	RowIndex     int    // 1-based (for error messages)
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
	n.Txn.Status = "needs_review" // promoted to confirmed by Importer.Run after category assignment

	// Optional category column
	if m.Columns.Category != "" {
		if catName := strings.TrimSpace(raw[m.Columns.Category]); catName != "" {
			n.CategoryName = m.ResolveCategory(catName)
		}
	}

	return n
}
```

- [ ] **Step 4: Run tests**

```bash
cd /root/Coding/ledger && go test ./internal/importer/... -v -count=1 2>&1 | tail -15
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/importer/normalize.go internal/importer/normalize_test.go
git commit -m "feat(importer): row normalization — date, amount, direction, category"
```

---

## Task 5: `internal/importer/importer.go` — `Run` orchestration

**Files:**
- Create: `internal/importer/importer.go`
- Create: `internal/importer/importer_test.go`

- [ ] **Step 1: Write the failing tests**

Create `internal/importer/importer_test.go`:

```go
package importer_test

import (
	"context"
	"testing"

	"ledger/internal/importer"
	"ledger/internal/store"
)

func newTestStore(t *testing.T) *store.Store {
	t.Helper()
	st, err := store.Open(t.TempDir())
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { st.Close() })
	return st
}

func baseMapConfig() importer.MapConfig {
	return importer.MapConfig{
		Columns: importer.ColumnMap{
			Date:        "Date",
			Description: "Description",
			Amount:      "Amount",
			Category:    "Category",
		},
		DateFormat:      "02/01/2006",
		Currency:        "AED",
		DirectionMode:   "sign",
		SkipZeroAmounts: true,
	}
}

func TestRun_DryRun_NoWrites(t *testing.T) {
	st := newTestStore(t)
	imp := importer.New(st, nil)
	rows := []importer.RawRow{
		{"Date": "19/08/2025", "Description": "Amazon.ae", "Amount": "-38.25", "Category": "Shopping"},
		{"Date": "20/08/2025", "Description": "Salary", "Amount": "10000.00", "Category": "Salary"},
	}
	result, err := imp.Run(context.Background(), rows, baseMapConfig(), "test.csv", true)
	if err != nil {
		t.Fatal(err)
	}
	if result.RowsTotal != 2 {
		t.Errorf("total = %d, want 2", result.RowsTotal)
	}
	if result.RowsAdded != 2 {
		t.Errorf("added (dry) = %d, want 2", result.RowsAdded)
	}
	// dry-run must not write to DB
	txns, _ := st.SelectTransactions("", "", "")
	if len(txns) != 0 {
		t.Errorf("dry-run wrote %d txns, want 0", len(txns))
	}
	logs, _ := st.SelectImportLogs()
	if len(logs) != 0 {
		t.Errorf("dry-run wrote %d import_log rows, want 0", len(logs))
	}
}

func TestRun_WetRun_InsertsAndCategorizes(t *testing.T) {
	st := newTestStore(t)
	imp := importer.New(st, nil)
	rows := []importer.RawRow{
		{"Date": "19/08/2025", "Description": "Amazon.ae", "Amount": "-38.25", "Category": "Shopping"},
	}
	result, err := imp.Run(context.Background(), rows, baseMapConfig(), "test.csv", false)
	if err != nil {
		t.Fatal(err)
	}
	if result.RowsAdded != 1 {
		t.Fatalf("added = %d, want 1", result.RowsAdded)
	}
	txns, _ := st.SelectTransactions("confirmed", "", "")
	if len(txns) != 1 {
		t.Fatalf("confirmed txns = %d, want 1", len(txns))
	}
	if txns[0].MerchantRaw != "Amazon.ae" {
		t.Errorf("merchant = %q, want Amazon.ae", txns[0].MerchantRaw)
	}
	// Import log should be written
	logs, _ := st.SelectImportLogs()
	if len(logs) != 1 {
		t.Errorf("import_log rows = %d, want 1", len(logs))
	}
	if logs[0].FileName != "test.csv" {
		t.Errorf("file_name = %q, want test.csv", logs[0].FileName)
	}
}

func TestRun_NoCategoryColumn_RoutesToReview(t *testing.T) {
	st := newTestStore(t)
	imp := importer.New(st, nil)
	m := baseMapConfig()
	m.Columns.Category = "" // no category column
	rows := []importer.RawRow{
		{"Date": "19/08/2025", "Description": "Unknown Merchant", "Amount": "-100.00"},
	}
	result, err := imp.Run(context.Background(), rows, m, "test.csv", false)
	if err != nil {
		t.Fatal(err)
	}
	if result.RowsReview != 1 {
		t.Errorf("review = %d, want 1", result.RowsReview)
	}
	txns, _ := st.SelectTransactions("needs_review", "", "")
	if len(txns) != 1 {
		t.Errorf("needs_review txns = %d, want 1", len(txns))
	}
}

func TestRun_Idempotent(t *testing.T) {
	st := newTestStore(t)
	imp := importer.New(st, nil)
	rows := []importer.RawRow{
		{"Date": "19/08/2025", "Description": "Amazon.ae", "Amount": "-38.25", "Category": "Shopping"},
	}
	r1, _ := imp.Run(context.Background(), rows, baseMapConfig(), "test.csv", false)
	r2, _ := imp.Run(context.Background(), rows, baseMapConfig(), "test.csv", false)
	if r1.RowsAdded != 1 {
		t.Errorf("first run: added = %d, want 1", r1.RowsAdded)
	}
	if r2.RowsSkipped != 1 {
		t.Errorf("second run: skipped = %d, want 1 (fingerprint dedup)", r2.RowsSkipped)
	}
	if r2.RowsAdded != 0 {
		t.Errorf("second run: added = %d, want 0", r2.RowsAdded)
	}
}

func TestRun_SkipZeroAmounts(t *testing.T) {
	st := newTestStore(t)
	imp := importer.New(st, nil)
	m := baseMapConfig()
	m.SkipZeroAmounts = true
	rows := []importer.RawRow{
		{"Date": "19/08/2025", "Description": "Zero", "Amount": "0.00", "Category": "Shopping"},
		{"Date": "20/08/2025", "Description": "Real", "Amount": "-50.00", "Category": "Shopping"},
	}
	result, _ := imp.Run(context.Background(), rows, m, "test.csv", false)
	if result.RowsSkipped != 1 {
		t.Errorf("skipped = %d, want 1 (zero amount)", result.RowsSkipped)
	}
	if result.RowsAdded != 1 {
		t.Errorf("added = %d, want 1", result.RowsAdded)
	}
}

func TestRun_DeriveRules_ThresholdThree(t *testing.T) {
	st := newTestStore(t)
	imp := importer.New(st, nil)
	// Same merchant, same category, 3 different days → should derive a rule
	rows := []importer.RawRow{
		{"Date": "01/08/2025", "Description": "AMAZON.AE", "Amount": "-10.00", "Category": "Shopping"},
		{"Date": "02/08/2025", "Description": "AMAZON.AE", "Amount": "-20.00", "Category": "Shopping"},
		{"Date": "03/08/2025", "Description": "AMAZON.AE", "Amount": "-30.00", "Category": "Shopping"},
	}
	result, err := imp.Run(context.Background(), rows, baseMapConfig(), "test.csv", false)
	if err != nil {
		t.Fatal(err)
	}
	if result.DerivedRules != 1 {
		t.Errorf("derived rules = %d, want 1", result.DerivedRules)
	}
	rules, _ := st.SelectRules()
	var found bool
	for _, r := range rules {
		if r.Source == "import_derived" {
			found = true
		}
	}
	if !found {
		t.Error("expected an import_derived rule in rules table")
	}
}

func TestRun_DeriveRules_BelowThresholdNoRule(t *testing.T) {
	st := newTestStore(t)
	imp := importer.New(st, nil)
	// Only 2 occurrences — below threshold of 3
	rows := []importer.RawRow{
		{"Date": "01/08/2025", "Description": "RARE SHOP", "Amount": "-10.00", "Category": "Shopping"},
		{"Date": "02/08/2025", "Description": "RARE SHOP", "Amount": "-20.00", "Category": "Shopping"},
	}
	result, _ := imp.Run(context.Background(), rows, baseMapConfig(), "test.csv", false)
	if result.DerivedRules != 0 {
		t.Errorf("derived rules = %d, want 0 (below threshold)", result.DerivedRules)
	}
}

func TestRun_ErrorRows_DoNotBlock(t *testing.T) {
	st := newTestStore(t)
	imp := importer.New(st, nil)
	rows := []importer.RawRow{
		{"Date": "BAD DATE", "Description": "Broken", "Amount": "-10.00"},
		{"Date": "19/08/2025", "Description": "Good", "Amount": "-20.00", "Category": "Shopping"},
	}
	result, err := imp.Run(context.Background(), rows, baseMapConfig(), "test.csv", false)
	if err != nil {
		t.Fatal(err)
	}
	if result.RowsError != 1 {
		t.Errorf("errors = %d, want 1", result.RowsError)
	}
	if result.RowsAdded != 1 {
		t.Errorf("added = %d, want 1 (good row still inserted)", result.RowsAdded)
	}
}
```

- [ ] **Step 2: Run to confirm failure**

```bash
cd /root/Coding/ledger && go test ./internal/importer/... -run TestRun -v 2>&1 | head -10
```

Expected: FAIL — `importer.New`, `importer.Result` undefined.

- [ ] **Step 3: Create `internal/importer/importer.go`**

```go
package importer

import (
	"context"
	"fmt"
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
	RowsAdded    int // inserted as confirmed (had a category)
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
			_ = imp.store.UpdateTransactionCategory(txID, catID, status)
			res.RowsAdded++
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
				cfg.MonthlyIncome = int64(m.Budget.MonthlyIncome*100 + 0.5)
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
```

- [ ] **Step 4: Run all tests**

```bash
cd /root/Coding/ledger && go test ./internal/importer/... -v -count=1 2>&1
```

Expected: all PASS.

- [ ] **Step 5: Run the full test suite**

```bash
cd /root/Coding/ledger && go test ./... -count=1 2>&1 | tail -15
```

Expected: all packages PASS.

- [ ] **Step 6: Commit**

```bash
git add internal/importer/importer.go internal/importer/importer_test.go
git commit -m "feat(importer): Run orchestration — normalize, insert, categorize, rule derivation"
```

---

## Task 6: CLI subcommand in `cmd/ledger/main.go`

**Files:**
- Modify: `cmd/ledger/main.go`
- Create: `docs/map.example.toml`

- [ ] **Step 1: Add `import` subcommand to `main.go`**

Read `cmd/ledger/main.go` first. Add these imports at the top:

```go
import (
	// ... existing imports ...
	"fmt"
	"os"
	"path/filepath"

	"ledger/internal/importer"
)
```

Add the subcommand check as the very first thing in `main()`, before `flag.Parse()`:

```go
func main() {
	if len(os.Args) > 1 && os.Args[1] == "import" {
		runImport(os.Args[2:])
		return
	}
	// ... existing server code unchanged ...
}
```

Add `runImport` after `main()`:

```go
func runImport(args []string) {
	fs := flag.NewFlagSet("import", flag.ExitOnError)
	filePath := fs.String("file", "", "path to CSV or XLSX file (required)")
	mapPath := fs.String("map", "map.toml", "path to map.toml column-mapping file")
	dryRun := fs.Bool("dry-run", false, "validate and report without writing to the database")
	configPath := fs.String("config", "", "path to config.toml (optional; uses defaults if empty)")
	if err := fs.Parse(args); err != nil {
		log.Fatalf("import flags: %v", err)
	}
	if *filePath == "" {
		log.Fatal("import: --file is required")
	}

	cfg, err := config.Load(*configPath)
	if err != nil {
		log.Fatalf("config: %v", err)
	}
	st, err := store.Open(cfg.Server.DataDir)
	if err != nil {
		log.Fatalf("store: %v", err)
	}
	defer st.Close()

	m, err := importer.LoadMap(*mapPath)
	if err != nil {
		log.Fatalf("map: %v", err)
	}

	rows, err := importer.ReadFile(*filePath)
	if err != nil {
		log.Fatalf("read file: %v", err)
	}

	// Build rules-only categorizer from live store data.
	storeCats, _ := st.SelectCategories()
	storeRules, _ := st.SelectRules()
	domainCats := make([]categorize.Category, len(storeCats))
	for i, c := range storeCats {
		domainCats[i] = categorize.Category{ID: c.ID, Name: c.Name, Kind: c.Kind, Bucket: c.Bucket}
	}
	domainRules := make([]categorize.Rule, len(storeRules))
	for i, r := range storeRules {
		domainRules[i] = categorize.Rule{
			MatchType:  r.MatchType,
			Pattern:    r.Pattern,
			CategoryID: r.CategoryID,
			Priority:   r.Priority,
		}
	}
	cat := categorize.New(domainRules, domainCats, categorize.DisabledAI{}, 0.85, false)

	imp := importer.New(st, cat)
	result, err := imp.Run(context.Background(), rows, m, filepath.Base(*filePath), *dryRun)
	if err != nil {
		log.Fatalf("import: %v", err)
	}

	mode := "COMMITTED"
	if *dryRun {
		mode = "DRY RUN"
	}
	fmt.Printf("\n[%s] %s\n", mode, *filePath)
	fmt.Printf("  Total rows:         %d\n", result.RowsTotal)
	fmt.Printf("  Added (confirmed):  %d\n", result.RowsAdded)
	fmt.Printf("  Review queue:       %d\n", result.RowsReview)
	fmt.Printf("  Skipped (dedup):    %d\n", result.RowsSkipped)
	fmt.Printf("  Errors:             %d\n", result.RowsError)
	if !*dryRun {
		fmt.Printf("  Rules derived:      %d\n", result.DerivedRules)
	}
	if result.RowsError > 0 {
		fmt.Fprintln(os.Stderr, "\nWARNING: some rows had errors — check output above")
		os.Exit(1)
	}
}
```

- [ ] **Step 2: Run build to confirm it compiles**

```bash
cd /root/Coding/ledger && go build ./... 2>&1
```

Expected: clean.

- [ ] **Step 3: Run full test suite**

```bash
cd /root/Coding/ledger && go test ./... -count=1 2>&1 | tail -10
```

Expected: all PASS.

- [ ] **Step 4: Smoke-test the subcommand with `--help`**

```bash
/usr/local/bin/ledger import --help 2>&1 || true
```

Expected: prints usage (or an unknown flag message — anything but a panic).

Actually, let's test against a real minimal CSV:

```bash
printf 'Date,Description,Amount,Category\n19/08/2025,Test Merchant,-50.00,Shopping\n' > /tmp/test-import.csv
cat > /tmp/test-map.toml << 'EOF'
[columns]
date        = "Date"
description = "Description"
amount      = "Amount"
category    = "Category"

date_format    = "02/01/2006"
currency       = "AED"
direction_mode = "sign"
EOF
cd /root/Coding/ledger && go run ./cmd/ledger import --file /tmp/test-import.csv --map /tmp/test-map.toml --dry-run 2>&1
```

Expected:
```
[DRY RUN] /tmp/test-import.csv
  Total rows:         1
  Added (confirmed):  1
  Review queue:       0
  Skipped (dedup):    0
  Errors:             0
```

- [ ] **Step 5: Create `docs/map.example.toml`**

```toml
# map.example.toml — Column and category mapping for `ledger import`.
# Copy this file to map.toml and edit to match your export format.
#
# Usage:
#   ledger import --file all-transactions.csv --map map.toml --dry-run
#   ledger import --file all-transactions.csv --map map.toml

# ── Column mapping ──────────────────────────────────────────────────────────
# The exact header names in your CSV or XLSX file.
[columns]
date        = "Date"           # required — e.g. "Date", "Transaction Date"
description = "Description"    # required — maps to merchant_raw
amount      = "Amount"         # required when direction_mode = "sign"
# debit     = "Debit"          # required when direction_mode = "columns"
# credit    = "Credit"         # required when direction_mode = "columns"
category    = "Category"       # optional — if present, maps to canonical category name

# ── Date parsing ─────────────────────────────────────────────────────────────
# Go reference time: Mon Jan 2 15:04:05 MST 2006
# Common formats:
#   "02/01/2006"  = DD/MM/YYYY  (default)
#   "2006-01-02"  = ISO 8601
#   "01/02/2006"  = MM/DD/YYYY (US)
#   "2/1/2006"    = M/D/YYYY
date_format = "02/01/2006"

# ── Currency ─────────────────────────────────────────────────────────────────
currency = "AED"   # applied to all rows

# ── Direction mode ───────────────────────────────────────────────────────────
# "sign"    → single Amount column; negative = debit, positive = credit (default)
# "columns" → separate Debit and Credit columns (columns.debit / columns.credit)
direction_mode = "sign"

# Skip rows where the amount resolves to zero
skip_zero_amounts = true

# ── Category name mapping ─────────────────────────────────────────────────────
# Maps your export's category names to ledger's canonical category names.
# Unmapped names are used as-is and create a new "spending / want" category.
# Format: "Source Name" = "Canonical Name"
[categories]
"Food & Dining"       = "Dining"
"Bills & Utilities"   = "Utilities"
"Transportation"      = "Transport"
"Health & Fitness"    = "Healthcare"
"Rent & Housing"      = "Rent"
"Personal Care"       = "Shopping"
"Entertainment"       = "Entertainment"
"Travel"              = "Travel"
"Shopping"            = "Shopping"
"Savings"             = "Savings"
"Salary"              = "Salary"
"Transfers"           = "Transfers"
"Reimbursements"      = "Reimbursements"

# ── Budget seeding (optional) ─────────────────────────────────────────────────
# If set, seeds budget_config from this import (safe to omit).
# [budget]
# monthly_income = 25000.00   # in AED; converted to fils internally
# need_pct       = 0.50
# want_pct       = 0.30
# saving_pct     = 0.20
```

- [ ] **Step 6: Commit**

```bash
git add cmd/ledger/main.go docs/map.example.toml
git commit -m "feat(cmd): ledger import subcommand — CSV/XLSX historical import with dry-run"
```

---

## Task 7: Deploy and smoke-test on dinosaur

**Files:** none new — just build, deploy, and verify.

- [ ] **Step 1: Build and deploy**

```bash
cd /root/Coding/ledger && \
  CGO_ENABLED=0 go build -o /usr/local/bin/ledger ./cmd/ledger && \
  systemctl restart ledger && \
  systemctl status ledger --no-pager
```

Expected: `active (running)`.

- [ ] **Step 2: Verify the `--help` text**

```bash
/usr/local/bin/ledger import --help 2>&1 || true
```

Expected: prints flag descriptions.

- [ ] **Step 3: Run a dry-run against your CSV export**

```bash
/usr/local/bin/ledger import \
  --file /path/to/all-transactions.csv \
  --map /path/to/map.toml \
  --dry-run
```

Expected: a summary showing RowsTotal/Added/Review/Errors. If RowsError > 0, check the error lines and update `map.toml` accordingly.

- [ ] **Step 4: Commit the real import (when dry-run looks clean)**

```bash
/usr/local/bin/ledger import \
  --file /path/to/all-transactions.csv \
  --map /path/to/map.toml
```

Expected: summary with `[COMMITTED]`, DerivedRules ≥ 0.

- [ ] **Step 5: Verify via API**

```bash
curl -s http://localhost:8080/api/transactions | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'{len(d)} total transactions')"
curl -s http://localhost:8080/api/review | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'{len(d)} in review queue')"
```

Expected: totals include the imported rows.

- [ ] **Step 6: Tag**

```bash
git tag m6-import
```

---

## Self-Review

### Spec Coverage (§6.9 + §10 milestone 6)

| Spec requirement | Task |
|---|---|
| `ledger import --file ... --map ... --dry-run` CLI | Task 6 |
| `map.toml` column mapping + category-name mapping | Task 2 |
| AED amounts → fils | Task 2 (`ParseAmount`) |
| Date format → ISO8601 | Task 2 (`ParseDate`) |
| Sign convention → `direction` + positive amount | Task 2 (`ParseAmount`) |
| Same fingerprint as email parser (dedup-safe) | Task 1 (`TransactionRow.Fingerprint()` unchanged; Source field added) |
| `source = 'import'` on imported rows | Task 4 (`Normalize`) |
| Dry-run: validate + report, commit nothing | Task 5 |
| Idempotent: re-running adds nothing (INSERT OR IGNORE) | Task 5 |
| Bootstraps rules engine from historical data | Task 5 (rule derivation, threshold=3) |
| Seeds category table from history | Task 5 (`ensureCategory`) |
| Optional: seeds budget_config | Task 5 (`m.Budget` block) |
| `import_log` batch record for auditability | Task 5 |
| XLSX support | Task 3 (excelize) |
| Example map.toml | Task 6 |

### Placeholder scan

No TBD, "implement later", or vague steps. All code blocks are complete.

### Type consistency

- `importer.RawRow = map[string]string` — used in reader.go, normalize.go, importer.go ✓
- `importer.NormalizedRow.Txn` is `store.TransactionRow` — Source field added in Task 1 ✓
- `importer.Result` fields (`RowsAdded`, `RowsSkipped`, `RowsReview`, `RowsError`, `DerivedRules`) match `store.ImportLogRow` fields ✓
- `categorize.New(rules, cats, DisabledAI{}, threshold, autoRule)` — same signature as M4 ✓
- `store.InsertTransaction` returns `(int64, bool, error)` — unchanged from M4 ✓

### Known limitation (documented in header)

Imported rows use empty `last4` in the fingerprint. Email-parsed rows that captured a real last4 for the same transaction will have a different fingerprint — they will coexist as duplicate rows rather than deduplicating. Recommend: import only up to the date IMAP ingest started.
