package norm

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// mustFixture returns the raw RFC822 bytes of a committed conformance fixture.
//
// The fixtures are the single source of truth for the sample mail this package
// is tested against: they already carry the raw message base64-encoded, so
// keeping a parallel tree of .eml files would be two copies of the same bytes
// that can drift apart.
func mustFixture(t *testing.T, name string) []byte {
	t.Helper()
	name = strings.TrimSuffix(name, ".eml")
	path := filepath.Join("..", "..", "..", "conformance", "normalizer", name+".json")
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("fixture %s: %v; regenerate with LEDGER_WRITE_CONFORMANCE=1 LEDGER_CORPUS_DB=... go test ./internal/v2/norm/ -run TestWriteNormalizerFixtures", name, err)
	}
	var c conformanceCase
	if err := json.Unmarshal(b, &c); err != nil {
		t.Fatalf("fixture %s: %v", name, err)
	}
	raw, err := base64.StdEncoding.DecodeString(c.RawBase64)
	if err != nil {
		t.Fatalf("fixture %s: raw_base64: %v", name, err)
	}
	return raw
}

// ---------------------------------------------------------------------------
// Versioning
// ---------------------------------------------------------------------------

func TestNormalizeUnknownVersionIsAnError(t *testing.T) {
	raw := []byte("Content-Type: text/plain; charset=utf-8\r\n\r\nhi\r\n")
	for _, v := range []int{0, 2, -1, 99} {
		if _, err := Normalize(v, raw, time.Now()); err == nil {
			t.Fatalf("Normalize(%d, ...) succeeded; an unknown normalizer version must be an error", v)
		}
	}
	if _, err := Normalize(CurrentVersion, raw, time.Now()); err != nil {
		t.Fatalf("Normalize(CurrentVersion, ...) = %v", err)
	}
}

func TestVersionsListsEverySupportedVersion(t *testing.T) {
	vs := Versions()
	if len(vs) == 0 {
		t.Fatal("Versions() is empty")
	}
	var found bool
	for _, v := range vs {
		if v == CurrentVersion {
			found = true
		}
		if _, err := Normalize(v, []byte("Content-Type: text/plain\r\n\r\nx\r\n"), time.Now()); err != nil {
			t.Fatalf("Versions() advertises %d but Normalize rejects it: %v", v, err)
		}
	}
	if !found {
		t.Fatalf("Versions() = %v; does not contain CurrentVersion %d", vs, CurrentVersion)
	}
}

// ---------------------------------------------------------------------------
// Stages 5-9: HTML strip, entities, whitespace, trim
// ---------------------------------------------------------------------------

func TestNormalizeCollapsesNBSPAndTrimsExplicitSet(t *testing.T) {
	raw := []byte("Content-Type: text/html; charset=utf-8\r\n\r\n" +
		"<div>\u00a0\u00a0AED 100.00 </div><div>\ufeff x </div>")
	got, err := Normalize(1, raw, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if got.Text != "AED 100.00\nx" {
		t.Fatalf("got %q, want %q", got.Text, "AED 100.00\nx")
	}
	if got.PartUsed != PartHTML {
		t.Fatalf("PartUsed = %q, want %q", got.PartUsed, PartHTML)
	}
}

func TestNormalizeTrimsTheExplicitSetNotGoTrimSpace(t *testing.T) {
	// U+0085 NEXT LINE and U+2028 LINE SEPARATOR are trimmed by Go's
	// strings.TrimSpace but are NOT in the normalizer's explicit set, so they
	// must survive. U+FEFF is the mirror image: not trimmed by TrimSpace, but
	// in the explicit set, so it must vanish. Both directions are what keep the
	// Go and TypeScript normalizers byte-identical.
	raw := []byte("Content-Type: text/plain; charset=utf-8\r\n\r\n" +
		"\u0085keep\u0085\n\ufeffdrop\ufeff\n\ufeff\u00a0\n\u200a\n")
	got, err := Normalize(1, raw, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	want := "\u0085keep\u0085\ndrop\n\u200a"
	if got.Text != want {
		t.Fatalf("got %q, want %q", got.Text, want)
	}
}

func TestNormalizeStripsScriptAndStyleBeforeTags(t *testing.T) {
	raw := []byte("Content-Type: text/html; charset=utf-8\r\n\r\n" +
		"<style>div{color:red}</style><script>var x='<b>no</b>';</script><p>AED 5.00</p>")
	got, err := Normalize(1, raw, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if got.Text != "AED 5.00" {
		t.Fatalf("got %q; script/style content must not survive", got.Text)
	}
}

func TestNormalizeDecodesExactlySixEntitiesInOnePass(t *testing.T) {
	// The entity decode is ONE left-to-right pass with no rescanning of what it
	// just emitted. "&amp;lt;" must therefore become "&lt;" and stop, not "<".
	// A TypeScript twin written as six sequential .replace() calls produces "<"
	// and silently disagrees on every message containing a double-escaped entity.
	raw := []byte("Content-Type: text/plain; charset=utf-8\r\n\r\n" +
		"&amp;lt; &nbsp;x&amp;&lt;&gt;&quot;&#39; &copy;\r\n")
	got, err := Normalize(1, raw, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	want := `&lt; x&<>"' &copy;`
	if got.Text != want {
		t.Fatalf("got %q, want %q", got.Text, want)
	}
}

// ---------------------------------------------------------------------------
// Stages 2-4: MIME walk, transfer encoding, charset
// ---------------------------------------------------------------------------

func TestNormalizeDecodesQuotedPrintableAndCharset(t *testing.T) {
	// windows-1256 Arabic, quoted-printable wrapped. 0xE3 0xC8 0xE1 0xDA is
	// "مبلغ"-ish in windows-1256; the point is that the bytes are NOT valid
	// UTF-8 and must be converted, not replaced.
	raw := []byte("Content-Type: text/plain; charset=windows-1256\r\n" +
		"Content-Transfer-Encoding: quoted-printable\r\n\r\n" +
		"AED 100.00 =E3=C8=E1=\r\n=DA\r\n")
	got, err := Normalize(1, raw, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(got.Text, "�") {
		t.Fatalf("got %q; a correctly declared windows-1256 body must decode without U+FFFD", got.Text)
	}
	if !strings.HasPrefix(got.Text, "AED 100.00 ") {
		t.Fatalf("got %q; quoted-printable soft line break was not joined", got.Text)
	}
	if got.Charset != "windows-1256" {
		t.Fatalf("Charset = %q, want windows-1256", got.Charset)
	}
	if got.PartUsed != PartPlain {
		t.Fatalf("PartUsed = %q, want %q", got.PartUsed, PartPlain)
	}
}

func TestNormalizePrefersHTMLOverPlainAndDescendsNestedMultipart(t *testing.T) {
	raw := []byte("MIME-Version: 1.0\r\n" +
		"Content-Type: multipart/alternative; boundary=outer\r\n\r\n" +
		"--outer\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nPLAIN BODY\r\n" +
		"--outer\r\nContent-Type: multipart/related; boundary=inner\r\n\r\n" +
		"--inner\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>HTML BODY</p>\r\n" +
		"--inner--\r\n" +
		"--outer--\r\n")
	got, err := Normalize(1, raw, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if got.Text != "HTML BODY" {
		t.Fatalf("got %q; the html leaf nested in multipart/related must win", got.Text)
	}
	if got.PartUsed != PartHTML {
		t.Fatalf("PartUsed = %q", got.PartUsed)
	}
}

func TestNormalizeFallsBackToRawOnBrokenMIME(t *testing.T) {
	raw := []byte("!!! this is not a header line\r\nneither is this\r\n\r\nAED 42.00\r\nMERCHANT\r\n")
	got, err := Normalize(1, raw, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if got.PartUsed != PartRaw {
		t.Fatalf("PartUsed = %q, want %q", got.PartUsed, PartRaw)
	}
	if got.Text != "AED 42.00\nMERCHANT" {
		t.Fatalf("got %q; the raw fallback takes everything after the first blank line", got.Text)
	}
}

func TestNormalizeRawFallbackHandlesBareLF(t *testing.T) {
	raw := []byte("!!! broken\nstill broken\n\nAED 7.00\n")
	got, err := Normalize(1, raw, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if got.PartUsed != PartRaw || got.Text != "AED 7.00" {
		t.Fatalf("PartUsed=%q Text=%q", got.PartUsed, got.Text)
	}
}

func TestNormalizeNoTextPartIsAnError(t *testing.T) {
	raw := []byte("Content-Type: application/octet-stream\r\n\r\n\x00\x01\x02\r\n")
	_, err := Normalize(1, raw, time.Now())
	if err == nil {
		t.Fatal("a message with no text/html and no text/plain leaf must return ErrNoTextPart")
	}
	if !errors.Is(err, ErrNoTextPart) {
		t.Fatalf("err = %v; want ErrNoTextPart", err)
	}
}

// ---------------------------------------------------------------------------
// Stage 3: WHATWG UTF-8 replacement
// ---------------------------------------------------------------------------

func TestInvalidUTF8BecomesWHATWGReplacementChars(t *testing.T) {
	// One U+FFFD per maximal subpart, exactly as TextDecoder does — NOT one per
	// contiguous invalid run (strings.ToValidUTF8) and NOT one per byte
	// (a naive utf8.DecodeRune loop).
	for _, tc := range []struct {
		name string
		in   []byte
		want string
	}{
		{"truncated 3-byte at EOF", []byte{'A', 0xE2, 0x82}, "A�"},
		{"truncated 4-byte at EOF", []byte{'A', 0xF0, 0x9F, 0x92}, "A�"},
		{"truncated then valid", []byte{0xE2, 0x82, 'A', 'B'}, "�AB"},
		{"lone continuation", []byte{'A', 0x80, 'B'}, "A�B"},
		{"two lone continuations", []byte{'A', 0x80, 0x80, 'B'}, "A��B"},
		{"overlong C0 80", []byte{'A', 0xC0, 0x80, 'B'}, "A��B"},
		{"overlong E0 80 80", []byte{'A', 0xE0, 0x80, 0x80, 'B'}, "A���B"},
		{"surrogate ED A0 80", []byte{'A', 0xED, 0xA0, 0x80, 'B'}, "A���B"},
		{"F5 out of range", []byte{'A', 0xF5, 0x80, 0x80, 0x80, 'B'}, "A����B"},
		{"FE FF", []byte{'A', 0xFE, 0xFF, 'B'}, "A��B"},
		{"valid euro survives", []byte{0xE2, 0x82, 0xAC}, "€"},
		{"leading BOM is NOT stripped", []byte{0xEF, 0xBB, 0xBF, 'A'}, "\ufeffA"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := decodeUTF8WHATWG(tc.in); got != tc.want {
				t.Fatalf("decodeUTF8WHATWG(% x) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

func TestMislabelledCharsetProducesWHATWGReplacements(t *testing.T) {
	// A windows-1256 body mislabelled utf-8. Every high byte here is a lone
	// invalid start/continuation byte, so the contract is one U+FFFD each.
	body := []byte{0xD9, 0xE5, 0xC7, ' ', 'A', 'E', 'D'}
	raw := append([]byte("Content-Type: text/plain; charset=utf-8\r\n\r\n"), body...)
	got, err := Normalize(1, raw, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	// 0xD9 is a valid 2-byte lead; 0xE5 is not a valid continuation, so 0xD9
	// yields one U+FFFD and 0xE5 is reprocessed as a 3-byte lead, which then
	// takes 0xC7 (not a valid continuation) -> another U+FFFD, and 0xC7 is
	// reprocessed as a 2-byte lead whose next byte is ' ' -> a third U+FFFD.
	want := "��� AED"
	if got.Text != want {
		t.Fatalf("got %q, want %q", got.Text, want)
	}
}

// ---------------------------------------------------------------------------
// Stage 10: unwrap (see also unwrap_test.go)
// ---------------------------------------------------------------------------

func TestUnwrapRecoversInnerSubjectFromAppleMailForward(t *testing.T) {
	got, err := Normalize(1, mustFixture(t, "apple-forward-enbd-alert.eml"), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if !got.Forwarded {
		t.Fatal("expected a detected forward")
	}
	if !strings.Contains(got.Subject, "account ending with") {
		t.Fatalf("inner subject lost: %q — enbd_alert reads last4 from here", got.Subject)
	}
	if strings.HasPrefix(strings.ToLower(got.Subject), "fwd:") {
		t.Fatalf("Subject %q is still the outer envelope subject", got.Subject)
	}
	if strings.Contains(got.Text, "Begin forwarded message") {
		t.Fatalf("forward preamble survived into Text: %q", got.Text[:80])
	}
}

func TestUnwrapRecoversInnerSubjectFromGmailForward(t *testing.T) {
	got, err := Normalize(1, mustFixture(t, "gmail-forward-1.eml"), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if !got.Forwarded {
		t.Fatal("expected a detected forward")
	}
	if strings.HasPrefix(strings.ToLower(got.Subject), "fwd:") {
		t.Fatalf("Subject %q is still the outer envelope subject", got.Subject)
	}
	if !strings.Contains(got.From, "@") {
		t.Fatalf("inner From not recovered from the same-line header layout: %q", got.From)
	}
	if strings.Contains(got.Text, "Forwarded message") {
		t.Fatalf("forward preamble survived into Text")
	}
}

func TestUnwrapUsesTheInnerDateNotTheArrivalTime(t *testing.T) {
	// The fixture's inner message is dated 2026-07-24; this arrival time is a
	// week later, which is exactly the "forwarded long after the purchase" case
	// Decision 14 exists for.
	recv := time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC)
	got, err := Normalize(1, mustFixture(t, "gmail-forward-1.eml"), recv)
	if err != nil {
		t.Fatal(err)
	}
	if got.DateSource != DateSourceForwardHeader {
		t.Fatalf("DateSource = %q", got.DateSource)
	}
	if !got.EmailDate.Before(recv) {
		t.Fatal("a late forward must date to the original message")
	}
}

func TestNonForwardKeepsReceivedDateAndOwnHeaders(t *testing.T) {
	recv := time.Date(2026, 6, 5, 9, 0, 0, 0, time.UTC)
	raw := []byte("From: DIB Notification <DIB.notification@dib.ae>\r\n" +
		"Subject: DIB Notification\r\n" +
		"Content-Type: text/plain; charset=utf-8\r\n\r\nAED 1.00\r\n")
	got, err := Normalize(1, raw, recv)
	if err != nil {
		t.Fatal(err)
	}
	if got.Forwarded {
		t.Fatal("no forward marker, yet Forwarded is true")
	}
	if got.Subject != "DIB Notification" {
		t.Fatalf("Subject = %q", got.Subject)
	}
	if got.From != "DIB.notification@dib.ae" {
		t.Fatalf("From = %q; want the bare address, as v1's IMAP envelope supplies", got.From)
	}
	if !got.EmailDate.Equal(recv) || got.DateSource != DateSourceReceived {
		t.Fatalf("EmailDate=%v DateSource=%q; want the received time", got.EmailDate, got.DateSource)
	}
}

func TestSubjectIsRFC2047Decoded(t *testing.T) {
	// Two adjacent encoded words must join with NO space between them; the
	// corpus's ENBD alert forward is exactly this shape.
	raw := []byte("Subject: =?utf-8?B?RndkOiBFbWlyYXRlcyBOQkQgVHJhbnNhY3Rpb24gYWR2aWNlIGZvciBhY2Nv?= =?utf-8?B?dW50IGVuZGluZyB3aXRoIDM3MDE=?=\r\n" +
		"From: a@b.c\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nx\r\n")
	got, err := Normalize(1, raw, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if got.Subject != "Emirates NBD Transaction advice for account ending with 3701" {
		t.Fatalf("Subject = %q", got.Subject)
	}
}
