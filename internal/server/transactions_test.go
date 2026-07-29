package server

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"ledger/internal/store"
)

func TestPostCategorize(t *testing.T) {
	st := newTestServerStore(t)
	txID := seedTestTransaction(t, st)
	cats, _ := st.SelectCategories()
	var catID int64
	for _, c := range cats {
		if c.Name == "Shopping" {
			catID = c.ID
		}
	}
	if catID == 0 {
		t.Fatal("Shopping category not found")
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
	var status string
	st.DB.QueryRow("SELECT status FROM transactions WHERE id=?", txID).Scan(&status)
	if status != "confirmed" {
		t.Errorf("status = %q, want confirmed", status)
	}
}

func TestPostCategorizeWithRule(t *testing.T) {
	st := newTestServerStore(t)
	txID := seedTestTransaction(t, st)
	cats, _ := st.SelectCategories()
	var catID int64
	for _, c := range cats {
		if c.Name == "Shopping" {
			catID = c.ID
		}
	}

	srv := newTestServerWithStore(t, st)
	body, _ := json.Marshal(map[string]any{"category_id": catID, "make_rule": true, "merchant_raw": "DAPPER DAN GENTS SAL"})
	r := httptest.NewRequest("POST", fmt.Sprintf("/api/transactions/%d/categorize", txID), bytes.NewReader(body))
	w := httptest.NewRecorder()
	srv.ServeHTTP(w, r)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d", w.Code)
	}
	rules, _ := st.SelectRules()
	if len(rules) == 0 {
		t.Error("expected a rule to be written back when make_rule=true")
	}
}

// The categorize response reports the ID of the rule it wrote so the client
// can offer an undo that also removes the rule.
func TestPostCategorizeReturnsRuleID(t *testing.T) {
	st := newTestServerStore(t)
	txID := seedTestTransaction(t, st)
	cats, _ := st.SelectCategories()
	var catID int64
	for _, c := range cats {
		if c.Name == "Shopping" {
			catID = c.ID
		}
	}

	srv := newTestServerWithStore(t, st)
	body, _ := json.Marshal(map[string]any{"category_id": catID, "make_rule": true, "merchant_raw": "DAPPER DAN GENTS SAL"})
	r := httptest.NewRequest("POST", fmt.Sprintf("/api/transactions/%d/categorize", txID), bytes.NewReader(body))
	w := httptest.NewRecorder()
	srv.ServeHTTP(w, r)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d", w.Code)
	}
	var resp struct {
		OK     bool   `json:"ok"`
		RuleID *int64 `json:"rule_id"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp.RuleID == nil || *resp.RuleID <= 0 {
		t.Fatalf("rule_id = %v, want positive rule id; body: %s", resp.RuleID, w.Body)
	}
	rules, _ := st.SelectRules()
	if len(rules) != 1 || rules[0].ID != *resp.RuleID {
		t.Errorf("rules = %+v, want single rule with id %d", rules, *resp.RuleID)
	}

	// Without make_rule the response must not claim a rule was written.
	tx2 := seedTestTransaction(t, st)
	body, _ = json.Marshal(map[string]any{"category_id": catID, "make_rule": false})
	r = httptest.NewRequest("POST", fmt.Sprintf("/api/transactions/%d/categorize", tx2), bytes.NewReader(body))
	w = httptest.NewRecorder()
	srv.ServeHTTP(w, r)
	var resp2 struct {
		RuleID *int64 `json:"rule_id"`
	}
	json.Unmarshal(w.Body.Bytes(), &resp2)
	if resp2.RuleID != nil {
		t.Errorf("rule_id = %v without make_rule, want absent", *resp2.RuleID)
	}
}

func TestPostStatus(t *testing.T) {
	st := newTestServerStore(t)
	txID := seedTestTransaction(t, st)

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
	txID := seedTestTransaction(t, st)
	srv := newTestServerWithStore(t, st)

	body, _ := json.Marshal(map[string]any{"status": "deleted"})
	r := httptest.NewRequest("POST", fmt.Sprintf("/api/transactions/%d/status", txID), bytes.NewReader(body))
	w := httptest.NewRecorder()
	srv.ServeHTTP(w, r)

	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400 for invalid status", w.Code)
	}
}

func TestPostArchiveAndRestore(t *testing.T) {
	st := newTestServerStore(t)
	txID := seedTestTransaction(t, st)
	srv := newTestServerWithStore(t, st)

	r := httptest.NewRequest("POST", fmt.Sprintf("/api/transactions/%d/archive", txID), nil)
	w := httptest.NewRecorder()
	srv.ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("archive status = %d; body: %s", w.Code, w.Body)
	}
	var dbStatus string
	st.DB.QueryRow("SELECT status FROM transactions WHERE id=?", txID).Scan(&dbStatus)
	if dbStatus != "archived" {
		t.Fatalf("db status = %q, want archived", dbStatus)
	}

	r = httptest.NewRequest("POST", fmt.Sprintf("/api/transactions/%d/restore", txID), nil)
	w = httptest.NewRecorder()
	srv.ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("restore status = %d; body: %s", w.Code, w.Body)
	}
	st.DB.QueryRow("SELECT status FROM transactions WHERE id=?", txID).Scan(&dbStatus)
	if dbStatus != "needs_review" {
		t.Fatalf("db status after restore = %q, want needs_review", dbStatus)
	}
}

func TestPostArchiveInvalidID(t *testing.T) {
	st := newTestServerStore(t)
	srv := newTestServerWithStore(t, st)
	r := httptest.NewRequest("POST", "/api/transactions/abc/archive", nil)
	w := httptest.NewRecorder()
	srv.ServeHTTP(w, r)
	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", w.Code)
	}
}

func TestPostManualTransaction(t *testing.T) {
	st := newTestServerStore(t)
	srv := newTestServerWithStore(t, st)
	body, _ := json.Marshal(map[string]any{
		"posted_at": "2026-06-15", "amount_fils": 4250, "direction": "debit",
		"merchant_raw": "Corner Shop",
	})
	r := httptest.NewRequest("POST", "/api/transactions", bytes.NewReader(body))
	w := httptest.NewRecorder()
	srv.ServeHTTP(w, r)
	if w.Code != http.StatusCreated {
		t.Fatalf("status = %d; body: %s", w.Code, w.Body)
	}
	var resp map[string]any
	json.NewDecoder(w.Body).Decode(&resp)
	if resp["id"] == nil || resp["id"].(float64) <= 0 {
		t.Fatalf("expected positive id, got %v", resp["id"])
	}
	var n int
	st.DB.QueryRow("SELECT count(*) FROM transactions WHERE source='manual'").Scan(&n)
	if n != 1 {
		t.Errorf("manual rows = %d, want 1", n)
	}
}

func TestPostManualTransactionRejectsBadInput(t *testing.T) {
	st := newTestServerStore(t)
	srv := newTestServerWithStore(t, st)
	cases := []map[string]any{
		{"posted_at": "2026-06-15", "amount_fils": 0, "direction": "debit", "merchant_raw": "X"},      // amount <= 0
		{"posted_at": "2026-06-15", "amount_fils": 100, "direction": "sideways", "merchant_raw": "X"}, // bad direction
		{"posted_at": "2026-06-15", "amount_fils": 100, "direction": "debit", "merchant_raw": "  "},   // blank merchant
		{"posted_at": "nope", "amount_fils": 100, "direction": "debit", "merchant_raw": "X"},          // bad date
	}
	for i, c := range cases {
		body, _ := json.Marshal(c)
		r := httptest.NewRequest("POST", "/api/transactions", bytes.NewReader(body))
		w := httptest.NewRecorder()
		srv.ServeHTTP(w, r)
		if w.Code != http.StatusBadRequest {
			t.Errorf("case %d: status = %d, want 400", i, w.Code)
		}
	}
}

func seedTestTransaction(t *testing.T, st *store.Store) int64 {
	t.Helper()
	if _, err := st.InsertIngest(store.IngestRecord{
		MessageUID:  "t1",
		FromAddr:    "DIB.notification@dib.ae",
		Subject:     "s",
		ParseStatus: "parsed",
		RawBody:     []byte("r"),
		CreatedAt:   time.Now(),
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
		IngestID:    ingestID,
	})
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func TestGetTransactions(t *testing.T) {
	st := newTestServerStore(t)
	seedTestTransaction(t, st)
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

func TestGetTransactionsStatusFilter(t *testing.T) {
	st := newTestServerStore(t)
	seedTestTransaction(t, st)
	srv := newTestServerWithStore(t, st)

	// Filter by confirmed — should return 0 (our tx is needs_review)
	r := httptest.NewRequest("GET", "/api/transactions?status=confirmed", nil)
	w := httptest.NewRecorder()
	srv.ServeHTTP(w, r)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d", w.Code)
	}
	var items []map[string]any
	json.NewDecoder(w.Body).Decode(&items)
	if len(items) != 0 {
		t.Errorf("confirmed filter: got %d items, want 0", len(items))
	}
}

func TestClearCategorization(t *testing.T) {
	st := newTestServerStore(t)
	txID := seedTestTransaction(t, st)
	cats, _ := st.SelectCategories()
	var catID int64
	for _, c := range cats {
		if c.Name == "Shopping" {
			catID = c.ID
		}
	}
	if err := st.UpdateTransactionCategory(txID, catID, "confirmed"); err != nil {
		t.Fatalf("setup categorize: %v", err)
	}

	srv := newTestServerWithStore(t, st)
	r := httptest.NewRequest("POST", "/api/categorization/clear", nil)
	w := httptest.NewRecorder()
	srv.ServeHTTP(w, r)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d; body: %s", w.Code, w.Body)
	}
	var resp map[string]any
	json.NewDecoder(w.Body).Decode(&resp)
	if resp["cleared"] == nil || resp["cleared"].(float64) != 1 {
		t.Errorf("expected cleared=1, got %v", resp["cleared"])
	}

	var status string
	var cat sql.NullInt64
	st.DB.QueryRow("SELECT status, category_id FROM transactions WHERE id=?", txID).Scan(&status, &cat)
	if status != "needs_review" {
		t.Errorf("db status = %q, want needs_review", status)
	}
	if cat.Valid {
		t.Errorf("category_id not cleared: %d", cat.Int64)
	}
}

func TestGetTransactionsSearch(t *testing.T) {
	st := newTestServerStore(t)
	seedTestTransaction(t, st) // merchant "DAPPER DAN GENTS SAL"
	srv := newTestServerWithStore(t, st)

	r := httptest.NewRequest("GET", "/api/transactions?q=dapper", nil)
	w := httptest.NewRecorder()
	srv.ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d; body: %s", w.Code, w.Body)
	}
	var hits []map[string]any
	json.NewDecoder(w.Body).Decode(&hits)
	if len(hits) != 1 {
		t.Errorf("q=dapper: got %d items, want 1", len(hits))
	}

	r = httptest.NewRequest("GET", "/api/transactions?q=nomatch", nil)
	w = httptest.NewRecorder()
	srv.ServeHTTP(w, r)
	var misses []map[string]any
	json.NewDecoder(w.Body).Decode(&misses)
	if len(misses) != 0 {
		t.Errorf("q=nomatch: got %d items, want 0", len(misses))
	}
}

// POST categorize with an explicit null category_id decategorizes: category
// cleared, transaction back in the review queue, no rule written.
func TestPostCategorizeClear(t *testing.T) {
	st := newTestServerStore(t)
	txID := seedTestTransaction(t, st)
	cats, _ := st.SelectCategories()
	var catID int64
	for _, c := range cats {
		if c.Name == "Shopping" {
			catID = c.ID
		}
	}
	if err := st.UpdateTransactionCategory(txID, catID, "confirmed"); err != nil {
		t.Fatalf("precategorize: %v", err)
	}

	srv := newTestServerWithStore(t, st)
	body := []byte(`{"category_id": null, "make_rule": true, "merchant_raw": "X"}`)
	r := httptest.NewRequest("POST", fmt.Sprintf("/api/transactions/%d/categorize", txID), bytes.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	srv.ServeHTTP(w, r)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d; body: %s", w.Code, w.Body)
	}
	var gotCat *int64
	var status string
	st.DB.QueryRow("SELECT category_id, status FROM transactions WHERE id=?", txID).Scan(&gotCat, &status)
	if gotCat != nil {
		t.Errorf("category_id = %v, want NULL", *gotCat)
	}
	if status != "needs_review" {
		t.Errorf("status = %q, want needs_review", status)
	}
	rules, _ := st.SelectRules()
	if len(rules) != 0 {
		t.Errorf("rules = %d, want 0 (make_rule ignored on clear)", len(rules))
	}
}

// TestPostManualTransactionWithAccount: the reconcile discrepancy card's
// "open manual entry" path — an entry created with account_id carries the
// account's last4 so expected-balance math converges.
func TestPostManualTransactionWithAccount(t *testing.T) {
	st := newTestServerStore(t)
	srv := newTestServerWithStore(t, st)
	acctID, err := st.InsertAccount("Main", "DIB", "7788")
	if err != nil {
		t.Fatal(err)
	}

	body, _ := json.Marshal(map[string]any{
		"posted_at": "2026-07-15", "amount_fils": 9000, "direction": "debit",
		"merchant_raw": "ATM cash", "account_id": acctID,
	})
	r := httptest.NewRequest("POST", "/api/transactions", bytes.NewReader(body))
	w := httptest.NewRecorder()
	srv.ServeHTTP(w, r)
	if w.Code != http.StatusCreated {
		t.Fatalf("status = %d; body: %s", w.Code, w.Body)
	}
	var last4 string
	st.DB.QueryRow(`SELECT COALESCE(last4,'') FROM transactions WHERE source='manual'`).Scan(&last4)
	if last4 != "7788" {
		t.Errorf("last4 = %q, want 7788", last4)
	}

	// Unknown account → 400, and nothing is written.
	body, _ = json.Marshal(map[string]any{
		"posted_at": "2026-07-15", "amount_fils": 9000, "direction": "debit",
		"merchant_raw": "ATM cash", "account_id": 999999,
	})
	r = httptest.NewRequest("POST", "/api/transactions", bytes.NewReader(body))
	w = httptest.NewRecorder()
	srv.ServeHTTP(w, r)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("unknown account: status = %d, want 400; body: %s", w.Code, w.Body)
	}
	var n int
	st.DB.QueryRow(`SELECT count(*) FROM transactions WHERE source='manual'`).Scan(&n)
	if n != 1 {
		t.Errorf("manual rows = %d, want 1 (rejected write persisted)", n)
	}
}

// TestPostCategorizeSplitParentConflicts: a split parent's category stays
// NULL (its lines carry the truth). The categorize endpoint must 409 instead
// of silently corrupting the split invariant — the embedded UI renders split
// parents as ordinary rows, so this tap WILL happen.
func TestPostCategorizeSplitParentConflicts(t *testing.T) {
	st := newTestServerStore(t)
	txID := seedTestTransaction(t, st)
	if err := st.UpdateTransactionStatus(txID, "confirmed"); err != nil {
		t.Fatal(err)
	}
	cats, _ := st.SelectCategories()
	var need, want int64
	for _, c := range cats {
		switch c.Name {
		case "Groceries":
			need = c.ID
		case "Shopping":
			want = c.ID
		}
	}
	if need == 0 || want == 0 {
		t.Fatal("seed categories missing")
	}
	if err := st.ReplaceTransactionSplits(txID, []store.TransactionSplitRow{
		{CategoryID: need, AmountFils: 11_500},
		{CategoryID: want, AmountFils: 10_000},
	}); err != nil {
		t.Fatal(err)
	}

	srv := newTestServerWithStore(t, st)
	body, _ := json.Marshal(map[string]any{"category_id": need})
	r := httptest.NewRequest("POST", fmt.Sprintf("/api/transactions/%d/categorize", txID), bytes.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	srv.ServeHTTP(w, r)

	if w.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409; body: %s", w.Code, w.Body)
	}
	var parentCat sql.NullInt64
	if err := st.DB.QueryRow(`SELECT category_id FROM transactions WHERE id=?`, txID).Scan(&parentCat); err != nil {
		t.Fatal(err)
	}
	if parentCat.Valid {
		t.Fatalf("split parent got categorized to %d despite 409", parentCat.Int64)
	}
}
