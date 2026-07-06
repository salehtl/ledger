# Forwarded-Email Parsing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the parse cascade correctly extract transactions from inline-forwarded bank emails by recovering the *original* sender/subject and stripping the forwarding preamble before extraction.

**Architecture:** Add one pure function, `parse.Unwrap`, that runs after `BodyText` and before `Cascade.Run`. It detects an inline-forward marker ("Begin forwarded message:" / "---------- Forwarded message ---------"), recovers the original `From`/`Subject` from the forwarded header block, and returns a body with the forwarder's preamble + header block removed. The cascade then sees the bank's real sender (so the bank template matches) and a clean body (so the heuristic no longer mistakes a `To:`/`From:` line for the merchant). Wiring is a one-line change in `Processor.ProcessPending`.

**Tech Stack:** Go (stdlib + existing `regexp`), pure-Go SQLite, existing `internal/parse` cascade.

## Global Constraints

- Money is integer minor units (`int64` fils, AED × 100); amounts always positive; `direction` carries sign. (Not touched by this plan, but assertions use fils.)
- `parse` package extracts and validates only — it does NOT categorize or dedup.
- Deterministic-first: this fix routes forwarded bank emails back through the **template** tier (high confidence), not AI.
- Single binary, pure-Go SQLite, `CGO_ENABLED=0`. Frontend is not touched, so no frontend rebuild is required for this plan.
- Go tests live beside the code (`*_test.go`); follow existing fixture style (inline raw strings; base64 `text/html` envelopes via the `dibEmail` helper pattern in `processor_test.go`).
- Tests are pinned non-parallel for frontend only; Go tests run normally (`go test ./internal/parse/`).

## Background: the exact failure (verified against production data)

A forwarded DIB email is stored in `ingest_log` with envelope `from_addr = "Saleh Lootah <salehtl@icloud.com>"`, `subject = "Fwd: DIB Notification"`. After `BodyText` HTML-stripping, the body is:

```
Sent from my iPhone
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
﻿
معاملة بطاقة ائتمان
عزيزي المتعامل,
إشعار مشتريات بتاريخ 18-06-2026 18:03 بالتفاصيل التالية.
رقم البطاقة
462467XXXXXX7502
المبلغ
AED 124.00
الدفع الى
NOIRO CAFE
...
```

Two failures stack:
1. `DIBParser.Matches(from, subject)` checks `from` for `dib.notification@dib.ae`, but the envelope `from` is the iCloud forwarder → **template tier is skipped**.
2. The cascade falls to the heuristic, whose `merchantRe = (?i)\b(?:at|to|merchant|payment to|paid to)\b[:\s]+(...)` matches the preamble line `To:` and captures `salehtl` → **wrong merchant** (`transactions` row 2446: `merchant_raw='salehtl'`, tier heuristic, conf 0.4). 51 of 52 forwarded emails are `unparsed`; the 1 that "parsed" is wrong.

After `Unwrap`, the cascade receives `from = "DIB Notification <DIB.notification@dib.ae>"` and a body starting at `معاملة بطاقة ائتمان`, so the DIB template matches and extracts `NOIRO CAFE / AED 124.00 / 18-06-2026 / card 7502 / debit`.

---

## File Structure

- **Create** `internal/parse/forward.go` — `Unwrap(from, subject, body string) (effFrom, effSubject, effBody string)` and its regexes. Single responsibility: forward detection + header recovery + preamble stripping. Operates on the HTML-stripped text produced by `BodyText`.
- **Create** `internal/parse/forward_test.go` — unit tests for `Unwrap` (Apple Mail shape, Gmail shape, non-forward passthrough, Fwd-subject fallback).
- **Modify** `internal/parse/processor.go:62` — call `Unwrap` between `BodyText` and `cascade.Run`.
- **Modify** `internal/parse/processor_test.go` — add `fwdEmail` helper + an end-to-end forwarded-DIB test asserting template tier and correct merchant.
- **No schema change.** `ingest_log.from_addr`/`subject` keep the envelope values; recovery is in-memory per parse. (Rewriting stored `from_addr` for drift-monitor grouping is **out of scope** — see "Out of scope".)

---

### Task 1: `Unwrap` pure function

**Files:**
- Create: `internal/parse/forward.go`
- Test: `internal/parse/forward_test.go`

**Interfaces:**
- Consumes: nothing from other tasks; operates on plain strings.
- Produces: `func Unwrap(from, subject, body string) (string, string, string)` — returns effective `from`, `subject`, `body`. For a non-forwarded email returns its three inputs unchanged. Task 2 consumes this exact signature.

- [ ] **Step 1: Write the failing tests**

Create `internal/parse/forward_test.go`:

```go
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
﻿
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `go test ./internal/parse/ -run TestUnwrap -v`
Expected: FAIL — `undefined: Unwrap` (compile error).

- [ ] **Step 3: Implement `Unwrap`**

Create `internal/parse/forward.go`:

```go
package parse

import (
	"regexp"
	"strings"
)

// forwardMarkerRe matches the line introducing an inline-forwarded message:
// Apple Mail ("Begin forwarded message:") and Gmail ("---------- Forwarded
// message ---------"), case-insensitively.
var forwardMarkerRe = regexp.MustCompile(`(?i)^\s*(begin forwarded message:|-+\s*forwarded message\s*-+)\s*$`)

// fwdSubjectRe strips a leading Fwd:/FW: from a subject.
var fwdSubjectRe = regexp.MustCompile(`(?i)^\s*(fwd?|fw)\s*:\s*`)

// fwdHeaderLineRe matches a forwarded-header line, capturing the label and any
// same-line value. Apple Mail puts the value on the NEXT line (empty group 2);
// Gmail puts it on the same line.
var fwdHeaderLineRe = regexp.MustCompile(`(?i)^\s*(from|to|subject|date|reply-to|cc|sent)\s*:\s*(.*)$`)

// Unwrap detects an inline-forwarded bank email and recovers the ORIGINAL
// sender and subject from the forwarded header block, returning a body with the
// forwarder's preamble and header block removed. A non-forwarded email is
// returned unchanged. Input body is the HTML-stripped text from BodyText.
func Unwrap(from, subject, body string) (string, string, string) {
	lines := strings.Split(body, "\n")

	marker := -1
	for i, l := range lines {
		if forwardMarkerRe.MatchString(l) {
			marker = i
			break
		}
	}
	if marker == -1 {
		// No forward marker. If the subject is Fwd-prefixed, still strip the
		// prefix so a future template Matches can use it; body is untouched.
		return from, fwdSubjectRe.ReplaceAllString(subject, ""), body
	}

	recFrom, recSubject := "", ""
	end := marker + 1 // first line of the original body (after the header block)
	sawHeader := false
	for i := marker + 1; i < len(lines); {
		m := fwdHeaderLineRe.FindStringSubmatch(lines[i])
		if m == nil {
			if sawHeader {
				break // header block ended; original body starts at lines[i]
			}
			i++ // skip preamble/blank noise between marker and first header
			continue
		}
		sawHeader = true
		label := strings.ToLower(m[1])
		value := strings.TrimSpace(m[2])
		if value == "" { // Apple Mail: value is on the next non-empty line
			j := i + 1
			for j < len(lines) && strings.TrimSpace(lines[j]) == "" {
				j++
			}
			if j < len(lines) {
				value = strings.TrimSpace(lines[j])
				i = j
			}
		}
		switch label {
		case "from":
			recFrom = value
		case "subject":
			recSubject = value
		}
		i++
		end = i
	}

	effFrom, effSubject, effBody := from, subject, body
	if recFrom != "" {
		effFrom = recFrom
	}
	if recSubject != "" {
		effSubject = recSubject
	} else {
		effSubject = fwdSubjectRe.ReplaceAllString(subject, "")
	}
	if sawHeader && end < len(lines) {
		effBody = strings.TrimSpace(strings.Join(lines[end:], "\n"))
	}
	return effFrom, effSubject, effBody
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `go test ./internal/parse/ -run TestUnwrap -v`
Expected: PASS (all four `TestUnwrap*`).

- [ ] **Step 5: Commit**

```bash
git add internal/parse/forward.go internal/parse/forward_test.go
git commit -m "feat(parse): add Unwrap to recover original sender + strip forward preamble

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Wire `Unwrap` into the processor

**Files:**
- Modify: `internal/parse/processor.go:57-62`
- Test: `internal/parse/processor_test.go` (add helper + test)

**Interfaces:**
- Consumes: `Unwrap(from, subject, body) (string, string, string)` from Task 1.
- Produces: no new exported symbols; behavior change only (forwarded rows now parse via template).

- [ ] **Step 1: Write the failing end-to-end test**

Append to `internal/parse/processor_test.go`:

```go
// fwdEmail builds a base64 text/html email whose envelope is the iCloud
// forwarder but whose body inline-forwards a DIB notification.
func fwdEmail() []byte {
	html := "<html><body>" +
		"<div>Sent from my iPhone</div>" +
		"<div><br>Begin forwarded message:<br><br></div>" +
		"<blockquote><div>" +
		"<b>From:</b> DIB Notification &lt;DIB.notification@dib.ae&gt;<br>" +
		"<b>Date:</b> 18 June 2026 at 7:33:38 PM GST<br>" +
		"<b>To:</b> salehtl@icloud.com<br>" +
		"<b>Subject:</b> <b>DIB Notification</b><br><br>" +
		"</div></blockquote>" +
		"<blockquote><div>" +
		"معاملة بطاقة ائتمان<br>" +
		"إشعار مشتريات بتاريخ 18-06-2026 18:03<br>" +
		"رقم البطاقة<br>462467XXXXXX7502<br>" +
		"المبلغ<br>AED 124.00<br>" +
		"الدفع الى<br>NOIRO CAFE<br>" +
		"</div></blockquote></body></html>"
	enc := base64.StdEncoding.EncodeToString([]byte(html))
	return []byte("From: Saleh Lootah <salehtl@icloud.com>\r\nSubject: Fwd: DIB Notification\r\n" +
		"MIME-Version: 1.0\r\nContent-Type: text/html; charset=\"utf-8\"\r\n" +
		"Content-Transfer-Encoding: base64\r\n\r\n" + enc)
}

func TestProcessorParsesForwardedDIBViaTemplate(t *testing.T) {
	st := procTestStore(t)
	if _, err := st.InsertIngest(store.IngestRecord{MessageUID: "fwd1", FromAddr: "Saleh Lootah <salehtl@icloud.com>",
		Subject: "Fwd: DIB Notification", ParseStatus: "unparsed", RawBody: fwdEmail(), CreatedAt: time.Now()}); err != nil {
		t.Fatal(err)
	}
	p := NewProcessor(st, dibCascade())
	n, err := p.ProcessPending(context.Background(), store.SelectForParseOpts{OnlyUnparsed: true})
	if err != nil {
		t.Fatalf("process: %v", err)
	}
	if n != 1 {
		t.Fatalf("processed = %d, want 1", n)
	}
	// Correct merchant + amount, NOT the forwarder ("salehtl").
	var cnt int
	st.DB.QueryRow("SELECT COUNT(*) FROM transactions WHERE merchant_raw='NOIRO CAFE' AND amount=12400 AND direction='debit'").Scan(&cnt)
	if cnt != 1 {
		t.Errorf("expected 1 NOIRO CAFE/12400 transaction, got %d", cnt)
	}
	// Must be the high-confidence template tier, and ingest marked parsed.
	var ps, tier string
	st.DB.QueryRow("SELECT parse_status, COALESCE(parse_tier,'') FROM ingest_log WHERE message_uid='fwd1'").Scan(&ps, &tier)
	if ps != "parsed" || tier != "template" {
		t.Errorf("ingest status/tier = %q/%q, want parsed/template", ps, tier)
	}
	// Guard against the original bug.
	var bad int
	st.DB.QueryRow("SELECT COUNT(*) FROM transactions WHERE merchant_raw='salehtl'").Scan(&bad)
	if bad != 0 {
		t.Errorf("found %d transactions with forwarder as merchant; preamble not stripped", bad)
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `go test ./internal/parse/ -run TestProcessorParsesForwardedDIBViaTemplate -v`
Expected: FAIL — the transaction is created with `merchant_raw='salehtl'` (heuristic tier) and the template/NOIRO assertions fail, because `Unwrap` is not yet wired in.

- [ ] **Step 3: Wire `Unwrap` into `ProcessPending`**

In `internal/parse/processor.go`, change the body-extraction block. Current code (lines ~57-62):

```go
		text, berr := BodyText(row.RawBody)
		if berr != nil {
			_ = p.store.MarkParsed(row.ID, StatusUnparsed, "", berr.Error())
			continue
		}
		res := p.cascade.Run(ctx, row.FromAddr, row.Subject, text)
```

Replace with:

```go
		text, berr := BodyText(row.RawBody)
		if berr != nil {
			_ = p.store.MarkParsed(row.ID, StatusUnparsed, "", berr.Error())
			continue
		}
		// Recover the original sender/subject and drop the forwarding preamble
		// for inline-forwarded bank mail; a non-forward passes through unchanged.
		from, subject, text := Unwrap(row.FromAddr, row.Subject, text)
		res := p.cascade.Run(ctx, from, subject, text)
```

- [ ] **Step 4: Run the new test and the full parse suite to verify they pass**

Run: `go test ./internal/parse/ -run TestProcessorParsesForwardedDIBViaTemplate -v`
Expected: PASS.

Run: `go test ./internal/parse/`
Expected: PASS (no regressions — existing direct-DIB/ENBD/heuristic tests still pass; non-forward emails pass through `Unwrap` unchanged).

- [ ] **Step 5: Run the whole Go suite with the race detector**

Run: `go test ./... -race`
Expected: PASS. (The `internal/config` env-dependent test may fail in this sandbox because `LEDGER_AI_API_KEY` is set — that is the known false-failure noted in project memory, not a regression from this change.)

- [ ] **Step 6: Commit**

```bash
git add internal/parse/processor.go internal/parse/processor_test.go
git commit -m "fix(parse): unwrap forwarded emails before the cascade

Forwarded bank mail arrived with the iCloud forwarder as the envelope
sender, so the bank template was skipped and the heuristic grabbed the
'To:' line as the merchant. Run Unwrap to recover the original sender
and strip the preamble; forwarded DIB/ENBD mail now parses via template.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Deploy and backfill the real forwarded emails

This task touches the production DB on `dinosaur` (this box). It rebuilds/redeploys the binary, then reprocesses the 52 forwarded rows so the previously-unparsed transactions backfill correctly.

**Files:**
- No source files. Operates on `/var/lib/ledger/ledger.db` and the systemd `ledger` service.

**Interfaces:**
- Consumes: the deployed binary containing Tasks 1–2.
- Produces: corrected `transactions` for forwarded mail; verification output.

- [ ] **Step 1: Build the binary**

The frontend is unchanged, so no `bun run build` is needed. Build the static binary:

Run:
```bash
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o ledger ./cmd/ledger
```
Expected: exits 0, produces `./ledger`.

- [ ] **Step 2: Snapshot current forwarded-email state (before)**

Run:
```bash
sudo -u ledger sqlite3 /var/lib/ledger/ledger.db \
  "SELECT parse_status, count(*) FROM ingest_log WHERE from_addr LIKE '%icloud%' GROUP BY parse_status;
   SELECT id, merchant_raw, amount, status FROM transactions WHERE merchant_raw='salehtl';"
```
Expected (baseline): `parsed|1`, `unparsed|51`; and one `transactions` row with `merchant_raw='salehtl'` (currently `archived`). Record these numbers.

- [ ] **Step 3: Reset the one mis-parsed forwarded row so it re-extracts**

`Reprocess` only re-runs `unparsed`/`low_confidence` rows. The single forwarded row that parsed wrongly is `parsed`, so it would be skipped and its correct transaction never created. Reset just the forwarded rows that are marked `parsed` (there is exactly one):

Run:
```bash
sudo -u ledger sqlite3 /var/lib/ledger/ledger.db \
  "UPDATE ingest_log SET parse_status='unparsed', parse_tier=NULL, parse_error=NULL
   WHERE from_addr LIKE '%icloud%' AND parse_status='parsed';"
sudo -u ledger sqlite3 /var/lib/ledger/ledger.db \
  "SELECT changes();"
```
Expected: `1` (one row reset).

The stale `merchant_raw='salehtl'` transaction is already `archived` (excluded from budgets); leave it. Reprocessing creates a new, correct transaction with a different fingerprint (merchant `NOIRO CAFE`, last4 `7502`).

- [ ] **Step 4: Install the new binary and restart the service**

Run:
```bash
sudo install -m 0755 ledger /usr/local/bin/ledger
sudo systemctl restart ledger
sleep 2
systemctl is-active ledger
curl -s http://127.0.0.1:8080/api/health
```
Expected: `active`; health JSON `{"status":"ok","db":"ok",...}`.

- [ ] **Step 5: Trigger reprocessing of forwarded mail**

Reprocess every forwarded row (filter on the forwarder substring):

Run:
```bash
curl -s -X POST http://127.0.0.1:8080/api/reprocess \
  -H 'Content-Type: application/json' -d '{"bank":"icloud"}'
```
Expected: `{"processed":N}` where `N` is the count of forwarded rows that produced a transaction (up to 52; some forwarded senders other than DIB/ENBD may legitimately remain `unparsed`).

- [ ] **Step 6: Verify the backfill (after)**

Run:
```bash
sudo -u ledger sqlite3 /var/lib/ledger/ledger.db \
  "SELECT parse_status, count(*) FROM ingest_log WHERE from_addr LIKE '%icloud%' GROUP BY parse_status;
   SELECT parse_tier, count(*) FROM ingest_log WHERE from_addr LIKE '%icloud%' AND parse_status='parsed' GROUP BY parse_tier;
   SELECT count(*) FROM transactions WHERE merchant_raw='salehtl' AND status!='archived';"
```
Expected:
- `parsed` count rose sharply versus Step 2 (forwarded DIB/ENBD now parse).
- `parse_tier` shows `template` (not `heuristic`) for the DIB/ENBD forwards.
- `0` non-archived transactions with `merchant_raw='salehtl'` — the forwarder is no longer mistaken for a merchant.

Spot-check one recovered transaction has a real merchant:
```bash
sudo -u ledger sqlite3 /var/lib/ledger/ledger.db \
  "SELECT merchant_raw, amount, direction FROM transactions WHERE ingest_id IN
     (SELECT id FROM ingest_log WHERE from_addr LIKE '%icloud%') ORDER BY id DESC LIMIT 10;"
```
Expected: real merchant strings (e.g. `NOIRO CAFE`), not `salehtl` or email addresses.

- [ ] **Step 7: Commit any docs/notes (no code in this task)**

This task changes no source files. If a CHANGELOG or plan-status note exists, update it; otherwise nothing to commit. Confirm a clean tree for source:

Run: `git status --porcelain internal/ cmd/`
Expected: empty (Tasks 1–2 already committed).

---

## Out of scope (note for the reviewer)

- **Drift-monitor grouping.** `monitor` groups parse-success by `ingest_log.from_addr`, which stays the iCloud forwarder for all forwarded mail. This plan does not rewrite stored `from_addr`, so forwarded banks are lumped under one sender for drift stats. Revisit only if drift detection on forwarded mail becomes necessary.
- **Heuristic merchant-regex hardening.** The heuristic's `merchantRe` can still match a stray `To:`/`From:` line in *non-forwarded* malformed mail. After this fix, forwarded bank mail no longer reaches the heuristic with a preamble, so this is not exercised; leave the regex as-is (YAGNI) unless a real non-forwarded case appears.
- **AI-tier changes.** None. The fix deliberately routes forwarded mail back to the deterministic template tier.

---

## Self-Review

**Spec coverage:** The request was "handle forwarded mail; stop confusing the txn title with the forwarded mail's author." Task 1 recovers the original sender (fixes template matching) and strips the preamble (removes the `To:`/`From:` line the heuristic mis-read as merchant). Task 2 wires it into the live parse path. Task 3 backfills the 52 real forwarded emails and verifies the `salehtl` merchant is gone. Covered.

**Placeholder scan:** No TBD/TODO/"handle edge cases". Every code step shows full code; every command shows expected output.

**Type consistency:** `Unwrap(from, subject, body string) (string, string, string)` is defined in Task 1 and consumed with the same signature/return order in Task 2. Regex names (`forwardMarkerRe`, `fwdSubjectRe`, `fwdHeaderLineRe`) are used consistently. Test helpers (`procTestStore`, `dibCascade`, `store.IngestRecord`, `InsertIngest`, `store.SelectForParseOpts`) match the existing `processor_test.go`. `parse_tier` column name confirmed against `MarkParsed`/`SelectForParse`.
