package server

import (
	"encoding/json"
	"net/http"
	"testing"

	"ledger/internal/store"
)

func newSplitsTestServer(t *testing.T) (*Server, *store.Store, int64, int64) {
	t.Helper()
	st := newTestServerStore(t)
	srv := New(st, testFS())
	srv.SetSplitsStore(st)
	srv.SetCategoryStore(st)
	catA := projInsertCategory(t, st, "SplitA", "spending", "need")
	catB := projInsertCategory(t, st, "SplitB", "spending", "want")
	return srv, st, catA, catB
}

func TestPutSplitsReplaceAndUnsplit(t *testing.T) {
	srv, st, catA, catB := newSplitsTestServer(t)
	txID := projInsertTxn(t, st, catA, "debit", 100_00, "2026-07-10", "confirmed")
	path := "/api/transactions/" + itoa(txID) + "/splits"

	// Split 60/40.
	w := doJSON(t, srv, "PUT", path, map[string]any{
		"splits": []map[string]any{
			{"category_id": catA, "amount_fils": 60_00, "note": "mine"},
			{"category_id": catB, "amount_fils": 40_00},
		},
	})
	if w.Code != http.StatusOK {
		t.Fatalf("PUT status = %d; body: %s", w.Code, w.Body)
	}
	var resp struct {
		OK     bool `json:"ok"`
		Splits []struct {
			ID         int64  `json:"id"`
			CategoryID int64  `json:"category_id"`
			AmountFils int64  `json:"amount_fils"`
			Note       string `json:"note"`
		} `json:"splits"`
	}
	json.Unmarshal(w.Body.Bytes(), &resp)
	if !resp.OK || len(resp.Splits) != 2 || resp.Splits[0].AmountFils != 60_00 || resp.Splits[0].Note != "mine" {
		t.Fatalf("resp = %+v", resp)
	}

	// GET echoes the same lines.
	w = doJSON(t, srv, "GET", path, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("GET status = %d", w.Code)
	}

	// The transaction list is decorated with the split lines, and the parent
	// is uncategorized while split.
	w = doJSON(t, srv, "GET", "/api/transactions", nil)
	if w.Code != http.StatusOK {
		t.Fatalf("list status = %d", w.Code)
	}
	var list []struct {
		ID         int64
		CategoryID *int64
		Splits     []struct {
			CategoryID int64
			AmountFils int64
		}
	}
	if err := json.Unmarshal(w.Body.Bytes(), &list); err != nil {
		t.Fatalf("decode list: %v; body: %s", err, w.Body)
	}
	var found bool
	for _, it := range list {
		if it.ID == txID {
			found = true
			if it.CategoryID != nil {
				t.Errorf("split parent still categorized: %v", *it.CategoryID)
			}
			if len(it.Splits) != 2 {
				t.Errorf("list decoration = %+v, want 2 split lines", it.Splits)
			}
		}
	}
	if !found {
		t.Fatal("split parent missing from list")
	}

	// Empty set un-splits.
	w = doJSON(t, srv, "PUT", path, map[string]any{"splits": []map[string]any{}})
	if w.Code != http.StatusOK {
		t.Fatalf("unsplit status = %d; body: %s", w.Code, w.Body)
	}
	json.Unmarshal(w.Body.Bytes(), &resp)
	if len(resp.Splits) != 0 {
		t.Fatalf("after unsplit resp = %+v", resp)
	}
}

func TestPutSplitsValidation(t *testing.T) {
	srv, st, catA, catB := newSplitsTestServer(t)
	txID := projInsertTxn(t, st, catA, "debit", 100_00, "2026-07-10", "confirmed")

	tests := []struct {
		name string
		path string
		body map[string]any
		want int
	}{
		{"sum mismatch", "/api/transactions/" + itoa(txID) + "/splits", map[string]any{
			"splits": []map[string]any{
				{"category_id": catA, "amount_fils": 60_00},
				{"category_id": catB, "amount_fils": 50_00},
			}}, http.StatusBadRequest},
		{"zero line", "/api/transactions/" + itoa(txID) + "/splits", map[string]any{
			"splits": []map[string]any{
				{"category_id": catA, "amount_fils": 0},
				{"category_id": catB, "amount_fils": 100_00},
			}}, http.StatusBadRequest},
		{"missing category", "/api/transactions/" + itoa(txID) + "/splits", map[string]any{
			"splits": []map[string]any{
				{"category_id": 0, "amount_fils": 100_00},
			}}, http.StatusBadRequest},
		{"unknown transaction", "/api/transactions/424242/splits", map[string]any{
			"splits": []map[string]any{
				{"category_id": catA, "amount_fils": 100_00},
			}}, http.StatusNotFound},
		{"bad id", "/api/transactions/abc/splits", map[string]any{}, http.StatusBadRequest},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			w := doJSON(t, srv, "PUT", tc.path, tc.body)
			if w.Code != tc.want {
				t.Errorf("status = %d, want %d; body: %s", w.Code, tc.want, w.Body)
			}
		})
	}
}

func TestPutTransactionNote(t *testing.T) {
	st := newTestServerStore(t)
	srv := New(st, testFS())
	srv.SetCategoryStore(st)
	srv.SetNoteStore(st)
	cat := projInsertCategory(t, st, "NoteCat", "spending", "need")
	txID := projInsertTxn(t, st, cat, "debit", 10_00, "2026-07-10", "confirmed")

	w := doJSON(t, srv, "PUT", "/api/transactions/"+itoa(txID)+"/note", map[string]any{"note": "team lunch"})
	if w.Code != http.StatusOK {
		t.Fatalf("PUT note status = %d; body: %s", w.Code, w.Body)
	}

	// The note flows through the transaction list payload.
	w = doJSON(t, srv, "GET", "/api/transactions", nil)
	var list []struct {
		ID   int64
		Note string
	}
	json.Unmarshal(w.Body.Bytes(), &list)
	var got string
	for _, it := range list {
		if it.ID == txID {
			got = it.Note
		}
	}
	if got != "team lunch" {
		t.Fatalf("note in list = %q, want %q", got, "team lunch")
	}

	// Clearing and missing-id behavior.
	if w := doJSON(t, srv, "PUT", "/api/transactions/"+itoa(txID)+"/note", map[string]any{"note": ""}); w.Code != http.StatusOK {
		t.Fatalf("clear note status = %d", w.Code)
	}
	if w := doJSON(t, srv, "PUT", "/api/transactions/424242/note", map[string]any{"note": "x"}); w.Code != http.StatusNotFound {
		t.Fatalf("missing txn status = %d, want 404", w.Code)
	}
}
