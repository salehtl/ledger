package parse

import (
	"testing"
	"time"
)

func valid() ParsedTxn {
	return ParsedTxn{
		PostedAt:    time.Date(2025, 8, 19, 0, 0, 0, 0, time.UTC),
		AmountFils:  21500,
		Currency:    "AED",
		Direction:   DirectionDebit,
		MerchantRaw: "DAPPER DAN GENTS SAL",
		Tier:        TierTemplate,
		Confidence:  0.99,
	}
}

func TestValidateAcceptsGoodTxn(t *testing.T) {
	if err := Validate(valid()); err != nil {
		t.Fatalf("expected valid, got %v", err)
	}
}

func TestValidateRejectsNonPositiveAmount(t *testing.T) {
	p := valid()
	p.AmountFils = 0
	if Validate(p) == nil {
		t.Error("expected error for zero amount")
	}
}

func TestValidateRejectsBadDirection(t *testing.T) {
	p := valid()
	p.Direction = "sideways"
	if Validate(p) == nil {
		t.Error("expected error for bad direction")
	}
}

func TestValidateRejectsMissingCurrency(t *testing.T) {
	p := valid()
	p.Currency = ""
	if Validate(p) == nil {
		t.Error("expected error for empty currency")
	}
}

func TestValidateRejectsZeroOrFutureDate(t *testing.T) {
	p := valid()
	p.PostedAt = time.Time{}
	if Validate(p) == nil {
		t.Error("expected error for zero date")
	}
	p2 := valid()
	p2.PostedAt = time.Now().AddDate(0, 0, 3)
	if Validate(p2) == nil {
		t.Error("expected error for future date")
	}
}
