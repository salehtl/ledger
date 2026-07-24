package parse

import (
	"fmt"
	"regexp"
	"strings"
)

// ENBDAlertParser parses Emirates NBD "Transaction advice" account alerts
// (alert@emiratesnbd.com): "AED 250,000.00 has been withdrawn from your
// account 067XXX17XXX01." They reach the mailbox directly or as unwrapped
// forwards. The body carries no transaction date and no merchant; the account
// last4 lives only in the subject ("account ending with 3701" — the body's
// account number is masked). PostedAt is left zero so the cascade fills it
// from the forwarded Date header / ingest received time.
type ENBDAlertParser struct{}

func (ENBDAlertParser) Bank() string { return "enbd" }

func (ENBDAlertParser) Matches(from, subject string) bool {
	return strings.Contains(strings.ToLower(from), "alert@emiratesnbd.com")
}

var (
	enbdAlertDebitRe  = regexp.MustCompile(`(?i)((?:[A-Z]{3}\s*)?[\d,]+\.\d{2})\s+has been\s+(?:withdrawn|debited)\s+from your account`)
	enbdAlertCreditRe = regexp.MustCompile(`(?i)((?:[A-Z]{3}\s*)?[\d,]+\.\d{2})\s+has been\s+(?:credited|deposited)\s+(?:in)?to your account`)
	enbdAlertLast4Re  = regexp.MustCompile(`(?i)account ending with\s+(\d{4})`)
)

func (ENBDAlertParser) Parse(subject, textBody string) (ParsedTxn, error) {
	direction := DirectionDebit
	m := enbdAlertDebitRe.FindStringSubmatch(textBody)
	if m == nil {
		m = enbdAlertCreditRe.FindStringSubmatch(textBody)
		direction = DirectionCredit
	}
	if m == nil {
		return ParsedTxn{}, fmt.Errorf("enbd alert: no withdrawal/deposit anchor found")
	}
	fils, currency, err := ParseAEDToFils(m[1])
	if err != nil {
		return ParsedTxn{}, fmt.Errorf("enbd alert amount: %w", err)
	}
	p := ParsedTxn{
		AmountFils: fils,
		Currency:   currency,
		Direction:  direction,
		Tier:       TierTemplate,
		// Slightly below body-dated templates: the date is inferred from the
		// email itself, not stated in the body.
		Confidence: 0.9,
	}
	if lm := enbdAlertLast4Re.FindStringSubmatch(subject); lm != nil {
		p.Last4 = lm[1]
	}
	return p, nil
}
