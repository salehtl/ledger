package parse

import "testing"

const enbdAlertSubject = "Emirates NBD Transaction advice for account ending with 3701"

const enbdAlertWithdrawal = `Dear Customer,
AED 250,000.00 has been withdrawn from your account 067XXX17XXX01. The available balance is AED 51,566.07. Save queuing time by using our free ATMs 24 x 7.`

func TestENBDAlertMatches(t *testing.T) {
	p := ENBDAlertParser{}
	if !p.Matches("alert@emiratesnbd.com", "anything") {
		t.Error("should match alert@emiratesnbd.com")
	}
	if !p.Matches("Alert@EmiratesNBD.com", "anything") {
		t.Error("should match case-insensitively")
	}
	if p.Matches("OnlineBanking@emiratesnbd.com", "anything") {
		t.Error("must not steal the transfer-advice sender from ENBDParser")
	}
}

func TestENBDAlertWithdrawal(t *testing.T) {
	got, err := ENBDAlertParser{}.Parse(enbdAlertSubject, enbdAlertWithdrawal)
	if err != nil {
		t.Fatal(err)
	}
	if got.AmountFils != 25_000_000 {
		t.Errorf("AmountFils = %d, want 25000000", got.AmountFils)
	}
	if got.Currency != "AED" {
		t.Errorf("Currency = %q", got.Currency)
	}
	if got.Direction != DirectionDebit {
		t.Errorf("Direction = %q, want debit", got.Direction)
	}
	if got.Last4 != "3701" {
		t.Errorf("Last4 = %q, want 3701 (from subject)", got.Last4)
	}
	if !got.PostedAt.IsZero() {
		t.Errorf("PostedAt = %v, want zero (cascade fills from email date)", got.PostedAt)
	}
	if got.Tier != TierTemplate || got.Confidence != 0.9 {
		t.Errorf("tier/confidence = %s/%v", got.Tier, got.Confidence)
	}
}

// Real Aug-2026 body. ENBD says "deducted ... for issuance of X" for
// bank-initiated debits (transfers, fees) rather than "withdrawn".
const enbdAlertDeduction = `Dear Customer,
AED 1,500.00 has been deducted from your account 067XXX17XXX01 for issuance of Telegraphic Transfer. The available balance is AED 50,066.07.`

func TestENBDAlertDeduction(t *testing.T) {
	got, err := ENBDAlertParser{}.Parse(enbdAlertSubject, enbdAlertDeduction)
	if err != nil {
		t.Fatal(err)
	}
	if got.AmountFils != 150_000 {
		t.Errorf("AmountFils = %d, want 150000", got.AmountFils)
	}
	if got.Direction != DirectionDebit {
		t.Errorf("Direction = %q, want debit", got.Direction)
	}
	if got.Last4 != "3701" {
		t.Errorf("Last4 = %q, want 3701", got.Last4)
	}
}

func TestENBDAlertCredit(t *testing.T) {
	got, err := ENBDAlertParser{}.Parse(enbdAlertSubject,
		"Dear Customer, AED 1,500.00 has been credited to your account 067XXX17XXX01.")
	if err != nil {
		t.Fatal(err)
	}
	if got.Direction != DirectionCredit {
		t.Errorf("Direction = %q, want credit", got.Direction)
	}
	if got.AmountFils != 150_000 {
		t.Errorf("AmountFils = %d, want 150000", got.AmountFils)
	}
}

func TestENBDAlertNoAnchor(t *testing.T) {
	if _, err := (ENBDAlertParser{}).Parse(enbdAlertSubject,
		"Dear Customer, your statement is ready."); err == nil {
		t.Error("non-advice body must error so the cascade can fall through")
	}
}

func TestENBDAlertNoLast4InSubject(t *testing.T) {
	got, err := ENBDAlertParser{}.Parse("Fwd: something odd", enbdAlertWithdrawal)
	if err != nil {
		t.Fatal(err)
	}
	if got.Last4 != "" {
		t.Errorf("Last4 = %q, want empty when subject lacks it", got.Last4)
	}
}
