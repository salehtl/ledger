package parse

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// amountRe finds an optional 3-letter currency then a number with comma
// thousands separators and exactly two decimals.
var amountRe = regexp.MustCompile(`(?:([A-Z]{3})\s*)?([0-9][0-9,]*\.[0-9]{2})`)

// ParseAEDToFils parses "AED 10,000.00" (or a bare "10,000.00") into integer
// fils (×100). Returns the currency (defaulting to "AED" when absent).
func ParseAEDToFils(s string) (int64, string, error) {
	m := amountRe.FindStringSubmatch(s)
	if m == nil {
		return 0, "", fmt.Errorf("no amount in %q", s)
	}
	currency := m[1]
	if currency == "" {
		currency = "AED"
	}
	digits := strings.ReplaceAll(m[2], ",", "")
	digits = strings.Replace(digits, ".", "", 1) // "10000.00" -> "1000000"
	fils, err := strconv.ParseInt(digits, 10, 64)
	if err != nil {
		return 0, "", fmt.Errorf("parse amount %q: %w", m[2], err)
	}
	return fils, currency, nil
}

// ParseDIBDate parses DIB's DD-MM-YYYY date (time, if any, is ignored).
func ParseDIBDate(s string) (time.Time, error) {
	return time.Parse("02-01-2006", strings.TrimSpace(s))
}
