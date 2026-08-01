# v2 seed templates: full-corpus validation record

**Status: PASS.** This document is spec §3.5's ship condition for Phase 1 —
"ported templates must reproduce the existing three parsers' output over the
full 3-year corpus before Phase 1 ships". Phase 1 does not ship without this
page showing a pass.

- **Gate run:** 2026-08-01
- **Gate:** `internal/v2/tmpl/seed` → `TestSeedTemplatesReproduceV1OverTheFullCorpus`
- **Corpus:** a root-made `.backup` snapshot of `/var/lib/ledger/ledger.db`,
  **7,004 messages**, `ingest_log` ids 1–7004, `received_at` spanning
  2023-07-10T17:21:54Z → 2026-08-01T13:18:34Z (three years of the operator's
  real bank mail).
- **Command:**

  ```bash
  sudo sqlite3 "file:/var/lib/ledger/ledger.db?mode=ro" ".backup '$S/t21-corpus.db'"
  sudo chown "$(id -un)" "$S/t21-corpus.db"
  LEDGER_CORPUS_DB=$S/t21-corpus.db go test ./internal/v2/tmpl/seed/ \
    -run TestSeedTemplatesReproduceV1OverTheFullCorpus -count=1 -v -timeout 30m
  ```

## Result

```
corpus: 7004 messages, v1 template hits: 5719, mismatches: 0, v2 misses: 0, new matches: 0
detail: v2 hits 5719, ambiguous 0, agreed-no-transaction 1285, v2 normalizer failures 0
per template: dib.account.v1=659 dib.card.v1=4997 enbd.alert.v1=1 enbd.transfer.v1=62
v1 template hits per sender: dib.notification@dib.ae=5651 onlinebanking@emiratesnbd.com=62 other=6
```

| criterion | required | measured |
|---|---|---|
| mismatches | 0 | **0** |
| v2 misses | 0 | **0** |
| ambiguous (two seeds claiming one message) | 0 | **0** |
| new matches | allowed, each listed | **0** |

All eight fields are compared on every message v1's template tier extracted:
`status`, `amount_minor`, `currency`, `direction`, `posted_at`, `merchant`,
`last4`, `is_transfer`.

`agreed-no-transaction: 1285` is the two implementations agreeing that a message
is not a transaction — DIB statement, marketing and service mail, plus messages
whose format no template anchors on. Both sides decline all 1,285.

## The four templates

v1 has three parsers; the port has four, because v1's `DIBParser` handles two
unrelated layouts behind one `Matches` and chooses between them with
`isCard := strings.Contains(textBody, "إشعار مشتريات")` and an early return.
That branch is control flow; a declarative template has none, so it becomes two
templates whose `Match` blocks are complements.

| template | ports | corpus hits | date source |
|---|---|---|---|
| `dib.card.v1` | `DIBParser`, card-purchase half | 4,997 | body (`بتاريخ`) |
| `dib.account.v1` | `DIBParser`, account-transaction half | 659 | body (`بتاريخ`) |
| `enbd.transfer.v1` | `ENBDParser` | 62 | body (`Transaction Date:`) |
| `enbd.alert.v1` | `ENBDAlertParser` | 1 | email |

`TestDIBSeedsPartitionEveryDIBMessage` pins the complement property with no
corpus, so the pair can never drift into overlapping or leaving a gap.

The two ENBD templates share `sender_domain: ["emiratesnbd.com"]` — v1
distinguishes them by local part (`onlinebanking@` vs `alert@`), which the
template format deliberately does not gate on, since the trusted lane verifies a
DKIM signing *domain*. They are disambiguated by body shape instead, and the
gate's `ambiguous: 0` over all 63 ENBD messages is the evidence that the
disambiguation holds.

## Adjudication

Every difference the gate has ever reported, and its disposition.

### D1 — six messages, v2 miss — HARNESS DEFECT, fixed

The first full-corpus run reported `mismatches: 0, v2 misses: 6`:

```
ingest_log ids 2554, 6850, 6853, 6854, 6855 (dib.card.v1) and 6973 (enbd.alert.v1)

id 2554: V2 MISS
  v1: amount=12400 AED debit posted=2026-06-18T00:00:00Z merchant="NOIRO CAFE" last4="7502"
    2| "إشعار مشتريات بتاريخ 18-06-2026 18:03 بالتفاصيل التالية."
    3| "رقم البطاقة"
    4| "462467XXXXXX7502"
    6| "المبلغ"
    7| "AED 124.00"
    8| "الدفع الى"
    9| "NOIRO CAFE"

id 6973: V2 MISS
  v1: amount=25000000 AED debit posted=2026-07-24T16:11:00Z merchant="" last4="3701"
    3| "AED 250,000.00 has been withdrawn from your account 067XXX17XXX01. ..."
```

Every anchor the template needs is present in the normalized text, and the
template extracts all of them. The miss was in the harness: all six messages are
inline forwards, and the gate was passing `ingest_log.from_addr` — the
FORWARDER's address — to the v2 sender gate while v1 gates on the address
`parse.Unwrap` recovers from the inner header block. The two halves disagreed
about who sent the mail.

**Disposition: harness fixed, not sanctioned and not absorbed.** The gate now
passes `norm.Result.From`, which is v2's own effective-From and the exact
counterpart of v1's unwrapped one; `internal/v2/norm`'s corpus gate requires
those two to be equal on every message, so the swap is like-for-like rather than
a second approximation. After the fix: 0 misses, and all six extract identically.

### D2 — none

No message produced a differing value on any of the eight fields, before or
after D1. There is no sanctioned-divergence list because there is nothing on it.

### New matches — none

`new_matches: 0`. v2 matched no message v1's template tier declined, so there is
nothing to justify here.

## Divergences that produce no corpus difference

These are real differences between v1's code and the ported templates. Each is
recorded with the measurement showing the corpus cannot exhibit it, so that a
future format change makes the difference visible rather than surprising.

| # | v1 | seed | corpus occurrences |
|---|---|---|---|
| 1 | `ParseAEDToFils` re-splits the captured amount with its own case-SENSITIVE `([A-Z]{3})` | the pattern splits `ccy` / `amt` up front, under `flags:["i"]` on the ENBD templates | **0** messages write a lower-case currency code after the amount anchor |
| 2 | `(?:[A-Z]{3}\s*)?` — the currency may be followed by any whitespace, including a newline, or none | `(?P<ccy>[A-Z]{3} )?` — exactly one space | **0** messages put the currency on its own line; **0** write it with no space |
| 3 | `[0-9][0-9,]*` — unbounded integer run | `[0-9][0-9,]{0,24}` (Task 20's ReDoS bound: unbounded, this anchor cost 333,859 ms on a 1 MB body in Bun) | **0** amounts have more than 24 characters before the point; `int64` tops out at 19 digits |
| 4 | `enbdAlertDebitRe` allows `[\d,]+`, i.e. a leading comma | `[0-9][0-9,]{0,24}` requires a leading digit | none — v1's own `ParseAEDToFils` re-extracts with `[0-9][0-9,]*`, so v1's *value* already requires the leading digit |
| 5 | `(\S+)` for both last4 anchors | `([^ \n]+)` — `\S` is banned by the dialect; this is its exact meaning on normalized text | **0** account lines and **0** card lines contain a space |
| 6 | `(.+)` for every text capture | `([^\n]+)` — Go's `.` and JavaScript's `.` disagree on `\r`, U+2028 and U+2029 | none; the normalizer emits none of the three |
| 7 | `strings.ToUpper` then `HasSuffix`/`Contains` | `flags:["i"]` with the literal in upper case | **0**; every corpus description is already upper case |

Item 1 is the one with a real behavioural edge: a body reading `usd 99.99`
would be AED to v1 (its currency group is case-sensitive even under `(?i)`) and
USD to v2. v2 is right and v1 is wrong, the corpus contains no such message, and
recording it here is the whole of the disposition.

## How the two-override problem was resolved

v1 computes the account layout's direction in two steps (`dib.go:68-91`): a
total four-way cascade, then a re-derivation from the uppercased description
suffix that WINS over whatever the cascade decided.

Transcribed literally, that needs `override` **twice** — once for the `DEBIT`
suffix and once for `CREDIT` — and `ValidateDefinition` permits it once, on
purpose ("a second use means the first-entry-wins rule is being worked around
rather than expressed"). A single override reproduces only v1's `DEBIT` half.

**The format did not need to change.** "Later entry wins" and "earlier entry
wins" are the same relation read from opposite ends. The suffix rules are
unconditional winners, so putting them FIRST and letting rule 3 — the first
entry to produce a value for a field wins, later entries are skipped — suppress
the cascade behind them is not an approximation of v1's shape; it is the same
function. `dib.account.v1` therefore carries **six ordered direction entries and
no `override` at all**:

```
1  debit   المعاملة\n[^\n]*DEBIT(?:\n|$)      flags:["i"]   v1's suffix re-derivation, DEBIT half
2  credit  المعاملة\n[^\n]*CREDIT(?:\n|$)     flags:["i"]   ... and CREDIT half
3  credit  إشعار إيداع                                      cascade arm 1
4  debit   إشعار خصم | إشعار سحب                             cascade arm 2
5  debit   من الحساب                                        the conditional default
6  credit  (no patterns)                                    the unconditional default
```

`TestSeedDirectionCascadeNeedsNoOverride` pins the order and the absence of
`override`, so a later edit cannot quietly restore the problem.

**The corpus cannot check this, and that is measured, not assumed.** 312
account-layout messages carry a `DEBIT`/`CREDIT` description suffix — the branch
is well covered — and on **all 312** the suffix agrees with what the cascade
already decided. It overrides it **zero** times. Deleting either suffix rule, or
moving both behind the cascade, changes nothing over three years of real mail.
So the full-corpus pass says nothing whatever about the override question; the
synthetic differential test does, with cases where the two rules disagree by
construction (`deposit notice with a DEBIT suffix`, `debit notice with a CREDIT
suffix`, `withdrawal notice with a CREDIT suffix`).

## What the gate would have caught

26 plausible one-edit template defects were measured against both halves.

- **Corpus gate: 15/26.** The ones it catches, it catches hard — the hamza
  misspelling of `الدفع الى` breaks 4,997 messages, an `amt` group that swallows
  `"AED "` turns all 4,997 into misses, dropping DIB's `TRNSFER` misspelling
  loses 23 `is_transfer` flags and dropping the correctly-spelled `TRANSFER`
  loses 339.
- **Synthetic differential table: 26/26**, including all eleven the corpus
  cannot see (both suffix rules, the entry order, both `(\S+)` captures, the
  `من الحساب` arm, the deposit-notice arm, the unconditional default, the
  case-insensitive flags, ENBD's date-only fallback layout, and the alert
  template's entire credit branch).
- **Union: 26/26.** Three of them (`card last4 -> whole line`, `card merchant
  capture crosses lines`, `deposit-notice rule deleted`) escaped BOTH on the
  first pass, because the synthetic inputs were too weak — a trailing token with
  no digits in it, a merchant on the last line of the body, and a deposit notice
  with no competing `من الحساب`. The inputs were strengthened rather than the
  finding waved away.

The full table is in `corpus_gate_test.go`'s header comment.

## Anti-regression guards (no corpus required)

`scripts/v2-check.sh` runs these on every checkout, including ones that have
never seen the v1 database:

- `TestSeedDefinitionsArePublishable` — all four pass `tmpl.ValidateForPublish`
  and target the current normalizer version.
- `TestSeedAnchorsAreByteIdenticalToV1` — every Arabic anchor is re-derived from
  `internal/parse/dib.go`'s own source and compared byte-for-byte, and the hamza
  spelling `الدفع إلى` is asserted absent. The JSON was GENERATED by extracting
  those literals from `dib.go`; no anchor in the seed set has been typed.
- `TestDIBSeedsPartitionEveryDIBMessage` — the card/account complement.
- `TestSeedDirectionCascadeNeedsNoOverride` — the direction entry order.
- `TestSeedReproducesV1OnTheBranchesTheCorpusNeverExercises` — 36 synthetic
  differential cases; v1's parser computes the expectation on every run.

The corpus gate itself carries two floors, because a gate that passes on an
empty corpus is not a gate: `recordedCorpusSize = 7005` (a snapshot below 90% of
it is truncated, stale or the wrong file — `ingest_log` is append-only) and
`recordedV1TemplateHits = 5719` (a corpus of the right size whose mail no longer
reaches the template tier would compare non-results to non-results and report
zero mismatches). `LEDGER_CORPUS_DB` set but unusable is a FAILURE, not a skip.

## Re-baselining

When the live instance has ingested enough new mail to move the numbers, re-run
the command at the top, then update `recordedCorpusSize`,
`recordedV1TemplateHits` and the Result block above in the same commit. Both
constants are floors with a 10% band, so they need updating only when the
corpus grows substantially — never to make a failure go away.

## Known follow-up

`internal/v2/tmpl/testdata/` holds its own copies of `dib.card.v1.json`,
`dib.account.v1.json` and `enbd.alert.v1.json`, used as executor test fixtures
and as the source of `conformance/templates/`. They are now a SECOND copy of
three of the four published seeds and they differ from this package:

- `dib.account.v1` there still carries the single `override` entry and no
  `CREDIT` suffix rule (it reproduces only half of v1);
- both DIB last4 captures there are `[^\n]+` rather than `([^ \n]+)`, v1's
  `(\S+)`;
- the card merchant capture there is `[^\n]*` rather than `([^\n]+)`, v1's
  `(.+)` — outcome-identical (an empty capture is a conversion failure either
  way), but it emits an `empty_groups` diagnostic where v1 simply finds nothing;
- there is no `enbd.transfer.v1` at all, so v1's `ENBDParser` — the 62-message
  "Local Bank Transfer" advice format — has no template there.

`internal/v2/tmpl/seed` is the canonical published set. `testdata/` should be
sourced from it and `conformance/templates/` regenerated, which is a change to
the cross-executor fixtures and so belongs to whoever owns that suite rather
than to this task.
