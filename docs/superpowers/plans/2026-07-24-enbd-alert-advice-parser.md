# ENBD Alert Advice Parser Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Parse ENBD "Transaction advice" alert emails (`alert@emiratesnbd.com`), including iCloud-webmail forwards, by adding a bank template plus a template-tier `posted_at` fallback taken from the forwarded `Date:` header or the ingest `received_at`.

**Architecture:** Extend `parse.Unwrap` to also recover the forwarded `Date:` header; add `ParseForwardDate`; give `Cascade.Run` a `fallbackDate` that fills a template result's zero `PostedAt` (template tier only — heuristic stays strict); widen `BankParser.Parse` to `Parse(subject, textBody)` so the new `ENBDAlertParser` can read the account last4 from the subject.

**Tech Stack:** Go stdlib only (regexp, time). No new dependencies. Spec: `docs/superpowers/specs/2026-07-24-enbd-alert-advice-parser-design.md`.

## Global Constraints

- Money is `int64` fils; amounts positive; direction carries sign. Never floats.
- Every task ends with `go test ./internal/parse/ ./internal/store/` green and the whole module compiling (`go build ./...`).
- The build box has `LEDGER_AI_API_KEY` set, which false-fails one `internal/config` test; full-suite runs must use `env -u LEDGER_AI_API_KEY go test ./...`.
- `gofmt` all touched files. Commit after each task on `main` (this repo commits directly to main).
- Subagents: `cd /root/Coding/ledger` first and confirm `git branch --show-current` prints `main`.
- Times are naive/UTC like every other parser date; no timezone handling.

---

### Task 1: `Unwrap` recovers the forwarded `Date:` header + `ParseForwardDate`

**Files:**
- Modify: `internal/parse/forward.go`
- Modify: `internal/parse/forward_test.go` (5 existing `Unwrap` call sites at lines ~43, 60, 77, 86, 97)
- Modify: `internal/parse/processor.go:69` (adapt call site to keep build green; the value is *used* in Task 3)

**Interfaces:**
- Consumes: existing `Unwrap(from, subject, body string) (string, string, string)`.
- Produces: `Unwrap(from, subject, body string) (effFrom, effSubject, fwdDate, effBody string)` — `fwdDate` is the raw forwarded `Date:` header value, `""` for non-forwards; and `ParseForwardDate(s string) (time.Time, error)`.

- [ ] **Step 1: Write the failing tests**

Append to `internal/parse/forward_test.go`:

```go
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
```

Add `"time"` to the test file's imports if absent.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /root/Coding/ledger && go test ./internal/parse/ -run 'TestUnwrap|TestParseForwardDate'`
Expected: compile error (`Unwrap` returns 3 values, tests expect 4; `ParseForwardDate` undefined).

- [ ] **Step 3: Implement**

In `internal/parse/forward.go`:

1. Change the signature and doc line:

```go
// Unwrap detects an inline-forwarded bank email and recovers the ORIGINAL
// sender, subject, and Date header from the forwarded header block, returning a
// body with the forwarder's preamble and header block removed. A non-forwarded
// email is returned unchanged with an empty date. Input body is the
// HTML-stripped text from BodyText.
func Unwrap(from, subject, body string) (string, string, string, string) {
```

2. Both early returns in the `marker == -1` branch gain an empty date:
`return from, fwdSubjectRe.ReplaceAllString(subject, ""), "", body` and
`return from, subject, "", body`.

3. Add `recDate` alongside `recFrom, recSubject`, capture it in the label switch:

```go
recFrom, recSubject, recDate := "", "", ""
...
		switch label {
		case "from":
			recFrom = value
		case "subject":
			recSubject = value
		case "date":
			recDate = value
		}
```

4. Final return becomes `return effFrom, effSubject, recDate, effBody`.

5. Add `ParseForwardDate` (new imports: `fmt`, `time`):

```go
// fwdDateLayouts covers the Date formats forwarding clients emit: iCloud
// webmail, Gmail, and the Apple Mail app (whose trailing zone token, e.g.
// "GMT+4", is stripped before matching — forward dates are treated as naive).
var fwdDateLayouts = []string{
	"Jan 2, 2006 at 3:04 PM",
	"Mon, Jan 2, 2006 at 3:04 PM",
	"2 January 2006 at 15:04:05",
	"2 January 2006 at 15:04",
}

// ParseForwardDate parses a forwarded-header Date value recovered by Unwrap.
func ParseForwardDate(s string) (time.Time, error) {
	s = strings.TrimSpace(s)
	candidates := []string{s}
	if i := strings.LastIndex(s, " "); i > 0 {
		candidates = append(candidates, strings.TrimSpace(s[:i]))
	}
	for _, c := range candidates {
		for _, layout := range fwdDateLayouts {
			if t, err := time.Parse(layout, c); err == nil {
				return t, nil
			}
		}
	}
	return time.Time{}, fmt.Errorf("unrecognized forward date %q", s)
}
```

6. Update the 5 existing call sites in `forward_test.go` mechanically — each gains a `_` (or an assertion) for the new third return value, e.g. `from, subject, _, body := Unwrap(...)`.

7. Keep the build green: in `internal/parse/processor.go:69` change to

```go
		from, subject, fwdDate, text := Unwrap(row.FromAddr, row.Subject, text)
		_ = fwdDate // consumed in the cascade fallback (next change)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./internal/parse/ && go build ./...`
Expected: PASS, clean build.

- [ ] **Step 5: Commit**

```bash
gofmt -w internal/parse/forward.go internal/parse/forward_test.go internal/parse/processor.go
git add internal/parse/forward.go internal/parse/forward_test.go internal/parse/processor.go
git commit -m "feat(parse): Unwrap recovers forwarded Date header; add ParseForwardDate"
```

---

### Task 2: `ReceivedAt` on `IngestForParse`

**Files:**
- Modify: `internal/store/transactions.go:100-160` (`IngestForParse`, `SelectForParse`)
- Test: `internal/store/transactions_test.go` (or the file where `SelectForParse` is already tested — put the test beside its siblings)

**Interfaces:**
- Consumes: `ingest_log.received_at` TEXT column, written as RFC3339Nano-or-empty by `rfc3339OrEmpty` (`internal/store/ingest.go`).
- Produces: `IngestForParse.ReceivedAt time.Time` (zero when the column is NULL/empty). Task 3's processor reads it.

- [ ] **Step 1: Write the failing test**

```go
func TestSelectForParseReturnsReceivedAt(t *testing.T) {
	st := testStore(t) // use this file's existing in-memory store helper; create the row via InsertIngest
	recv := time.Date(2026, 7, 24, 13, 51, 40, 0, time.UTC)
	if _, err := st.InsertIngest(IngestRecord{
		MessageUID: "recv1", FromAddr: "a@b.c", Subject: "s",
		ReceivedAt: recv, ParseStatus: "unparsed", RawBody: []byte("x"), CreatedAt: time.Now(),
	}); err != nil {
		t.Fatal(err)
	}
	rows, err := st.SelectForParse(SelectForParseOpts{OnlyUnparsed: true})
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 {
		t.Fatalf("got %d rows", len(rows))
	}
	if !rows[0].ReceivedAt.Equal(recv) {
		t.Errorf("ReceivedAt = %v, want %v", rows[0].ReceivedAt, recv)
	}
}
```

(Adapt the store-constructor helper name to whatever the neighboring tests in that file use.)

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/store/ -run TestSelectForParseReturnsReceivedAt`
Expected: FAIL — `rows[0].ReceivedAt` undefined (compile error).

- [ ] **Step 3: Implement**

In `internal/store/transactions.go`:

```go
type IngestForParse struct {
	ID          int64
	FromAddr    string
	Subject     string
	ParseStatus string
	ReceivedAt  time.Time
	RawBody     []byte
}
```

In `SelectForParse`, extend the query and scan:

```go
q := `SELECT id, from_addr, subject, parse_status, received_at, raw_body FROM ingest_log WHERE parse_status IN ` + statuses
...
		var recv sql.NullString
		if err := rows.Scan(&r.ID, &r.FromAddr, &r.Subject, &r.ParseStatus, &recv, &raw); err != nil {
			return nil, err
		}
		if recv.Valid && recv.String != "" {
			if t, perr := time.Parse(time.RFC3339, recv.String); perr == nil {
				r.ReceivedAt = t
			}
		}
```

(`time.Parse` with `time.RFC3339` accepts the stored fractional-second form. Ensure `database/sql` and `time` are imported — check the file's existing imports.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./internal/store/ && go build ./...`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
gofmt -w internal/store/transactions.go internal/store/transactions_test.go
git add internal/store/transactions.go internal/store/transactions_test.go
git commit -m "feat(store): SelectForParse returns received_at for date fallback"
```

---

### Task 3: `BankParser.Parse(subject, textBody)` + cascade `fallbackDate` + processor wiring

**Files:**
- Modify: `internal/parse/parse.go:44-48` (interface + doc)
- Modify: `internal/parse/dib.go:30`, `internal/parse/enbd.go:31` (signature only; both ignore `subject`)
- Modify: `internal/parse/cascade.go:34-55` (`Run` signature, template-tier fallback)
- Modify: `internal/parse/processor.go:69-80` (compute fallback, pass to `Run`)
- Modify: every test call site the compiler flags (`cascade_test.go` lines ~25-92 pass a new final arg `time.Time{}`; `dib_test.go`/`enbd_test.go` call `Parse("", body)`; any stub `BankParser` in tests gains the `subject` param)
- Test: `internal/parse/cascade_test.go`

**Interfaces:**
- Consumes: `Unwrap`'s `fwdDate` + `ParseForwardDate` (Task 1); `IngestForParse.ReceivedAt` (Task 2).
- Produces: `BankParser.Parse(subject, textBody string) (ParsedTxn, error)`; `(c *Cascade) Run(ctx context.Context, from, subject, textBody string, fallbackDate time.Time) Result`. Task 4's parser relies on: a template returning zero `PostedAt` gets `fallbackDate` before `Validate`.

- [ ] **Step 1: Write the failing tests**

Append to `internal/parse/cascade_test.go` (import `time` if absent):

```go
// stubNoDateParser mimics a template for a format that carries no body date
// (e.g. ENBD transaction advice): it returns a zero PostedAt and relies on the
// cascade's fallbackDate.
type stubNoDateParser struct{}

func (stubNoDateParser) Bank() string { return "stub" }
func (stubNoDateParser) Matches(from, subject string) bool {
	return from == "stub@bank.com"
}
func (stubNoDateParser) Parse(subject, textBody string) (ParsedTxn, error) {
	return ParsedTxn{AmountFils: 1000, Currency: "AED", Direction: DirectionDebit,
		Tier: TierTemplate, Confidence: 0.9}, nil
}

func TestCascadeTemplateFallbackDate(t *testing.T) {
	c := &Cascade{Parsers: []BankParser{stubNoDateParser{}}}
	fb := time.Date(2026, 7, 24, 16, 11, 0, 0, time.UTC)
	res := c.Run(context.Background(), "stub@bank.com", "s", "whatever", fb)
	if res.Status != StatusParsed || res.Tier != TierTemplate {
		t.Fatalf("status/tier = %s/%s, want parsed/template (err %s)", res.Status, res.Tier, res.Err)
	}
	if !res.Txn.PostedAt.Equal(fb) {
		t.Errorf("PostedAt = %v, want fallback %v", res.Txn.PostedAt, fb)
	}
}

func TestCascadeZeroFallbackStillUnparsed(t *testing.T) {
	c := &Cascade{Parsers: []BankParser{stubNoDateParser{}}}
	res := c.Run(context.Background(), "stub@bank.com", "s", "whatever", time.Time{})
	if res.Status != StatusUnparsed {
		t.Fatalf("status = %s, want unparsed when no date exists anywhere", res.Status)
	}
}

func TestCascadeFallbackNeverOverridesBodyDate(t *testing.T) {
	// A template that DID extract a body date must keep it even when a
	// fallback is offered.
	c := &Cascade{Parsers: []BankParser{DIBParser{}}}
	fb := time.Date(2020, 1, 1, 0, 0, 0, 0, time.UTC)
	res := c.Run(context.Background(), "DIB.notification@dib.ae", "DIB Notification", dibCardPurchase, fb)
	if res.Status != StatusParsed {
		t.Fatalf("status = %s (err %s)", res.Status, res.Err)
	}
	if res.Txn.PostedAt.Equal(fb) {
		t.Error("fallback overwrote a template-extracted body date")
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./internal/parse/ -run TestCascade`
Expected: compile error (`Run` takes 4 args; stub's `Parse` has wrong arity).

- [ ] **Step 3: Implement**

1. `internal/parse/parse.go`:

```go
// BankParser is a per-bank template tier. Matches is a cheap sender/subject
// check; Parse runs on the HTML-stripped plain-text body plus the (unwrapped)
// subject, which some formats need for data the body lacks (e.g. the account
// last4 in ENBD advice subjects). A parser for a format with no body date may
// return a zero PostedAt; the cascade fills it from the email's own date.
type BankParser interface {
	Bank() string
	Matches(from, subject string) bool
	Parse(subject, textBody string) (ParsedTxn, error)
}
```

2. `dib.go` / `enbd.go`: `func (DIBParser) Parse(subject, textBody string) (ParsedTxn, error)` — body unchanged, `subject` unused (name it `_` if the linter complains; keep `subject` for docs otherwise). Same for `ENBDParser`.

3. `cascade.go` — signature plus template-tier fill (add `"time"` import):

```go
func (c *Cascade) Run(ctx context.Context, from, subject, textBody string, fallbackDate time.Time) Result {
	...
	// Tier 1: matching per-bank template.
	for _, bp := range c.Parsers {
		if !bp.Matches(from, subject) {
			continue
		}
		p, err := bp.Parse(subject, textBody)
		if err == nil {
			// A template may leave PostedAt zero when its format carries no
			// body date; the email's own date is trustworthy for advice mail.
			if p.PostedAt.IsZero() {
				p.PostedAt = fallbackDate
			}
			if verr := Validate(p); verr == nil {
				return Result{Txn: p, Status: StatusParsed, Tier: TierTemplate}
			} else {
				err = verr
			}
		}
		fail(TierTemplate, err)
		break // the bank matched but failed; fall through to heuristic
	}
	...
```

Heuristic and AI tiers: **unchanged** (no fallback there).

4. `processor.go` — replace the Task 1 stopgap:

```go
		from, subject, fwdDate, text := Unwrap(row.FromAddr, row.Subject, text)
		// posted_at fallback for templates whose format has no body date: the
		// forwarded Date header (transaction time even for late forwards),
		// else the mailbox arrival time.
		fallback := row.ReceivedAt
		if fd, err := ParseForwardDate(fwdDate); err == nil {
			fallback = fd
		}
		...
		res := casc.Run(ctx, from, subject, text, fallback)
```

5. Fix every remaining compile error mechanically: existing `c.Run(ctx, from, subject, body)` test calls gain `, time.Time{}`; existing direct `Parse(body)` template-test calls become `Parse("", body)`; any other stub `BankParser` implementations in tests gain the `subject` parameter.

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./internal/parse/ ./internal/store/ && go build ./...`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
gofmt -w internal/parse/
git add internal/parse/
git commit -m "feat(parse): subject-aware templates + template-tier posted_at fallback"
```

---

### Task 4: `ENBDAlertParser` + wiring

**Files:**
- Create: `internal/parse/enbd_alert.go`
- Test: `internal/parse/enbd_alert_test.go`
- Modify: `cmd/ledger/main.go:228` (add to `Parsers` slice)

**Interfaces:**
- Consumes: `BankParser` shape from Task 3 (`Parse(subject, textBody)`), zero-`PostedAt` fallback contract, `ParseAEDToFils` (`fields.go`).
- Produces: `parse.ENBDAlertParser{}` — registered in `main.go`.

- [ ] **Step 1: Write the failing tests**

Create `internal/parse/enbd_alert_test.go`:

```go
package parse

import "testing"

const enbdAlertSubject = "Emirates NBD Transaction advice for account ending with 3701"

const enbdAlertWithdrawal = `Dear Customer,
AED 250,000.00 has been withdrawn from your account 067XXX17XXX01. The available balance is AED 51,566.07. Save queuing time by using our free ATMs 24 x 7.`

func TestENBDAlertMatches(t *testing.T) {
	p := ENBDAlertParser{}
	if !p.Matches("alert@emiratesnbd.com", "anything") {
		t.Error("should match alert@emiratesnbd.com")
	}
	if !p.Matches("Alert@EmiratesNBD.com", "anything") {
		t.Error("should match case-insensitively")
	}
	if p.Matches("OnlineBanking@emiratesnbd.com", "anything") {
		t.Error("must not steal the transfer-advice sender from ENBDParser")
	}
}

func TestENBDAlertWithdrawal(t *testing.T) {
	got, err := ENBDAlertParser{}.Parse(enbdAlertSubject, enbdAlertWithdrawal)
	if err != nil {
		t.Fatal(err)
	}
	if got.AmountFils != 25_000_000 {
		t.Errorf("AmountFils = %d, want 25000000", got.AmountFils)
	}
	if got.Currency != "AED" {
		t.Errorf("Currency = %q", got.Currency)
	}
	if got.Direction != DirectionDebit {
		t.Errorf("Direction = %q, want debit", got.Direction)
	}
	if got.Last4 != "3701" {
		t.Errorf("Last4 = %q, want 3701 (from subject)", got.Last4)
	}
	if !got.PostedAt.IsZero() {
		t.Errorf("PostedAt = %v, want zero (cascade fills from email date)", got.PostedAt)
	}
	if got.Tier != TierTemplate || got.Confidence != 0.9 {
		t.Errorf("tier/confidence = %s/%v", got.Tier, got.Confidence)
	}
}

func TestENBDAlertCredit(t *testing.T) {
	got, err := ENBDAlertParser{}.Parse(enbdAlertSubject,
		"Dear Customer, AED 1,500.00 has been credited to your account 067XXX17XXX01.")
	if err != nil {
		t.Fatal(err)
	}
	if got.Direction != DirectionCredit {
		t.Errorf("Direction = %q, want credit", got.Direction)
	}
	if got.AmountFils != 150_000 {
		t.Errorf("AmountFils = %d, want 150000", got.AmountFils)
	}
}

func TestENBDAlertNoAnchor(t *testing.T) {
	if _, err := (ENBDAlertParser{}).Parse(enbdAlertSubject,
		"Dear Customer, your statement is ready."); err == nil {
		t.Error("non-advice body must error so the cascade can fall through")
	}
}

func TestENBDAlertNoLast4InSubject(t *testing.T) {
	got, err := ENBDAlertParser{}.Parse("Fwd: something odd", enbdAlertWithdrawal)
	if err != nil {
		t.Fatal(err)
	}
	if got.Last4 != "" {
		t.Errorf("Last4 = %q, want empty when subject lacks it", got.Last4)
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./internal/parse/ -run TestENBDAlert`
Expected: compile error — `ENBDAlertParser` undefined.

- [ ] **Step 3: Implement**

Create `internal/parse/enbd_alert.go`:

```go
package parse

import (
	"fmt"
	"regexp"
	"strings"
)

// ENBDAlertParser parses Emirates NBD "Transaction advice" account alerts
// (alert@emiratesnbd.com): "AED 250,000.00 has been withdrawn from your
// account 067XXX17XXX01." They reach the mailbox directly or as unwrapped
// forwards. The body carries no transaction date and no merchant; the account
// last4 lives only in the subject ("account ending with 3701" — the body's
// account number is masked). PostedAt is left zero so the cascade fills it
// from the forwarded Date header / ingest received time.
type ENBDAlertParser struct{}

func (ENBDAlertParser) Bank() string { return "enbd" }

func (ENBDAlertParser) Matches(from, subject string) bool {
	return strings.Contains(strings.ToLower(from), "alert@emiratesnbd.com")
}

var (
	enbdAlertDebitRe  = regexp.MustCompile(`(?i)((?:[A-Z]{3}\s*)?[\d,]+\.\d{2})\s+has been\s+(?:withdrawn|debited)\s+from your account`)
	enbdAlertCreditRe = regexp.MustCompile(`(?i)((?:[A-Z]{3}\s*)?[\d,]+\.\d{2})\s+has been\s+(?:credited|deposited)\s+(?:in)?to your account`)
	enbdAlertLast4Re  = regexp.MustCompile(`(?i)account ending with\s+(\d{4})`)
)

func (ENBDAlertParser) Parse(subject, textBody string) (ParsedTxn, error) {
	direction := DirectionDebit
	m := enbdAlertDebitRe.FindStringSubmatch(textBody)
	if m == nil {
		m = enbdAlertCreditRe.FindStringSubmatch(textBody)
		direction = DirectionCredit
	}
	if m == nil {
		return ParsedTxn{}, fmt.Errorf("enbd alert: no withdrawal/deposit anchor found")
	}
	fils, currency, err := ParseAEDToFils(m[1])
	if err != nil {
		return ParsedTxn{}, fmt.Errorf("enbd alert amount: %w", err)
	}
	p := ParsedTxn{
		AmountFils: fils,
		Currency:   currency,
		Direction:  direction,
		Tier:       TierTemplate,
		// Slightly below body-dated templates: the date is inferred from the
		// email itself, not stated in the body.
		Confidence: 0.9,
	}
	if lm := enbdAlertLast4Re.FindStringSubmatch(subject); lm != nil {
		p.Last4 = lm[1]
	}
	return p, nil
}
```

Wire into `cmd/ledger/main.go:228`:

```go
Parsers:   []parse.BankParser{parse.DIBParser{}, parse.ENBDParser{}, parse.ENBDAlertParser{}},
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./internal/parse/ && go build ./...`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
gofmt -w internal/parse/enbd_alert.go internal/parse/enbd_alert_test.go cmd/ledger/main.go
git add internal/parse/enbd_alert.go internal/parse/enbd_alert_test.go cmd/ledger/main.go
git commit -m "feat(parse): ENBD transaction-advice alert template (alert@emiratesnbd.com)"
```

---

### Task 5: End-to-end processor test — forwarded advice → transaction

**Files:**
- Test: `internal/parse/processor_test.go` (append)

**Interfaces:**
- Consumes: everything from Tasks 1–4 through the public `Processor.ProcessPending` path; `store.InsertIngest` / `store.IngestRecord`.
- Produces: regression coverage that the real row-6973 shape yields a transaction dated by the forwarded header, not the mailbox arrival time.

- [ ] **Step 1: Write the failing test**

Append to `internal/parse/processor_test.go`:

```go
func TestProcessorParsesForwardedENBDAlert(t *testing.T) {
	st := procTestStore(t)
	raw := []byte("From: salehtl@icloud.com\r\n" +
		"To: ledgerdino@gmail.com\r\n" +
		"Subject: Fwd: Emirates NBD Transaction advice for account ending with 3701\r\n" +
		"Content-Type: text/plain; charset=utf-8\r\n" +
		"\r\n" +
		"Begin forwarded message:\n" +
		"From:\nalert@emiratesnbd.com\n" +
		"Subject:\nEmirates NBD Transaction advice for account ending with 3701\n" +
		"Date:\nJul 24, 2026 at 4:11 PM\n" +
		"To:\nSALEHTL@icloud.com\n" +
		"Dear Customer,\n" +
		"AED 250,000.00 has been withdrawn from your account 067XXX17XXX01. The available balance is AED 51,566.07.\n")
	if _, err := st.InsertIngest(store.IngestRecord{
		MessageUID: "fwd-enbd-1",
		FromAddr:   "salehtl@icloud.com",
		Subject:    "Fwd: Emirates NBD Transaction advice for account ending with 3701",
		ReceivedAt: time.Date(2026, 7, 24, 13, 51, 40, 0, time.UTC), // forward arrival ≠ txn time
		ParseStatus: "unparsed",
		RawBody:     raw,
		CreatedAt:   time.Now(),
	}); err != nil {
		t.Fatal(err)
	}
	c := &Cascade{Parsers: []BankParser{ENBDAlertParser{}}}
	n, err := NewProcessor(st, c).ProcessPending(context.Background(), store.SelectForParseOpts{OnlyUnparsed: true})
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("created %d transactions, want 1", n)
	}
	var amount int64
	var direction, last4, postedAt, status string
	if err := st.DB.QueryRow(
		`SELECT amount, direction, last4, posted_at, status FROM transactions`).
		Scan(&amount, &direction, &last4, &postedAt, &status); err != nil {
		t.Fatal(err)
	}
	if amount != 25_000_000 || direction != "debit" || last4 != "3701" || status != "needs_review" {
		t.Errorf("amount/direction/last4/status = %d/%s/%s/%s", amount, direction, last4, status)
	}
	if !strings.HasPrefix(postedAt, "2026-07-24T16:11") {
		t.Errorf("posted_at = %q, want the forwarded Date (16:11), not received_at (13:51)", postedAt)
	}
}
```

(Column names: verify against `internal/store/schema.sql` before running; if `posted_at` is stored date-only or the columns differ, adjust the SELECT — the assertions' *meaning* is fixed: forwarded-header date wins, amount/direction/last4/status as above. Import `strings`/`time` if absent.)

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/parse/ -run TestProcessorParsesForwardedENBDAlert`
Expected: FAIL only if a prior task was mis-wired; with Tasks 1–4 done this should PASS immediately. If it passes on first run, temporarily flip the expected `posted_at` prefix to `2026-07-24T13:51` and confirm the test then fails (proving it discriminates), revert, and continue.

- [ ] **Step 3: Run the full suites**

Run: `env -u LEDGER_AI_API_KEY go test ./... && go test ./internal/parse/ -race`
Expected: all PASS (the `internal/config` env false-failure is avoided by `env -u`).

- [ ] **Step 4: Commit**

```bash
gofmt -w internal/parse/processor_test.go
git add internal/parse/processor_test.go
git commit -m "test(parse): end-to-end forwarded ENBD advice → dated transaction"
```

---

### Task 6: Verify, deploy, reprocess row 6973 (MAIN SESSION ONLY — needs root + prod DB)

**Files:** none created; prod deploy per `deploy/README.md`.

- [ ] **Step 1: Full verification**

```bash
cd /root/Coding/ledger
gofmt -l . | grep -v node_modules   # expect empty
go vet ./...
env -u LEDGER_AI_API_KEY go test ./...
git status --short                   # expect only known untracked files
```

- [ ] **Step 2: Build** (frontend untouched — skip bun build unless `git log` shows a parallel session moved frontend/)

```bash
CGO_ENABLED=0 go build -o ledger ./cmd/ledger
```

- [ ] **Step 3: Backup DB as root (NOT `sudo -u ledger`, NOT chained under `set -e`)**

```bash
sudo sqlite3 /var/lib/ledger/ledger.db ".backup /var/backups/ledger-$(date +%Y%m%d-%H%M%S).db"
```

- [ ] **Step 4: Install + restart + verify running binary**

```bash
sudo install -m 0755 ledger /usr/local/bin/ledger
sudo systemctl restart ledger
sleep 2
sha256sum /usr/local/bin/ledger ledger        # must match
sudo ls -la /proc/$(systemctl show -p MainPID --value ledger)/exe   # → /usr/local/bin/ledger
curl -s http://127.0.0.1:8080/api/health
```

- [ ] **Step 5: Reprocess the forwarded row and verify**

```bash
curl -s -X POST http://127.0.0.1:8080/api/reprocess -d '{"bank":"icloud.com"}'
sudo sqlite3 "file:/var/lib/ledger/ledger.db?mode=ro" \
  "SELECT parse_status, parse_tier FROM ingest_log WHERE id=6973;"
# expect: parsed|template
sudo sqlite3 "file:/var/lib/ledger/ledger.db?mode=ro" \
  "SELECT amount, direction, last4, posted_at, status FROM transactions WHERE ingest_id=6973;"
# expect: 25000000|debit|3701|2026-07-24T16:11:00Z (naive-UTC form)|needs_review
```

(Adjust column names to schema if needed. `ingest_id` FK name per schema.sql.)

- [ ] **Step 6: Final commit / wrap-up**

Nothing to commit unless fixes were needed; report the verified transaction to the user.

---

## Self-Review

- **Spec coverage:** §1→Task 1, §2→Task 1, §3→Task 3, §4→Task 2, §5→Task 3, §6→Task 4, error handling→Tasks 3/4 tests, testing §1-5→Tasks 1-5, rollout→Task 6. Covered.
- **Placeholders:** the two "adapt to existing helper/schema names" notes are deliberate look-before-you-write instructions with the expected semantics pinned, not TBDs.
- **Type consistency:** `Unwrap` 4-return order (from, subject, fwdDate, body) consistent across Tasks 1/3/5; `Run(ctx, from, subject, textBody, fallbackDate)` consistent across 3/4/5; `Parse(subject, textBody)` consistent across 3/4/5.
