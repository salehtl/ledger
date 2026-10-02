package parse

import (
	"context"
	"errors"
	"testing"
	"time"
)

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

// dibDebitNoDate is dibDebit with the بتاريخ (date) anchor dropped from the
// intro sentence — amount/merchant anchors still match, but the date anchor
// is missing.
const dibDebitNoDate = `إشعار خصم
عزيزي المتعامل,
إشعار خصم من الحساب بالتفاصيل التالية.
المبلغ
AED 170.00
من حساب
001-520-XXXX999-01
حساب جاري
المعاملة
OUTWARD UAE FUNDS TRANS IPI
الحالة
تمت بنجاح`

func TestDIBMissingDateAnchorReturnsError(t *testing.T) {
	// DIB must fail hard when its date anchor is absent, rather than leaving
	// PostedAt zero — a zero PostedAt is the template-tier fallback opt-in
	// signal (currently reserved for ENBDAlertParser), and DIB must not
	// silently inherit it.
	if _, err := (DIBParser{}).Parse("", dibDebitNoDate); err == nil {
		t.Error("expected error when date anchor is missing")
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

// dibEnglishMoneyTransfer is DIB's English "Money Transfer" confirmation — a
// duplicate notification for a fund transfer already recorded from its
// sibling Arabic account-transaction email. Layout from a real message; every
// identifier below is synthetic.
const dibEnglishMoneyTransfer = `Money Transfer
Dear Customer,
This is to notify you that a Domestic Fund Transfer transaction has been initiated on 02-08-2026 12:58:19 with the following details.
Amount
9,780.00
From
AE9801234XXXXXX9
[From Account FRM]
To
AE0400012345678XXXXX999
Beneficiary Bank
National Bank of Abu Dhabi
Status
Credited to beneficiary
Reference Number
[Reference Number]
If you have not initiated this request, kindly change your password and inform the Bank by calling +97146092222.
This is the new design of automated notification emails that you receive from Dubai Islamic Bank (DIB).`

func TestDIBEnglishMoneyTransferReturnsIgnoreError(t *testing.T) {
	_, err := DIBParser{}.Parse("DIB Notification", dibEnglishMoneyTransfer)
	if !errors.Is(err, ErrIgnoreEmail) {
		t.Fatalf("err = %v, want ErrIgnoreEmail", err)
	}
}

// DIB's card reversal and card refund notices carry an amount and a card but
// no date. Both layouts copied from real mail; every value is invented.
const dibCardReversal = `عزيزي المتعامل,
A transaction to the value of AED 1,212.50 made at ACME CAFE on your DIB card ending with XX9999 has been reversed.
في حالة عدم قيامك بهذه المعاملة, يرجي تغيير رقمك السري وإعلامنا عن طريق الاتصال برقم 0097146092222.
هذا البريد الإلكتروني بالشكل الجديد خاص بالمعاملات المرسلة من بنك دبي الإسلامي.`

const dibCardRefund = `عزيزي المتعامل,
تم إرجاع مبلغ 34.56 درهم على بطاقة بنك دبي الإسلامي الخاصة بك والمنتهية بالرقم XX9999.
في حالة عدم قيامك بهذه المعاملة, يرجي تغيير رقمك السري وإعلامنا عن طريق الاتصال برقم 0097146092222.
هذا البريد الإلكتروني بالشكل الجديد خاص بالمعاملات المرسلة من بنك دبي الإسلامي.`

func TestDIBCardReversalIsCredit(t *testing.T) {
	got, err := DIBParser{}.Parse("DIB Notification", dibCardReversal)
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if got.Direction != DirectionCredit || got.AmountFils != 121250 || got.Currency != "AED" {
		t.Errorf("direction/amount/currency = %s/%d/%s, want credit/121250/AED", got.Direction, got.AmountFils, got.Currency)
	}
	if got.MerchantRaw != "ACME CAFE" || got.Last4 != "9999" {
		t.Errorf("merchant/last4 = %q/%q, want ACME CAFE/9999", got.MerchantRaw, got.Last4)
	}
	if !got.PostedAt.IsZero() || got.IsTransfer || got.Tier != TierTemplate {
		t.Errorf("got %+v, want zero PostedAt (the cascade fills the email date), not a transfer, template tier", got)
	}
}

func TestDIBCardRefundIsCredit(t *testing.T) {
	got, err := DIBParser{}.Parse("DIB Notification", dibCardRefund)
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if got.Direction != DirectionCredit || got.AmountFils != 3456 || got.Currency != "AED" {
		t.Errorf("direction/amount/currency = %s/%d/%s, want credit/3456/AED", got.Direction, got.AmountFils, got.Currency)
	}
	if got.MerchantRaw != "DIB card refund" || got.Last4 != "9999" {
		t.Errorf("merchant/last4 = %q/%q, want \"DIB card refund\"/9999", got.MerchantRaw, got.Last4)
	}
}

// Neither layout has a date, so the transaction must take the email's own
// date through the cascade, and come out as a parsed credit.
func TestCascadeDatesDIBRefundFromEmail(t *testing.T) {
	c := &Cascade{Parsers: []BankParser{DIBParser{}}, Heuristic: HeuristicParser{}}
	fb := time.Date(2026, 9, 22, 9, 11, 0, 0, time.UTC)
	for name, body := range map[string]string{"reversal": dibCardReversal, "refund": dibCardRefund} {
		res := c.Run(context.Background(), "DIB.notification@dib.ae", "DIB Notification", body, fb)
		if res.Status != StatusParsed || res.Tier != TierTemplate || res.Txn.Direction != DirectionCredit {
			t.Errorf("%s: status/tier/direction = %s/%s/%s (err %s), want parsed/template/credit",
				name, res.Status, res.Tier, res.Txn.Direction, res.Err)
		}
		if !res.Txn.PostedAt.Equal(fb) {
			t.Errorf("%s: PostedAt = %v, want the email date %v", name, res.Txn.PostedAt, fb)
		}
	}
}
