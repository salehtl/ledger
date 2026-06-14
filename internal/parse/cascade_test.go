package parse

import (
	"context"
	"testing"
	"time"
)

type stubExtractor struct {
	p   ParsedTxn
	err error
}

func (s stubExtractor) Extract(context.Context, string) (ParsedTxn, error) { return s.p, s.err }

func newCascade(ai Extractor) *Cascade {
	return &Cascade{Parsers: []BankParser{DIBParser{}}, Heuristic: HeuristicParser{}, AI: ai}
}

func mustDate(s string) time.Time { d, _ := ParseDIBDate(s); return d }

func TestCascadeTemplateWins(t *testing.T) {
	c := newCascade(DisabledExtractor{})
	res := c.Run(context.Background(), "DIB.notification@dib.ae", "DIB Notification", dibCardPurchase)
	if res.Status != StatusParsed || res.Txn.Tier != TierTemplate {
		t.Fatalf("status=%q tier=%q", res.Status, res.Txn.Tier)
	}
	if res.Txn.MerchantRaw != "DAPPER DAN GENTS SAL" {
		t.Errorf("merchant=%q", res.Txn.MerchantRaw)
	}
}

func TestCascadeFallsToHeuristicWhenNoTemplateMatches(t *testing.T) {
	c := newCascade(DisabledExtractor{})
	body := "Charged AED 49.90 on 03-02-2025 at STARBUCKS"
	res := c.Run(context.Background(), "alerts@unknownbank.com", "spend", body)
	if res.Status != StatusParsed || res.Txn.Tier != TierHeuristic {
		t.Fatalf("status=%q tier=%q", res.Status, res.Txn.Tier)
	}
}

func TestCascadeUsesAIWhenHeuristicFails(t *testing.T) {
	ai := stubExtractor{p: ParsedTxn{AmountFils: 100, Currency: "AED", Direction: DirectionDebit,
		PostedAt: mustDate("01-01-2025"), Tier: TierAI, Confidence: 0.3}}
	c := newCascade(ai)
	res := c.Run(context.Background(), "x@y.com", "s", "no parseable amount or date here")
	if res.Status != StatusLowConfidence || res.Txn.Tier != TierAI {
		t.Fatalf("status=%q tier=%q", res.Status, res.Txn.Tier)
	}
}

func TestCascadeUnparsedWhenEverythingFails(t *testing.T) {
	c := newCascade(DisabledExtractor{})
	res := c.Run(context.Background(), "x@y.com", "s", "totally unparseable content")
	if res.Status != StatusUnparsed {
		t.Fatalf("status=%q, want unparsed", res.Status)
	}
}

func TestCascadeValidationFailureFallsThrough(t *testing.T) {
	ai := stubExtractor{p: ParsedTxn{AmountFils: 0, Currency: "AED", Direction: DirectionDebit, Tier: TierAI}}
	c := newCascade(ai)
	res := c.Run(context.Background(), "x@y.com", "s", "no amount here either")
	if res.Status != StatusUnparsed {
		t.Fatalf("status=%q, want unparsed (invalid AI result rejected)", res.Status)
	}
}
