package parse

import (
	"strings"
	"testing"
	"time"
)

// Apple Mail inline forward, as BodyText emits it (label and value on
// separate lines because every HTML tag becomes a newline).
const fwdAppleBody = `Sent from my iPhone
Begin forwarded message:
From:
DIB Notification <DIB.notification@dib.ae>
Date:
18 June 2026 at 7:33:38 PM GST
To:
salehtl@icloud.com
Subject:
DIB Notification
Reply-To:
DIB Notification <DIB.notification@dib.ae>

معاملة بطاقة ائتمان
إشعار مشتريات بتاريخ 18-06-2026 18:03
المبلغ
AED 124.00
الدفع الى
NOIRO CAFE`

// Gmail-style forward: "Label: value" on a single line.
const fwdGmailBody = `---------- Forwarded message ---------
From: DIB Notification <DIB.notification@dib.ae>
Date: Thu, 18 Jun 2026 at 19:33
Subject: DIB Notification
To: <salehtl@icloud.com>

المبلغ
AED 124.00
الدفع الى
NOIRO CAFE`

func TestUnwrapAppleMail(t *testing.T) {
	from, subject, _, body := Unwrap("Saleh Lootah <salehtl@icloud.com>", "Fwd: DIB Notification", fwdAppleBody)
	if from != "DIB Notification <DIB.notification@dib.ae>" {
		t.Errorf("from = %q, want recovered DIB sender", from)
	}
	if subject != "DIB Notification" {
		t.Errorf("subject = %q, want %q", subject, "DIB Notification")
	}
	if !strings.HasPrefix(body, "معاملة") {
		// body must begin at the original bank content, not the preamble.
		t.Errorf("body should start at bank content, got prefix %.30q", body)
	}
	if strings.Contains(body, "salehtl@icloud.com") || strings.Contains(body, "Begin forwarded") || strings.Contains(body, "Sent from my iPhone") {
		t.Errorf("body still contains forwarding preamble:\n%s", body)
	}
}

func TestUnwrapGmail(t *testing.T) {
	from, subject, _, body := Unwrap("salehtl@icloud.com", "Fwd: DIB Notification", fwdGmailBody)
	if from != "DIB Notification <DIB.notification@dib.ae>" {
		t.Errorf("from = %q, want recovered DIB sender", from)
	}
	if subject != "DIB Notification" {
		t.Errorf("subject = %q, want recovered subject", subject)
	}
	if strings.Contains(body, "Forwarded message") || strings.Contains(body, "salehtl@icloud.com") {
		t.Errorf("body still contains preamble:\n%s", body)
	}
	if !strings.Contains(body, "NOIRO CAFE") {
		t.Errorf("body lost bank content:\n%s", body)
	}
}

func TestUnwrapNonForwardPassthrough(t *testing.T) {
	const direct = "المبلغ\nAED 124.00\nالدفع الى\nNOIRO CAFE"
	from, subject, _, body := Unwrap("DIB.notification@dib.ae", "DIB Notification", direct)
	if from != "DIB.notification@dib.ae" || subject != "DIB Notification" || body != direct {
		t.Errorf("non-forward should pass through unchanged; got %q / %q / %q", from, subject, body)
	}
}

func TestUnwrapFwdSubjectFallbackWhenNoMarker(t *testing.T) {
	// A Fwd subject but no recoverable header block: keep body, strip the Fwd: prefix.
	const body = "المبلغ\nAED 124.00"
	_, subject, _, gotBody := Unwrap("salehtl@icloud.com", "Fwd: DIB Notification", body)
	if subject != "DIB Notification" {
		t.Errorf("subject = %q, want Fwd prefix stripped", subject)
	}
	if gotBody != body {
		t.Errorf("body changed unexpectedly: %q", gotBody)
	}
}

func TestUnwrapPlainSubjectUntouched(t *testing.T) {
	const body = "المبلغ\nAED 124.00"
	from, subject, _, gotBody := Unwrap("DIB.notification@dib.ae", "DIB Notification", body)
	if from != "DIB.notification@dib.ae" || subject != "DIB Notification" || gotBody != body {
		t.Errorf("plain non-forward should pass through unchanged; got %q / %q / %q", from, subject, gotBody)
	}
}

const fwdWebmailBody = `Begin forwarded message:
From:
alert@emiratesnbd.com
Subject:
Emirates NBD Transaction advice for account ending with 3701
Date:
Jul 24, 2026 at 4:11 PM
To:
SALEHTL@icloud.com
Dear Customer,
AED 250,000.00 has been withdrawn from your account 067XXX17XXX01. The available balance is AED 51,566.07.`

func TestUnwrapRecoversForwardedDate(t *testing.T) {
	from, subject, fwdDate, body := Unwrap("salehtl@icloud.com", "Fwd: Emirates NBD Transaction advice for account ending with 3701", fwdWebmailBody)
	if from != "alert@emiratesnbd.com" {
		t.Errorf("from = %q", from)
	}
	if subject != "Emirates NBD Transaction advice for account ending with 3701" {
		t.Errorf("subject = %q", subject)
	}
	if fwdDate != "Jul 24, 2026 at 4:11 PM" {
		t.Errorf("fwdDate = %q", fwdDate)
	}
	if !strings.HasPrefix(body, "Dear Customer,") {
		t.Errorf("body should start after the header block, got %q", body)
	}
}

func TestUnwrapNonForwardHasNoDate(t *testing.T) {
	_, _, fwdDate, _ := Unwrap("DIB.notification@dib.ae", "DIB Notification", "Dear Customer, AED 10.00 spent")
	if fwdDate != "" {
		t.Errorf("fwdDate = %q, want empty for non-forward", fwdDate)
	}
}

func TestParseForwardDate(t *testing.T) {
	cases := []struct {
		in   string
		want time.Time
	}{
		{"Jul 24, 2026 at 4:11 PM", time.Date(2026, 7, 24, 16, 11, 0, 0, time.UTC)},
		{"Fri, Jul 24, 2026 at 4:11 PM", time.Date(2026, 7, 24, 16, 11, 0, 0, time.UTC)},
		{"24 July 2026 at 17:51:40 GMT+4", time.Date(2026, 7, 24, 17, 51, 40, 0, time.UTC)},
		{"Jul 24, 2026 at 4:11 PM", time.Date(2026, 7, 24, 16, 11, 0, 0, time.UTC)},
		{"Jul 24, 2026 at 4:11 PM", time.Date(2026, 7, 24, 16, 11, 0, 0, time.UTC)},
	}
	for _, c := range cases {
		got, err := ParseForwardDate(c.in)
		if err != nil {
			t.Errorf("ParseForwardDate(%q) error: %v", c.in, err)
			continue
		}
		if !got.Equal(c.want) {
			t.Errorf("ParseForwardDate(%q) = %v, want %v", c.in, got, c.want)
		}
	}
	if _, err := ParseForwardDate(""); err == nil {
		t.Error("empty string should error")
	}
	if _, err := ParseForwardDate("not a date"); err == nil {
		t.Error("garbage should error")
	}
}
