# ENBD "Transaction advice" alert parser + email-date fallback

**Date:** 2026-07-24
**Status:** Approved (user pre-approved autonomous design; assumptions below)
**Trigger:** ingest_log row 6973 — an iCloud-webmail forward of an Emirates NBD
"Transaction advice for account ending with 3701" (AED 250,000.00 withdrawal)
sits `unparsed`.

## Problem

ENBD sends per-transaction "advice" alerts from `alert@emiratesnbd.com` to the
user's iCloud address; they reach the ledger mailbox as iCloud-webmail forwards.
Diagnosis of row 6973 showed:

1. `parse.Unwrap` **works** on these forwards — the HTML part preserves line
   structure, so the marker and Apple-Mail-style header block unwrap cleanly and
   the original sender (`alert@emiratesnbd.com`) and subject are recovered.
2. No template matches `alert@emiratesnbd.com`. The existing `ENBDParser` only
   matches `onlinebanking@emiratesnbd.com` transfer advice (different format).
3. The advice body carries **no transaction date** — the only timestamp is the
   forwarded `Date:` header, which `Unwrap` currently discards — so the
   heuristic tier fails `Validate` with `posted_at must be set`.
4. The AI tier is disabled, so the row lands `unparsed` (correctly retained,
   recoverable via reprocess).

## Decision

Add a deterministic template for this format plus a narrowly-scoped date
fallback. Rejected alternatives: enabling the AI extraction tier (violates
deterministic-first for a now-known format; per-email cost; lands in review as
low-confidence anyway) and one-off manual entry (the next advice email breaks
again).

## Design

### 1. `Unwrap` recovers the forwarded `Date:` header

`internal/parse/forward.go` — `fwdHeaderLineRe` already matches the `Date`
label; capture it like `From`/`Subject`. New signature:

```go
func Unwrap(from, subject, body string) (effFrom, effSubject, fwdDate, effBody string)
```

`fwdDate` is the raw header value (`"Jul 24, 2026 at 4:11 PM"`), empty for
non-forwards. Single production caller (`processor.go`) plus tests.

### 2. `ParseForwardDate`

New helper in `forward.go`: parses the recovered date string against a small
list of known forward-header layouts (Apple webmail `"Jan 2, 2006 at 3:04 PM"`,
Gmail `"Mon, Jan 2, 2006 at 3:04 PM"`, and Apple Mail app
`"2 January 2006 at 15:04:05"` with a trailing zone token tolerated/stripped).
Returns zero time + error when nothing matches. Times are naive (no zone), like
every other parser date in the codebase.

### 3. Cascade: template-tier `posted_at` fallback

`Cascade.Run` gains a fallback date:

```go
func (c *Cascade) Run(ctx context.Context, from, subject, textBody string, fallbackDate time.Time) Result
```

In the **template tier only**: when `bp.Parse` succeeds but `PostedAt` is zero,
set `PostedAt = fallbackDate` before `Validate`. Zero fallback → `Validate`
fails exactly as today. The heuristic and AI tiers are untouched — the
heuristic must keep requiring a body date (safety property: it runs against
arbitrary senders; only a template that *knows* its format carries no body date
may opt in by returning zero `PostedAt`).

`Processor.ProcessPending` computes the fallback: `ParseForwardDate(fwdDate)`
when it parses, else the ingest row's `received_at`. The forwarded header date
wins because a forward can happen days after the transaction; for direct
(non-forwarded) alert mail `received_at` ≈ send time, which is correct.

### 4. Store: `ReceivedAt` on `IngestForParse`

`SelectForParse` additionally selects `received_at`; `IngestForParse` gains
`ReceivedAt time.Time` (empty/NULL → zero time).

### 5. `BankParser.Parse` gains the subject

The advice **subject** carries the only clean account identifier
("account ending with 3701"); the body's account number is masked
(`067XXX17XXX01`). Change the interface:

```go
Parse(subject, textBody string) (ParsedTxn, error)
```

`DIBParser`/`ENBDParser` ignore the new argument. Call site is `cascade.go`;
tests updated mechanically.

### 6. New `ENBDAlertParser` (`internal/parse/enbd_alert.go`)

- `Bank() = "enbd"`.
- `Matches`: `from` contains `alert@emiratesnbd.com` (case-insensitive).
  Matches both direct mail and unwrapped forwards, since `Unwrap` restores the
  original sender.
- `Parse`:
  - Debit anchor: `AED 250,000.00 has been withdrawn from your account` →
    regex on `(?i)((?:[A-Z]{3}\s*)?[\d,]+\.\d{2}) has been (withdrawn|debited) from your account`,
    amount via `ParseAEDToFils`.
  - Credit anchor: `has been (credited|deposited) (?:to|in)(?:to)? your account` → credit.
    (Wording for the credit variant is inferred from ENBD's standard advice
    copy; the debit variant is verified against the real row-6973 sample.)
  - `Last4`: from subject `account ending with (\d{4})`; empty when absent.
  - `PostedAt`: zero — opts into the cascade fallback (§3).
  - `MerchantRaw`: empty. These advices are account-level (ATM/branch/transfer)
    with no merchant; the transaction lands in `needs_review` for manual
    categorization, and the existing transfer-leg matcher may pair it.
  - `Confidence`: 0.9 (template tier, but the date is inferred from the email
    rather than stated in the body — slightly below the 0.95 of body-dated
    templates).
- Wire into `cmd/ledger/main.go`: `Parsers: []parse.BankParser{parse.DIBParser{}, parse.ENBDParser{}, parse.ENBDAlertParser{}}`.

## Error handling

- Advice mail whose body matches no anchor → template error → falls through to
  heuristic/AI exactly as today; row stays recoverable in `ingest_log`.
- Unparseable forwarded date → fallback to `received_at`; both zero →
  `unparsed` with `posted_at must be set`, same as today.
- `Validate`'s future-date guard still applies to fallback dates.

## Testing

TDD throughout; fixtures use the real row-6973 text with account digits
redacted.

1. `forward_test.go`: webmail forward → recovered date string; non-forward →
   empty; existing cases keep passing with the new return value.
2. `ParseForwardDate`: the three layouts, plus garbage → error.
3. `enbd_alert_test.go`: withdrawal sample → debit / 25,000,000 fils / AED /
   `Last4 "3701"` / zero `PostedAt`; credit variant; non-advice body → error.
4. `cascade_test.go`: template returning zero `PostedAt` gets the fallback;
   zero fallback still → `unparsed`.
5. `processor_test.go`: end-to-end raw-email fixture → transaction inserted
   with `posted_at` = forwarded header date, `needs_review`.

## Rollout

1. `go test ./...`, build binary (frontend untouched — dist rebuild only if
   main has moved under a parallel session).
2. Deploy per runbook: root DB backup, install, restart, verify the running
   process loaded the new binary.
3. `POST /api/reprocess` (manual path has no attempt cap) → row 6973 upgrades
   to `parsed`/`template`, inserting the AED 250,000.00 debit dated
   2026-07-24 16:11 with last4 3701.

## Assumptions (user away; decided autonomously)

- ENBD advice mail keeps arriving as iCloud forwards; direct delivery may start
  later — both paths are covered by the same parser.
- English-language advice copy only.
- Flattened `text/plain`-only forwards (no HTML part) remain unsupported —
  iCloud webmail always includes an HTML part; revisit only if a real sample
  fails.
- The AED 250k transaction is inserted as a normal `needs_review` debit; if it
  is one leg of a self-transfer the existing matcher/manual review handles it.
