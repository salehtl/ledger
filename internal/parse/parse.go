// Package parse turns raw bank-notification emails into validated transactions
// via a resilient cascade: per-bank template → generic heuristic → AI → review.
// It does NOT categorize (M4) or dedup/reconcile (M5); it extracts and validates.
package parse

import (
	"fmt"
	"regexp"
	"time"
)

// Tier and direction constants.
const (
	TierTemplate  = "template"
	TierHeuristic = "heuristic"
	TierAI        = "ai"

	DirectionDebit  = "debit"
	DirectionCredit = "credit"
)

// currencyRe enforces a 3-letter uppercase ISO 4217-shaped code. Template and
// heuristic tiers already guarantee this via their own extraction regexes;
// this check exists to catch a wayward AI-tier result before it becomes a
// transaction whose currency can never match a user-entered rate.
var currencyRe = regexp.MustCompile(`^[A-Z]{3}$`)

// ParsedTxn is the extracted, not-yet-categorized transaction. AmountFils is
// always a positive integer minor unit (AED × 100); Direction carries sign.
type ParsedTxn struct {
	PostedAt    time.Time
	AmountFils  int64
	Currency    string
	Direction   string // "debit" | "credit"
	MerchantRaw string
	Last4       string
	IsTransfer  bool
	Confidence  float64
	Tier        string // "template" | "heuristic" | "ai"
}

// BankParser is a per-bank template tier. Matches is a cheap sender/subject
// check; Parse runs on the HTML-stripped plain-text body.
type BankParser interface {
	Bank() string
	Matches(from, subject string) bool
	Parse(textBody string) (ParsedTxn, error)
}

// Validate gates a result regardless of tier. A failure routes the email to
// review rather than trusting a wrong number. Account resolution is NOT required
// here (accounts may be unseeded in early milestones).
func Validate(p ParsedTxn) error {
	if p.AmountFils <= 0 {
		return fmt.Errorf("amount must be positive, got %d", p.AmountFils)
	}
	if p.Currency == "" {
		return fmt.Errorf("currency must not be empty")
	}
	if !currencyRe.MatchString(p.Currency) {
		return fmt.Errorf("currency must be a 3-letter uppercase code, got %q", p.Currency)
	}
	if p.Direction != DirectionDebit && p.Direction != DirectionCredit {
		return fmt.Errorf("direction must be debit|credit, got %q", p.Direction)
	}
	if p.PostedAt.IsZero() {
		return fmt.Errorf("posted_at must be set")
	}
	if p.PostedAt.After(time.Now().AddDate(0, 0, 2)) {
		return fmt.Errorf("posted_at is implausibly in the future: %s", p.PostedAt)
	}
	return nil
}
