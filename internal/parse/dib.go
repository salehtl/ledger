package parse

import (
	"fmt"
	"regexp"
	"strings"
)

// DIBParser parses Dubai Islamic Bank notification emails (Arabic HTML). It
// handles two layouts: card purchases (إشعار مشتريات) and account transactions
// (خصم/إيداع/تحويل/سحب). See the plan's "DIB email anatomy" section.
type DIBParser struct{}

func (DIBParser) Bank() string { return "dib" }

func (DIBParser) Matches(from, subject string) bool {
	return strings.Contains(strings.ToLower(from), "dib.notification@dib.ae")
}

var (
	dibAmountRe = regexp.MustCompile(`المبلغ\s*\n\s*((?:[A-Z]{3}\s*)?[0-9][0-9,]*\.[0-9]{2})`)
	dibDateRe   = regexp.MustCompile(`بتاريخ\s*([0-9]{2}-[0-9]{2}-[0-9]{4})`)
	dibPayeeRe  = regexp.MustCompile(`الدفع الى\s*\n\s*(.+)`)
	dibTxnRe    = regexp.MustCompile(`المعاملة\s*\n\s*(.+)`)
	dibCardRe   = regexp.MustCompile(`رقم البطاقة\s*\n\s*(\S+)`)
	dibAcctRe   = regexp.MustCompile(`من حساب\s*\n\s*(\S+)`)
	digitsRe    = regexp.MustCompile(`[0-9]`)
)

// isEnglishMoneyTransfer reports whether textBody is DIB's English "Money
// Transfer" confirmation layout — a second, duplicate notification for a fund
// transfer already recorded from its sibling Arabic account-transaction
// email (see the DIBParser doc comment). It requires two signals unique to
// this English layout, neither of which can appear in the Arabic layouts
// this parser otherwise handles.
func isEnglishMoneyTransfer(textBody string) bool {
	return strings.Contains(textBody, "Money Transfer") &&
		strings.Contains(textBody, "Beneficiary Bank")
}

func (DIBParser) Parse(subject, textBody string) (ParsedTxn, error) {
	if isEnglishMoneyTransfer(textBody) {
		return ParsedTxn{}, ErrIgnoreEmail
	}
	am := dibAmountRe.FindStringSubmatch(textBody)
	if am == nil {
		return ParsedTxn{}, fmt.Errorf("dib: amount anchor المبلغ not found")
	}
	fils, currency, err := ParseAEDToFils(am[1])
	if err != nil {
		return ParsedTxn{}, fmt.Errorf("dib amount: %w", err)
	}
	p := ParsedTxn{
		AmountFils: fils,
		Currency:   currency,
		Tier:       TierTemplate,
		Confidence: 0.97,
	}
	dm := dibDateRe.FindStringSubmatch(textBody)
	if dm == nil {
		return ParsedTxn{}, fmt.Errorf("dib: بتاريخ date anchor not found")
	}
	d, derr := ParseDIBDate(dm[1])
	if derr != nil {
		return ParsedTxn{}, fmt.Errorf("dib date: %w", derr)
	}
	p.PostedAt = d

	isCard := strings.Contains(textBody, "إشعار مشتريات")
	if isCard {
		p.Direction = DirectionDebit
		if mm := dibPayeeRe.FindStringSubmatch(textBody); mm != nil {
			p.MerchantRaw = strings.TrimSpace(mm[1])
		}
		if cm := dibCardRe.FindStringSubmatch(textBody); cm != nil {
			p.Last4 = lastFourDigits(cm[1])
		}
		return p, nil
	}

	// account-transaction layout
	switch {
	case strings.Contains(textBody, "إشعار إيداع"):
		p.Direction = DirectionCredit
	case strings.Contains(textBody, "إشعار خصم"), strings.Contains(textBody, "إشعار سحب"):
		p.Direction = DirectionDebit
	default: // تحويل / unknown: infer from preposition / description
		if strings.Contains(textBody, "من الحساب") {
			p.Direction = DirectionDebit
		} else {
			p.Direction = DirectionCredit
		}
	}
	if tm := dibTxnRe.FindStringSubmatch(textBody); tm != nil {
		desc := strings.TrimSpace(tm[1])
		p.MerchantRaw = desc
		up := strings.ToUpper(desc)
		if strings.HasSuffix(up, "DEBIT") {
			p.Direction = DirectionDebit
		} else if strings.HasSuffix(up, "CREDIT") {
			p.Direction = DirectionCredit
		}
		if strings.Contains(up, "TRNSFER") || strings.Contains(up, "TRANSFER") {
			p.IsTransfer = true
		}
	}
	if acc := dibAcctRe.FindStringSubmatch(textBody); acc != nil {
		p.Last4 = lastFourDigits(acc[1])
	}
	if p.Direction == "" {
		return ParsedTxn{}, fmt.Errorf("dib: could not determine direction")
	}
	return p, nil
}

// lastFourDigits returns the last four numeric digits in s (ignoring separators
// and masking characters).
func lastFourDigits(s string) string {
	d := strings.Join(digitsRe.FindAllString(s, -1), "")
	if len(d) <= 4 {
		return d
	}
	return d[len(d)-4:]
}
