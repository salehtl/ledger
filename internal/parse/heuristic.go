package parse

import (
	"fmt"
	"regexp"
	"strings"
)

// HeuristicParser is a bank-agnostic fallback. It is NOT a BankParser (it has no
// sender match); the cascade calls it directly when no template matches.
type HeuristicParser struct{}

var (
	heurDateRe   = regexp.MustCompile(`\b(\d{2}-\d{2}-\d{4})\b`)
	creditWordRe = regexp.MustCompile(`(?i)\b(credit(ed)?|deposit(ed)?|received|refund)\b`)
	merchantRe   = regexp.MustCompile(`(?i)\b(?:at|to|merchant|payment to|paid to)\b[:\s]+([A-Za-z0-9][A-Za-z0-9 &.'\-]{2,40})`)
)

// Parse extracts shape-level fields. Confidence is fixed low so results route to
// review. Returns an error only when no amount can be found (nothing to record).
func (HeuristicParser) Parse(textBody string) (ParsedTxn, error) {
	fils, currency, err := ParseAEDToFils(textBody)
	if err != nil {
		return ParsedTxn{}, fmt.Errorf("heuristic: %w", err)
	}
	p := ParsedTxn{
		AmountFils: fils,
		Currency:   currency,
		Direction:  DirectionDebit,
		Tier:       TierHeuristic,
		Confidence: 0.4,
	}
	if creditWordRe.MatchString(textBody) {
		p.Direction = DirectionCredit
	}
	if m := heurDateRe.FindStringSubmatch(textBody); m != nil {
		if d, derr := ParseDIBDate(m[1]); derr == nil {
			p.PostedAt = d
		}
	}
	if m := merchantRe.FindStringSubmatch(textBody); m != nil {
		p.MerchantRaw = strings.TrimSpace(m[1])
	}
	return p, nil
}
