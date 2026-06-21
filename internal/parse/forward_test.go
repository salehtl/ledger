package parse

import (
	"strings"
	"testing"
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
	from, subject, body := Unwrap("Saleh Lootah <salehtl@icloud.com>", "Fwd: DIB Notification", fwdAppleBody)
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
	from, subject, body := Unwrap("salehtl@icloud.com", "Fwd: DIB Notification", fwdGmailBody)
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
	from, subject, body := Unwrap("DIB.notification@dib.ae", "DIB Notification", direct)
	if from != "DIB.notification@dib.ae" || subject != "DIB Notification" || body != direct {
		t.Errorf("non-forward should pass through unchanged; got %q / %q / %q", from, subject, body)
	}
}

func TestUnwrapFwdSubjectFallbackWhenNoMarker(t *testing.T) {
	// A Fwd subject but no recoverable header block: keep body, strip the Fwd: prefix.
	const body = "المبلغ\nAED 124.00"
	_, subject, gotBody := Unwrap("salehtl@icloud.com", "Fwd: DIB Notification", body)
	if subject != "DIB Notification" {
		t.Errorf("subject = %q, want Fwd prefix stripped", subject)
	}
	if gotBody != body {
		t.Errorf("body changed unexpectedly: %q", gotBody)
	}
}

func TestUnwrapPlainSubjectUntouched(t *testing.T) {
	const body = "المبلغ\nAED 124.00"
	from, subject, gotBody := Unwrap("DIB.notification@dib.ae", "DIB Notification", body)
	if from != "DIB.notification@dib.ae" || subject != "DIB Notification" || gotBody != body {
		t.Errorf("plain non-forward should pass through unchanged; got %q / %q / %q", from, subject, gotBody)
	}
}
