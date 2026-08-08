package parse

import (
	"context"
	"strings"
	"testing"
	"time"
)

// stubNoDateParser mimics a template for a format that carries no body date
// (e.g. ENBD transaction advice): it returns a zero PostedAt and relies on the
// cascade's fallbackDate.
type stubNoDateParser struct{}

func (stubNoDateParser) Bank() string { return "stub" }
func (stubNoDateParser) Matches(from, subject string) bool {
	return from == "stub@bank.com"
}
func (stubNoDateParser) Parse(subject, textBody string) (ParsedTxn, error) {
	return ParsedTxn{AmountFils: 1000, Currency: "AED", Direction: DirectionDebit,
		Tier: TierTemplate, Confidence: 0.9}, nil
}

func TestCascadeTemplateFallbackDate(t *testing.T) {
	c := &Cascade{Parsers: []BankParser{stubNoDateParser{}}}
	fb := time.Date(2026, 7, 24, 16, 11, 0, 0, time.UTC)
	res := c.Run(context.Background(), "stub@bank.com", "s", "whatever", fb)
	if res.Status != StatusParsed || res.Tier != TierTemplate {
		t.Fatalf("status/tier = %s/%s, want parsed/template (err %s)", res.Status, res.Tier, res.Err)
	}
	if !res.Txn.PostedAt.Equal(fb) {
		t.Errorf("PostedAt = %v, want fallback %v", res.Txn.PostedAt, fb)
	}
}

func TestCascadeZeroFallbackStillUnparsed(t *testing.T) {
	c := &Cascade{Parsers: []BankParser{stubNoDateParser{}}}
	res := c.Run(context.Background(), "stub@bank.com", "s", "whatever", time.Time{})
	if res.Status != StatusUnparsed {
		t.Fatalf("status = %s, want unparsed when no date exists anywhere", res.Status)
	}
}

func TestCascadeFallbackNeverOverridesBodyDate(t *testing.T) {
	// A template that DID extract a body date must keep it even when a
	// fallback is offered.
	c := &Cascade{Parsers: []BankParser{DIBParser{}}}
	fb := time.Date(2020, 1, 1, 0, 0, 0, 0, time.UTC)
	res := c.Run(context.Background(), "DIB.notification@dib.ae", "DIB Notification", dibCardPurchase, fb)
	if res.Status != StatusParsed {
		t.Fatalf("status = %s (err %s)", res.Status, res.Err)
	}
	if res.Txn.PostedAt.Equal(fb) {
		t.Error("fallback overwrote a template-extracted body date")
	}
}

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
	res := c.Run(context.Background(), "DIB.notification@dib.ae", "DIB Notification", dibCardPurchase, time.Time{})
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
	res := c.Run(context.Background(), "alerts@unknownbank.com", "spend", body, time.Time{})
	if res.Status != StatusParsed || res.Txn.Tier != TierHeuristic {
		t.Fatalf("status=%q tier=%q", res.Status, res.Txn.Tier)
	}
}

func TestCascadeUsesAIWhenHeuristicFails(t *testing.T) {
	ai := stubExtractor{p: ParsedTxn{AmountFils: 100, Currency: "AED", Direction: DirectionDebit,
		PostedAt: mustDate("01-01-2025"), Tier: TierAI, Confidence: 0.3}}
	c := newCascade(ai)
	res := c.Run(context.Background(), "x@y.com", "s", "no parseable amount or date here", time.Time{})
	if res.Status != StatusLowConfidence || res.Txn.Tier != TierAI {
		t.Fatalf("status=%q tier=%q", res.Status, res.Txn.Tier)
	}
}

func TestCascadeUnparsedWhenEverythingFails(t *testing.T) {
	c := newCascade(DisabledExtractor{})
	res := c.Run(context.Background(), "x@y.com", "s", "totally unparseable content", time.Time{})
	if res.Status != StatusUnparsed {
		t.Fatalf("status=%q, want unparsed", res.Status)
	}
}

// An unparsed result must say WHY the tiers failed so ingest_log.parse_error is
// debuggable — but not report the disabled AI tier, which is a benign skip.
func TestCascadeUnparsedCapturesTierErrors(t *testing.T) {
	c := newCascade(DisabledExtractor{})
	res := c.Run(context.Background(), "DIB.notification@dib.ae", "s", "totally unparseable content", time.Time{})
	if res.Status != StatusUnparsed {
		t.Fatalf("status=%q, want unparsed", res.Status)
	}
	if res.Err == "" {
		t.Fatal("Err empty; want tier failure details")
	}
	if !strings.Contains(res.Err, "template") || !strings.Contains(res.Err, "heuristic") {
		t.Errorf("Err = %q, want template and heuristic failures noted", res.Err)
	}
	if strings.Contains(res.Err, "unavailable") {
		t.Errorf("Err = %q, must not report the disabled AI tier as a failure", res.Err)
	}
}

func TestCascadeUnparsedCapturesValidationError(t *testing.T) {
	ai := stubExtractor{p: ParsedTxn{AmountFils: 0, Currency: "AED", Direction: DirectionDebit, Tier: TierAI}}
	c := newCascade(ai)
	res := c.Run(context.Background(), "x@y.com", "s", "no amount here either", time.Time{})
	if !strings.Contains(res.Err, "amount") {
		t.Errorf("Err = %q, want the AI validation failure (amount) captured", res.Err)
	}
}

// TestCascadeIgnoresEnglishMoneyTransfer is a guard: DIB's English "Money
// Transfer" confirmation duplicates a transaction already recorded from its
// sibling Arabic email. The template must reject it via ErrIgnoreEmail, and
// the cascade must stop right there — NOT fall through to the heuristic,
// which (pre-fix) misparses this body into a bogus credit dated 2026-08-02.
// This is the terminal-ness guard: Tier must not be heuristic, and Status
// must be exactly "ignored".
func TestCascadeIgnoresEnglishMoneyTransfer(t *testing.T) {
	c := newCascade(DisabledExtractor{})
	res := c.Run(context.Background(), "DIB.notification@dib.ae", "DIB Notification", dibEnglishMoneyTransfer, time.Time{})
	if res.Tier == TierHeuristic {
		t.Fatalf("heuristic got a chance at this body (tier=%q); the ignore must be terminal", res.Tier)
	}
	if res.Status != StatusIgnored {
		t.Fatalf("status = %q, want %q (err=%q tier=%q)", res.Status, StatusIgnored, res.Err, res.Tier)
	}
}

func TestCascadeValidationFailureFallsThrough(t *testing.T) {
	ai := stubExtractor{p: ParsedTxn{AmountFils: 0, Currency: "AED", Direction: DirectionDebit, Tier: TierAI}}
	c := newCascade(ai)
	res := c.Run(context.Background(), "x@y.com", "s", "no amount here either", time.Time{})
	if res.Status != StatusUnparsed {
		t.Fatalf("status=%q, want unparsed (invalid AI result rejected)", res.Status)
	}
}
