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

func TestLoadMap_MissingDate(t *testing.T) {
	p := writeMapTOML(t, `[columns]`)
	_, err := LoadMap(p)
	if err == nil {
		t.Error("expected error for missing columns.date")
	}
}

func TestLoadMap_MissingDescription(t *testing.T) {
	p := writeMapTOML(t, `
[columns]
date = "Date"
`)
	_, err := LoadMap(p)
	if err == nil {
		t.Error("expected error for missing columns.description")
	}
}

func TestLoadMap_InvalidDirectionMode(t *testing.T) {
	p := writeMapTOML(t, `
[columns]
date        = "Date"
description = "Description"
amount      = "Amount"
direction_mode = "bad"
`)
	_, err := LoadMap(p)
	if err == nil {
		t.Error("expected error for invalid direction_mode")
	}
}

func TestParseDate_DDMMYYYY(t *testing.T) {
	m := MapConfig{DateFormat: "02/01/2006"}
	got, err := m.ParseDate("19/08/2025")
	if err != nil {
		t.Fatal(err)
	}
	if got.Year() != 2025 || int(got.Month()) != 8 || got.Day() != 19 {
		t.Errorf("got %v, want 2025-08-19", got)
	}
}

func TestParseDate_ISO8601(t *testing.T) {
	m := MapConfig{DateFormat: "2006-01-02"}
	got, err := m.ParseDate("2025-08-19")
	if err != nil {
		t.Fatal(err)
	}
	if got.Year() != 2025 || int(got.Month()) != 8 || got.Day() != 19 {
		t.Errorf("got %v, want 2025-08-19", got)
	}
}

func TestParseDate_Invalid(t *testing.T) {
	m := MapConfig{DateFormat: "02/01/2006"}
	_, err := m.ParseDate("not-a-date")
	if err == nil {
		t.Error("expected error for invalid date")
	}
}

func TestParseAmount_SignMode_Debit(t *testing.T) {
	m := MapConfig{DirectionMode: "sign", Columns: ColumnMap{Amount: "Amount"}}
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
	m := MapConfig{DirectionMode: "sign", Columns: ColumnMap{Amount: "Amount"}}
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

func TestParseAmount_ColumnsMode_Debit(t *testing.T) {
	m := MapConfig{DirectionMode: "columns", Columns: ColumnMap{Debit: "Debit", Credit: "Credit"}}
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

func TestParseAmount_ColumnsMode_Credit(t *testing.T) {
	m := MapConfig{DirectionMode: "columns", Columns: ColumnMap{Debit: "Debit", Credit: "Credit"}}
	fils, dir, err := m.ParseAmount(map[string]string{"Debit": "", "Credit": "5000.00"})
	if err != nil {
		t.Fatal(err)
	}
	if fils != 500000 {
		t.Errorf("fils = %d, want 500000", fils)
	}
	if dir != "credit" {
		t.Errorf("direction = %q, want credit", dir)
	}
}

func TestParseAmount_ThousandsSeparator(t *testing.T) {
	m := MapConfig{DirectionMode: "sign", Columns: ColumnMap{Amount: "Amount"}}
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
