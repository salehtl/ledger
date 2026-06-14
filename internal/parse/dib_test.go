package parse

import "testing"

const dibCardPurchase = `معاملة بطاقة ائتمان
عزيزي المتعامل,
إشعار مشتريات بتاريخ 19-08-2025 16:18 بالتفاصيل التالية.
رقم البطاقة
525467XXXXXX1502
بطاقة الإئتمان
المبلغ
AED 215.00
الدفع الى
DAPPER DAN GENTS SAL
إجمالي الرصيد المتوفر
86,664.42`

const dibDebit = `إشعار خصم
عزيزي المتعامل,
إشعار خصم من الحساب بتاريخ 19-08-2025 بالتفاصيل التالية.
المبلغ
AED 170.00
من حساب
001-520-XXXX081-01
حساب جاري
المعاملة
OUTWARD UAE FUNDS TRANS IPI
الحالة
تمت بنجاح`

const dibDeposit = `إشعار إيداع
عزيزي المتعامل,
إشعار إيداع فى الحساب بتاريخ 19-08-2025 بالتفاصيل التالية.
المبلغ
AED 10,000.00
من حساب
001-580-XXXX081-01
حساب جاري
المعاملة
OWN ACCOUNT TRNSFER
الحالة
تمت بنجاح`

func TestDIBMatches(t *testing.T) {
	p := DIBParser{}
	if !p.Matches("DIB.notification@dib.ae", "DIB Notification") {
		t.Error("should match DIB sender")
	}
	if p.Matches("alerts@other.com", "x") {
		t.Error("should not match other senders")
	}
}

func TestDIBCardPurchase(t *testing.T) {
	got, err := DIBParser{}.Parse(dibCardPurchase)
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if got.AmountFils != 21500 {
		t.Errorf("amount = %d, want 21500", got.AmountFils)
	}
	if got.Direction != DirectionDebit {
		t.Errorf("direction = %q, want debit", got.Direction)
	}
	if got.MerchantRaw != "DAPPER DAN GENTS SAL" {
		t.Errorf("merchant = %q", got.MerchantRaw)
	}
	if got.Last4 != "1502" {
		t.Errorf("last4 = %q, want 1502", got.Last4)
	}
	if got.PostedAt.Day() != 19 || got.PostedAt.Month() != 8 {
		t.Errorf("date = %s", got.PostedAt)
	}
	if got.Tier != TierTemplate || got.Confidence < 0.9 {
		t.Errorf("tier/conf = %q/%v", got.Tier, got.Confidence)
	}
}

func TestDIBDebit(t *testing.T) {
	got, err := DIBParser{}.Parse(dibDebit)
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if got.AmountFils != 17000 || got.Direction != DirectionDebit {
		t.Errorf("got %d/%s", got.AmountFils, got.Direction)
	}
	if got.MerchantRaw != "OUTWARD UAE FUNDS TRANS IPI" {
		t.Errorf("desc = %q", got.MerchantRaw)
	}
	// Account "001-520-XXXX081-01" → digits "00152008101" → last4 "8101"
	if got.Last4 != "8101" {
		t.Errorf("last4 = %q, want 8101 (trailing acct digits)", got.Last4)
	}
}

func TestDIBDeposit(t *testing.T) {
	got, err := DIBParser{}.Parse(dibDeposit)
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if got.AmountFils != 1000000 {
		t.Errorf("amount = %d, want 1000000", got.AmountFils)
	}
	if got.Direction != DirectionCredit {
		t.Errorf("direction = %q, want credit", got.Direction)
	}
}

func TestDIBUnrecognizedReturnsError(t *testing.T) {
	if _, err := (DIBParser{}).Parse("just some text with no DIB anchors"); err == nil {
		t.Error("expected error when anchors absent")
	}
}
