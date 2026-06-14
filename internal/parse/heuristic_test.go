package parse

import "testing"

func TestHeuristicExtractsAmountAndDate(t *testing.T) {
	body := "Your card was charged AED 49.90 on 03-02-2025 at STARBUCKS DUBAI."
	p, err := HeuristicParser{}.Parse(body)
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if p.AmountFils != 4990 {
		t.Errorf("amount = %d, want 4990", p.AmountFils)
	}
	if p.Currency != "AED" {
		t.Errorf("currency = %q", p.Currency)
	}
	if p.Tier != TierHeuristic {
		t.Errorf("tier = %q, want heuristic", p.Tier)
	}
	if p.Confidence >= 0.8 {
		t.Errorf("heuristic confidence should be low, got %v", p.Confidence)
	}
	if p.MerchantRaw == "" {
		t.Error("expected some merchant text")
	}
}

func TestHeuristicErrorsWithoutAmount(t *testing.T) {
	if _, err := (HeuristicParser{}).Parse("no money, no date, nothing useful"); err == nil {
		t.Error("expected error when no amount found")
	}
}

func TestHeuristicCreditKeyword(t *testing.T) {
	p, err := HeuristicParser{}.Parse("AED 500.00 credited to your account on 01-01-2025")
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if p.Direction != DirectionCredit {
		t.Errorf("direction = %q, want credit", p.Direction)
	}
}
