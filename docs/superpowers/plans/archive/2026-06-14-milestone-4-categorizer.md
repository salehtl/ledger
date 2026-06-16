# Milestone 4 — Categorizer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the 2,370 `needs_review` transactions into categorized, budgeted spending by building a rules-first categorizer (with Anthropic AI as fallback), seeding default categories, and wiring the real AI client into both the categorization and extraction tiers.

**Architecture:** A `categorize` package orchestrates two tiers — a rules matcher (checks `rules` table by priority, case-insensitive) then an Anthropic AI fallback that sends *only the merchant string* and gets back `{category, confidence}`. A result at or above `auto_accept_threshold` is auto-confirmed and optionally writes back a rule; below threshold stays `needs_review`. The real `AnthropicExtractor` (deferred from M3) is also wired in M4 since the HTTP client pattern is identical. New API endpoints let the frontend review and manually categorize transactions.

**Tech Stack:** Go 1.25, SQLite via `modernc.org/sqlite`, Anthropic Messages API over `net/http` (no SDK — plain HTTP + JSON), standard library testing.

---

## File Map

| File | Status | Responsibility |
|---|---|---|
| `internal/config/config.go` | Modify | Add `AIConfig` struct and `[ai]` section |
| `internal/config/config_test.go` | Modify | Tests for AI config loading and validation |
| `internal/store/categories.go` | **Create** | `InsertCategory`, `SelectCategories`, `SelectRules`, `InsertRule`, `UpdateTransactionCategory`, `UpdateTransactionStatus`, `SelectNeedsReview`, `SelectTransactions`, `SeedDefaultCategories` |
| `internal/store/categories_test.go` | **Create** | Tests for all category/rule store methods |
| `internal/store/transactions.go` | Modify | `InsertTransaction` returns `(int64, bool, error)` (adds row ID) |
| `internal/store/transactions_test.go` | Modify | Update call sites to accept 3-return signature |
| `internal/categorize/categorize.go` | **Create** | `Category`, `Rule`, `Result` types; `RuleMatcher` (exact/contains/regex); `Categorizer` orchestrator |
| `internal/categorize/categorize_test.go` | **Create** | Table-driven tests for each match type + orchestration |
| `internal/categorize/ai.go` | **Create** | `AnthropicCategorizer` (real HTTP client); `DisabledCategorizer` |
| `internal/categorize/ai_test.go` | **Create** | Tests against a mock HTTP server |
| `internal/parse/ai.go` | Modify | Add `AnthropicExtractor` (real HTTP client); keep `DisabledExtractor` |
| `internal/parse/ai_test.go` | **Create** | Tests for `AnthropicExtractor` against a mock HTTP server |
| `internal/parse/processor.go` | Modify | Inject `*categorize.Categorizer`; call it after `InsertTransaction` |
| `internal/parse/processor_test.go` | Modify | Add categorizer to processor setup; verify category assignment |
| `internal/server/categories.go` | **Create** | `GET/POST /api/categories` handlers |
| `internal/server/categories_test.go` | **Create** | Tests for categories endpoints |
| `internal/server/review.go` | **Create** | `GET /api/review`, `GET /api/transactions` handlers |
| `internal/server/review_test.go` | **Create** | Tests for review/transactions endpoints |
| `internal/server/transactions.go` | **Create** | `POST /api/transactions/{id}/categorize`, `POST /api/transactions/{id}/status`, `POST /api/recategorize` handlers |
| `internal/server/transactions_test.go` | **Create** | Tests for transaction action endpoints |
| `internal/server/server.go` | Modify | Add new routes; add `Categorizer` field and `SetCategorizer` method |
| `cmd/ledger/main.go` | Modify | Wire AI config, build real categorizer + extractor, seed categories |
| `config.example.toml` | Modify | Uncomment and document `[ai]` section |

---

## Task 1: AI Config

Add `[ai]` section to `config.Config`. The API key is env-only (`LEDGER_AI_API_KEY`).

**Files:**
- Modify: `internal/config/config.go`
- Modify: `internal/config/config_test.go`

- [ ] **Step 1: Write failing tests**

Add to `internal/config/config_test.go`:

```go
func TestAIConfigDefaults(t *testing.T) {
    cfg, err := Load("")
    if err != nil {
        t.Fatal(err)
    }
    if cfg.AI.Enabled {
        t.Error("AI must default to disabled")
    }
    if cfg.AI.AutoAcceptThreshold != 0.85 {
        t.Errorf("auto_accept_threshold default = %v, want 0.85", cfg.AI.AutoAcceptThreshold)
    }
    if cfg.AI.Model != "claude-haiku-4-5-20251001" {
        t.Errorf("model default = %q, want claude-haiku-4-5-20251001", cfg.AI.Model)
    }
}

func TestAIConfigEnvAPIKey(t *testing.T) {
    t.Setenv("LEDGER_AI_API_KEY", "sk-test-key")
    cfg, err := Load("")
    if err != nil {
        t.Fatal(err)
    }
    if cfg.AI.APIKey != "sk-test-key" {
        t.Errorf("APIKey = %q, want sk-test-key", cfg.AI.APIKey)
    }
}

func TestAIConfigEnabledRequiresAPIKey(t *testing.T) {
    f := writeTOML(t, `
[ai]
enabled = true
`)
    _, err := Load(f)
    if err == nil {
        t.Error("expected error when AI enabled but no API key")
    }
}
```

Add `writeTOML` helper at the top of `config_test.go` if not already present:

```go
func writeTOML(t *testing.T, content string) string {
    t.Helper()
    f := filepath.Join(t.TempDir(), "config.toml")
    if err := os.WriteFile(f, []byte(content), 0644); err != nil {
        t.Fatal(err)
    }
    return f
}
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /root/Coding/ledger && go test ./internal/config/... -run TestAI -v
```
Expected: FAIL — `cfg.AI` field undefined.

- [ ] **Step 3: Implement AIConfig in config.go**

Add after `IMAPConfig`:

```go
// AIConfig holds settings for the Anthropic AI client (categorization + extraction fallback).
// The API key is NEVER read from TOML; it comes from LEDGER_AI_API_KEY.
type AIConfig struct {
    Enabled              bool    `toml:"enabled"`
    Model                string  `toml:"model"`
    AutoAcceptThreshold  float64 `toml:"auto_accept_threshold"`
    AutoRule             bool    `toml:"auto_rule"`
    AllowAIExtraction    bool    `toml:"allow_ai_extraction"`
    APIKey               string  `toml:"-"` // env only
}
```

Update `Config` struct to add the field:
```go
type Config struct {
    Server ServerConfig `toml:"server"`
    IMAP   IMAPConfig   `toml:"imap"`
    AI     AIConfig     `toml:"ai"`
}
```

Update `defaults()`:
```go
AI: AIConfig{
    Model:               "claude-haiku-4-5-20251001",
    AutoAcceptThreshold: 0.85,
    AllowAIExtraction:   true,
},
```

Add env override in `Load()` (after IMAP block):
```go
if v := os.Getenv("LEDGER_AI_API_KEY"); v != "" {
    cfg.AI.APIKey = v
}
```

Add validation in `validate()`:
```go
if cfg.AI.Enabled && cfg.AI.APIKey == "" {
    return fmt.Errorf("ai.enabled requires LEDGER_AI_API_KEY env var")
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /root/Coding/ledger && go test ./internal/config/... -v
```
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/config/config.go internal/config/config_test.go
git commit -m "feat(config): add [ai] section with model, threshold, and env API key"
```

---

## Task 2: Store — Categories, Rules, and Transaction Updates

Add DB methods for categories and rules, and change `InsertTransaction` to return the row ID alongside the insertion boolean.

**Files:**
- Create: `internal/store/categories.go`
- Create: `internal/store/categories_test.go`
- Modify: `internal/store/transactions.go`
- Modify: `internal/store/transactions_test.go`

- [ ] **Step 1: Write failing tests in `internal/store/categories_test.go`**

```go
package store

import (
    "testing"
    "time"
)

func TestSeedDefaultCategories(t *testing.T) {
    st := newTestStore(t)
    if err := st.SeedDefaultCategories(); err != nil {
        t.Fatalf("SeedDefaultCategories: %v", err)
    }
    cats, err := st.SelectCategories()
    if err != nil {
        t.Fatalf("SelectCategories: %v", err)
    }
    if len(cats) == 0 {
        t.Fatal("expected seeded categories, got none")
    }
    // Check a known seed
    var found bool
    for _, c := range cats {
        if c.Name == "Groceries" && c.Kind == "spending" && c.Bucket == "need" {
            found = true
        }
    }
    if !found {
        t.Error("expected Groceries/spending/need in seeded categories")
    }
}

func TestSeedDefaultCategoriesIdempotent(t *testing.T) {
    st := newTestStore(t)
    if err := st.SeedDefaultCategories(); err != nil {
        t.Fatal(err)
    }
    if err := st.SeedDefaultCategories(); err != nil {
        t.Fatal("second seed must not error")
    }
    cats, _ := st.SelectCategories()
    // Count shouldn't double
    names := make(map[string]int)
    for _, c := range cats {
        names[c.Name]++
    }
    if names["Groceries"] > 1 {
        t.Error("Groceries appears more than once after double seed")
    }
}

func TestInsertAndSelectRules(t *testing.T) {
    st := newTestStore(t)
    if err := st.SeedDefaultCategories(); err != nil {
        t.Fatal(err)
    }
    cats, _ := st.SelectCategories()
    var groceriesID int64
    for _, c := range cats {
        if c.Name == "Groceries" {
            groceriesID = c.ID
        }
    }
    if groceriesID == 0 {
        t.Fatal("Groceries category not found")
    }

    rule := RuleRow{
        MatchType:  "contains",
        Pattern:    "AMAZON",
        CategoryID: groceriesID,
        Priority:   100,
        Source:     "manual",
    }
    if err := st.InsertRule(rule); err != nil {
        t.Fatalf("InsertRule: %v", err)
    }
    rules, err := st.SelectRules()
    if err != nil {
        t.Fatalf("SelectRules: %v", err)
    }
    if len(rules) != 1 || rules[0].Pattern != "AMAZON" {
        t.Errorf("SelectRules = %+v, want one AMAZON rule", rules)
    }
}

func TestInsertTransactionReturnsID(t *testing.T) {
    st := newTestStore(t)
    if _, err := st.InsertIngest(IngestRecord{MessageUID: "u1", FromAddr: "x@y.com",
        Subject: "s", ParseStatus: "parsed", RawBody: []byte("r"), CreatedAt: time.Now()}); err != nil {
        t.Fatal(err)
    }
    var ingestID int64
    st.DB.QueryRow("SELECT id FROM ingest_log LIMIT 1").Scan(&ingestID)

    row := txnRow()
    row.IngestID = ingestID
    id, created, err := st.InsertTransaction(row)
    if err != nil {
        t.Fatalf("InsertTransaction: %v", err)
    }
    if !created {
        t.Error("first insert should report created=true")
    }
    if id <= 0 {
        t.Errorf("id = %d, want > 0", id)
    }
    // Duplicate returns id=0 and created=false
    id2, created2, err := st.InsertTransaction(row)
    if err != nil {
        t.Fatalf("duplicate insert: %v", err)
    }
    if created2 {
        t.Error("duplicate should report created=false")
    }
    if id2 != 0 {
        t.Errorf("duplicate id = %d, want 0", id2)
    }
}

func TestUpdateTransactionCategory(t *testing.T) {
    st := newTestStore(t)
    if err := st.SeedDefaultCategories(); err != nil {
        t.Fatal(err)
    }
    if _, err := st.InsertIngest(IngestRecord{MessageUID: "u1", FromAddr: "x@y.com",
        Subject: "s", ParseStatus: "parsed", RawBody: []byte("r"), CreatedAt: time.Now()}); err != nil {
        t.Fatal(err)
    }
    var ingestID int64
    st.DB.QueryRow("SELECT id FROM ingest_log LIMIT 1").Scan(&ingestID)

    row := txnRow()
    row.IngestID = ingestID
    id, _, err := st.InsertTransaction(row)
    if err != nil {
        t.Fatal(err)
    }

    cats, _ := st.SelectCategories()
    var catID int64
    for _, c := range cats {
        if c.Name == "Groceries" {
            catID = c.ID
        }
    }
    if err := st.UpdateTransactionCategory(id, catID, "confirmed"); err != nil {
        t.Fatalf("UpdateTransactionCategory: %v", err)
    }
    var status string
    var gotCatID int64
    st.DB.QueryRow("SELECT status, category_id FROM transactions WHERE id=?", id).Scan(&status, &gotCatID)
    if status != "confirmed" {
        t.Errorf("status = %q, want confirmed", status)
    }
    if gotCatID != catID {
        t.Errorf("category_id = %d, want %d", gotCatID, catID)
    }
}

func TestUpdateTransactionStatus(t *testing.T) {
    st := newTestStore(t)
    if _, err := st.InsertIngest(IngestRecord{MessageUID: "u1", FromAddr: "x@y.com",
        Subject: "s", ParseStatus: "parsed", RawBody: []byte("r"), CreatedAt: time.Now()}); err != nil {
        t.Fatal(err)
    }
    var ingestID int64
    st.DB.QueryRow("SELECT id FROM ingest_log LIMIT 1").Scan(&ingestID)

    row := txnRow()
    row.IngestID = ingestID
    id, _, _ := st.InsertTransaction(row)

    if err := st.UpdateTransactionStatus(id, "ignored"); err != nil {
        t.Fatalf("UpdateTransactionStatus: %v", err)
    }
    var status string
    st.DB.QueryRow("SELECT status FROM transactions WHERE id=?", id).Scan(&status)
    if status != "ignored" {
        t.Errorf("status = %q, want ignored", status)
    }
}

func TestSelectNeedsReview(t *testing.T) {
    st := newTestStore(t)
    if _, err := st.InsertIngest(IngestRecord{MessageUID: "u1", FromAddr: "x@y.com",
        Subject: "s", ParseStatus: "parsed", RawBody: []byte("r"), CreatedAt: time.Now()}); err != nil {
        t.Fatal(err)
    }
    var ingestID int64
    st.DB.QueryRow("SELECT id FROM ingest_log LIMIT 1").Scan(&ingestID)

    row := txnRow()
    row.IngestID = ingestID
    st.InsertTransaction(row)

    items, err := st.SelectNeedsReview()
    if err != nil {
        t.Fatalf("SelectNeedsReview: %v", err)
    }
    if len(items) != 1 {
        t.Errorf("got %d items, want 1", len(items))
    }
    if items[0].MerchantRaw != "DAPPER DAN GENTS SAL" {
        t.Errorf("merchant = %q", items[0].MerchantRaw)
    }
}
```

- [ ] **Step 2: Write failing test for changed InsertTransaction signature in `transactions_test.go`**

Update the call sites in `internal/store/transactions_test.go` to use the new 3-return signature:

```go
// Replace:
ins1, err := st.InsertTransaction(row)
// With:
_, ins1, err := st.InsertTransaction(row)

// Replace:
ins2, err := st.InsertTransaction(row)
// With:
_, ins2, err := st.InsertTransaction(row)
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
cd /root/Coding/ledger && go test ./internal/store/... -v 2>&1 | head -40
```
Expected: compilation errors — `InsertTransaction` returns wrong number of values, `CategoryRow` undefined, etc.

- [ ] **Step 4: Create `internal/store/categories.go`**

```go
package store

import (
    "time"
)

// CategoryRow is one row from the categories table.
type CategoryRow struct {
    ID       int64
    Name     string
    Kind     string // "spending" | "income" | "excluded"
    Bucket   string // "need" | "want" | "saving"; empty when kind != "spending"
    IsActive bool
}

// RuleRow is one row from the rules table, ordered by priority.
type RuleRow struct {
    ID         int64
    MatchType  string // "contains" | "exact" | "regex"
    Pattern    string
    CategoryID int64
    Priority   int
    Source     string // "manual" | "ai_confirmed"
}

// ReviewItem is a transaction awaiting user action.
type ReviewItem struct {
    ID          int64
    PostedAt    string
    AmountFils  int64
    Currency    string
    Direction   string
    MerchantRaw string
    Last4       string
    Status      string
    Confidence  float64
    Tier        string
}

// SeedDefaultCategories writes the standard 50/30/20 category set idempotently.
func (s *Store) SeedDefaultCategories() error {
    seeds := []CategoryRow{
        {Name: "Rent", Kind: "spending", Bucket: "need"},
        {Name: "Utilities", Kind: "spending", Bucket: "need"},
        {Name: "Groceries", Kind: "spending", Bucket: "need"},
        {Name: "Transport", Kind: "spending", Bucket: "need"},
        {Name: "Healthcare", Kind: "spending", Bucket: "need"},
        {Name: "Insurance", Kind: "spending", Bucket: "need"},
        {Name: "Dining", Kind: "spending", Bucket: "want"},
        {Name: "Entertainment", Kind: "spending", Bucket: "want"},
        {Name: "Shopping", Kind: "spending", Bucket: "want"},
        {Name: "Travel", Kind: "spending", Bucket: "want"},
        {Name: "Subscriptions", Kind: "spending", Bucket: "want"},
        {Name: "Savings", Kind: "spending", Bucket: "saving"},
        {Name: "Investments", Kind: "spending", Bucket: "saving"},
        {Name: "Debt Repayment", Kind: "spending", Bucket: "saving"},
        {Name: "Salary", Kind: "income"},
        {Name: "Freelance", Kind: "income"},
        {Name: "Transfers", Kind: "excluded"},
        {Name: "Reimbursements", Kind: "excluded"},
    }
    for _, c := range seeds {
        if _, err := s.DB.Exec(
            `INSERT OR IGNORE INTO categories (name, kind, bucket, is_active) VALUES (?, ?, ?, 1)`,
            c.Name, c.Kind, nullableStr(c.Bucket),
        ); err != nil {
            return err
        }
    }
    return nil
}

func nullableStr(s string) any {
    if s == "" {
        return nil
    }
    return s
}

// InsertCategory writes one category and returns its new row ID.
func (s *Store) InsertCategory(c CategoryRow) (int64, error) {
    res, err := s.DB.Exec(
        `INSERT INTO categories (name, kind, bucket, is_active) VALUES (?, ?, ?, 1)`,
        c.Name, c.Kind, nullableStr(c.Bucket),
    )
    if err != nil {
        return 0, err
    }
    return res.LastInsertId()
}

// SelectCategories returns all active categories ordered by kind then name.
func (s *Store) SelectCategories() ([]CategoryRow, error) {
    rows, err := s.DB.Query(
        `SELECT id, name, kind, COALESCE(bucket,''), is_active FROM categories WHERE is_active=1 ORDER BY kind, name`)
    if err != nil {
        return nil, err
    }
    defer rows.Close()
    var out []CategoryRow
    for rows.Next() {
        var c CategoryRow
        var active int
        if err := rows.Scan(&c.ID, &c.Name, &c.Kind, &c.Bucket, &active); err != nil {
            return nil, err
        }
        c.IsActive = active == 1
        out = append(out, c)
    }
    return out, rows.Err()
}

// InsertRule writes a new categorization rule and returns its ID.
func (s *Store) InsertRule(r RuleRow) error {
    now := time.Now().UTC().Format(time.RFC3339Nano)
    _, err := s.DB.Exec(
        `INSERT INTO rules (match_type, pattern, category_id, priority, source, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
        r.MatchType, r.Pattern, r.CategoryID, r.Priority, r.Source, now,
    )
    return err
}

// SelectRules returns all rules ordered by priority ascending (lower number = higher priority).
func (s *Store) SelectRules() ([]RuleRow, error) {
    rows, err := s.DB.Query(
        `SELECT id, match_type, pattern, category_id, priority, source FROM rules ORDER BY priority, id`)
    if err != nil {
        return nil, err
    }
    defer rows.Close()
    var out []RuleRow
    for rows.Next() {
        var r RuleRow
        if err := rows.Scan(&r.ID, &r.MatchType, &r.Pattern, &r.CategoryID, &r.Priority, &r.Source); err != nil {
            return nil, err
        }
        out = append(out, r)
    }
    return out, rows.Err()
}

// UpdateTransactionCategory sets category_id and status on one transaction.
func (s *Store) UpdateTransactionCategory(txID, categoryID int64, status string) error {
    now := time.Now().UTC().Format(time.RFC3339Nano)
    _, err := s.DB.Exec(
        `UPDATE transactions SET category_id=?, status=?, updated_at=? WHERE id=?`,
        categoryID, status, now, txID,
    )
    return err
}

// UpdateTransactionStatus sets only the status (transfer / ignored / confirmed).
func (s *Store) UpdateTransactionStatus(txID int64, status string) error {
    now := time.Now().UTC().Format(time.RFC3339Nano)
    _, err := s.DB.Exec(
        `UPDATE transactions SET status=?, updated_at=? WHERE id=?`,
        status, now, txID,
    )
    return err
}

// SelectNeedsReview returns transactions with status='needs_review', newest first.
func (s *Store) SelectNeedsReview() ([]ReviewItem, error) {
    rows, err := s.DB.Query(
        `SELECT id, posted_at, amount, currency, direction,
                COALESCE(merchant_raw,''), COALESCE(description,''),
                status, COALESCE(confidence,0), COALESCE(source,'')
         FROM transactions WHERE status='needs_review' ORDER BY posted_at DESC`)
    if err != nil {
        return nil, err
    }
    defer rows.Close()
    var out []ReviewItem
    for rows.Next() {
        var r ReviewItem
        var desc, src string
        if err := rows.Scan(&r.ID, &r.PostedAt, &r.AmountFils, &r.Currency,
            &r.Direction, &r.MerchantRaw, &desc, &r.Status, &r.Confidence, &src); err != nil {
            return nil, err
        }
        out = append(out, r)
    }
    return out, rows.Err()
}

// SelectTransactions returns transactions matching optional status and date filters.
func (s *Store) SelectTransactions(status, from, to string) ([]ReviewItem, error) {
    q := `SELECT id, posted_at, amount, currency, direction,
                 COALESCE(merchant_raw,''), COALESCE(description,''),
                 status, COALESCE(confidence,0), COALESCE(source,'')
          FROM transactions WHERE 1=1`
    var args []any
    if status != "" {
        q += " AND status=?"
        args = append(args, status)
    }
    if from != "" {
        q += " AND posted_at >= ?"
        args = append(args, from)
    }
    if to != "" {
        q += " AND posted_at <= ?"
        args = append(args, to)
    }
    q += " ORDER BY posted_at DESC"
    rows, err := s.DB.Query(q, args...)
    if err != nil {
        return nil, err
    }
    defer rows.Close()
    var out []ReviewItem
    for rows.Next() {
        var r ReviewItem
        var desc, src string
        if err := rows.Scan(&r.ID, &r.PostedAt, &r.AmountFils, &r.Currency,
            &r.Direction, &r.MerchantRaw, &desc, &r.Status, &r.Confidence, &src); err != nil {
            return nil, err
        }
        out = append(out, r)
    }
    return out, rows.Err()
}
```

- [ ] **Step 5: Update `InsertTransaction` signature in `internal/store/transactions.go`**

Change:
```go
func (s *Store) InsertTransaction(r TransactionRow) (bool, error) {
```
To:
```go
// InsertTransaction writes a transaction idempotently. Returns (rowID, created, error).
// rowID is the new row's ID when created=true, and 0 when the fingerprint already existed.
func (s *Store) InsertTransaction(r TransactionRow) (int64, bool, error) {
```

Change the return at the end:
```go
    // Old:
    n, err := res.RowsAffected()
    return n > 0, err

    // New:
    n, err := res.RowsAffected()
    if err != nil {
        return 0, false, err
    }
    if n == 0 {
        return 0, false, nil
    }
    id, err := res.LastInsertId()
    return id, true, err
```

- [ ] **Step 6: Fix call site in `internal/store/transactions_test.go`**

In `TestInsertTransactionAndFingerprintDedup`, change:
```go
ins1, err := st.InsertTransaction(row)
// ...
ins2, err := st.InsertTransaction(row)
```
To:
```go
_, ins1, err := st.InsertTransaction(row)
// ...
_, ins2, err := st.InsertTransaction(row)
```

- [ ] **Step 7: Run tests to verify they pass**

```bash
cd /root/Coding/ledger && go test ./internal/store/... -v
```
Expected: all PASS.

- [ ] **Step 8: Commit**

```bash
git add internal/store/categories.go internal/store/categories_test.go \
        internal/store/transactions.go internal/store/transactions_test.go
git commit -m "feat(store): add categories/rules CRUD, InsertTransaction returns row ID"
```

---

## Task 3: Seed Default Categories on Startup

Call `SeedDefaultCategories()` from `store.Open()` so the app always has a working category set from the first run.

**Files:**
- Modify: `internal/store/store.go`
- Modify: `internal/store/store_test.go`

- [ ] **Step 1: Write failing test**

Add to `internal/store/store_test.go`:

```go
func TestOpenSeedsDefaultCategories(t *testing.T) {
    dir := t.TempDir()
    st, err := Open(dir)
    if err != nil {
        t.Fatalf("Open: %v", err)
    }
    defer st.Close()

    cats, err := st.SelectCategories()
    if err != nil {
        t.Fatalf("SelectCategories: %v", err)
    }
    if len(cats) == 0 {
        t.Error("Open must seed default categories")
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /root/Coding/ledger && go test ./internal/store/... -run TestOpenSeedsDefault -v
```
Expected: FAIL — 0 categories.

- [ ] **Step 3: Add seed call in `store.Open()`**

At the end of `Open()`, before the final `return`, add:

```go
    if err := (&Store{DB: db}).SeedDefaultCategories(); err != nil {
        db.Close()
        return nil, fmt.Errorf("seed categories: %w", err)
    }
    return &Store{DB: db}, nil
```

Replace the current `return &Store{DB: db}, nil` with the block above.

- [ ] **Step 4: Run all store tests to verify they pass**

```bash
cd /root/Coding/ledger && go test ./internal/store/... -v
```
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/store/store.go internal/store/store_test.go
git commit -m "feat(store): seed default categories on Open"
```

---

## Task 4: `internal/categorize` Package — Rules Matcher & Orchestrator

Build the categorizer: rules-first (exact/contains/regex), AI fallback via interface, orchestration logic.

**Files:**
- Create: `internal/categorize/categorize.go`
- Create: `internal/categorize/categorize_test.go`

- [ ] **Step 1: Write failing tests in `internal/categorize/categorize_test.go`**

```go
package categorize

import (
    "context"
    "testing"
)

func TestRuleMatchExact(t *testing.T) {
    rules := []Rule{
        {MatchType: "exact", Pattern: "AMAZON.AE", CategoryID: 1, Priority: 10},
    }
    cats := []Category{{ID: 1, Name: "Shopping", Kind: "spending", Bucket: "want"}}
    c := New(rules, cats, DisabledAI{}, 0.85, false)

    res, ok := c.Categorize(context.Background(), "AMAZON.AE")
    if !ok {
        t.Fatal("exact match must succeed")
    }
    if res.CategoryID != 1 || res.Source != "rule" {
        t.Errorf("res = %+v, want CategoryID=1, Source=rule", res)
    }
}

func TestRuleMatchContainsCaseInsensitive(t *testing.T) {
    rules := []Rule{
        {MatchType: "contains", Pattern: "amazon", CategoryID: 1, Priority: 10},
    }
    cats := []Category{{ID: 1, Name: "Shopping", Kind: "spending", Bucket: "want"}}
    c := New(rules, cats, DisabledAI{}, 0.85, false)

    res, ok := c.Categorize(context.Background(), "AMAZON.AE")
    if !ok {
        t.Fatal("contains match must succeed")
    }
    if res.Source != "rule" {
        t.Errorf("source = %q, want rule", res.Source)
    }
}

func TestRuleMatchRegex(t *testing.T) {
    rules := []Rule{
        {MatchType: "regex", Pattern: `^FIGMA`, CategoryID: 2, Priority: 10},
    }
    cats := []Category{{ID: 2, Name: "Subscriptions", Kind: "spending", Bucket: "want"}}
    c := New(rules, cats, DisabledAI{}, 0.85, false)

    res, ok := c.Categorize(context.Background(), "FIGMA")
    if !ok {
        t.Fatal("regex match must succeed")
    }
    if res.CategoryID != 2 {
        t.Errorf("CategoryID = %d, want 2", res.CategoryID)
    }

    _, notOk := c.Categorize(context.Background(), "NOT FIGMA")
    if notOk {
        t.Error("regex ^FIGMA must not match 'NOT FIGMA'")
    }
}

func TestRulePriorityOrder(t *testing.T) {
    rules := []Rule{
        {MatchType: "contains", Pattern: "amazon", CategoryID: 1, Priority: 100},
        {MatchType: "contains", Pattern: "amazon", CategoryID: 2, Priority: 10}, // wins
    }
    cats := []Category{
        {ID: 1, Name: "Shopping"},
        {ID: 2, Name: "Groceries"},
    }
    c := New(rules, cats, DisabledAI{}, 0.85, false)

    res, _ := c.Categorize(context.Background(), "AMAZON.AE")
    if res.CategoryID != 2 {
        t.Errorf("expected lower-priority-number rule to win, got CategoryID=%d", res.CategoryID)
    }
}

func TestNoRuleNoAI(t *testing.T) {
    c := New(nil, nil, DisabledAI{}, 0.85, false)
    _, ok := c.Categorize(context.Background(), "UNKNOWN MERCHANT")
    if ok {
        t.Error("no rules and disabled AI should return ok=false")
    }
}

func TestAIFallbackAboveThreshold(t *testing.T) {
    cats := []Category{{ID: 3, Name: "Dining", Kind: "spending", Bucket: "want"}}
    c := New(nil, cats, fixedAI{name: "Dining", conf: 0.92}, 0.85, false)

    res, ok := c.Categorize(context.Background(), "MCDONALDS")
    if !ok {
        t.Fatal("AI above threshold should succeed")
    }
    if res.CategoryID != 3 || res.Source != "ai" {
        t.Errorf("res = %+v, want CategoryID=3 Source=ai", res)
    }
    if res.ProposedRule == nil {
        t.Error("expected a proposed rule when AI confidence >= threshold")
    }
}

func TestAIFallbackBelowThreshold(t *testing.T) {
    cats := []Category{{ID: 3, Name: "Dining"}}
    c := New(nil, cats, fixedAI{name: "Dining", conf: 0.50}, 0.85, false)

    res, ok := c.Categorize(context.Background(), "MCDONALDS")
    if !ok {
        t.Fatal("AI below threshold still returns a result (ok=true) but needs_review")
    }
    if res.Source != "ai" {
        t.Errorf("source = %q, want ai", res.Source)
    }
    if res.ProposedRule != nil {
        t.Error("below threshold must not propose a rule")
    }
    if res.AboveThreshold {
        t.Error("below threshold: AboveThreshold must be false")
    }
}

// fixedAI always returns the same name and confidence.
type fixedAI struct{ name string; conf float64 }

func (f fixedAI) Categorize(_ context.Context, _ string, _ []Category) (string, float64, error) {
    return f.name, f.conf, nil
}
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /root/Coding/ledger && go test ./internal/categorize/... -v 2>&1 | head -20
```
Expected: compilation errors — package does not exist.

- [ ] **Step 3: Create `internal/categorize/categorize.go`**

```go
// Package categorize assigns categories to extracted bank transactions.
// It runs a rules-first pass (exact, contains, regex) then falls back to
// an AI client. The AI path is always gated by a threshold and caller-controlled.
package categorize

import (
    "context"
    "regexp"
    "strings"
)

// Category is a spending/income/excluded category.
type Category struct {
    ID     int64
    Name   string
    Kind   string // "spending" | "income" | "excluded"
    Bucket string // "need" | "want" | "saving"
}

// Rule is one merchant-match rule, ordered by Priority (lower = higher priority).
type Rule struct {
    MatchType  string // "contains" | "exact" | "regex"
    Pattern    string
    CategoryID int64
    Priority   int
}

// Result is what Categorize returns.
type Result struct {
    CategoryID     int64
    CategoryName   string
    Confidence     float64
    Source         string // "rule" | "ai"
    AboveThreshold bool   // true when AI confidence >= threshold (auto-confirm)
    ProposedRule   *Rule  // non-nil when AI fires above threshold
}

// AICategorizer is the AI fallback interface.
type AICategorizer interface {
    Categorize(ctx context.Context, merchant string, cats []Category) (name string, conf float64, err error)
}

// DisabledAI always returns ErrAIUnavailable.
type DisabledAI struct{}

func (DisabledAI) Categorize(_ context.Context, _ string, _ []Category) (string, float64, error) {
    return "", 0, ErrAIUnavailable
}

// ErrAIUnavailable means no AI categorizer is configured.
var ErrAIUnavailable = fmt.Errorf("ai categorizer unavailable")

// Categorizer orchestrates rules → AI tiers.
type Categorizer struct {
    rules     []Rule
    cats      []Category
    catsByName map[string]Category
    ai        AICategorizer
    threshold float64
    autoRule  bool
    compiled  map[string]*regexp.Regexp
}

// New builds a Categorizer. Rules must be sorted by priority ascending before calling.
func New(rules []Rule, cats []Category, ai AICategorizer, threshold float64, autoRule bool) *Categorizer {
    byName := make(map[string]Category, len(cats))
    for _, c := range cats {
        byName[strings.ToLower(c.Name)] = c
    }
    compiled := make(map[string]*regexp.Regexp)
    for _, r := range rules {
        if r.MatchType == "regex" {
            if re, err := regexp.Compile("(?i)" + r.Pattern); err == nil {
                compiled[r.Pattern] = re
            }
        }
    }
    return &Categorizer{
        rules: rules, cats: cats, catsByName: byName,
        ai: ai, threshold: threshold, autoRule: autoRule,
        compiled: compiled,
    }
}

// Categorize returns (Result, true) if a category was found, or (Result{}, false) if not.
func (c *Categorizer) Categorize(ctx context.Context, merchantRaw string) (Result, bool) {
    lower := strings.ToLower(merchantRaw)

    // Tier 1: rules (already ordered by priority).
    for _, r := range c.rules {
        if c.matchRule(r, lower) {
            cat := c.catForID(r.CategoryID)
            return Result{
                CategoryID:     r.CategoryID,
                CategoryName:   cat.Name,
                Confidence:     1.0,
                Source:         "rule",
                AboveThreshold: true,
            }, true
        }
    }

    // Tier 2: AI fallback.
    name, conf, err := c.ai.Categorize(ctx, merchantRaw, c.cats)
    if err != nil {
        return Result{}, false
    }
    cat, ok := c.catsByName[strings.ToLower(name)]
    if !ok {
        return Result{}, false
    }
    res := Result{
        CategoryID:   cat.ID,
        CategoryName: cat.Name,
        Confidence:   conf,
        Source:       "ai",
    }
    if conf >= c.threshold {
        res.AboveThreshold = true
        res.ProposedRule = &Rule{
            MatchType:  "contains",
            Pattern:    strings.ToLower(merchantRaw),
            CategoryID: cat.ID,
            Priority:   100,
        }
    }
    return res, true
}

func (c *Categorizer) matchRule(r Rule, lowerMerchant string) bool {
    switch r.MatchType {
    case "exact":
        return lowerMerchant == strings.ToLower(r.Pattern)
    case "contains":
        return strings.Contains(lowerMerchant, strings.ToLower(r.Pattern))
    case "regex":
        if re, ok := c.compiled[r.Pattern]; ok {
            return re.MatchString(lowerMerchant)
        }
    }
    return false
}

func (c *Categorizer) catForID(id int64) Category {
    for _, cat := range c.cats {
        if cat.ID == id {
            return cat
        }
    }
    return Category{}
}
```

Note: Add `"fmt"` to the imports.

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /root/Coding/ledger && go test ./internal/categorize/... -v
```
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/categorize/categorize.go internal/categorize/categorize_test.go
git commit -m "feat(categorize): rules matcher (exact/contains/regex) + Categorizer orchestrator"
```

---

## Task 5: Anthropic Categorizer (AI Client)

Build the real `AnthropicCategorizer` that sends only the merchant string to the Claude Messages API and parses `{category, confidence}`.

**Files:**
- Create: `internal/categorize/ai.go`
- Create: `internal/categorize/ai_test.go`

- [ ] **Step 1: Write failing tests in `internal/categorize/ai_test.go`**

```go
package categorize

import (
    "context"
    "encoding/json"
    "net/http"
    "net/http/httptest"
    "testing"
)

func TestAnthropicCategorizerSuccess(t *testing.T) {
    srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        // Verify headers
        if r.Header.Get("x-api-key") != "test-key" {
            t.Errorf("missing x-api-key header")
        }
        if r.Header.Get("anthropic-version") == "" {
            t.Error("missing anthropic-version header")
        }
        // Return mock response
        w.Header().Set("Content-Type", "application/json")
        json.NewEncoder(w).Encode(map[string]any{
            "content": []map[string]any{
                {"type": "text", "text": `{"category":"Shopping","confidence":0.95}`},
            },
        })
    }))
    defer srv.Close()

    ac := &AnthropicCategorizer{
        apiKey:   "test-key",
        model:    "claude-haiku-4-5-20251001",
        endpoint: srv.URL + "/v1/messages",
        client:   srv.Client(),
    }
    cats := []Category{{ID: 1, Name: "Shopping"}, {ID: 2, Name: "Dining"}}

    name, conf, err := ac.Categorize(context.Background(), "AMAZON.AE", cats)
    if err != nil {
        t.Fatalf("Categorize: %v", err)
    }
    if name != "Shopping" {
        t.Errorf("name = %q, want Shopping", name)
    }
    if conf != 0.95 {
        t.Errorf("conf = %v, want 0.95", conf)
    }
}

func TestAnthropicCategorizerSendsOnlyMerchant(t *testing.T) {
    var capturedBody map[string]any
    srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        json.NewDecoder(r.Body).Decode(&capturedBody)
        w.Header().Set("Content-Type", "application/json")
        json.NewEncoder(w).Encode(map[string]any{
            "content": []map[string]any{
                {"type": "text", "text": `{"category":"Dining","confidence":0.88}`},
            },
        })
    }))
    defer srv.Close()

    ac := &AnthropicCategorizer{
        apiKey:   "k",
        model:    "claude-haiku-4-5-20251001",
        endpoint: srv.URL + "/v1/messages",
        client:   srv.Client(),
    }
    cats := []Category{{ID: 1, Name: "Dining"}}
    ac.Categorize(context.Background(), "MCDONALDS", cats)

    msgs, _ := capturedBody["messages"].([]any)
    if len(msgs) == 0 {
        t.Fatal("no messages in request")
    }
    content, _ := msgs[0].(map[string]any)["content"].(string)
    if !strings.Contains(content, "MCDONALDS") {
        t.Errorf("request content must include merchant string, got: %q", content)
    }
}

func TestAnthropicCategorizerHTTPError(t *testing.T) {
    srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        http.Error(w, "overloaded", http.StatusServiceUnavailable)
    }))
    defer srv.Close()

    ac := &AnthropicCategorizer{
        apiKey:   "k",
        model:    "claude-haiku-4-5-20251001",
        endpoint: srv.URL + "/v1/messages",
        client:   srv.Client(),
    }
    _, _, err := ac.Categorize(context.Background(), "X", nil)
    if err == nil {
        t.Error("expected error on HTTP 503")
    }
}
```

Add `"strings"` to the imports.

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /root/Coding/ledger && go test ./internal/categorize/... -run TestAnthropic -v 2>&1 | head -20
```
Expected: FAIL — `AnthropicCategorizer` undefined.

- [ ] **Step 3: Create `internal/categorize/ai.go`**

```go
package categorize

import (
    "bytes"
    "context"
    "encoding/json"
    "fmt"
    "net/http"
    "strings"
)

// AnthropicCategorizer calls the Anthropic Messages API to suggest a category
// for a merchant string. It sends ONLY the merchant and the category list —
// no amounts, dates, or account details leave the server.
type AnthropicCategorizer struct {
    apiKey   string
    model    string
    endpoint string     // defaults to "https://api.anthropic.com/v1/messages"
    client   *http.Client
}

// NewAnthropicCategorizer builds the real AI categorizer.
func NewAnthropicCategorizer(apiKey, model string) *AnthropicCategorizer {
    return &AnthropicCategorizer{
        apiKey:   apiKey,
        model:    model,
        endpoint: "https://api.anthropic.com/v1/messages",
        client:   &http.Client{},
    }
}

type anthropicReq struct {
    Model     string      `json:"model"`
    MaxTokens int         `json:"max_tokens"`
    System    string      `json:"system"`
    Messages  []aMsg      `json:"messages"`
}

type aMsg struct {
    Role    string `json:"role"`
    Content string `json:"content"`
}

type anthropicResp struct {
    Content []struct {
        Type string `json:"type"`
        Text string `json:"text"`
    } `json:"content"`
}

type catResult struct {
    Category   string  `json:"category"`
    Confidence float64 `json:"confidence"`
}

const categorizerSystemPrompt = `You are a financial transaction categorizer.
Given a merchant name and a list of categories, return ONLY valid JSON on one line:
{"category": "<exact category name from the list>", "confidence": <0.0 to 1.0>}
Use confidence < 0.5 if no category is a good fit. Never add explanation outside the JSON.`

// Categorize sends the merchant string and category list to Claude and returns
// the suggested category name and confidence.
func (a *AnthropicCategorizer) Categorize(ctx context.Context, merchant string, cats []Category) (string, float64, error) {
    names := make([]string, len(cats))
    for i, c := range cats {
        names[i] = c.Name
    }
    userMsg := fmt.Sprintf("Merchant: %q\nCategories: %s", merchant, strings.Join(names, ", "))

    body, err := json.Marshal(anthropicReq{
        Model:     a.model,
        MaxTokens: 200,
        System:    categorizerSystemPrompt,
        Messages:  []aMsg{{Role: "user", Content: userMsg}},
    })
    if err != nil {
        return "", 0, err
    }

    req, err := http.NewRequestWithContext(ctx, http.MethodPost, a.endpoint, bytes.NewReader(body))
    if err != nil {
        return "", 0, err
    }
    req.Header.Set("x-api-key", a.apiKey)
    req.Header.Set("anthropic-version", "2023-06-01")
    req.Header.Set("content-type", "application/json")

    resp, err := a.client.Do(req)
    if err != nil {
        return "", 0, err
    }
    defer resp.Body.Close()
    if resp.StatusCode != http.StatusOK {
        return "", 0, fmt.Errorf("anthropic API status %d", resp.StatusCode)
    }

    var ar anthropicResp
    if err := json.NewDecoder(resp.Body).Decode(&ar); err != nil {
        return "", 0, err
    }
    if len(ar.Content) == 0 {
        return "", 0, fmt.Errorf("empty anthropic response")
    }

    var result catResult
    if err := json.Unmarshal([]byte(ar.Content[0].Text), &result); err != nil {
        return "", 0, fmt.Errorf("parse anthropic response %q: %w", ar.Content[0].Text, err)
    }
    return result.Category, result.Confidence, nil
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /root/Coding/ledger && go test ./internal/categorize/... -v
```
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/categorize/ai.go internal/categorize/ai_test.go
git commit -m "feat(categorize): AnthropicCategorizer calls Messages API with merchant-only payload"
```

---

## Task 6: Real AnthropicExtractor in `internal/parse/ai.go`

The `Extractor` interface has existed since M3 with only `DisabledExtractor`. Wire in the real HTTP client that sends the email body and parses a `ParsedTxn` JSON response.

**Files:**
- Modify: `internal/parse/ai.go`
- Create: `internal/parse/ai_test.go`

- [ ] **Step 1: Write failing tests in `internal/parse/ai_test.go`**

```go
package parse

import (
    "context"
    "encoding/json"
    "net/http"
    "net/http/httptest"
    "testing"
    "time"
)

func TestAnthropicExtractorSuccess(t *testing.T) {
    srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        w.Header().Set("Content-Type", "application/json")
        json.NewEncoder(w).Encode(map[string]any{
            "content": []map[string]any{
                {"type": "text", "text": `{"posted_at":"2025-08-19T00:00:00Z","amount_fils":21500,"currency":"AED","direction":"debit","merchant_raw":"AMAZON.AE","last4":"1502","confidence":0.82}`},
            },
        })
    }))
    defer srv.Close()

    ex := &AnthropicExtractor{
        apiKey:   "test-key",
        model:    "claude-haiku-4-5-20251001",
        endpoint: srv.URL + "/v1/messages",
        client:   srv.Client(),
    }

    p, err := ex.Extract(context.Background(), "some email body text")
    if err != nil {
        t.Fatalf("Extract: %v", err)
    }
    if p.AmountFils != 21500 {
        t.Errorf("AmountFils = %d, want 21500", p.AmountFils)
    }
    if p.Direction != "debit" {
        t.Errorf("Direction = %q, want debit", p.Direction)
    }
    if p.MerchantRaw != "AMAZON.AE" {
        t.Errorf("MerchantRaw = %q, want AMAZON.AE", p.MerchantRaw)
    }
    wantTime := time.Date(2025, 8, 19, 0, 0, 0, 0, time.UTC)
    if !p.PostedAt.Equal(wantTime) {
        t.Errorf("PostedAt = %v, want %v", p.PostedAt, wantTime)
    }
    if p.Confidence != 0.82 {
        t.Errorf("Confidence = %v, want 0.82", p.Confidence)
    }
    if p.Tier != TierAI {
        t.Errorf("Tier = %q, want %q", p.Tier, TierAI)
    }
}

func TestAnthropicExtractorHTTPError(t *testing.T) {
    srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        http.Error(w, "bad gateway", http.StatusBadGateway)
    }))
    defer srv.Close()

    ex := &AnthropicExtractor{
        apiKey:   "k",
        model:    "claude-haiku-4-5-20251001",
        endpoint: srv.URL + "/v1/messages",
        client:   srv.Client(),
    }
    _, err := ex.Extract(context.Background(), "body")
    if err == nil {
        t.Error("expected error on HTTP 502")
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /root/Coding/ledger && go test ./internal/parse/... -run TestAnthropic -v 2>&1 | head -20
```
Expected: FAIL — `AnthropicExtractor` undefined.

- [ ] **Step 3: Add `AnthropicExtractor` to `internal/parse/ai.go`**

Replace the entire `internal/parse/ai.go` content with:

```go
package parse

import (
    "bytes"
    "context"
    "encoding/json"
    "errors"
    "fmt"
    "net/http"
    "time"
)

// ErrAIUnavailable means no AI extractor is configured/enabled. The cascade
// treats it as "skip the AI tier".
var ErrAIUnavailable = errors.New("ai extractor unavailable")

// Extractor is the AI extraction tier. Implementations operate on the plain-text
// body and MUST be treated as low-confidence by the caller (always routed to
// review). The real Anthropic-backed implementation is AnthropicExtractor.
type Extractor interface {
    Extract(ctx context.Context, textBody string) (ParsedTxn, error)
}

// DisabledExtractor is the default when ai.enabled is false. It always returns
// ErrAIUnavailable so the cascade falls through to the review-queue floor.
type DisabledExtractor struct{}

func (DisabledExtractor) Extract(context.Context, string) (ParsedTxn, error) {
    return ParsedTxn{}, ErrAIUnavailable
}

// AnthropicExtractor calls the Anthropic Messages API as the last-resort extraction
// tier. It sends the email body and expects a JSON ParsedTxn in reply.
// Output is always confidence < 1 and routed to needs_review by the cascade.
type AnthropicExtractor struct {
    apiKey   string
    model    string
    endpoint string
    client   *http.Client
}

// NewAnthropicExtractor builds the real AI extractor.
func NewAnthropicExtractor(apiKey, model string) *AnthropicExtractor {
    return &AnthropicExtractor{
        apiKey:   apiKey,
        model:    model,
        endpoint: "https://api.anthropic.com/v1/messages",
        client:   &http.Client{},
    }
}

type extractReq struct {
    Model     string   `json:"model"`
    MaxTokens int      `json:"max_tokens"`
    System    string   `json:"system"`
    Messages  []extMsg `json:"messages"`
}

type extMsg struct {
    Role    string `json:"role"`
    Content string `json:"content"`
}

type extractResp struct {
    Content []struct {
        Type string `json:"type"`
        Text string `json:"text"`
    } `json:"content"`
}

type extractedTxn struct {
    PostedAt    string  `json:"posted_at"`
    AmountFils  int64   `json:"amount_fils"`
    Currency    string  `json:"currency"`
    Direction   string  `json:"direction"`
    MerchantRaw string  `json:"merchant_raw"`
    Last4       string  `json:"last4"`
    Confidence  float64 `json:"confidence"`
}

const extractorSystemPrompt = `Extract financial transaction data from this bank email body.
Respond ONLY with valid JSON on one line (no extra text):
{"posted_at":"2024-01-15T00:00:00Z","amount_fils":3825,"currency":"AED","direction":"debit","merchant_raw":"AMAZON.AE","last4":"1234","confidence":0.8}
Rules: posted_at is ISO8601 UTC; amount_fils is positive integer (AED×100); direction is exactly "debit" or "credit"; last4 may be empty string "".`

// Extract sends the email body to Claude and returns a ParsedTxn.
func (a *AnthropicExtractor) Extract(ctx context.Context, textBody string) (ParsedTxn, error) {
    body, err := json.Marshal(extractReq{
        Model:     a.model,
        MaxTokens: 400,
        System:    extractorSystemPrompt,
        Messages:  []extMsg{{Role: "user", Content: textBody}},
    })
    if err != nil {
        return ParsedTxn{}, err
    }

    req, err := http.NewRequestWithContext(ctx, http.MethodPost, a.endpoint, bytes.NewReader(body))
    if err != nil {
        return ParsedTxn{}, err
    }
    req.Header.Set("x-api-key", a.apiKey)
    req.Header.Set("anthropic-version", "2023-06-01")
    req.Header.Set("content-type", "application/json")

    resp, err := a.client.Do(req)
    if err != nil {
        return ParsedTxn{}, err
    }
    defer resp.Body.Close()
    if resp.StatusCode != http.StatusOK {
        return ParsedTxn{}, fmt.Errorf("anthropic API status %d", resp.StatusCode)
    }

    var ar extractResp
    if err := json.NewDecoder(resp.Body).Decode(&ar); err != nil {
        return ParsedTxn{}, err
    }
    if len(ar.Content) == 0 {
        return ParsedTxn{}, fmt.Errorf("empty anthropic response")
    }

    var et extractedTxn
    if err := json.Unmarshal([]byte(ar.Content[0].Text), &et); err != nil {
        return ParsedTxn{}, fmt.Errorf("parse AI response %q: %w", ar.Content[0].Text, err)
    }

    postedAt, err := time.Parse(time.RFC3339, et.PostedAt)
    if err != nil {
        return ParsedTxn{}, fmt.Errorf("parse posted_at %q: %w", et.PostedAt, err)
    }

    return ParsedTxn{
        PostedAt:    postedAt,
        AmountFils:  et.AmountFils,
        Currency:    et.Currency,
        Direction:   et.Direction,
        MerchantRaw: et.MerchantRaw,
        Last4:       et.Last4,
        Confidence:  et.Confidence,
        Tier:        TierAI,
    }, nil
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /root/Coding/ledger && go test ./internal/parse/... -v
```
Expected: all PASS (including existing DIB, heuristic, cascade, and processor tests).

- [ ] **Step 5: Commit**

```bash
git add internal/parse/ai.go internal/parse/ai_test.go
git commit -m "feat(parse): AnthropicExtractor — real AI extraction tier via Messages API"
```

---

## Task 7: Wire Categorizer into Processor

After extracting and inserting a transaction, call the categorizer and update the row's `category_id` and `status` accordingly.

**Files:**
- Modify: `internal/parse/processor.go`
- Modify: `internal/parse/processor_test.go`

- [ ] **Step 1: Write failing tests**

Add to `internal/parse/processor_test.go`. First, look at the existing test setup — `processor_test.go` creates a `Processor` via `NewProcessor(st, cascade)`. We need to add `NewProcessorWithCategorizer`:

```go
// Add this test after the existing processor tests:

func TestProcessorCategorizes(t *testing.T) {
    st := storetest.NewTestStore(t) // adjust import if needed — use the existing helper
    // Seed a category
    if err := st.SeedDefaultCategories(); err != nil {
        t.Fatal(err)
    }
    cats, _ := st.SelectCategories()
    var shoppingID int64
    for _, c := range cats {
        if c.Name == "Shopping" {
            shoppingID = c.ID
        }
    }
    // Seed a rule: merchant "AMAZON" → Shopping
    st.InsertRule(store.RuleRow{
        MatchType:  "contains",
        Pattern:    "AMAZON",
        CategoryID: shoppingID,
        Priority:   100,
        Source:     "manual",
    })

    // Build categorizer
    catRules, _ := st.SelectRules()
    rules := make([]categorize.Rule, len(catRules))
    for i, r := range catRules {
        rules[i] = categorize.Rule{
            MatchType:  r.MatchType,
            Pattern:    r.Pattern,
            CategoryID: r.CategoryID,
            Priority:   r.Priority,
        }
    }
    storeCats, _ := st.SelectCategories()
    domainCats := make([]categorize.Category, len(storeCats))
    for i, c := range storeCats {
        domainCats[i] = categorize.Category{ID: c.ID, Name: c.Name, Kind: c.Kind, Bucket: c.Bucket}
    }
    cat := categorize.New(rules, domainCats, categorize.DisabledAI{}, 0.85, false)

    // Ingest one row
    st.InsertIngest(store.IngestRecord{
        MessageUID: "u1", FromAddr: "DIB.notification@dib.ae",
        Subject: "DIB Notification", ParseStatus: "unparsed",
        RawBody: []byte(dibCardPurchaseAmazon), CreatedAt: time.Now(),
    })

    cascade := &Cascade{
        Parsers:   []BankParser{DIBParser{}},
        Heuristic: HeuristicParser{},
        AI:        DisabledExtractor{},
    }
    p := NewProcessorWithCategorizer(st, cascade, cat)
    n, err := p.ProcessPending(context.Background(), store.SelectForParseOpts{OnlyUnparsed: true})
    if err != nil {
        t.Fatalf("ProcessPending: %v", err)
    }
    if n != 1 {
        t.Fatalf("n = %d, want 1", n)
    }

    // Verify transaction was categorized
    var status string
    var catIDGot *int64
    st.DB.QueryRow("SELECT status, category_id FROM transactions LIMIT 1").Scan(&status, &catIDGot)
    if status != "confirmed" {
        t.Errorf("status = %q, want confirmed", status)
    }
    if catIDGot == nil || *catIDGot != shoppingID {
        t.Errorf("category_id = %v, want %d", catIDGot, shoppingID)
    }
}

// dibCardPurchaseAmazon is a DIB card-purchase email with merchant AMAZON.AE
const dibCardPurchaseAmazon = `معاملة بطاقة ائتمان
عزيزي المتعامل,
إشعار مشتريات بتاريخ 19-08-2025 16:18 بالتفاصيل التالية.
رقم البطاقة
525467XXXXXX1502
بطاقة الإئتمان
المبلغ
AED 38.25
الدفع الى
AMAZON.AE
إجمالي الرصيد المتوفر
86,664.42`
```

Note: The test imports `store` and `categorize`. Adjust imports accordingly. Since the processor is in the `parse` package and uses `store` already, you'll need to add `categorize` to the imports.

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /root/Coding/ledger && go test ./internal/parse/... -run TestProcessorCategorizes -v 2>&1 | head -30
```
Expected: FAIL — `NewProcessorWithCategorizer` undefined.

- [ ] **Step 3: Update `internal/parse/processor.go`**

Replace the file content with:

```go
package parse

import (
    "context"

    "ledger/internal/categorize"
    "ledger/internal/store"
)

// Processor runs the cascade over ingest_log rows and persists results.
// If a Categorizer is set, it runs immediately after each successful extraction.
type Processor struct {
    store      *store.Store
    cascade    *Cascade
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
        txID, _, ierr := p.store.InsertTransaction(store.TransactionRow{
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
        // Categorize immediately when a categorizer is wired in.
        if p.categorizer != nil && txID > 0 {
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
```

- [ ] **Step 4: Fix processor_test.go imports and update existing test**

The existing processor test calls `NewProcessor` which still works. Add `"ledger/internal/categorize"` and `"ledger/internal/store"` to imports. The existing test that calls `InsertTransaction` in the store might need the return value updated — check `processor_test.go` and fix any compilation errors.

- [ ] **Step 5: Run all parse tests to verify they pass**

```bash
cd /root/Coding/ledger && go test ./internal/parse/... -v
```
Expected: all PASS.

- [ ] **Step 6: Verify the build compiles**

```bash
cd /root/Coding/ledger && go build ./...
```
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add internal/parse/processor.go internal/parse/processor_test.go
git commit -m "feat(parse): wire Categorizer into Processor — auto-confirm rule hits"
```

---

## Task 8: API Endpoints — Categories, Review, Transaction Actions

Add `GET /api/categories`, `POST /api/categories`, `GET /api/review`, `GET /api/transactions`, `POST /api/transactions/{id}/categorize`, and `POST /api/transactions/{id}/status`.

**Files:**
- Create: `internal/server/categories.go`
- Create: `internal/server/categories_test.go`
- Create: `internal/server/review.go`
- Create: `internal/server/review_test.go`
- Create: `internal/server/transactions.go`
- Create: `internal/server/transactions_test.go`
- Modify: `internal/server/server.go`

- [ ] **Step 1: Write failing tests in `internal/server/categories_test.go`**

```go
package server

import (
    "bytes"
    "encoding/json"
    "net/http"
    "net/http/httptest"
    "testing"
)

func TestGetCategories(t *testing.T) {
    st := newTestServerStore(t)
    srv := newTestServerWithStore(t, st)

    r := httptest.NewRequest("GET", "/api/categories", nil)
    w := httptest.NewRecorder()
    srv.ServeHTTP(w, r)

    if w.Code != http.StatusOK {
        t.Fatalf("status = %d, want 200; body: %s", w.Code, w.Body)
    }
    var cats []map[string]any
    if err := json.NewDecoder(w.Body).Decode(&cats); err != nil {
        t.Fatalf("decode: %v", err)
    }
    if len(cats) == 0 {
        t.Error("expected seeded categories in response")
    }
}

func TestPostCategory(t *testing.T) {
    st := newTestServerStore(t)
    srv := newTestServerWithStore(t, st)

    body, _ := json.Marshal(map[string]any{
        "name":   "Hobbies",
        "kind":   "spending",
        "bucket": "want",
    })
    r := httptest.NewRequest("POST", "/api/categories", bytes.NewReader(body))
    r.Header.Set("Content-Type", "application/json")
    w := httptest.NewRecorder()
    srv.ServeHTTP(w, r)

    if w.Code != http.StatusCreated {
        t.Fatalf("status = %d, want 201; body: %s", w.Code, w.Body)
    }
    var resp map[string]any
    json.NewDecoder(w.Body).Decode(&resp)
    if resp["id"] == nil {
        t.Error("expected id in response")
    }
}

func TestPostCategoryMissingKind(t *testing.T) {
    st := newTestServerStore(t)
    srv := newTestServerWithStore(t, st)

    body, _ := json.Marshal(map[string]any{"name": "Foo"})
    r := httptest.NewRequest("POST", "/api/categories", bytes.NewReader(body))
    w := httptest.NewRecorder()
    srv.ServeHTTP(w, r)

    if w.Code != http.StatusBadRequest {
        t.Errorf("status = %d, want 400", w.Code)
    }
}
```

- [ ] **Step 2: Write failing tests in `internal/server/review_test.go`**

```go
package server

import (
    "encoding/json"
    "net/http"
    "net/http/httptest"
    "testing"
    "time"

    "ledger/internal/store"
)

func TestGetReview(t *testing.T) {
    st := newTestServerStore(t)
    seedTransaction(t, st)
    srv := newTestServerWithStore(t, st)

    r := httptest.NewRequest("GET", "/api/review", nil)
    w := httptest.NewRecorder()
    srv.ServeHTTP(w, r)

    if w.Code != http.StatusOK {
        t.Fatalf("status = %d; body: %s", w.Code, w.Body)
    }
    var items []map[string]any
    json.NewDecoder(w.Body).Decode(&items)
    if len(items) != 1 {
        t.Errorf("got %d items, want 1", len(items))
    }
}

func TestGetTransactions(t *testing.T) {
    st := newTestServerStore(t)
    seedTransaction(t, st)
    srv := newTestServerWithStore(t, st)

    r := httptest.NewRequest("GET", "/api/transactions", nil)
    w := httptest.NewRecorder()
    srv.ServeHTTP(w, r)

    if w.Code != http.StatusOK {
        t.Fatalf("status = %d; body: %s", w.Code, w.Body)
    }
    var items []map[string]any
    json.NewDecoder(w.Body).Decode(&items)
    if len(items) == 0 {
        t.Error("expected at least one transaction")
    }
}

// seedTransaction inserts one ingest row and one needs_review transaction.
func seedTransaction(t *testing.T, st *store.Store) int64 {
    t.Helper()
    if _, err := st.InsertIngest(store.IngestRecord{
        MessageUID: "t1", FromAddr: "DIB.notification@dib.ae",
        Subject: "s", ParseStatus: "parsed",
        RawBody: []byte("r"), CreatedAt: time.Now(),
    }); err != nil {
        t.Fatal(err)
    }
    var ingestID int64
    st.DB.QueryRow("SELECT id FROM ingest_log LIMIT 1").Scan(&ingestID)

    id, _, err := st.InsertTransaction(store.TransactionRow{
        PostedAt:    time.Date(2025, 8, 19, 0, 0, 0, 0, time.UTC),
        AmountFils:  21500,
        Currency:    "AED",
        Direction:   "debit",
        MerchantRaw: "DAPPER DAN GENTS SAL",
        Last4:       "1502",
        Status:      "needs_review",
        Confidence:  0.97,
        Tier:        "template",
        IngestID:    ingestID,
    })
    if err != nil {
        t.Fatal(err)
    }
    return id
}
```

- [ ] **Step 3: Write failing tests in `internal/server/transactions_test.go`**

```go
package server

import (
    "bytes"
    "encoding/json"
    "fmt"
    "net/http"
    "net/http/httptest"
    "testing"
)

func TestPostCategorize(t *testing.T) {
    st := newTestServerStore(t)
    txID := seedTransaction(t, st)
    cats, _ := st.SelectCategories()
    var catID int64
    for _, c := range cats {
        if c.Name == "Shopping" {
            catID = c.ID
        }
    }

    srv := newTestServerWithStore(t, st)
    body, _ := json.Marshal(map[string]any{"category_id": catID, "make_rule": false})
    r := httptest.NewRequest("POST", fmt.Sprintf("/api/transactions/%d/categorize", txID), bytes.NewReader(body))
    r.Header.Set("Content-Type", "application/json")
    w := httptest.NewRecorder()
    srv.ServeHTTP(w, r)

    if w.Code != http.StatusOK {
        t.Fatalf("status = %d; body: %s", w.Code, w.Body)
    }

    // Verify DB
    var status string
    st.DB.QueryRow("SELECT status FROM transactions WHERE id=?", txID).Scan(&status)
    if status != "confirmed" {
        t.Errorf("status = %q, want confirmed", status)
    }
}

func TestPostCategorizeWithRule(t *testing.T) {
    st := newTestServerStore(t)
    txID := seedTransaction(t, st)
    cats, _ := st.SelectCategories()
    var catID int64
    for _, c := range cats {
        if c.Name == "Shopping" {
            catID = c.ID
        }
    }

    srv := newTestServerWithStore(t, st)
    body, _ := json.Marshal(map[string]any{"category_id": catID, "make_rule": true})
    r := httptest.NewRequest("POST", fmt.Sprintf("/api/transactions/%d/categorize", txID), bytes.NewReader(body))
    w := httptest.NewRecorder()
    srv.ServeHTTP(w, r)

    if w.Code != http.StatusOK {
        t.Fatalf("status = %d", w.Code)
    }

    rules, _ := st.SelectRules()
    if len(rules) == 0 {
        t.Error("expected a rule to be written back")
    }
}

func TestPostStatus(t *testing.T) {
    st := newTestServerStore(t)
    txID := seedTransaction(t, st)

    srv := newTestServerWithStore(t, st)
    body, _ := json.Marshal(map[string]any{"status": "ignored"})
    r := httptest.NewRequest("POST", fmt.Sprintf("/api/transactions/%d/status", txID), bytes.NewReader(body))
    w := httptest.NewRecorder()
    srv.ServeHTTP(w, r)

    if w.Code != http.StatusOK {
        t.Fatalf("status = %d; body: %s", w.Code, w.Body)
    }
    var dbStatus string
    st.DB.QueryRow("SELECT status FROM transactions WHERE id=?", txID).Scan(&dbStatus)
    if dbStatus != "ignored" {
        t.Errorf("db status = %q, want ignored", dbStatus)
    }
}

func TestPostStatusInvalid(t *testing.T) {
    st := newTestServerStore(t)
    txID := seedTransaction(t, st)
    srv := newTestServerWithStore(t, st)

    body, _ := json.Marshal(map[string]any{"status": "deleted"})
    r := httptest.NewRequest("POST", fmt.Sprintf("/api/transactions/%d/status", txID), bytes.NewReader(body))
    w := httptest.NewRecorder()
    srv.ServeHTTP(w, r)

    if w.Code != http.StatusBadRequest {
        t.Errorf("status = %d, want 400 for invalid status", w.Code)
    }
}
```

- [ ] **Step 4: Run tests to verify they fail**

```bash
cd /root/Coding/ledger && go test ./internal/server/... -v 2>&1 | head -40
```
Expected: FAIL — routes 404 or handlers undefined.

- [ ] **Step 5: Add `CategoryStore` interface and helpers to `server.go`**

Add to `internal/server/server.go`:

```go
// CategoryStore is the subset of store methods the category/review/transaction
// handlers need.
type CategoryStore interface {
    SelectCategories() ([]store.CategoryRow, error)
    InsertCategory(store.CategoryRow) (int64, error)
    SelectRules() ([]store.RuleRow, error)
    InsertRule(store.RuleRow) error
    SelectNeedsReview() ([]store.ReviewItem, error)
    SelectTransactions(status, from, to string) ([]store.ReviewItem, error)
    UpdateTransactionCategory(txID, catID int64, status string) error
    UpdateTransactionStatus(txID int64, status string) error
}
```

Add field to `Server` struct: `catStore CategoryStore`

Add method:
```go
// SetCategoryStore wires the category/transaction API.
func (s *Server) SetCategoryStore(cs CategoryStore) { s.catStore = cs }
```

Add routes in `routes()`:
```go
s.mux.HandleFunc("GET /api/categories", s.handleGetCategories)
s.mux.HandleFunc("POST /api/categories", s.handlePostCategory)
s.mux.HandleFunc("GET /api/review", s.handleGetReview)
s.mux.HandleFunc("GET /api/transactions", s.handleGetTransactions)
s.mux.HandleFunc("POST /api/transactions/{id}/categorize", s.handleCategorize)
s.mux.HandleFunc("POST /api/transactions/{id}/status", s.handleSetStatus)
```

Add imports: `"ledger/internal/store"`.

- [ ] **Step 6: Create `internal/server/categories.go`**

```go
package server

import (
    "encoding/json"
    "net/http"

    "ledger/internal/store"
)

func (s *Server) handleGetCategories(w http.ResponseWriter, r *http.Request) {
    cats, err := s.catStore.SelectCategories()
    if err != nil {
        http.Error(w, `{"error":"db error"}`, http.StatusInternalServerError)
        return
    }
    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(cats)
}

type createCategoryReq struct {
    Name   string `json:"name"`
    Kind   string `json:"kind"`
    Bucket string `json:"bucket"`
}

func (s *Server) handlePostCategory(w http.ResponseWriter, r *http.Request) {
    var req createCategoryReq
    if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
        http.Error(w, `{"error":"invalid json"}`, http.StatusBadRequest)
        return
    }
    if req.Name == "" || req.Kind == "" {
        http.Error(w, `{"error":"name and kind are required"}`, http.StatusBadRequest)
        return
    }
    if req.Kind == "spending" && req.Bucket == "" {
        http.Error(w, `{"error":"bucket required for spending categories"}`, http.StatusBadRequest)
        return
    }
    id, err := s.catStore.InsertCategory(store.CategoryRow{
        Name:   req.Name,
        Kind:   req.Kind,
        Bucket: req.Bucket,
    })
    if err != nil {
        http.Error(w, `{"error":"db error"}`, http.StatusInternalServerError)
        return
    }
    w.Header().Set("Content-Type", "application/json")
    w.WriteHeader(http.StatusCreated)
    json.NewEncoder(w).Encode(map[string]any{"id": id})
}
```

- [ ] **Step 7: Create `internal/server/review.go`**

```go
package server

import (
    "encoding/json"
    "net/http"
)

func (s *Server) handleGetReview(w http.ResponseWriter, r *http.Request) {
    items, err := s.catStore.SelectNeedsReview()
    if err != nil {
        http.Error(w, `{"error":"db error"}`, http.StatusInternalServerError)
        return
    }
    if items == nil {
        items = []store.ReviewItem{}
    }
    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(items)
}

func (s *Server) handleGetTransactions(w http.ResponseWriter, r *http.Request) {
    q := r.URL.Query()
    items, err := s.catStore.SelectTransactions(q.Get("status"), q.Get("from"), q.Get("to"))
    if err != nil {
        http.Error(w, `{"error":"db error"}`, http.StatusInternalServerError)
        return
    }
    if items == nil {
        items = []store.ReviewItem{}
    }
    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(items)
}
```

Add `"ledger/internal/store"` to the import in review.go.

- [ ] **Step 8: Create `internal/server/transactions.go`**

```go
package server

import (
    "encoding/json"
    "fmt"
    "net/http"
    "strconv"

    "ledger/internal/store"
)

type categorizeReq struct {
    CategoryID int64 `json:"category_id"`
    MakeRule   bool  `json:"make_rule"`
}

func (s *Server) handleCategorize(w http.ResponseWriter, r *http.Request) {
    txID, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
    if err != nil {
        http.Error(w, `{"error":"invalid id"}`, http.StatusBadRequest)
        return
    }
    var req categorizeReq
    if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.CategoryID == 0 {
        http.Error(w, `{"error":"category_id required"}`, http.StatusBadRequest)
        return
    }
    if err := s.catStore.UpdateTransactionCategory(txID, req.CategoryID, "confirmed"); err != nil {
        http.Error(w, `{"error":"db error"}`, http.StatusInternalServerError)
        return
    }
    if req.MakeRule {
        // Fetch the transaction's merchant_raw from the DB for the rule pattern.
        // We use a simple SELECT here rather than adding another interface method.
        var merchant string
        if cs, ok := s.catStore.(interface {
            DB() interface{ QueryRow(string, ...any) interface{ Scan(...any) error } }
        }); ok {
            _ = cs
        }
        // Use the store directly via type assertion to the concrete *store.Store.
        if st, ok := s.catStore.(*store.Store); ok {
            st.DB.QueryRow("SELECT COALESCE(merchant_raw,'') FROM transactions WHERE id=?", txID).Scan(&merchant)
        }
        if merchant != "" {
            _ = s.catStore.InsertRule(store.RuleRow{
                MatchType:  "contains",
                Pattern:    merchant,
                CategoryID: req.CategoryID,
                Priority:   100,
                Source:     "manual",
            })
        }
    }
    w.Header().Set("Content-Type", "application/json")
    fmt.Fprintln(w, `{"ok":true}`)
}

type setStatusReq struct {
    Status string `json:"status"`
}

var validStatuses = map[string]bool{
    "confirmed": true, "ignored": true, "transfer": true, "needs_review": true,
}

func (s *Server) handleSetStatus(w http.ResponseWriter, r *http.Request) {
    txID, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
    if err != nil {
        http.Error(w, `{"error":"invalid id"}`, http.StatusBadRequest)
        return
    }
    var req setStatusReq
    if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Status == "" {
        http.Error(w, `{"error":"status required"}`, http.StatusBadRequest)
        return
    }
    if !validStatuses[req.Status] {
        http.Error(w, `{"error":"invalid status"}`, http.StatusBadRequest)
        return
    }
    if err := s.catStore.UpdateTransactionStatus(txID, req.Status); err != nil {
        http.Error(w, `{"error":"db error"}`, http.StatusInternalServerError)
        return
    }
    w.Header().Set("Content-Type", "application/json")
    fmt.Fprintln(w, `{"ok":true}`)
}
```

- [ ] **Step 9: Add test helpers to `server_test.go`** (or a new test helper file)

The tests reference `newTestServerStore(t)` and `newTestServerWithStore(t, st)`. Add these to the existing `server_test.go` or a new `server_testhelper_test.go`:

```go
func newTestServerStore(t *testing.T) *store.Store {
    t.Helper()
    st, err := store.Open(t.TempDir())
    if err != nil {
        t.Fatalf("store.Open: %v", err)
    }
    t.Cleanup(func() { st.Close() })
    return st
}

func newTestServerWithStore(t *testing.T, st *store.Store) *Server {
    t.Helper()
    webFS, _ := web.FS()
    srv := New(st, webFS)
    srv.SetCategoryStore(st)
    return srv
}
```

Ensure `"ledger/internal/store"` and `"ledger/internal/web"` are in imports.

- [ ] **Step 10: Run all server tests to verify they pass**

```bash
cd /root/Coding/ledger && go test ./internal/server/... -v
```
Expected: all PASS.

- [ ] **Step 11: Commit**

```bash
git add internal/server/categories.go internal/server/categories_test.go \
        internal/server/review.go internal/server/review_test.go \
        internal/server/transactions.go internal/server/transactions_test.go \
        internal/server/server.go
git commit -m "feat(server): GET/POST categories, review, transactions, categorize, set-status endpoints"
```

---

## Task 9: `POST /api/recategorize` — Bulk Categorize Existing Transactions

Add an endpoint that runs the categorizer over all `needs_review` transactions. This processes the 2,370 existing transactions from M3.

**Files:**
- Modify: `internal/server/transactions.go`
- Modify: `internal/server/transactions_test.go`
- Modify: `internal/server/server.go`

- [ ] **Step 1: Write failing test**

Add to `internal/server/transactions_test.go`:

```go
func TestPostRecategorize(t *testing.T) {
    st := newTestServerStore(t)
    seedTransaction(t, st)

    srv := newTestServerWithStore(t, st)
    // Without a categorizer set, recategorize should still return 200 with 0 processed
    r := httptest.NewRequest("POST", "/api/recategorize", nil)
    w := httptest.NewRecorder()
    srv.ServeHTTP(w, r)

    if w.Code != http.StatusOK {
        t.Fatalf("status = %d; body: %s", w.Code, w.Body)
    }
    var resp map[string]any
    json.NewDecoder(w.Body).Decode(&resp)
    if _, ok := resp["processed"]; !ok {
        t.Error("expected 'processed' in response")
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /root/Coding/ledger && go test ./internal/server/... -run TestPostRecategorize -v
```
Expected: FAIL — 404.

- [ ] **Step 3: Add `Categorize` to the server and the recategorize handler**

In `internal/server/server.go`, add:
```go
// CategorizeFunc is called by POST /api/recategorize.
type CategorizeFunc func(ctx context.Context, merchantRaw string) (categoryID int64, status string, ok bool)
```

Add field to Server: `recatFn CategorizeFunc`

Add method:
```go
func (s *Server) SetRecategorizeFn(fn CategorizeFunc) { s.recatFn = fn }
```

Add route in `routes()`:
```go
s.mux.HandleFunc("POST /api/recategorize", s.handleRecategorize)
```

In `internal/server/transactions.go`, add:

```go
func (s *Server) handleRecategorize(w http.ResponseWriter, r *http.Request) {
    items, err := s.catStore.SelectNeedsReview()
    if err != nil {
        http.Error(w, `{"error":"db error"}`, http.StatusInternalServerError)
        return
    }
    processed := 0
    if s.recatFn != nil {
        for _, item := range items {
            catID, status, ok := s.recatFn(r.Context(), item.MerchantRaw)
            if !ok {
                continue
            }
            if err := s.catStore.UpdateTransactionCategory(item.ID, catID, status); err == nil {
                processed++
            }
        }
    }
    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(map[string]any{"processed": processed})
}
```

Add `"context"` to imports in `server.go`.

- [ ] **Step 4: Run all tests**

```bash
cd /root/Coding/ledger && go test ./internal/server/... -v
```
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/server/server.go internal/server/transactions.go internal/server/transactions_test.go
git commit -m "feat(server): POST /api/recategorize — bulk categorize needs_review transactions"
```

---

## Task 10: Wire AI in `main.go` + Update Config + Deploy

Wire the real AI client, build the categorizer from live store data, wire `SetCategoryStore` and `SetRecategorizeFn`, update the example config, and deploy to dinosaur.

**Files:**
- Modify: `cmd/ledger/main.go`
- Modify: `config.example.toml`

- [ ] **Step 1: Update `cmd/ledger/main.go`**

Replace the parse layer block (after `store.Open`) with the full wired version:

```go
import (
    // existing imports…
    "ledger/internal/categorize"
)
```

After `store.Open` and before `srv := server.New(...)`:

```go
    // Categories are seeded by store.Open (idempotent). Build the categorizer
    // from the live store: load rules and categories at startup.
    storeCats, err := st.SelectCategories()
    if err != nil {
        log.Fatalf("select categories: %v", err)
    }
    storeRules, err := st.SelectRules()
    if err != nil {
        log.Fatalf("select rules: %v", err)
    }
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

    // Pick the AI clients based on config.
    var aiCat categorize.AICategorizer = categorize.DisabledAI{}
    var aiExt parse.Extractor = parse.DisabledExtractor{}
    if cfg.AI.Enabled {
        aiCat = categorize.NewAnthropicCategorizer(cfg.AI.APIKey, cfg.AI.Model)
        if cfg.AI.AllowAIExtraction {
            aiExt = parse.NewAnthropicExtractor(cfg.AI.APIKey, cfg.AI.Model)
        }
        log.Printf("ai: enabled (model=%s, threshold=%.2f, auto_rule=%v, allow_extraction=%v)",
            cfg.AI.Model, cfg.AI.AutoAcceptThreshold, cfg.AI.AutoRule, cfg.AI.AllowAIExtraction)
    } else {
        log.Printf("ai: disabled (set ai.enabled=true + LEDGER_AI_API_KEY to activate)")
    }

    cat := categorize.New(domainRules, domainCats, aiCat, cfg.AI.AutoAcceptThreshold, cfg.AI.AutoRule)

    // Parse layer.
    cascade := &parse.Cascade{
        Parsers:   []parse.BankParser{parse.DIBParser{}},
        Heuristic: parse.HeuristicParser{},
        AI:        aiExt,
    }
    processor := parse.NewProcessorWithCategorizer(st, cascade, cat)
```

Wire the server:
```go
    srv := server.New(st, webFS)
    srv.SetIngest(st, cfg.IMAP.Enabled())
    srv.SetReprocessor(processor)
    srv.SetCategoryStore(st)
    srv.SetRecategorizeFn(func(ctx context.Context, merchantRaw string) (int64, string, bool) {
        result, ok := cat.Categorize(ctx, merchantRaw)
        if !ok {
            return 0, "", false
        }
        status := "needs_review"
        if result.AboveThreshold {
            status = "confirmed"
        }
        if result.ProposedRule != nil {
            _ = st.InsertRule(store.RuleRow{
                MatchType:  result.ProposedRule.MatchType,
                Pattern:    result.ProposedRule.Pattern,
                CategoryID: result.ProposedRule.CategoryID,
                Priority:   result.ProposedRule.Priority,
                Source:     "ai_confirmed",
            })
        }
        return result.CategoryID, status, true
    })
```

- [ ] **Step 2: Update `config.example.toml`**

Uncomment the `[ai]` section and add inline docs:

```toml
[ai]
# Set enabled=true and LEDGER_AI_API_KEY env var to activate AI categorization.
# AI never auto-confirms without reaching auto_accept_threshold.
enabled               = false
model                 = "claude-haiku-4-5-20251001"   # cheapest model; good for single merchants
auto_accept_threshold = 0.85                           # >= this → confirmed + rule proposed
auto_rule             = false                          # true = write rule without user tap
allow_ai_extraction   = true                           # let AI be the last-resort parse tier
# Secret: LEDGER_AI_API_KEY=sk-ant-...
```

- [ ] **Step 3: Verify the full build compiles and all tests pass**

```bash
cd /root/Coding/ledger && go build ./... && go test ./... -count=1
```
Expected: build succeeds, all tests PASS.

- [ ] **Step 4: Commit**

```bash
git add cmd/ledger/main.go config.example.toml
git commit -m "feat(main): wire AI categorizer + extractor, SetCategoryStore, recategorize fn"
```

- [ ] **Step 5: Deploy to dinosaur**

```bash
CGO_ENABLED=0 go build -o /usr/local/bin/ledger ./cmd/ledger && \
  systemctl restart ledger && \
  systemctl status ledger --no-pager
```

- [ ] **Step 6: Verify categories were seeded**

```bash
curl -s http://localhost:8080/api/categories | jq 'length'
```
Expected: 18 (or however many seed categories).

- [ ] **Step 7: Verify review queue has the 2,370 transactions**

```bash
curl -s http://localhost:8080/api/review | jq 'length'
```
Expected: ~2370.

- [ ] **Step 8: Run recategorize and verify progress**

If `ai.enabled = false` (default), this processes the rules (none yet), so all stay needs_review:
```bash
curl -s -X POST http://localhost:8080/api/recategorize | jq
```
Expected: `{"processed": 0}` (no rules yet).

Once you add a rule via `POST /api/rules` or enable AI, rerun to categorize.

- [ ] **Step 9: Tag and commit**

```bash
git tag m4-categorize
```

- [ ] **Step 10: Final commit**

```bash
git add config.example.toml
git commit -m "chore: tag m4-categorize — categorizer live on dinosaur"
```

---

## Self-Review

### Spec Coverage Check

| Spec requirement (§6.3) | Covered by task |
|---|---|
| Rules pass: match merchant_raw by priority, case-insensitive | Task 4 |
| Exact / contains / regex match types | Task 4 |
| Rule hit → category_id, status=confirmed, no AI call | Task 4, 7 |
| AI fallback on miss, only if enabled | Task 5, 7 |
| AI receives ONLY the merchant string | Task 5 (AnthropicCategorizer sends only merchant + names) |
| confidence >= threshold → confirmed + propose rule | Task 4, 7 |
| confidence < threshold → needs_review | Task 4, 7 |
| No AI / disabled / error → needs_review | Task 4 (DisabledAI), Task 7 |
| Never block ingestion on LLM | Task 7 (categorizeTransaction ignores errors silently) |
| Rule write-back when auto_rule=true or user confirms | Task 7 (AI), Task 8 (manual categorize with make_rule=true) |
| Real Anthropic client (deferred from M3) | Task 5, 6 |
| API: POST /api/transactions/{id}/categorize | Task 8 |
| API: POST /api/transactions/{id}/status | Task 8 |
| API: GET/POST /api/categories | Task 8 |
| API: GET /api/review | Task 8 |
| Seed default categories day-one | Task 3 |
| AI config: enabled, model, threshold, auto_rule, allow_ai_extraction | Task 1 |
| [ai] in config.example.toml | Task 10 |
| Bulk recategorize existing 2,370 transactions | Task 9, 10 |

### Placeholder Scan

No TBD, TODO, "implement later", or vague instructions found. All code steps include actual Go.

### Type Consistency Check

- `store.CategoryRow` → used in `categories.go`, `server.go` interface, `categories_test.go` ✓
- `store.RuleRow` → used in `categories.go`, `transactions.go` ✓
- `store.ReviewItem` → returned by `SelectNeedsReview`, `SelectTransactions`, used in review.go, review_test.go ✓
- `categorize.Category`, `categorize.Rule`, `categorize.Result` → defined in Task 4, used in Tasks 5, 7, 10 ✓
- `InsertTransaction` 3-return `(int64, bool, error)` → updated in Task 2, caller in Task 7 uses `txID, _, ierr` ✓
- `NewProcessorWithCategorizer` → defined Task 7, used Task 10 ✓
- `server.CategorizeFunc` signature `func(ctx context.Context, merchantRaw string) (int64, string, bool)` → defined Task 9, wired Task 10 ✓
