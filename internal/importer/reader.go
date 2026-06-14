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
