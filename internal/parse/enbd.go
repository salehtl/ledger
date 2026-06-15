package parse

import (
	"fmt"
	"regexp"
	"strings"
	"time"
)

// ENBDParser parses Emirates NBD online-banking transfer notifications
// (English HTML — "Local Bank Transfer" / "Telegraphic Transfer"). They are
// outgoing transfers, so they always represent a debit on the sender's account.
//
// The heuristic tier could already read the amount, but ENBD's date format
// ("05/Jun/2026 04:25 PM") is not the dd-mm-yyyy the heuristic recognises, so
// Validate dropped every one of these as unparsed. This template fixes that.
type ENBDParser struct{}

func (ENBDParser) Bank() string { return "enbd" }

func (ENBDParser) Matches(from, subject string) bool {
	return strings.Contains(strings.ToLower(from), "onlinebanking@emiratesnbd.com")
}

var (
	enbdDebitRe = regexp.MustCompile(`(?i)Debit Amount:\s*\n\s*(.+)`)
	enbdDateRe  = regexp.MustCompile(`(?i)Transaction Date:\s*\n\s*(.+)`)
	enbdPayeeRe = regexp.MustCompile(`(?i)Beneficiary Name:\s*\n\s*(.+)`)
)

func (ENBDParser) Parse(textBody string) (ParsedTxn, error) {
	am := enbdDebitRe.FindStringSubmatch(textBody)
	if am == nil {
		return ParsedTxn{}, fmt.Errorf("enbd: 'Debit Amount' anchor not found")
	}
	fils, currency, err := ParseAEDToFils(am[1])
	if err != nil {
		return ParsedTxn{}, fmt.Errorf("enbd amount: %w", err)
	}
	p := ParsedTxn{
		AmountFils: fils,
		Currency:   currency,
		Direction:  DirectionDebit,
		Tier:       TierTemplate,
		Confidence: 0.95,
	}
	dm := enbdDateRe.FindStringSubmatch(textBody)
	if dm == nil {
		return ParsedTxn{}, fmt.Errorf("enbd: 'Transaction Date' anchor not found")
	}
	d, err := ParseENBDDate(dm[1])
	if err != nil {
		return ParsedTxn{}, fmt.Errorf("enbd date: %w", err)
	}
	p.PostedAt = d
	if pm := enbdPayeeRe.FindStringSubmatch(textBody); pm != nil {
		p.MerchantRaw = strings.TrimSpace(pm[1])
	}
	return p, nil
}

// ParseENBDDate parses "05/Jun/2026 04:25 PM" with a date-only fallback.
func ParseENBDDate(s string) (time.Time, error) {
	s = strings.TrimSpace(s)
	if t, err := time.Parse("02/Jan/2006 03:04 PM", s); err == nil {
		return t, nil
	}
	fields := strings.Fields(s)
	if len(fields) == 0 {
		return time.Time{}, fmt.Errorf("enbd: empty date")
	}
	return time.Parse("02/Jan/2006", fields[0])
}
