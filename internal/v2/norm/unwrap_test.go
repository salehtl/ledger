package norm

import (
	"strings"
	"testing"
	"time"
)

// appleBody is Apple Mail's layout: every header label sits on its own line and
// the value follows on the NEXT line. Taken from the shape of corpus id 6855.
const appleBody = `Sent from my iPhone
Begin forwarded message:
From:
DIB Notification <DIB.notification@dib.ae>
Subject:
DIB Notification
Date:
Jun 22, 2026 at 11:41 AM
To:
salehtl@icloud.com
Reply-To:
DIB Notification <DIB.notification@dib.ae>
AED 473.00
NOMOD- SMART DCS CLE`

// gmailBody is Gmail's layout: label and value on the SAME line, under a
// dashed marker.
const gmailBody = `---------- Forwarded message ---------
From: Emirates NBD <alert@emiratesnbd.com>
Date: Jul 24, 2026 at 4:11 PM
Subject: Emirates NBD Transaction advice for account ending with 3701
To: <someone@gmail.com>

AED 250,000.00 has been withdrawn from your account 067XXX17XXX01.`

func TestUnwrapAppleMailNextLineLayout(t *testing.T) {
	got := unwrapForward("salehtl@icloud.com", "Fwd: DIB Notification", appleBody)
	if !got.Found {
		t.Fatal("marker not found")
	}
	if got.From != "DIB Notification <DIB.notification@dib.ae>" {
		t.Fatalf("From = %q", got.From)
	}
	if got.Subject != "DIB Notification" {
		t.Fatalf("Subject = %q", got.Subject)
	}
	if got.Date != "Jun 22, 2026 at 11:41 AM" {
		t.Fatalf("Date = %q", got.Date)
	}
	if got.Body != "AED 473.00\nNOMOD- SMART DCS CLE" {
		t.Fatalf("Body = %q; the preamble and header block must be gone", got.Body)
	}
}

func TestUnwrapGmailSameLineLayout(t *testing.T) {
	got := unwrapForward("someone@gmail.com", "Fwd: Emirates NBD Transaction advice", gmailBody)
	if !got.Found {
		t.Fatal("marker not found")
	}
	if got.From != "Emirates NBD <alert@emiratesnbd.com>" {
		t.Fatalf("From = %q", got.From)
	}
	if !strings.Contains(got.Subject, "account ending with 3701") {
		t.Fatalf("Subject = %q; enbd_alert reads last4 from here", got.Subject)
	}
	if got.Body != "AED 250,000.00 has been withdrawn from your account 067XXX17XXX01." {
		t.Fatalf("Body = %q", got.Body)
	}
}

func TestUnwrapQuotedForwardFindsMarkerButRecoversNoHeaders(t *testing.T) {
	// 50 of the corpus's 56 forwards are this shape: a text/plain forward whose
	// header block is ">"-quoted. fwdHeaderLineRe anchors on optional
	// whitespace, and ">" is not whitespace, so no header is ever recovered and
	// the body is returned untouched. This is v1's behavior and v2 reproduces
	// it; see the report's "known gaps".
	body := `Begin forwarded message:
> From: DIB Notification <DIB.notification@dib.ae>
> Subject: DIB Notification
> Date: 22 April 2026 at 1:11:10 AM GST
>
> AED 20,000.00`
	got := unwrapForward("salehtl@icloud.com", "Fwd: DIB Notification", body)
	if !got.Found {
		t.Fatal("the marker line itself is unquoted, so it must still be found")
	}
	if got.From != "salehtl@icloud.com" {
		t.Fatalf("From = %q; a quoted header block recovers nothing, so the outer From stands", got.From)
	}
	if got.Subject != "DIB Notification" {
		t.Fatalf("Subject = %q; only the Fwd: prefix is stripped", got.Subject)
	}
	if got.Date != "" {
		t.Fatalf("Date = %q; nothing is recoverable from a quoted block", got.Date)
	}
	if got.Body != body {
		t.Fatal("with no header recovered the body must be returned unchanged")
	}
}

func TestNonForwardStripsOnlyTheFwdPrefix(t *testing.T) {
	for _, subject := range []string{"Fwd: x", "FW: x", "Fw: x", "fwd:  x", "FWD :x"} {
		got := unwrapForward("a@b.c", subject, "body line\nsecond line")
		if got.Found {
			t.Fatalf("%q: no marker in the body, yet Found is true", subject)
		}
		if got.Subject != "x" {
			t.Fatalf("%q -> Subject %q, want %q", subject, got.Subject, "x")
		}
		if got.Body != "body line\nsecond line" {
			t.Fatalf("%q: body must be untouched, got %q", subject, got.Body)
		}
		if got.From != "a@b.c" {
			t.Fatalf("%q: From must be untouched, got %q", subject, got.From)
		}
	}
	got := unwrapForward("a@b.c", "Forwarding you this", "body")
	if got.Subject != "Forwarding you this" {
		t.Fatalf("a subject that merely starts with 'Forward' must not be stripped: %q", got.Subject)
	}
}

func TestUnwrapMarkerVariants(t *testing.T) {
	for _, marker := range []string{
		"Begin forwarded message:",
		"begin forwarded message:",
		"  Begin forwarded message:  ",
		"---------- Forwarded message ---------",
		"-------- forwarded message --------",
		"- Forwarded message -",
	} {
		got := unwrapForward("a@b.c", "s", marker+"\nFrom: x@y.z\n\nbody")
		if !got.Found {
			t.Fatalf("marker %q not recognised", marker)
		}
	}
	for _, notMarker := range []string{
		"Begin forwarded message",            // no colon
		"x Begin forwarded message:",         // not at line start
		"Begin forwarded message: see below", // trailing text
		"Forwarded message",                  // no dashes
	} {
		got := unwrapForward("a@b.c", "s", notMarker+"\nFrom: x@y.z\n\nbody")
		if got.Found {
			t.Fatalf("%q must NOT be treated as a forward marker", notMarker)
		}
	}
}

func TestUnwrapNeverAffectsTrust(t *testing.T) {
	// A hostile body: anyone can type a forward header block into an email.
	// It may change Result.From, which is diagnostic content, and nothing else.
	hostile := "Begin forwarded message:\nFrom: alerts@dib.ae\nSubject: You have been paid\n\nAED 1.00"
	got := unwrapForward("attacker@evil.example", "hello", hostile)
	if got.From != "alerts@dib.ae" {
		t.Fatalf("From = %q; the content-derived value is expected here", got.From)
	}
	// The forward struct carries exactly four content fields plus Found. If a
	// future field ever looks like an identity or a verification result, this
	// test is where the reviewer should stop.
	res := Result{}
	res.From = got.From
	if res.From == "" {
		t.Fatal("unreachable")
	}
	// Result must expose no verified-sender field: the trusted lane reads the
	// signing domain from the ARC/DKIM verifier, never from here.
	for _, forbidden := range []string{"SenderDomain", "Verified", "Trusted", "SigningDomain"} {
		if resultHasField(forbidden) {
			t.Fatalf("Result exposes %q; Result.From is attacker-authored content and "+
				"no trust decision may read anything from this struct", forbidden)
		}
	}
}

// ---------------------------------------------------------------------------
// Forward Date parsing
// ---------------------------------------------------------------------------

func TestParseForwardDateLayouts(t *testing.T) {
	for _, tc := range []struct {
		in   string
		want time.Time
	}{
		{"Jun 21, 2026 at 12:29 PM", time.Date(2026, 6, 21, 12, 29, 0, 0, time.UTC)},
		{"Jul 24, 2026 at 4:11 PM", time.Date(2026, 7, 24, 16, 11, 0, 0, time.UTC)},
		{"Sun, Jun 21, 2026 at 12:29 PM", time.Date(2026, 6, 21, 12, 29, 0, 0, time.UTC)},
		{"21 June 2026 at 21:24:54", time.Date(2026, 6, 21, 21, 24, 54, 0, time.UTC)},
		{"21 June 2026 at 21:24", time.Date(2026, 6, 21, 21, 24, 0, 0, time.UTC)},
		// A trailing zone token is stripped and the value treated as naive.
		{"21 June 2026 at 21:24:54 GMT+4", time.Date(2026, 6, 21, 21, 24, 54, 0, time.UTC)},
		{"Jun 21, 2026 at 12:29 PM GST", time.Date(2026, 6, 21, 12, 29, 0, 0, time.UTC)},
	} {
		got, err := parseForwardDate(tc.in)
		if err != nil {
			t.Fatalf("parseForwardDate(%q) = %v", tc.in, err)
		}
		if !got.Equal(tc.want) {
			t.Fatalf("parseForwardDate(%q) = %v, want %v", tc.in, got, tc.want)
		}
	}
}

func TestUnwrapHandlesNarrowNoBreakSpaceBeforeAMPM(t *testing.T) {
	// Apple Mail on recent OSes writes U+202F (narrow no-break space) before
	// AM/PM; iCloud webmail has been seen using U+00A0. Both must normalize to
	// U+0020 before the layouts are tried.
	for _, in := range []string{
		"Jun 21, 2026 at 12:29\u202fPM",
		"Jun 21, 2026 at 12:29\u00a0PM",
		"Jun 21, 2026 at 12:29\u202fPM GST",
	} {
		got, err := parseForwardDate(in)
		if err != nil {
			t.Fatalf("parseForwardDate(%q) = %v", in, err)
		}
		if !got.Equal(time.Date(2026, 6, 21, 12, 29, 0, 0, time.UTC)) {
			t.Fatalf("parseForwardDate(%q) = %v", in, got)
		}
	}
}

func TestParseForwardDateRejectsTheiPhoneSecondsWithAMPMShape(t *testing.T) {
	// KNOWN GAP, ported deliberately from v1 so the corpus-equivalence gate
	// stays clean. The Apple Mail iOS app writes "18 June 2026 at 7:33:38 PM
	// GST" — 12-hour WITH seconds — which none of the four closed layouts
	// covers, so the transaction silently falls back to the arrival time. Three
	// corpus messages (ids 2554, 6853, 6854) are affected. If a later task adds
	// "2 January 2006 at 3:04:05 PM" to the layout list, this test is the one
	// that must be updated, and the change is a normalizer VERSION bump.
	for _, in := range []string{
		"18 June 2026 at 7:33:38\u202fPM GST",
		"21 June 2026 at 11:07:51\u202fPM GST",
	} {
		if _, err := parseForwardDate(in); err == nil {
			t.Fatalf("parseForwardDate(%q) now succeeds; v1 fails here and the "+
				"corpus-equivalence gate expects the same result", in)
		}
	}
}

func TestParseForwardDateRejectsGarbage(t *testing.T) {
	for _, in := range []string{"", "   ", "not a date", "2026-06-21T12:29:00Z", "Mon, 21 Jun 2026 12:29:00 +0400"} {
		if _, err := parseForwardDate(in); err == nil {
			t.Fatalf("parseForwardDate(%q) unexpectedly succeeded", in)
		}
	}
}

func TestUnwrapTrimsTheRemainderWithTheExplicitSet(t *testing.T) {
	// The line after the header block is a lone U+FEFF, exactly as corpus ids
	// 2554/6853/6854 have it. Go's strings.TrimSpace leaves U+FEFF in place;
	// the explicit set removes it. This is a deliberate divergence from v1.
	body := "Begin forwarded message:\nFrom: a@b.c\nSubject: s\n\ufeff\nAED 1.00"
	got := unwrapForward("x@y.z", "Fwd: s", body)
	if got.Body != "AED 1.00" {
		t.Fatalf("Body = %q; the U+FEFF line must be trimmed away", got.Body)
	}
}
