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

func TestReadCSV_HeaderOnly(t *testing.T) {
	rows, err := ReadCSV(strings.NewReader("Date,Description,Amount\n"))
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 0 {
		t.Errorf("got %d rows, want 0 for header-only CSV", len(rows))
	}
}

func TestReadCSV_TrimsHeaderWhitespace(t *testing.T) {
	input := " Date , Description , Amount \n19/08/2025,Amazon.ae,-38.25\n"
	rows, err := ReadCSV(strings.NewReader(input))
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 {
		t.Fatalf("got %d rows, want 1", len(rows))
	}
	if rows[0]["Date"] != "19/08/2025" {
		t.Errorf("Date key not found or wrong; row = %v", rows[0])
	}
}

func TestReadCSV_EmptyReader(t *testing.T) {
	rows, err := ReadCSV(strings.NewReader(""))
	if err != nil {
		t.Fatal(err)
	}
	if rows != nil {
		t.Errorf("got %v, want nil for empty CSV", rows)
	}
}

func TestReadFile_UnsupportedExtension(t *testing.T) {
	_, err := ReadFile("/tmp/data.txt")
	if err == nil {
		t.Error("expected error for unsupported extension")
	}
}
