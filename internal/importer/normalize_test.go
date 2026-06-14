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
	m.Columns.Category = "" // no category column configured
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
		t.Errorf("status = %q, want needs_review (category/status promoted post-insert by Importer)", n.Txn.Status)
	}
}
