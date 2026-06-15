package parse

import "testing"

// Sanitised from a real Emirates NBD "Local Bank Transfer" notification, as it
// looks AFTER BodyText decodes MIME/quoted-printable and strips HTML to text.
const enbdLocalTransfer = `CIF: ***17***
Dear Saleh Tariq Helal Lootah,
Here is a consolidated status of your Local Bank Transfer.
Transaction Date:
05/Jun/2026 04:25 PM
From Account:
067***17***01
Debit Amount:
AED 4,100.00
Transaction Amount:
AED 4,100.00
Exchange Rate:
N/A
Beneficiary Name:
Siddiq sabir sabir hussain
Beneficiary Account / IBAN:
AE25033000001XXX02XXX88
Status:
Success`

func TestENBDMatches(t *testing.T) {
	p := ENBDParser{}
	if !p.Matches("OnlineBanking@emiratesnbd.com", "Local Bank Transfer") {
		t.Fatal("should match the ENBD online-banking sender")
	}
	if p.Matches("DIB.notification@dib.ae", "x") {
		t.Fatal("should not match a different sender")
	}
}

func TestENBDParseLocalTransfer(t *testing.T) {
	got, err := ENBDParser{}.Parse(enbdLocalTransfer)
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if got.AmountFils != 410000 {
		t.Errorf("AmountFils = %d, want 410000", got.AmountFils)
	}
	if got.Currency != "AED" {
		t.Errorf("Currency = %q, want AED", got.Currency)
	}
	if got.Direction != DirectionDebit {
		t.Errorf("Direction = %q, want debit", got.Direction)
	}
	if got.MerchantRaw != "Siddiq sabir sabir hussain" {
		t.Errorf("MerchantRaw = %q", got.MerchantRaw)
	}
	if got.Tier != TierTemplate {
		t.Errorf("Tier = %q, want template", got.Tier)
	}
	y, m, d := got.PostedAt.Date()
	if y != 2026 || m != 6 || d != 5 {
		t.Errorf("PostedAt = %v, want 2026-06-05", got.PostedAt)
	}
	if got.PostedAt.Hour() != 16 || got.PostedAt.Minute() != 25 {
		t.Errorf("PostedAt time = %02d:%02d, want 16:25", got.PostedAt.Hour(), got.PostedAt.Minute())
	}
	// A validated, parseable result (the whole point — the heuristic dropped these on the date).
	if err := Validate(got); err != nil {
		t.Errorf("Validate: %v", err)
	}
}

func TestParseENBDDate(t *testing.T) {
	d, err := ParseENBDDate("05/Jun/2026 04:25 PM")
	if err != nil {
		t.Fatalf("ParseENBDDate: %v", err)
	}
	if d.Year() != 2026 || d.Month() != 6 || d.Day() != 5 || d.Hour() != 16 {
		t.Errorf("got %v", d)
	}
	// date-only fallback
	if _, err := ParseENBDDate("05/Jun/2026"); err != nil {
		t.Errorf("date-only fallback failed: %v", err)
	}
}
