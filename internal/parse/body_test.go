package parse

import (
	"encoding/base64"
	"strings"
	"testing"
)

// a minimal single-part base64 text/html RFC822 message, like DIB's.
func b64HTMLMessage(html string) []byte {
	enc := base64.StdEncoding.EncodeToString([]byte(html))
	var wrapped strings.Builder
	for i := 0; i < len(enc); i += 76 {
		end := i + 76
		if end > len(enc) {
			end = len(enc)
		}
		wrapped.WriteString(enc[i:end])
		wrapped.WriteString("\r\n")
	}
	msg := "From: DIB.notification@dib.ae\r\n" +
		"Subject: DIB Notification\r\n" +
		"MIME-Version: 1.0\r\n" +
		"Content-Type: text/html; charset=\"utf-8\"\r\n" +
		"Content-Transfer-Encoding: base64\r\n" +
		"\r\n" + wrapped.String()
	return []byte(msg)
}

func TestBodyTextDecodesBase64HTMLAndStrips(t *testing.T) {
	raw := b64HTMLMessage(`<html><body><p>المبلغ</p><p>AED 215.00</p><b>الدفع الى</b> DAPPER DAN</body></html>`)
	text, err := BodyText(raw)
	if err != nil {
		t.Fatalf("BodyText: %v", err)
	}
	for _, want := range []string{"المبلغ", "AED 215.00", "الدفع الى", "DAPPER DAN"} {
		if !strings.Contains(text, want) {
			t.Errorf("text missing %q; got:\n%s", want, text)
		}
	}
	if strings.Contains(text, "<p>") || strings.Contains(text, "<body>") {
		t.Errorf("tags not stripped: %s", text)
	}
}

func TestBodyTextPrefersHTMLInMultipart(t *testing.T) {
	boundary := "BOUND"
	body := "--" + boundary + "\r\n" +
		"Content-Type: text/plain; charset=utf-8\r\n\r\nplain version\r\n" +
		"--" + boundary + "\r\n" +
		"Content-Type: text/html; charset=utf-8\r\n\r\n<p>html version</p>\r\n" +
		"--" + boundary + "--\r\n"
	msg := "From: x@y.com\r\nMIME-Version: 1.0\r\n" +
		"Content-Type: multipart/alternative; boundary=\"" + boundary + "\"\r\n\r\n" + body
	text, err := BodyText([]byte(msg))
	if err != nil {
		t.Fatalf("BodyText: %v", err)
	}
	if !strings.Contains(text, "html version") {
		t.Errorf("expected html part, got: %s", text)
	}
}
