package parse

import "testing"

const dibCardPurchase = `معاملة بطاقة ائتمان
عزيزي المتعامل,
إشعار مشتريات بتاريخ 19-08-2025 16:18 بالتفاصيل التالية.
رقم البطاقة
400000XXXXXX9999
بطاقة الإئتمان
المبلغ
AED 215.00
الدفع الى
ACME TRADING LLC
إجمالي الرصيد المتوفر
10,000.00`

const dibDebit = `إشعار خصم
عزيزي المتعامل,
إشعار خصم من الحساب بتاريخ 19-08-2025 بالتفاصيل التالية.
المبلغ
AED 170.00
من حساب
001-520-XXXX999-01
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
001-580-XXXX999-01
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
	got, err := DIBParser{}.Parse("", dibCardPurchase)
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if got.AmountFils != 21500 {
		t.Errorf("amount = %d, want 21500", got.AmountFils)
	}
	if got.Direction != DirectionDebit {
		t.Errorf("direction = %q, want debit", got.Direction)
	}
	if got.MerchantRaw != "ACME TRADING LLC" {
		t.Errorf("merchant = %q", got.MerchantRaw)
	}
	if got.Last4 != "9999" {
		t.Errorf("last4 = %q, want 9999", got.Last4)
	}
	if got.PostedAt.Day() != 19 || got.PostedAt.Month() != 8 {
		t.Errorf("date = %s", got.PostedAt)
	}
	if got.Tier != TierTemplate || got.Confidence < 0.9 {
		t.Errorf("tier/conf = %q/%v", got.Tier, got.Confidence)
	}
}

func TestDIBDebit(t *testing.T) {
	got, err := DIBParser{}.Parse("", dibDebit)
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if got.AmountFils != 17000 || got.Direction != DirectionDebit {
		t.Errorf("got %d/%s", got.AmountFils, got.Direction)
	}
	if got.MerchantRaw != "OUTWARD UAE FUNDS TRANS IPI" {
		t.Errorf("desc = %q", got.MerchantRaw)
	}
	// Account "001-520-XXXX999-01" → digits "00152099901" → last4 "9901"
	if got.Last4 != "9901" {
		t.Errorf("last4 = %q, want 9901 (trailing acct digits)", got.Last4)
	}
}

func TestDIBDeposit(t *testing.T) {
	got, err := DIBParser{}.Parse("", dibDeposit)
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
	if _, err := (DIBParser{}).Parse("", "just some text with no DIB anchors"); err == nil {
		t.Error("expected error when anchors absent")
	}
}

const dibTransferOut = `إشعار تحويل
عزيزي المتعامل,
إشعار تحويل من الحساب بتاريخ 20-08-2025 بالتفاصيل التالية.
المبلغ
AED 300.00
من حساب
001-520-XXXX999-01
حساب جاري
المعاملة
MB FUND TRANSFER DEBIT
الحالة
تمت بنجاح`

const dibTransferIn = `إشعار تحويل
عزيزي المتعامل,
إشعار تحويل فى الحساب بتاريخ 20-08-2025 بالتفاصيل التالية.
المبلغ
AED 900.00
من حساب
001-580-XXXX999-01
حساب جاري
المعاملة
IB FUNDS TRANSFER CREDIT
الحالة
تمت بنجاح`

func TestDIBTransferOutgoingIsDebit(t *testing.T) {
	got, err := DIBParser{}.Parse("", dibTransferOut)
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if got.Direction != DirectionDebit {
		t.Errorf("direction = %q, want debit (outgoing transfer / desc suffix DEBIT)", got.Direction)
	}
	if !got.IsTransfer {
		t.Error("expected IsTransfer = true")
	}
}

func TestDIBTransferIncomingIsCredit(t *testing.T) {
	got, err := DIBParser{}.Parse("", dibTransferIn)
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if got.Direction != DirectionCredit {
		t.Errorf("direction = %q, want credit (incoming transfer / desc suffix CREDIT)", got.Direction)
	}
}
