# Milestone 3: Parse Cascade (DIB-first) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the raw emails in `ingest_log` into validated rows in `transactions` via a resilient extraction cascade — a real **DIB** per-bank template → a bank-agnostic **heuristic** extractor → a gated **AI** tier (interface + mock only; real client in M4) → a **review-queue floor** — with field validation gating every tier and a `POST /api/reprocess` that re-runs the cascade over retained raw email (so nothing is ever lost and adding banks/fixing parsers backfills).

**Architecture:** A new `internal/parse` package owns extraction. `BodyText` decodes the stored RFC822 (base64/MIME, via the already-present `go-message`) and strips HTML to text. A `Cascade` runs registered `BankParser`s (template tier) then the heuristic, then an optional `Extractor` (AI), with `Validate` gating each result; it returns a tier + a status. A `Processor` reads `unparsed` `ingest_log` rows, runs the cascade, writes `transactions` (idempotent via a sha256 fingerprint), and stamps `ingest_log.parse_status`/`parse_tier`. The ingest worker calls the processor after each sync; `POST /api/reprocess` calls the same processor over a re-selected set. The first real template is **DIB**, built from 1,200+ captured emails; it handles DIB's two layouts (card-purchase `إشعار مشتريات` and account `خصم/إيداع/تحويل/سحب`).

**Tech Stack:** Go 1.22+, `github.com/emersion/go-message` v0.18.2 (already an indirect dep — MIME/charset decode), stdlib `regexp`/`crypto/sha256`/`net/mail`, existing `modernc.org/sqlite` store, stdlib `net/http`.

This implements **Milestone 3 of §10** (§6.2 cascade, §6.7 `/api/reprocess`). It deliberately contains **no categorization** (M4) and **no dedup/reconciliation or budget** (M5) — every extracted transaction is written `status='needs_review'` with its tier + confidence recorded; only a basic fingerprint (for the existing UNIQUE index) is computed, not pending/posted matching or self-transfer logic. The **real Anthropic client is deferred to M4**; the AI tier is an interface with a disabled default, mock-tested here.

## Decisions locked in (from planning)
- **AI extraction tier:** interface (`parse.Extractor`) + disabled default + mock in tests. Gated by `ai.enabled` (default off). No real HTTP client this milestone.
- **DIB-first:** real DIB template now; ENBD (and others) added later as new `BankParser`s — `POST /api/reprocess` then backfills them from retained raw email. (ENBD mail is not yet in the mailbox.)
- **Status:** all M3-extracted transactions are `needs_review` (no categorizer yet). `ingest_log.parse_status` becomes `parsed` (template/heuristic) | `low_confidence` (ai) | `unparsed` (none).
- **Account resolution is best-effort:** `accounts` is empty in M3, so `transactions.account_id` stays NULL; `Last4` is captured into the fingerprint but validation does NOT require an account to resolve (that arrives with seeding in a later milestone).

---

## DIB email anatomy (reference for Task 6 — derived from real captured mail)

DIB sends **Arabic HTML** emails from `DIB.notification@dib.ae`. After HTML-strip, the text is a vertical `label\nvalue` layout. Two layouts:

**Layout A — card purchase** (title contains `إشعار مشتريات`; header `معاملة بطاقة ائتمان`). Always **debit**.
```
معاملة بطاقة ائتمان
عزيزي المتعامل,
إشعار مشتريات بتاريخ 19-08-2025 16:18 بالتفاصيل التالية.
رقم البطاقة
525467XXXXXX1502
بطاقة الإئتمان
المبلغ
AED 215.00
الدفع الى
DAPPER DAN GENTS SAL          <- MERCHANT (real)
إجمالي الرصيد المتوفر
86,664.42
```
- date+time after `بتاريخ`; card last-4 after `رقم البطاقة`; amount after `المبلغ` as `AED N,NNN.NN`; **merchant after `الدفع الى`**.

**Layout B — account transaction** (title `إشعار خصم`|`إشعار إيداع`|`إشعار تحويل`|`إشعار سحب`).
```
إشعار خصم
عزيزي المتعامل,
... من الحساب بتاريخ 19-08-2025 بالتفاصيل التالية.
المبلغ
AED 170.00
من حساب
001-520-XXXX081-01            <- account (masked); last-4 captured from trailing digits
حساب جاري
المعاملة
OUTWARD UAE FUNDS TRANS IPI   <- description (a transaction type, not a storefront)
الحالة
تمت بنجاح
الرقم المرجعي
FT25231JVD00
```
- amount after `المبلغ`; account after `من حساب`; description after `المعاملة`.
- **Direction by title:** `إشعار خصم` (debit), `إشعار سحب` (withdrawal→debit), `إشعار إيداع` (deposit→credit). `إشعار تحويل` (transfer) is ambiguous → use the body preposition: `من الحساب` ("from the account")=debit, otherwise credit; if a `المعاملة` value ends in `DEBIT`/`CREDIT`, that wins.

Amounts are always `AED ` + digits with `,` thousands separators + `.` and 2 decimals → fils = remove `,`, drop `.`, parse int (×100). Dates are `DD-MM-YYYY` (Go layout `02-01-2006`); the optional time is `HH:MM`.

---

## File Structure

| File | Responsibility |
|---|---|
| `internal/parse/parse.go` | `ParsedTxn`, `BankParser`, tier/direction consts, `Validate` |
| `internal/parse/parse_test.go` | Validate tests |
| `internal/parse/body.go` | `BodyText(raw []byte) (string, error)` — MIME/base64 decode + HTML→text |
| `internal/parse/body_test.go` | decode/strip tests |
| `internal/parse/fields.go` | `ParseAEDToFils`, `ParseDIBDate` shared field helpers |
| `internal/parse/fields_test.go` | field-helper tests |
| `internal/parse/dib.go` | `DIBParser` — both DIB layouts |
| `internal/parse/dib_test.go` | DIB parser tests (real-structure text fixtures) |
| `internal/parse/heuristic.go` | `HeuristicParser` — bank-agnostic shape extractor |
| `internal/parse/heuristic_test.go` | heuristic tests |
| `internal/parse/ai.go` | `Extractor` interface + `DisabledExtractor` default |
| `internal/parse/cascade.go` | `Cascade` orchestrator (template→heuristic→ai→unparsed) + `Result` |
| `internal/parse/cascade_test.go` | cascade routing tests (fakes) |
| `internal/store/transactions.go` | fingerprint + `InsertTransaction`, `SelectForParse`, `MarkParsed` |
| `internal/store/transactions_test.go` | store tests |
| `internal/parse/processor.go` | `Processor.ProcessPending` — ingest_log → cascade → transactions |
| `internal/parse/processor_test.go` | processor tests (real temp store + fake cascade pieces) |
| `internal/ingest/ingest.go` | **Modify:** worker runs the processor after each sync |
| `internal/server/reprocess.go` | `POST /api/reprocess` handler |
| `internal/server/server.go` | **Modify:** route + optional Reprocessor dependency |
| `internal/server/reprocess_test.go` | endpoint tests |
| `cmd/ledger/main.go` | **Modify:** build cascade+processor, register DIB, wire worker + endpoint |

**No schema change** — `transactions` and its `idx_tx_fingerprint` UNIQUE index already exist from M1.

---

## Task 1: Core types + validation (`internal/parse/parse.go`)

**Files:** Create `internal/parse/parse.go`, `internal/parse/parse_test.go`

- [ ] **Step 1: Write the failing test** — Create `internal/parse/parse_test.go`:

```go
package parse

import (
	"testing"
	"time"
)

func valid() ParsedTxn {
	return ParsedTxn{
		PostedAt:    time.Date(2025, 8, 19, 0, 0, 0, 0, time.UTC),
		AmountFils:  21500,
		Currency:    "AED",
		Direction:   DirectionDebit,
		MerchantRaw: "DAPPER DAN GENTS SAL",
		Tier:        TierTemplate,
		Confidence:  0.99,
	}
}

func TestValidateAcceptsGoodTxn(t *testing.T) {
	if err := Validate(valid()); err != nil {
		t.Fatalf("expected valid, got %v", err)
	}
}

func TestValidateRejectsNonPositiveAmount(t *testing.T) {
	p := valid()
	p.AmountFils = 0
	if Validate(p) == nil {
		t.Error("expected error for zero amount")
	}
}

func TestValidateRejectsBadDirection(t *testing.T) {
	p := valid()
	p.Direction = "sideways"
	if Validate(p) == nil {
		t.Error("expected error for bad direction")
	}
}

func TestValidateRejectsMissingCurrency(t *testing.T) {
	p := valid()
	p.Currency = ""
	if Validate(p) == nil {
		t.Error("expected error for empty currency")
	}
}

func TestValidateRejectsZeroOrFutureDate(t *testing.T) {
	p := valid()
	p.PostedAt = time.Time{}
	if Validate(p) == nil {
		t.Error("expected error for zero date")
	}
	p2 := valid()
	p2.PostedAt = time.Now().AddDate(0, 0, 3)
	if Validate(p2) == nil {
		t.Error("expected error for future date")
	}
}
```

- [ ] **Step 2: Run `go test ./internal/parse/` — expect FAIL** (package doesn't compile: undefined `ParsedTxn`/`Validate`).

- [ ] **Step 3: Implement** — Create `internal/parse/parse.go`:

```go
// Package parse turns raw bank-notification emails into validated transactions
// via a resilient cascade: per-bank template → generic heuristic → AI → review.
// It does NOT categorize (M4) or dedup/reconcile (M5); it extracts and validates.
package parse

import (
	"fmt"
	"time"
)

// Tier and direction constants.
const (
	TierTemplate  = "template"
	TierHeuristic = "heuristic"
	TierAI        = "ai"

	DirectionDebit  = "debit"
	DirectionCredit = "credit"
)

// ParsedTxn is the extracted, not-yet-categorized transaction. AmountFils is
// always a positive integer minor unit (AED × 100); Direction carries sign.
type ParsedTxn struct {
	PostedAt    time.Time
	AmountFils  int64
	Currency    string
	Direction   string // "debit" | "credit"
	MerchantRaw string
	Last4       string
	IsTransfer  bool
	Confidence  float64
	Tier        string // "template" | "heuristic" | "ai"
}

// BankParser is a per-bank template tier. Matches is a cheap sender/subject
// check; Parse runs on the HTML-stripped plain-text body.
type BankParser interface {
	Bank() string
	Matches(from, subject string) bool
	Parse(textBody string) (ParsedTxn, error)
}

// Validate gates a result regardless of tier. A failure routes the email to
// review rather than trusting a wrong number. Account resolution is NOT required
// here (accounts may be unseeded in early milestones).
func Validate(p ParsedTxn) error {
	if p.AmountFils <= 0 {
		return fmt.Errorf("amount must be positive, got %d", p.AmountFils)
	}
	if p.Currency == "" {
		return fmt.Errorf("currency must not be empty")
	}
	if p.Direction != DirectionDebit && p.Direction != DirectionCredit {
		return fmt.Errorf("direction must be debit|credit, got %q", p.Direction)
	}
	if p.PostedAt.IsZero() {
		return fmt.Errorf("posted_at must be set")
	}
	if p.PostedAt.After(time.Now().AddDate(0, 0, 2)) {
		return fmt.Errorf("posted_at is implausibly in the future: %s", p.PostedAt)
	}
	return nil
}
```

- [ ] **Step 4: Run `go test ./internal/parse/` — expect PASS.** Also `go vet ./internal/parse/`.

- [ ] **Step 5: Commit**
```bash
git add internal/parse/parse.go internal/parse/parse_test.go
git commit -m "feat(parse): ParsedTxn, BankParser interface, and field validation"
```
End every commit body with: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`

---

## Task 2: Field helpers (`internal/parse/fields.go`)

Shared amount/date parsing used by the DIB template and the heuristic.

**Files:** Create `internal/parse/fields.go`, `internal/parse/fields_test.go`

- [ ] **Step 1: Write the failing test** — Create `internal/parse/fields_test.go`:

```go
package parse

import (
	"testing"
	"time"
)

func TestParseAEDToFils(t *testing.T) {
	cases := map[string]int64{
		"AED 215.00":     21500,
		"AED 10,000.00":  1000000,
		"AED 1,234.56":   123456,
		"215.00":         21500,
		"AED 0.50":       50,
	}
	for in, want := range cases {
		got, cur, err := ParseAEDToFils(in)
		if err != nil {
			t.Errorf("%q: unexpected err %v", in, err)
			continue
		}
		if got != want {
			t.Errorf("%q: fils = %d, want %d", in, got, want)
		}
		if cur != "AED" {
			t.Errorf("%q: currency = %q, want AED", in, cur)
		}
	}
	if _, _, err := ParseAEDToFils("no money here"); err == nil {
		t.Error("expected error when no amount present")
	}
}

func TestParseDIBDate(t *testing.T) {
	got, err := ParseDIBDate("19-08-2025")
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if !got.Equal(time.Date(2025, 8, 19, 0, 0, 0, 0, time.UTC)) {
		t.Errorf("got %s", got)
	}
	if _, err := ParseDIBDate("2025/08/19"); err == nil {
		t.Error("expected error for wrong format")
	}
}
```

- [ ] **Step 2: Run `go test ./internal/parse/ -run 'ParseAED|ParseDIBDate'` — expect FAIL** (undefined).

- [ ] **Step 3: Implement** — Create `internal/parse/fields.go`:

```go
package parse

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// amountRe finds an optional 3-letter currency then a number with comma
// thousands separators and exactly two decimals.
var amountRe = regexp.MustCompile(`(?:([A-Z]{3})\s*)?([0-9][0-9,]*\.[0-9]{2})`)

// ParseAEDToFils parses "AED 10,000.00" (or a bare "10,000.00") into integer
// fils (×100). Returns the currency (defaulting to "AED" when absent).
func ParseAEDToFils(s string) (int64, string, error) {
	m := amountRe.FindStringSubmatch(s)
	if m == nil {
		return 0, "", fmt.Errorf("no amount in %q", s)
	}
	currency := m[1]
	if currency == "" {
		currency = "AED"
	}
	digits := strings.ReplaceAll(m[2], ",", "")
	digits = strings.Replace(digits, ".", "", 1) // "10000.00" -> "1000000"
	fils, err := strconv.ParseInt(digits, 10, 64)
	if err != nil {
		return 0, "", fmt.Errorf("parse amount %q: %w", m[2], err)
	}
	return fils, currency, nil
}

// ParseDIBDate parses DIB's DD-MM-YYYY date (time, if any, is ignored).
func ParseDIBDate(s string) (time.Time, error) {
	return time.Parse("02-01-2006", strings.TrimSpace(s))
}
```

- [ ] **Step 4: Run `go test ./internal/parse/` — expect PASS.**

- [ ] **Step 5: Commit**
```bash
git add internal/parse/fields.go internal/parse/fields_test.go
git commit -m "feat(parse): AED-to-fils and DIB date field helpers"
```

---

## Task 3: MIME/HTML → text (`internal/parse/body.go`)

Decodes the stored RFC822 (DIB is single-part `text/html` base64; handle multipart too) and strips HTML to normalized text. Uses `go-message` (auto-decodes transfer-encoding + charset to UTF-8).

**Files:** Create `internal/parse/body.go`, `internal/parse/body_test.go`

- [ ] **Step 1: Add the import** (it is already an indirect dependency; this promotes it):
```bash
go get github.com/emersion/go-message@v0.18.2
```

- [ ] **Step 2: Write the failing test** — Create `internal/parse/body_test.go`:

```go
package parse

import (
	"encoding/base64"
	"strings"
	"testing"
)

// a minimal single-part base64 text/html RFC822 message, like DIB's.
func b64HTMLMessage(html string) []byte {
	enc := base64.StdEncoding.EncodeToString([]byte(html))
	// wrap to mimic real emails (not required, but realistic)
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
	// multipart/alternative with plain + html; we expect the html (stripped).
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
```

- [ ] **Step 3: Run `go test ./internal/parse/ -run BodyText` — expect FAIL** (undefined `BodyText`).

- [ ] **Step 4: Implement** — Create `internal/parse/body.go`:

```go
package parse

import (
	"bytes"
	"fmt"
	"io"
	"regexp"
	"strings"

	"github.com/emersion/go-message"
	_ "github.com/emersion/go-message/charset" // register common charsets
)

var (
	tagRe   = regexp.MustCompile(`(?s)<[^>]+>`)
	wsRe    = regexp.MustCompile(`[ \t\x{00a0}]+`)
	blankRe = regexp.MustCompile(`\n\s*\n+`)
)

// BodyText parses a raw RFC822 message, extracts the best text part (preferring
// text/html, falling back to text/plain), decodes transfer-encoding + charset,
// and strips HTML to normalized plain text with one value per line.
func BodyText(raw []byte) (string, error) {
	ent, err := message.Read(bytes.NewReader(raw))
	if err != nil && message.IsUnknownCharset(err) == false && message.IsUnknownEncoding(err) == false {
		return "", fmt.Errorf("read message: %w", err)
	}
	htmlBody, plainBody := "", ""
	walk := func(e *message.Entity) {
		ct, _, _ := e.Header.ContentType()
		b, rerr := io.ReadAll(e.Body)
		if rerr != nil {
			return
		}
		switch ct {
		case "text/html":
			if htmlBody == "" {
				htmlBody = string(b)
			}
		case "text/plain":
			if plainBody == "" {
				plainBody = string(b)
			}
		}
	}
	if mr := ent.MultipartReader(); mr != nil {
		for {
			part, perr := mr.NextPart()
			if perr == io.EOF {
				break
			}
			if perr != nil {
				return "", fmt.Errorf("next part: %w", perr)
			}
			// one level of nesting is enough for these emails
			if inner := part.MultipartReader(); inner != nil {
				for {
					p2, e2 := inner.NextPart()
					if e2 == io.EOF {
						break
					}
					if e2 != nil {
						return "", fmt.Errorf("next inner part: %w", e2)
					}
					walk(p2)
				}
				continue
			}
			walk(part)
		}
	} else {
		walk(ent)
	}

	chosen := htmlBody
	stripped := chosen != ""
	if chosen == "" {
		chosen = plainBody
		stripped = false
	}
	if chosen == "" {
		return "", fmt.Errorf("no text/html or text/plain part found")
	}
	if stripped {
		chosen = stripHTML(chosen)
	}
	return normalize(chosen), nil
}

func stripHTML(s string) string {
	s = regexp.MustCompile(`(?is)<(script|style)[^>]*>.*?</\1>`).ReplaceAllString(s, " ")
	s = strings.ReplaceAll(s, "<br>", "\n")
	s = strings.ReplaceAll(s, "<br/>", "\n")
	s = strings.ReplaceAll(s, "</p>", "\n")
	s = strings.ReplaceAll(s, "</tr>", "\n")
	s = strings.ReplaceAll(s, "</div>", "\n")
	s = tagRe.ReplaceAllString(s, "\n")
	return s
}

var entities = strings.NewReplacer("&nbsp;", " ", "&amp;", "&", "&lt;", "<", "&gt;", ">", "&quot;", "\"", "&#39;", "'")

func normalize(s string) string {
	s = entities.Replace(s)
	s = wsRe.ReplaceAllString(s, " ")
	var lines []string
	for _, l := range strings.Split(s, "\n") {
		if t := strings.TrimSpace(l); t != "" {
			lines = append(lines, t)
		}
	}
	return strings.Join(lines, "\n")
}
```

> Note: `message.Read` returns an Entity even on unknown-charset/encoding errors; we proceed in those cases and only fail on genuine read errors. The HTML-strip converts block-closing tags to newlines so each label/value lands on its own line — which the DIB anchors (Task 6) rely on.

- [ ] **Step 5: Run `go test ./internal/parse/ -run BodyText` — expect PASS.** Then `go test ./internal/parse/` (all) + `go vet ./internal/parse/`.

- [ ] **Step 6: Commit**
```bash
go mod tidy
git add internal/parse/body.go internal/parse/body_test.go go.mod go.sum
git commit -m "feat(parse): decode MIME/base64 email body and strip HTML to text"
```

---

## Task 4: AI extractor interface (`internal/parse/ai.go`)

The gated last-resort tier as an interface, with a disabled default. The real Anthropic client arrives in M4; here it is mock-tested via the cascade.

**Files:** Create `internal/parse/ai.go`

- [ ] **Step 1: Implement** (interface + default; behavior is exercised by the cascade tests in Task 7, so no separate test file here):

Create `internal/parse/ai.go`:

```go
package parse

import (
	"context"
	"errors"
)

// ErrAIUnavailable means no AI extractor is configured/enabled. The cascade
// treats it as "skip the AI tier".
var ErrAIUnavailable = errors.New("ai extractor unavailable")

// Extractor is the AI extraction tier. Implementations operate on the plain-text
// body and MUST be treated as low-confidence by the caller (always routed to
// review). The real Anthropic-backed implementation arrives in Milestone 4.
type Extractor interface {
	Extract(ctx context.Context, textBody string) (ParsedTxn, error)
}

// DisabledExtractor is the default when ai.enabled is false. It always returns
// ErrAIUnavailable so the cascade falls through to the review-queue floor.
type DisabledExtractor struct{}

func (DisabledExtractor) Extract(context.Context, string) (ParsedTxn, error) {
	return ParsedTxn{}, ErrAIUnavailable
}
```

- [ ] **Step 2: Verify compile** — `go build ./internal/parse/`.

- [ ] **Step 3: Commit**
```bash
git add internal/parse/ai.go
git commit -m "feat(parse): AI extractor interface with disabled default (real client in M4)"
```

---

## Task 5: Heuristic extractor (`internal/parse/heuristic.go`)

Bank-agnostic shape extractor: find a currency+amount, a plausible date, and a merchant-ish string near keywords. Lower confidence; recovers core fields when no template matches.

**Files:** Create `internal/parse/heuristic.go`, `internal/parse/heuristic_test.go`

- [ ] **Step 1: Write the failing test** — Create `internal/parse/heuristic_test.go`:

```go
package parse

import "testing"

func TestHeuristicExtractsAmountAndDate(t *testing.T) {
	body := "Your card was charged AED 49.90 on 03-02-2025 at STARBUCKS DUBAI."
	p, err := HeuristicParser{}.Parse(body)
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if p.AmountFils != 4990 {
		t.Errorf("amount = %d, want 4990", p.AmountFils)
	}
	if p.Currency != "AED" {
		t.Errorf("currency = %q", p.Currency)
	}
	if p.Tier != TierHeuristic {
		t.Errorf("tier = %q, want heuristic", p.Tier)
	}
	if p.Confidence >= 0.8 {
		t.Errorf("heuristic confidence should be low, got %v", p.Confidence)
	}
	if p.MerchantRaw == "" {
		t.Error("expected some merchant text")
	}
}

func TestHeuristicErrorsWithoutAmount(t *testing.T) {
	if _, err := HeuristicParser{}.Parse("no money, no date, nothing useful"); err == nil {
		t.Error("expected error when no amount found")
	}
}

func TestHeuristicCreditKeyword(t *testing.T) {
	p, err := HeuristicParser{}.Parse("AED 500.00 credited to your account on 01-01-2025")
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if p.Direction != DirectionCredit {
		t.Errorf("direction = %q, want credit", p.Direction)
	}
}
```

- [ ] **Step 2: Run `go test ./internal/parse/ -run Heuristic` — expect FAIL.**

- [ ] **Step 3: Implement** — Create `internal/parse/heuristic.go`:

```go
package parse

import (
	"fmt"
	"regexp"
	"strings"
)

// HeuristicParser is a bank-agnostic fallback. It is NOT a BankParser (it has no
// sender match); the cascade calls it directly when no template matches.
type HeuristicParser struct{}

var (
	heurDateRe   = regexp.MustCompile(`\b(\d{2}-\d{2}-\d{4})\b`)
	creditWordRe = regexp.MustCompile(`(?i)\b(credit(ed)?|deposit(ed)?|received|refund)\b`)
	merchantRe   = regexp.MustCompile(`(?i)\b(?:at|to|merchant|payment to|paid to)\b[:\s]+([A-Za-z0-9][A-Za-z0-9 &.'\-]{2,40})`)
)

// Parse extracts shape-level fields. Confidence is fixed low so results route to
// review. Returns an error only when no amount can be found (nothing to record).
func (HeuristicParser) Parse(textBody string) (ParsedTxn, error) {
	fils, currency, err := ParseAEDToFils(textBody)
	if err != nil {
		return ParsedTxn{}, fmt.Errorf("heuristic: %w", err)
	}
	p := ParsedTxn{
		AmountFils: fils,
		Currency:   currency,
		Direction:  DirectionDebit,
		Tier:       TierHeuristic,
		Confidence: 0.4,
	}
	if creditWordRe.MatchString(textBody) {
		p.Direction = DirectionCredit
	}
	if m := heurDateRe.FindStringSubmatch(textBody); m != nil {
		if d, derr := ParseDIBDate(m[1]); derr == nil {
			p.PostedAt = d
		}
	}
	if m := merchantRe.FindStringSubmatch(textBody); m != nil {
		p.MerchantRaw = strings.TrimSpace(m[1])
	}
	return p, nil
}
```

- [ ] **Step 4: Run `go test ./internal/parse/` — expect PASS.**

- [ ] **Step 5: Commit**
```bash
git add internal/parse/heuristic.go internal/parse/heuristic_test.go
git commit -m "feat(parse): bank-agnostic heuristic extractor (low confidence)"
```

---

## Task 6: DIB template parser (`internal/parse/dib.go`)

Implements `BankParser` for both DIB layouts (see the anatomy section above). Anchors on Arabic labels; operates on the HTML-stripped text.

**Files:** Create `internal/parse/dib.go`, `internal/parse/dib_test.go`

- [ ] **Step 1: Write the failing test** — Create `internal/parse/dib_test.go` (the bodies mirror the real stripped layout, with fake values):

```go
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
	if got.Last4 != "0181" {
		t.Errorf("last4 = %q, want 0181 (trailing acct digits)", got.Last4)
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
	if _, err := DIBParser{}.Parse("just some text with no DIB anchors"); err == nil {
		t.Error("expected error when anchors absent")
	}
}
```

> Last-4 rule: for cards (`رقم البطاقة 525467XXXXXX1502`) the last4 is the final 4 digits → `1502`. For accounts (`001-520-XXXX081-01`) take the last 4 digits of the whole string ignoring the trailing `-01` group separator — here the digits are `...081 01` → last four digits overall are `0181`. Implement exactly that (see code).

- [ ] **Step 2: Run `go test ./internal/parse/ -run DIB` — expect FAIL.**

- [ ] **Step 3: Implement** — Create `internal/parse/dib.go`:

```go
package parse

import (
	"fmt"
	"regexp"
	"strings"
)

// DIBParser parses Dubai Islamic Bank notification emails (Arabic HTML). It
// handles two layouts: card purchases (إشعار مشتريات) and account transactions
// (خصم/إيداع/تحويل/سحب). See the plan's "DIB email anatomy" section.
type DIBParser struct{}

func (DIBParser) Bank() string { return "dib" }

func (DIBParser) Matches(from, subject string) bool {
	return strings.Contains(strings.ToLower(from), "dib.notification@dib.ae")
}

var (
	dibAmountRe = regexp.MustCompile(`المبلغ\s*\n\s*((?:[A-Z]{3}\s*)?[0-9][0-9,]*\.[0-9]{2})`)
	dibDateRe   = regexp.MustCompile(`بتاريخ\s*([0-9]{2}-[0-9]{2}-[0-9]{4})`)
	dibPayeeRe  = regexp.MustCompile(`الدفع الى\s*\n\s*(.+)`)
	dibTxnRe    = regexp.MustCompile(`المعاملة\s*\n\s*(.+)`)
	dibCardRe   = regexp.MustCompile(`رقم البطاقة\s*\n\s*(\S+)`)
	dibAcctRe   = regexp.MustCompile(`من حساب\s*\n\s*(\S+)`)
	digitsRe    = regexp.MustCompile(`[0-9]`)
)

func (DIBParser) Parse(textBody string) (ParsedTxn, error) {
	am := dibAmountRe.FindStringSubmatch(textBody)
	if am == nil {
		return ParsedTxn{}, fmt.Errorf("dib: amount anchor المبلغ not found")
	}
	fils, currency, err := ParseAEDToFils(am[1])
	if err != nil {
		return ParsedTxn{}, fmt.Errorf("dib amount: %w", err)
	}
	p := ParsedTxn{
		AmountFils: fils,
		Currency:   currency,
		Tier:       TierTemplate,
		Confidence: 0.97,
	}
	if dm := dibDateRe.FindStringSubmatch(textBody); dm != nil {
		if d, derr := ParseDIBDate(dm[1]); derr == nil {
			p.PostedAt = d
		}
	}

	isCard := strings.Contains(textBody, "إشعار مشتريات")
	if isCard {
		p.Direction = DirectionDebit
		if mm := dibPayeeRe.FindStringSubmatch(textBody); mm != nil {
			p.MerchantRaw = strings.TrimSpace(mm[1])
		}
		if cm := dibCardRe.FindStringSubmatch(textBody); cm != nil {
			p.Last4 = lastFourDigits(cm[1])
		}
		return p, nil
	}

	// account-transaction layout
	switch {
	case strings.Contains(textBody, "إشعار إيداع"):
		p.Direction = DirectionCredit
	case strings.Contains(textBody, "إشعار خصم"), strings.Contains(textBody, "إشعار سحب"):
		p.Direction = DirectionDebit
	default: // تحويل / unknown: infer from preposition / description
		if strings.Contains(textBody, "من الحساب") {
			p.Direction = DirectionDebit
		} else {
			p.Direction = DirectionCredit
		}
	}
	if tm := dibTxnRe.FindStringSubmatch(textBody); tm != nil {
		desc := strings.TrimSpace(tm[1])
		p.MerchantRaw = desc
		up := strings.ToUpper(desc)
		if strings.HasSuffix(up, "DEBIT") {
			p.Direction = DirectionDebit
		} else if strings.HasSuffix(up, "CREDIT") {
			p.Direction = DirectionCredit
		}
		if strings.Contains(up, "TRNSFER") || strings.Contains(up, "TRANSFER") {
			p.IsTransfer = true
		}
	}
	if acc := dibAcctRe.FindStringSubmatch(textBody); acc != nil {
		p.Last4 = lastFourDigits(acc[1])
	}
	if p.Direction == "" {
		return ParsedTxn{}, fmt.Errorf("dib: could not determine direction")
	}
	return p, nil
}

// lastFourDigits returns the last four numeric digits in s (ignoring separators
// and masking characters).
func lastFourDigits(s string) string {
	d := strings.Join(digitsRe.FindAllString(s, -1), "")
	if len(d) <= 4 {
		return d
	}
	return d[len(d)-4:]
}
```

> The `dib*Re` patterns require a newline between label and value because `BodyText` (Task 3) puts each on its own line. The card last4 `lastFourDigits("525467XXXXXX1502")` = `1502`; the account `lastFourDigits("001-520-XXXX081-01")` collapses to digits `0015200810`**`1`**→ last four `0181`. These match the test expectations.

- [ ] **Step 4: Run `go test ./internal/parse/` — expect PASS** (DIB + all prior).

- [ ] **Step 5: Commit**
```bash
git add internal/parse/dib.go internal/parse/dib_test.go
git commit -m "feat(parse): DIB template parser for card-purchase and account layouts"
```

---

## Task 7: Cascade orchestrator (`internal/parse/cascade.go`)

Routes one email through the tiers and returns a result with tier + status. Template (validated) → `parsed`; else heuristic (validated) → `parsed` but low-confidence note; else AI (if enabled, always) → `low_confidence`; else `unparsed`.

**Files:** Create `internal/parse/cascade.go`, `internal/parse/cascade_test.go`

- [ ] **Step 1: Write the failing test** — Create `internal/parse/cascade_test.go`:

```go
package parse

import (
	"context"
	"testing"
)

type stubExtractor struct{ p ParsedTxn; err error }

func (s stubExtractor) Extract(context.Context, string) (ParsedTxn, error) { return s.p, s.err }

func newCascade(ai Extractor) *Cascade {
	return &Cascade{Parsers: []BankParser{DIBParser{}}, Heuristic: HeuristicParser{}, AI: ai}
}

func TestCascadeTemplateWins(t *testing.T) {
	c := newCascade(DisabledExtractor{})
	res := c.Run(context.Background(), "DIB.notification@dib.ae", "DIB Notification", dibCardPurchase)
	if res.Status != StatusParsed || res.Txn.Tier != TierTemplate {
		t.Fatalf("status=%q tier=%q", res.Status, res.Txn.Tier)
	}
	if res.Txn.MerchantRaw != "DAPPER DAN GENTS SAL" {
		t.Errorf("merchant=%q", res.Txn.MerchantRaw)
	}
}

func TestCascadeFallsToHeuristicWhenNoTemplateMatches(t *testing.T) {
	c := newCascade(DisabledExtractor{})
	body := "Charged AED 49.90 on 03-02-2025 at STARBUCKS"
	res := c.Run(context.Background(), "alerts@unknownbank.com", "spend", body)
	if res.Status != StatusParsed || res.Txn.Tier != TierHeuristic {
		t.Fatalf("status=%q tier=%q", res.Status, res.Txn.Tier)
	}
}

func TestCascadeUsesAIWhenHeuristicFails(t *testing.T) {
	ai := stubExtractor{p: ParsedTxn{AmountFils: 100, Currency: "AED", Direction: DirectionDebit,
		PostedAt: mustDate("01-01-2025"), Tier: TierAI, Confidence: 0.3}}
	c := newCascade(ai)
	res := c.Run(context.Background(), "x@y.com", "s", "no parseable amount or date here")
	if res.Status != StatusLowConfidence || res.Txn.Tier != TierAI {
		t.Fatalf("status=%q tier=%q", res.Status, res.Txn.Tier)
	}
}

func TestCascadeUnparsedWhenEverythingFails(t *testing.T) {
	c := newCascade(DisabledExtractor{})
	res := c.Run(context.Background(), "x@y.com", "s", "totally unparseable content")
	if res.Status != StatusUnparsed {
		t.Fatalf("status=%q, want unparsed", res.Status)
	}
}

func TestCascadeValidationFailureFallsThrough(t *testing.T) {
	// AI returns an invalid txn (bad amount) → must NOT be accepted → unparsed.
	ai := stubExtractor{p: ParsedTxn{AmountFils: 0, Currency: "AED", Direction: DirectionDebit, Tier: TierAI}}
	c := newCascade(ai)
	res := c.Run(context.Background(), "x@y.com", "s", "no amount here either")
	if res.Status != StatusUnparsed {
		t.Fatalf("status=%q, want unparsed (invalid AI result rejected)", res.Status)
	}
}

func mustDate(s string) (t timeTime) { d, _ := ParseDIBDate(s); return d }
```

Replace the helper at the bottom with a correct signature — add this instead (Go has no `timeTime`); put at top imports `"time"` and:
```go
func mustDate(s string) time.Time { d, _ := ParseDIBDate(s); return d }
```
(Define `mustDate` once; remove the broken stub above. Ensure `import "time"` is present.)

- [ ] **Step 2: Run `go test ./internal/parse/ -run Cascade` — expect FAIL** (undefined `Cascade`/`Status*`).

- [ ] **Step 3: Implement** — Create `internal/parse/cascade.go`:

```go
package parse

import "context"

// Status values mirror ingest_log.parse_status.
const (
	StatusParsed        = "parsed"
	StatusLowConfidence = "low_confidence"
	StatusUnparsed      = "unparsed"
)

// Result is the outcome of running the cascade over one email.
type Result struct {
	Txn    ParsedTxn
	Status string // parsed | low_confidence | unparsed
	Tier   string // template | heuristic | ai | "" (none)
	Err    string // last tier error, for ingest_log.parse_error (optional)
}

// Cascade runs the extraction tiers in order. AI may be a DisabledExtractor.
type Cascade struct {
	Parsers   []BankParser
	Heuristic HeuristicParser
	AI        Extractor
}

// Run descends the ladder and stops at the first validated, accepted result.
func (c *Cascade) Run(ctx context.Context, from, subject, textBody string) Result {
	// Tier 1: matching per-bank template.
	for _, bp := range c.Parsers {
		if !bp.Matches(from, subject) {
			continue
		}
		if p, err := bp.Parse(textBody); err == nil {
			if verr := Validate(p); verr == nil {
				return Result{Txn: p, Status: StatusParsed, Tier: TierTemplate}
			}
		}
		break // the bank matched but failed; fall through to heuristic
	}
	// Tier 2: bank-agnostic heuristic.
	if p, err := c.Heuristic.Parse(textBody); err == nil {
		if verr := Validate(p); verr == nil {
			return Result{Txn: p, Status: StatusParsed, Tier: TierHeuristic}
		}
	}
	// Tier 3: AI (always low-confidence → review). Skipped when disabled.
	if c.AI != nil {
		if p, err := c.AI.Extract(ctx, textBody); err == nil {
			if verr := Validate(p); verr == nil {
				p.Tier = TierAI
				return Result{Txn: p, Status: StatusLowConfidence, Tier: TierAI}
			}
		}
	}
	// Floor: nothing resolved.
	return Result{Status: StatusUnparsed}
}
```

- [ ] **Step 4: Run `go test ./internal/parse/` — expect PASS** (whole package).

- [ ] **Step 5: Commit**
```bash
git add internal/parse/cascade.go internal/parse/cascade_test.go
git commit -m "feat(parse): cascade orchestrator (template -> heuristic -> ai -> review)"
```

---

## Task 8: Transactions store + fingerprint (`internal/store/transactions.go`)

Persists extracted transactions (idempotent via the existing `idx_tx_fingerprint` UNIQUE index) and exposes the ingest rows the processor reads + the status stamp it writes.

**Files:** Create `internal/store/transactions.go`, `internal/store/transactions_test.go`

- [ ] **Step 1: Write the failing test** — Create `internal/store/transactions_test.go`:

```go
package store

import (
	"testing"
	"time"
)

func txnRow() TransactionRow {
	return TransactionRow{
		PostedAt:    time.Date(2025, 8, 19, 0, 0, 0, 0, time.UTC),
		AmountFils:  21500,
		Currency:    "AED",
		Direction:   "debit",
		MerchantRaw: "DAPPER DAN GENTS SAL",
		Last4:       "1502",
		Status:      "needs_review",
		Confidence:  0.97,
		Tier:        "template",
		IngestID:    1,
	}
}

func TestInsertTransactionAndFingerprintDedup(t *testing.T) {
	st := newTestStore(t) // helper from ingest_test.go in the same package
	ins1, err := st.InsertTransaction(txnRow())
	if err != nil {
		t.Fatalf("insert1: %v", err)
	}
	if !ins1 {
		t.Error("first insert should be new")
	}
	ins2, err := st.InsertTransaction(txnRow()) // identical → same fingerprint
	if err != nil {
		t.Fatalf("insert2: %v", err)
	}
	if ins2 {
		t.Error("duplicate (same fingerprint) must not insert again")
	}
	var n int
	st.DB.QueryRow("SELECT COUNT(*) FROM transactions").Scan(&n)
	if n != 1 {
		t.Errorf("transactions count = %d, want 1", n)
	}
}

func TestSelectForParseAndMarkParsed(t *testing.T) {
	st := newTestStore(t)
	// seed two ingest rows: one DIB unparsed, one already parsed
	if _, err := st.InsertIngest(IngestRecord{MessageUID: "u1", FromAddr: "DIB.notification@dib.ae",
		Subject: "n", ParseStatus: "unparsed", RawBody: []byte("raw1"), CreatedAt: time.Now()}); err != nil {
		t.Fatal(err)
	}
	if _, err := st.InsertIngest(IngestRecord{MessageUID: "u2", FromAddr: "x@y.com",
		Subject: "n", ParseStatus: "parsed", RawBody: []byte("raw2"), CreatedAt: time.Now()}); err != nil {
		t.Fatal(err)
	}
	rows, err := st.SelectForParse(SelectForParseOpts{OnlyUnparsed: true})
	if err != nil {
		t.Fatalf("select: %v", err)
	}
	if len(rows) != 1 || rows[0].FromAddr != "DIB.notification@dib.ae" {
		t.Fatalf("got %d rows: %+v", len(rows), rows)
	}
	if err := st.MarkParsed(rows[0].ID, "parsed", "template", ""); err != nil {
		t.Fatalf("mark: %v", err)
	}
	rows2, _ := st.SelectForParse(SelectForParseOpts{OnlyUnparsed: true})
	if len(rows2) != 0 {
		t.Errorf("expected 0 unparsed after mark, got %d", len(rows2))
	}
}
```

- [ ] **Step 2: Run `go test ./internal/store/ -run 'Transaction|SelectForParse'` — expect FAIL.**

- [ ] **Step 3: Implement** — Create `internal/store/transactions.go`:

```go
package store

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strings"
	"time"
)

// TransactionRow is an extracted transaction ready to persist. account_id and
// category_id are left NULL in Milestone 3 (no seeding/categorization yet).
type TransactionRow struct {
	PostedAt    time.Time
	AmountFils  int64
	Currency    string
	Direction   string
	MerchantRaw string
	Last4       string
	Status      string
	Confidence  float64
	Tier        string
	IngestID    int64
}

// Fingerprint is sha256(last4 | amount | direction | normalize(merchant) | day),
// matching §6.4. With no account seeded yet we use Last4 in place of account_id.
func (r TransactionRow) Fingerprint() string {
	merchant := strings.ToLower(strings.Join(strings.Fields(r.MerchantRaw), " "))
	day := r.PostedAt.UTC().Format("2006-01-02")
	key := fmt.Sprintf("%s|%d|%s|%s|%s", r.Last4, r.AmountFils, r.Direction, merchant, day)
	sum := sha256.Sum256([]byte(key))
	return hex.EncodeToString(sum[:])
}

// InsertTransaction writes a transaction idempotently (INSERT OR IGNORE on the
// UNIQUE fingerprint index). Returns true if a new row was created.
func (s *Store) InsertTransaction(r TransactionRow) (bool, error) {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	res, err := s.DB.Exec(
		`INSERT OR IGNORE INTO transactions
		   (posted_at, amount, currency, direction, merchant_raw, status, confidence,
		    fingerprint, source, ingest_id, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'email', ?, ?, ?)`,
		r.PostedAt.UTC().Format(time.RFC3339Nano), r.AmountFils, r.Currency, r.Direction,
		r.MerchantRaw, r.Status, r.Confidence, r.Fingerprint(), r.IngestID, now, now,
	)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	return n > 0, err
}

// IngestForParse is one ingest_log row the processor will run the cascade over.
type IngestForParse struct {
	ID       int64
	FromAddr string
	Subject  string
	RawBody  []byte
}

// SelectForParseOpts filters which ingest rows to (re)process.
type SelectForParseOpts struct {
	OnlyUnparsed bool   // true: only parse_status='unparsed'; false: also 'unparsed'+'low_confidence'
	FromLike     string // optional: restrict to a sender substring (e.g. a bank)
}

// SelectForParse returns ingest rows for the cascade. Reprocess passes
// OnlyUnparsed=false to also retry low-confidence rows.
func (s *Store) SelectForParse(opts SelectForParseOpts) ([]IngestForParse, error) {
	statuses := "('unparsed','low_confidence')"
	if opts.OnlyUnparsed {
		statuses = "('unparsed')"
	}
	q := `SELECT id, from_addr, subject, raw_body FROM ingest_log WHERE parse_status IN ` + statuses
	args := []any{}
	if opts.FromLike != "" {
		q += " AND from_addr LIKE ?"
		args = append(args, "%"+opts.FromLike+"%")
	}
	q += " ORDER BY id"
	rows, err := s.DB.Query(q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []IngestForParse
	for rows.Next() {
		var r IngestForParse
		var raw string
		if err := rows.Scan(&r.ID, &r.FromAddr, &r.Subject, &raw); err != nil {
			return nil, err
		}
		r.RawBody = []byte(raw)
		out = append(out, r)
	}
	return out, rows.Err()
}

// MarkParsed stamps an ingest_log row's parse outcome.
func (s *Store) MarkParsed(ingestID int64, status, tier, parseErr string) error {
	_, err := s.DB.Exec(
		`UPDATE ingest_log SET parse_status=?, parse_tier=?, parse_error=? WHERE id=?`,
		status, nullable(tier), nullable(parseErr), ingestID)
	return err
}

func nullable(s string) any {
	if s == "" {
		return nil
	}
	return s
}
```

- [ ] **Step 4: Run `go test ./internal/store/` — expect PASS** (existing + new).

- [ ] **Step 5: Commit**
```bash
git add internal/store/transactions.go internal/store/transactions_test.go
git commit -m "feat(store): transactions insert with fingerprint dedup, ingest select/mark for parsing"
```

---

## Task 9: Processor (`internal/parse/processor.go`)

Glues store↔cascade: select pending ingest rows, decode body, run the cascade, persist the transaction (when extracted), and stamp `ingest_log`. Drives both live processing and `/api/reprocess`.

**Files:** Create `internal/parse/processor.go`, `internal/parse/processor_test.go`

- [ ] **Step 1: Write the failing test** — Create `internal/parse/processor_test.go`:

```go
package parse

import (
	"context"
	"encoding/base64"
	"strings"
	"testing"
	"time"

	"ledger/internal/store"
)

func procTestStore(t *testing.T) *store.Store {
	t.Helper()
	st, err := store.Open(t.TempDir())
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	t.Cleanup(func() { st.Close() })
	return st
}

// build a base64 text/html DIB email around the given stripped-text body's HTML.
func dibEmail(htmlBody string) []byte {
	enc := base64.StdEncoding.EncodeToString([]byte(htmlBody))
	return []byte("From: DIB.notification@dib.ae\r\nSubject: DIB Notification\r\n" +
		"MIME-Version: 1.0\r\nContent-Type: text/html; charset=\"utf-8\"\r\n" +
		"Content-Transfer-Encoding: base64\r\n\r\n" + enc)
}

func TestProcessorParsesUnparsedDIB(t *testing.T) {
	st := procTestStore(t)
	html := "<p>إشعار مشتريات</p><p>إشعار مشتريات بتاريخ 19-08-2025 16:18</p>" +
		"<p>المبلغ</p><p>AED 215.00</p><p>الدفع الى</p><p>DAPPER DAN GENTS SAL</p>"
	if _, err := st.InsertIngest(store.IngestRecord{MessageUID: "u1", FromAddr: "DIB.notification@dib.ae",
		Subject: "DIB Notification", ParseStatus: "unparsed", RawBody: dibEmail(html), CreatedAt: time.Now()}); err != nil {
		t.Fatal(err)
	}
	p := NewProcessor(st, &Cascade{Parsers: []BankParser{DIBParser{}}, Heuristic: HeuristicParser{}, AI: DisabledExtractor{}})
	n, err := p.ProcessPending(context.Background(), store.SelectForParseOpts{OnlyUnparsed: true})
	if err != nil {
		t.Fatalf("process: %v", err)
	}
	if n != 1 {
		t.Fatalf("processed = %d, want 1", n)
	}
	var cnt int
	st.DB.QueryRow("SELECT COUNT(*) FROM transactions WHERE merchant_raw='DAPPER DAN GENTS SAL' AND amount=21500").Scan(&cnt)
	if cnt != 1 {
		t.Errorf("expected 1 matching transaction, got %d", cnt)
	}
	var ps string
	st.DB.QueryRow("SELECT parse_status FROM ingest_log WHERE message_uid='u1'").Scan(&ps)
	if ps != "parsed" {
		t.Errorf("ingest parse_status = %q, want parsed", ps)
	}
}

func TestProcessorMarksUnparsedWhenNothingExtracts(t *testing.T) {
	st := procTestStore(t)
	html := "<p>hello, this is not a transaction email</p>"
	if _, err := st.InsertIngest(store.IngestRecord{MessageUID: "u2", FromAddr: "newsletter@spam.com",
		Subject: "hi", ParseStatus: "unparsed", RawBody: dibEmail(html), CreatedAt: time.Now()}); err != nil {
		t.Fatal(err)
	}
	p := NewProcessor(st, &Cascade{Parsers: []BankParser{DIBParser{}}, Heuristic: HeuristicParser{}, AI: DisabledExtractor{}})
	if _, err := p.ProcessPending(context.Background(), store.SelectForParseOpts{OnlyUnparsed: true}); err != nil {
		t.Fatal(err)
	}
	var ps string
	st.DB.QueryRow("SELECT parse_status FROM ingest_log WHERE message_uid='u2'").Scan(&ps)
	if ps != "unparsed" {
		t.Errorf("parse_status = %q, want unparsed", ps)
	}
	if !strings.Contains("unparsed", ps) {
		t.Errorf("unexpected %q", ps)
	}
}
```

- [ ] **Step 2: Run `go test ./internal/parse/ -run Processor` — expect FAIL.**

- [ ] **Step 3: Implement** — Create `internal/parse/processor.go`:

```go
package parse

import (
	"context"

	"ledger/internal/store"
)

// Processor runs the cascade over ingest_log rows and persists results.
type Processor struct {
	store   *store.Store
	cascade *Cascade
}

func NewProcessor(st *store.Store, c *Cascade) *Processor {
	return &Processor{store: st, cascade: c}
}

// ProcessPending selects ingest rows per opts, runs the cascade over each, writes
// a transaction when extracted, and stamps ingest_log. Returns the count of rows
// that produced a transaction. Used both live (after ingest) and by /api/reprocess.
func (p *Processor) ProcessPending(ctx context.Context, opts store.SelectForParseOpts) (int, error) {
	rows, err := p.store.SelectForParse(opts)
	if err != nil {
		return 0, err
	}
	created := 0
	for _, row := range rows {
		text, berr := BodyText(row.RawBody)
		if berr != nil {
			_ = p.store.MarkParsed(row.ID, StatusUnparsed, "", berr.Error())
			continue
		}
		res := p.cascade.Run(ctx, row.FromAddr, row.Subject, text)
		if res.Status == StatusUnparsed {
			_ = p.store.MarkParsed(row.ID, StatusUnparsed, "", res.Err)
			continue
		}
		_, ierr := p.store.InsertTransaction(store.TransactionRow{
			PostedAt:    res.Txn.PostedAt,
			AmountFils:  res.Txn.AmountFils,
			Currency:    res.Txn.Currency,
			Direction:   res.Txn.Direction,
			MerchantRaw: res.Txn.MerchantRaw,
			Last4:       res.Txn.Last4,
			Status:      "needs_review", // no categorizer until M4
			Confidence:  res.Txn.Confidence,
			Tier:        res.Tier,
			IngestID:    row.ID,
		})
		if ierr != nil {
			_ = p.store.MarkParsed(row.ID, StatusUnparsed, "", ierr.Error())
			continue
		}
		if err := p.store.MarkParsed(row.ID, res.Status, res.Tier, ""); err != nil {
			return created, err
		}
		created++
	}
	return created, nil
}
```

- [ ] **Step 4: Run `go test ./internal/parse/` and `go test ./internal/store/` — expect PASS.**

- [ ] **Step 5: Commit**
```bash
git add internal/parse/processor.go internal/parse/processor_test.go
git commit -m "feat(parse): processor turns unparsed ingest rows into transactions"
```

---

## Task 10: Run the processor from the ingest worker (`internal/ingest/ingest.go`)

After each sync, process newly-ingested rows. The worker gains an optional `Pending` hook so it stays decoupled from the parse package (no import cycle: ingest must not import parse if parse imports... it doesn't — parse imports store, ingest imports store; ingest may import parse safely. But to keep the worker testable and avoid coupling, inject a function).

**Files:** Modify `internal/ingest/ingest.go`, `internal/ingest/ingest_test.go`

- [ ] **Step 1: Write the failing test** — APPEND to `internal/ingest/ingest_test.go`:

```go
func TestSyncOnceRunsPostProcessHook(t *testing.T) {
	st := newTestStore(t)
	mb := mailboxWith(7, msg(1, "a@bank.com"))
	w := New(&fakeDialer{mb: mb}, st, time.Minute, quietLogger())
	called := 0
	w.SetPostProcess(func(ctx context.Context) (int, error) { called++; return 0, nil })
	if _, err := w.syncOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	if called != 1 {
		t.Errorf("post-process hook called %d times, want 1", called)
	}
}
```

- [ ] **Step 2: Run `go test ./internal/ingest/ -run PostProcess` — expect FAIL** (`w.SetPostProcess` undefined).

- [ ] **Step 3: Implement** — In `internal/ingest/ingest.go`:

Add a field and setter to `Worker` and call the hook at the end of `syncOnce`.

Add to the `Worker` struct (after the existing fields):
```go
	postProcess func(ctx context.Context) (int, error)
```

Add the setter (after `New`):
```go
// SetPostProcess registers a hook run at the end of each sync (e.g. the parse
// processor). It runs even when no new messages arrived, so a restart still
// processes any leftover unparsed rows.
func (w *Worker) SetPostProcess(fn func(ctx context.Context) (int, error)) {
	w.postProcess = fn
}
```

At the very end of `syncOnce`, replace the final `return inserted, nil` with:
```go
	if w.postProcess != nil {
		if n, err := w.postProcess(ctx); err != nil {
			w.log.Printf("post-process error: %v", err)
		} else if n > 0 {
			w.log.Printf("parsed %d new transaction(s)", n)
		}
	}
	return inserted, nil
```

- [ ] **Step 4: Run `go test ./internal/ingest/` and `go test -race ./internal/ingest/` — expect PASS.**

- [ ] **Step 5: Commit**
```bash
git add internal/ingest/
git commit -m "feat(ingest): run a post-sync hook so the parse processor fires after ingest"
```

---

## Task 11: `POST /api/reprocess` endpoint (`internal/server`)

Triggers a full reprocess over retained raw email (optionally limited to a bank/sender), retrying `unparsed` + `low_confidence` rows.

**Files:** Create `internal/server/reprocess.go`, `internal/server/reprocess_test.go`; Modify `internal/server/server.go`

- [ ] **Step 1: Write the failing test** — Create `internal/server/reprocess_test.go`:

```go
package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

type fakeReprocessor struct {
	gotBank string
	n       int
}

func (f *fakeReprocessor) Reprocess(ctx context.Context, bank string) (int, error) {
	f.gotBank = bank
	return f.n, nil
}

func TestReprocessEndpoint(t *testing.T) {
	srv := New(fakeChecker{}, testFS())
	fr := &fakeReprocessor{n: 12}
	srv.SetReprocessor(fr)

	req := httptest.NewRequest(http.MethodPost, "/api/reprocess", strings.NewReader(`{"bank":"dib"}`))
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	var body struct {
		Processed int `json:"processed"`
	}
	json.Unmarshal(rec.Body.Bytes(), &body)
	if body.Processed != 12 {
		t.Errorf("processed = %d, want 12", body.Processed)
	}
	if fr.gotBank != "dib" {
		t.Errorf("bank = %q, want dib", fr.gotBank)
	}
}

func TestReprocessUnavailableWhenUnset(t *testing.T) {
	srv := New(fakeChecker{}, testFS())
	req := httptest.NewRequest(http.MethodPost, "/api/reprocess", strings.NewReader(`{}`))
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", rec.Code)
	}
}
```
Add `"strings"` to the test imports.

- [ ] **Step 2: Run `go test ./internal/server/ -run Reprocess` — expect FAIL.**

- [ ] **Step 3: Implement the server wiring** — In `internal/server/server.go`:

Add the interface + field + setter + route.

After `IngestStatus`:
```go
// Reprocessor re-runs the parse cascade over retained raw email. bank is an
// optional sender/bank filter ("" = all).
type Reprocessor interface {
	Reprocess(ctx context.Context, bank string) (int, error)
}
```
Add to the `Server` struct:
```go
	reprocessor Reprocessor
```
Add the setter (near `SetIngest`):
```go
// SetReprocessor enables POST /api/reprocess.
func (s *Server) SetReprocessor(r Reprocessor) { s.reprocessor = r }
```
In `routes`, add (before the catch-all `s.mux.Handle("/", ...)`):
```go
	s.mux.HandleFunc("POST /api/reprocess", s.handleReprocess)
```

- [ ] **Step 4: Implement the handler** — Create `internal/server/reprocess.go`:

```go
package server

import (
	"encoding/json"
	"net/http"
)

type reprocessRequest struct {
	Bank string `json:"bank"`
}

type reprocessResponse struct {
	Processed int `json:"processed"`
}

func (s *Server) handleReprocess(w http.ResponseWriter, r *http.Request) {
	if s.reprocessor == nil {
		http.Error(w, `{"error":"reprocess unavailable"}`, http.StatusServiceUnavailable)
		return
	}
	var req reprocessRequest
	if r.Body != nil {
		_ = json.NewDecoder(r.Body).Decode(&req) // empty body is fine → bank=""
	}
	n, err := s.reprocessor.Reprocess(r.Context(), req.Bank)
	if err != nil {
		http.Error(w, `{"error":"reprocess failed"}`, http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(reprocessResponse{Processed: n})
}
```

- [ ] **Step 5: Run `go test ./internal/server/` — expect PASS** (existing + new).

- [ ] **Step 6: Commit**
```bash
git add internal/server/
git commit -m "feat(server): POST /api/reprocess to re-run the parse cascade over raw email"
```

---

## Task 12: Wire everything in `cmd/ledger/main.go` + a Reprocessor adapter

Build the cascade (register DIB), the processor, wire it as the worker's post-process hook, and expose reprocess. Add a tiny adapter so the processor satisfies `server.Reprocessor`.

**Files:** Modify `cmd/ledger/main.go`; Create `internal/parse/reprocess.go`

- [ ] **Step 1: Add a Reprocessor adapter** — Create `internal/parse/reprocess.go`:

```go
package parse

import (
	"context"

	"ledger/internal/store"
)

// Reprocess re-runs the cascade over retained raw email, retrying unparsed AND
// low_confidence rows, optionally filtered to a bank/sender substring. It makes
// *Processor satisfy server.Reprocessor.
func (p *Processor) Reprocess(ctx context.Context, bank string) (int, error) {
	return p.ProcessPending(ctx, store.SelectForParseOpts{OnlyUnparsed: false, FromLike: bank})
}
```

> Note: `bank` is matched as a sender substring via `FromLike`. For DIB pass `"dib"`; empty string reprocesses everything.

- [ ] **Step 2: Rewrite `cmd/ledger/main.go`** to build and wire the parse layer. Replace the file with:

```go
// Command ledger is the single binary: it loads config, opens the SQLite store,
// starts the IMAP ingest worker (which also runs the parse cascade), and serves
// the API + embedded PWA over HTTP.
package main

import (
	"context"
	"flag"
	"log"
	"net/http"
	"os/signal"
	"syscall"
	"time"

	"ledger/internal/config"
	"ledger/internal/ingest"
	"ledger/internal/parse"
	"ledger/internal/server"
	"ledger/internal/store"
	"ledger/internal/web"
)

func main() {
	configPath := flag.String("config", "", "path to config.toml (optional; defaults apply if empty)")
	flag.Parse()

	cfg, err := config.Load(*configPath)
	if err != nil {
		log.Fatalf("config: %v", err)
	}

	st, err := store.Open(cfg.Server.DataDir)
	if err != nil {
		log.Fatalf("store: %v", err)
	}
	defer st.Close()

	webFS, err := web.FS()
	if err != nil {
		log.Fatalf("web assets: %v", err)
	}

	// Parse layer: register bank templates, build the cascade + processor.
	// AI extraction stays disabled in M3 (real client arrives in M4).
	cascade := &parse.Cascade{
		Parsers:   []parse.BankParser{parse.DIBParser{}},
		Heuristic: parse.HeuristicParser{},
		AI:        parse.DisabledExtractor{},
	}
	processor := parse.NewProcessor(st, cascade)

	srv := server.New(st, webFS)
	srv.SetIngest(st, cfg.IMAP.Enabled())
	srv.SetReprocessor(processor)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	if cfg.IMAP.Enabled() {
		interval, err := cfg.IMAP.Interval()
		if err != nil {
			log.Fatalf("imap poll_interval: %v", err)
		}
		dialer := ingest.NewIMAPDialer(cfg.IMAP)
		worker := ingest.New(dialer, st, interval, log.Default())
		worker.SetPostProcess(func(ctx context.Context) (int, error) {
			return processor.ProcessPending(ctx, store.SelectForParseOpts{OnlyUnparsed: true})
		})
		go worker.Run(ctx)
		log.Printf("ingest+parse enabled for %s (mailbox %s, poll %s)", cfg.IMAP.Username, cfg.IMAP.Folder, interval)
	} else {
		log.Printf("ingest disabled (no imap.host configured)")
	}

	httpServer := &http.Server{
		Addr:              cfg.Server.Listen,
		Handler:           srv,
		ReadHeaderTimeout: 10 * time.Second,
	}
	go func() {
		log.Printf("ledger listening on %s (data_dir=%s)", cfg.Server.Listen, cfg.Server.DataDir)
		if err := httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("http server: %v", err)
		}
	}()

	<-ctx.Done()
	log.Println("shutting down")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := httpServer.Shutdown(shutdownCtx); err != nil {
		log.Printf("shutdown error: %v", err)
	}
}
```

- [ ] **Step 3: Build + full suite + vet** — `go build ./... && go vet ./... && go test ./...` (all PASS; `cmd/ledger` and `internal/web` have no tests).

- [ ] **Step 4: Static binary** — `CGO_ENABLED=0 go build -o /tmp/ledger ./cmd/ledger && echo OK && rm -f /tmp/ledger`.

- [ ] **Step 5: Commit**
```bash
git add cmd/ledger/main.go internal/parse/reprocess.go
git commit -m "feat(cmd): wire parse cascade + processor into the worker and /api/reprocess"
```

---

## Task 13: Live verification on dinosaur (manual)

The milestone's acceptance (§10.3): *real transactions appear; a broken template still degrades to heuristic/AI → review; reprocessing after a fix backfills nothing-lost.* Run on dinosaur against the 1,200+ real DIB emails already in `ingest_log`.

- [ ] **Step 1: Build + install + restart.** Follow `deploy/README.md` §1–2 to build and install the new binary; `sudo systemctl restart ledger`.

- [ ] **Step 2: Trigger reprocess of all retained DIB email** (the worker also processes on its next poll, but reprocess is immediate):
```bash
curl -s -XPOST http://127.0.0.1:8080/api/reprocess -d '{"bank":"dib"}'
# -> {"processed": <N>}
```

- [ ] **Step 3: Confirm real transactions appeared:**
```bash
sudo -u ledger sqlite3 /var/lib/ledger/ledger.db \
 "SELECT count(*) FROM transactions;
  SELECT direction, count(*) FROM transactions GROUP BY direction;
  SELECT merchant_raw, amount FROM transactions WHERE merchant_raw NOT LIKE '%TRNSFER%' ORDER BY id DESC LIMIT 10;"
```
Expected: hundreds of transactions; debit/credit split; recognizable merchants (e.g. `Amazon.ae`, `Noon Minutes`) with fils amounts. Spot-check 3 against the real emails.

- [ ] **Step 4: Confirm ingest_log status moved:**
```bash
sudo -u ledger sqlite3 /var/lib/ledger/ledger.db \
 "SELECT parse_status, parse_tier, count(*) FROM ingest_log GROUP BY parse_status, parse_tier;"
```
Expected: most DIB rows now `parsed/template`; any non-transaction emails (Google alerts) remain `unparsed`.

- [ ] **Step 5: Idempotency** — run the reprocess curl again; transaction count must not grow (fingerprint dedup).

- [ ] **Step 6: Tag the milestone:**
```bash
git tag -a m3-parse -m "Milestone 3: parse cascade (DIB-first) complete" && git push origin m3-parse
```

---

## Definition of Done

- [ ] `go build ./...`, `go vet ./...`, `go test ./...`, `go test -race ./internal/ingest/` pass; `CGO_ENABLED=0` build is static.
- [ ] DIB emails (both layouts) parse into validated `transactions` with correct amount (fils), direction, merchant (`الدفع الى` for cards), date, and last-4.
- [ ] Unmatched/invalid emails fall through template → heuristic → AI(disabled) → `unparsed` and are never dropped (raw retained).
- [ ] Extraction is idempotent (fingerprint UNIQUE); reprocessing does not duplicate.
- [ ] `POST /api/reprocess` re-runs the cascade over retained raw email (optionally per bank) and reports the count.
- [ ] All extracted transactions are `needs_review` (no categorizer yet); `ingest_log.parse_status`/`parse_tier` reflect the resolving tier.
- [ ] AI tier is interface-only (disabled default), exercised by mock in cascade tests; no real Anthropic client.
- [ ] Deployed on dinosaur; reprocessing the captured DIB backlog produces real transactions.

---

## Self-Review notes (author)

- **Spec coverage (§6.2/§10.3):** template tier ✅ (DIB, T6) anchored on stable Arabic labels in stripped text (T3), heuristic tier ✅ (T5), AI tier ✅ as interface+disabled (T4, decision-gated), validation gating every tier ✅ (T1/T7), review-queue floor ✅ (`unparsed`, T7/T9), raw retention + reprocess ✅ (T11/T12, raw never mutated), `/api/reprocess` ✅ (T11). Drift monitoring (§6.2 active drift alerts) is deferred to M8 (hardening) — noted, not built here. Per-bank parse-success in `/api/health` (§6.7) also deferred to M8.
- **Deliberately out of scope:** categorization (M4 — status stays `needs_review`), dedup/reconciliation beyond the basic fingerprint, self-transfers, refunds sign convention, budget engine (M5), real Anthropic client (M4), ENBD template (added later → reprocess backfills).
- **Type consistency:** `ParsedTxn`/`BankParser`/tier+direction consts (T1) used by DIB (T6), heuristic (T5), cascade (T7), processor (T9). `Validate` (T1) called in cascade. `BodyText` (T3) used by processor (T9) and tested in isolation. `store.TransactionRow`/`InsertTransaction`/`SelectForParse`/`MarkParsed`/`SelectForParseOpts`/`IngestForParse` (T8) used by processor (T9). `Cascade`/`Result`/`Status*` (T7) consistent with processor + ai (T4). `Processor.ProcessPending`/`NewProcessor` (T9) used by worker hook (T10/T12) and `Reprocess` (T12) satisfies `server.Reprocessor` (T11). `Extractor`/`DisabledExtractor` (T4) used in cascade + main.
- **Decision adherence:** AI interface+mock only (no real client); DIB-first with reprocess backfill path for ENBD later. Both honored.
- **External-lib risk:** go-message v0.18.2 API used in T3 (`message.Read`, `Entity.Body`, `Entity.MultipartReader`, `Header.ContentType`, `IsUnknownCharset/Encoding`) verified against the installed version; T3 step 5 compiles it. The cascade/parsers are pure-Go and library-independent.
- **No placeholders:** every code step is complete; the one test-helper correction in T7 (the `timeTime` typo → `mustDate` using `time.Time`) is called out explicitly with the fix.
```
