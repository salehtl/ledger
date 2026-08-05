package importer

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
)

func TestImportConformance(t *testing.T) {
	_, file, _, _ := runtime.Caller(0)
	b, err := os.ReadFile(filepath.Join(filepath.Dir(file), "..", "..", "conformance", "import", "vectors.json"))
	if err != nil {
		t.Fatal(err)
	}
	var vectors []struct {
		Name string `json:"name"`
		Map  struct {
			DateFormat    string            `json:"date_format"`
			Currency      string            `json:"currency"`
			DirectionMode string            `json:"direction_mode"`
			Columns       ColumnMap         `json:"columns"`
			Categories    map[string]string `json:"categories"`
		} `json:"map"`
		Raw      RawRow `json:"raw"`
		RowIndex int    `json:"row_index"`
		Expected struct {
			PostedAt    string `json:"posted_at"`
			MerchantRaw string `json:"merchant_raw"`
			AmountMinor string `json:"amount_minor"`
			Currency    string `json:"currency"`
			Direction   string `json:"direction"`
			Category    string `json:"category"`
		} `json:"expected"`
		Error string `json:"error"`
	}
	if err := json.Unmarshal(b, &vectors); err != nil {
		t.Fatal(err)
	}
	for _, v := range vectors {
		t.Run(v.Name, func(t *testing.T) {
			m := MapConfig{Columns: v.Map.Columns, Categories: v.Map.Categories, DateFormat: v.Map.DateFormat, Currency: v.Map.Currency, DirectionMode: v.Map.DirectionMode}
			n := Normalize(v.Raw, m, v.RowIndex)
			if v.Error != "" {
				if n.Err == nil || !strings.Contains(n.Err.Error(), v.Error) {
					t.Fatalf("error=%v, want containing %q", n.Err, v.Error)
				}
				return
			}
			if n.Err != nil {
				t.Fatal(n.Err)
			}
			if got := n.Txn.PostedAt.Format("2006-01-02T15:04:05Z"); got != v.Expected.PostedAt {
				t.Errorf("posted_at=%s", got)
			}
			if n.Txn.MerchantRaw != v.Expected.MerchantRaw || strconv.FormatInt(n.Txn.AmountFils, 10) != v.Expected.AmountMinor || n.Txn.Currency != v.Expected.Currency || n.Txn.Direction != v.Expected.Direction || n.CategoryName != v.Expected.Category {
				t.Errorf("normalized mismatch: %+v category=%q", n.Txn, n.CategoryName)
			}
		})
	}
}
