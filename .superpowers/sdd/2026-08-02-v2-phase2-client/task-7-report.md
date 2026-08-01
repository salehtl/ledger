# Task 7 — `unparsed` and zero-amount ops in the replay engine

**Commit:** `6a97cb4` `feat(v2): decode unparsed and zero-amount ops in the replay engine`
**Parent:** `4ddf942` (Task 0/4, the platform seam, landed mid-task)
**Gate:** `bash scripts/v2-check.sh` → exit **0**, `v2-check: OK (go + client + conformance)`
**Mutation score:** **30/30**

---

## 1. What was built

### The gap, precisely

`internal/v2/ingest/pipeline.go` appends an op for every accepted message,
resolved or not (step 7: *"nothing matched — still appended, flagged
unparsed"*). `txnPayloadOf` builds that op from a zero-valued
`tmpl.Extraction`, so the payload is literally:

```json
{"amount_minor":"0","currency":"","direction":"","posted_at":"…","merchant_raw":"",
 "last4":"","is_transfer":false,"tier":"none","needs_review":true,"unparsed":true,
 "normalizer_version":3}
```

Every one of those three money fields was refused by the TypeScript decoder —
`positiveMoney` throws at zero, `currencyOf` requires three letters, `direction`
requires `debit|credit`. So the op raised `PayloadError`, became an
`invalid_payload` anomaly, and **no row was materialized**. The review queue's
entire input was missing, which is why the plan makes this a foundation task
(`7 → {18, 19, 21}`, `7 → 24`).

### `Txn` gains three fields

```ts
unparsed: boolean;
tier: "template" | "heuristic" | "none";   // exported as ParseTier
parse_error: string | null;
```

`direction` widened to `"debit" | "credit" | ""`, because the type was
previously lying about a value the wire can carry.

### The decode contract is a biconditional, not a relaxation

The naive fix is "allow zero when `unparsed`". That is half a rule, and the
missing half is the dangerous one. `decodeTxnPayload` now holds the two shapes
to each other in **both** directions:

| rule | why |
|---|---|
| `unparsed: true` ⟹ `amount_minor === "0"` | a row flagged unparsed is excluded from every total on the device; one carrying a real amount is money the user paid for that they will *never see* |
| `unparsed: true` ⟹ `currency === ""`, `direction === ""` | same, one field at a time |
| `unparsed: true` ⟹ `tier === "none"` | no cascade both produces a transaction and reports nothing extracted |
| `unparsed: true` ⟹ `needs_review !== false` | the review queue is the only surface such a row has |
| `unparsed: false` ⟹ `amount_minor > 0n` | unchanged; Go refuses zero upstream (`carriesMoney`) for exactly this reason |
| `parse_error !== null` ⟹ `unparsed` | a parsed row has no reason for failing |

The **converse of the tier rule is deliberately not enforced**: `tier: "none"`
with `unparsed: false` is every client-authored op — CSV import (Decision 9),
manual entry — and those carry real money. An absent `tier` reads as `"none"`
for the same reason, and an absent `unparsed` reads as **`false`** (a writer
that omits the flag is claiming money). The whole pre-existing 1,969-test suite
exercises the absent-field path, which is why the parsed builder in
`replay.test.ts` still omits both fields by default.

Violations are `PayloadError` → `invalid_payload` anomaly: visible, non-fatal,
nothing dropped, using the mechanism the engine already has for a payload it
cannot read.

### Aggregate exclusion

- `markPending` refuses unparsed rows. Their currency is `""`, which `rate_set`
  cannot name (`currencyOf` requires three letters), so the bucket they would
  sit in is one **no op in the vocabulary can ever drain** — it would grow with
  every unresolved message for the life of the log. The guard is in
  `markPending` rather than at the two call sites because that is where the
  index's meaning is defined, and it covers `freezeIfPossible` and
  `applyTxnEdit` with one line.
- `countsTowardMoney(t)` is the single place the "may an aggregate sum, count or
  bucket this row" rule lives, so a total, a count, a direction split and a
  currency breakdown cannot answer it differently. Tasks 18/19/21 call this
  rather than re-deriving it. `client/src/net/client.ts`'s `stateToJSON` (the
  `cli state --json` surface) now emits the three fields, because without them
  an operator inspecting an alpha's log sees an unparsed row as an ordinary
  zero-amount debit.
- `applyTxnEdit` refuses `amount_home_minor` on an unparsed row with an
  `unsupported_edit_field` anomaly. Without it, §3.7:137's explicit-recompute
  edit is a legal user op that makes `I12` report a hard stop.
- `unparsed`, `tier` and `parse_error` were added to `PARSE_OWNED`. They come
  from the parse, and `txn_superseded` is the op that changes them. This matters
  even though `applyTxnEdit` never assigns them: a decoder that simply does not
  read a key ignores it *silently*, and a client correcting a row would watch its
  op land, consume a version and change nothing.

### `I12_money_shape`

Rewritten as a two-sided rule (see §5 for the mutant). It also shape-checks
`unparsed` itself: every branch keys on that flag, so a truthy string there would
read as unparsed and switch the money rules off entirely — the checker disarmed
by the field it uses to decide.

---

## 2. The fingerprint collapse

`state.ts:295` computed `${last4}|${amount_minor}|${direction}|${merchant_raw}|${day}`.
For an unparsed row every one of those four fields is empty, so the value is
`||0|||2026-06-11` for **every unresolved message on that day** — they all
fingerprint identically and each becomes a `possible_duplicate` of the first.
Phase 1's exit run produced 18 such anomalies from a corpus of two distinct
messages; at alpha scale it is one review item per unread message per day.

**Resolution:** an unparsed row fingerprints on `` `unparsed|${t.ingest_id}` ``.

Three properties make this the duplicate heuristic *applied* to an unparsed row
rather than a special case that opts out of it:

1. **`ingest_id` is the right discriminator, not merely a unique one.** It is
   the sha256 of the raw body — exactly the identity dedup already keys on
   (§3.3:67) — and `liveByIngestID` guarantees at most one live row per value: a
   second ingest of the same email is a `duplicate_ingest` anomaly, and a
   supersede unindexes its predecessor before the successor is indexed. So the
   heuristic is not weakened; a genuine re-ingest is still caught, by the
   stronger check.
2. **The two namespaces are disjoint structurally, not by convention.** The
   parsed form emits four separators unconditionally, so any value with fewer
   than four is unreachable from it *no matter what a merchant contains*. This
   matters because `|` is deliberately unescaped: a discriminator relying on a
   prefix no merchant happens to spell would be a rule a user could break by
   typing. There is a test that folds a transaction whose `merchant_raw` is
   literally `unparsed|<the other row's ingest id>` and asserts no collision.
3. **No edit can move a row out of its bucket.** `merchant_raw`, `last4` and
   `posted_at` are all editable and none of them is in the unparsed key, so
   `applyTxnEdit`'s reindex path is a no-op for these rows and the review queue
   stays stable while a user edits it.

Four unparsed messages on one day, plus a template-fix supersede, are now in the
**replay sample log** and three more in the **FX sample log**, so every
determinism, chunk-stability and prefix-monotonicity proof in the suite folds
over them.

---

## 3. The wall clock inside `fingerprint()` — and the crash it was hiding

The brief flagged `new Date(parseInstantMs(t.posted_at)).toISOString().slice(0, 10)`
as a portability hazard. Investigating it turned up a **live fold-crashing bug**,
reachable from a wire-legal payload.

`RFC3339` in `wire/op.ts` admits a four-digit year with a UTC offset of up to
±23:59. So `9999-12-31T23:59:59-23:59` is legal and lands in year 10000.
`instant()` stored `canonicalTime(v)`, which is `new Date(ms).toISOString()` —
ISO **expanded-year** form, `"+010000-01-01T23:58:59.000Z"`. Then:

- `.slice(0, 10)` reads `"+010000-01"` — a truncated fragment, not a date;
- worse, getting there re-parsed the stored string, and `parseInstantMs`
  **refuses** the expanded form (its grammar has exactly four year digits), so
  `fingerprint` threw `BlobDecodeError` from inside `createTxn`. That is not a
  `PayloadError`, so it escaped `applyOp`'s catch and **took down the whole
  fold**. One legal message and the device can never sync past it, because every
  subsequent sync re-folds the same prefix.

Verified empirically before writing the fix; there is a named regression test
(`the fold survives an unreadable posted_at even when it is the only op`).

Two changes:

1. **`utcDay(epochMs)`** replaces the `Date` round trip — Howard Hinnant's
   civil-from-days on a March-based year, pure integer arithmetic, no `Date`, no
   allocation, total over every finite input. Pinned against the expression it
   replaces over ~4,000 pseudorandom instants plus hand-picked boundaries (epoch
   0, −1, leap days, century non-leap, pre-1970) everywhere that expression was
   trustworthy at all. `state.ts`'s file-header "no wall clock" bullet — which
   covered only `Date.now()` — was corrected to the stronger claim it now earns.
2. **`instant()` refuses a timestamp whose canonical form cannot be read back.**
   The check is the round trip itself (`parseInstantMs(canonicalTime(v))`) rather
   than a year-range test, so it cannot drift from whatever `canonicalTime`
   actually produces. Such a payload becomes an ordinary `invalid_payload`
   anomaly and the log either side of it keeps folding.

**A cross-executor finding this surfaced, recorded and not fixed here:** Go's
`Format(RFC3339)` renders year 10000 as `10000-01-01T…` and JavaScript's
`toISOString` as `+010000-01-01T…`. So `oplog.canonicalTime` and
`wire/op.ts:canonicalTime` **already disagree** on this range. Refusing the value
is the right answer on both sides, but the Go half of that refusal is not
written, and `wire/op.ts` is outside this task's file list and is a dual-executor
contract. Flagged in §7.

---

## 4. TDD evidence

Failing-first, in order:

1. Tests written and run before any implementation — 5 failures + 1 unresolved
   import (`countsTowardMoney` not exported), including the plan's five named
   tests verbatim.
2. Implementation in `state.ts` / `replay.ts` / `check.ts`.
3. Re-run: the expanded-year test **still failed**, with the exact
   `BlobDecodeError` escaping the fold — which is how the root cause in §3 was
   found rather than assumed. Fixed in `instant()`, test rewritten to assert the
   refusal rather than a fabricated day.
4. Typecheck caught `direction: ""` against the narrow type; widened.
5. Mutation run scored 25/30; **five escaped mutants were real gaps in my own
   tests**, closed (§5), re-run to 30/30.

Counts, measured on a scratch copy of `HEAD` and `HEAD + this change` under
identical conditions:

| | collected | pass | skip | fail |
|---|---|---|---|---|
| `4ddf942` (pristine) | 1969 | 1932 | 37 | 0 |
| `+ Task 7` | 1986 | 1949 | 37 | 0 |

+17 tests, **no pre-existing test removed, skipped or weakened**, same 37 e2e
self-skips, `expect()` calls 11,272 → 13,853.

`bash scripts/v2-check.sh` exit **0** (the script's own status, captured
directly), printing `v2-check: OK (go + client + conformance)` with 1,985 client
tests run including the e2e round trip. **The `fx.test.ts` 5 s fold timeout did
not fire in any of the four gate runs**; its limit was not touched.

---

## 5. Mutation testing — 30/30

Battery in `scratchpad/mutate.mjs`: 30 hand-written defects, each applied to a
scratch copy, `bun test src/replay/ src/invariants/` run, file restored. A mutant
is caught when the suite goes red.

Covered: dropping the unparsed fingerprint branch (the Phase 1 state); keying it
on the day or on a constant; losing the namespace prefix; five `utcDay` defects
(era origin, `trunc` vs `floor`, month wrap, Jan/Feb year carry, year padding);
removing the `markPending` and `countsTowardMoney` guards; each of the six decode
rules independently; dropping the flag on the way into the row; emptying
`PARSE_OWNED`; removing the `amount_home_minor` edit guard; removing the
`instant()` round trip; and six `I12` defects including the plan's named one
(`else if (t.unparsed === true)` → `else if (true)`, i.e. accept zero everywhere).

**The five that escaped on the first run are the finding worth recording**, and
they are precisely the Phase 1 lesson the brief named. My "a zero-amount parsed
txn is NOT the same thing as unparsed" test used a **compound** payload that
broke three rules at once (`unparsed: true` with amount *and* currency *and*
direction). That payload stays refused with any one of the three checks switched
off, so the test was red for the wrong reason and three rules were unpinned while
every test was green — a check true by construction rather than by measurement.
It was rewritten as a table of **one-field-per-case** violations, each rule the
only thing that can refuse its case. Same for `tier` and `parse_error`, neither of
which had a test at all. Score went 25/30 → 30/30 by fixing the tests, not the
threshold.

---

## 6. Conformance

**The conformance suite needed no changes, and it is worth being explicit about
why rather than reporting a green run.**

- **No Go executor computes `fingerprint()`.** Verified by search:
  `internal/store/transactions.go:61`'s `Fingerprint()` is **v1** — a different
  system, a different formula (`sha256(...)` with a normalized merchant), a
  different database. Nothing under `internal/v2/` computes the v2 value. So
  changing its shape breaks no cross-executor contract today.
- **There is no Go replay/fold executor at all.** `conformance/fx` is written by
  `client/scripts/gen-fx-conformance.ts` and read only by `fx.test.ts`; its own
  header says it is "written for a reader that has not been born" (Phase 3). No
  Go test reads that directory.
- **The FX fixtures were unaffected.** They pin `snapshots`, `rates`, `pending`
  and `anomalies` — not whole serialized `Txn` records — so three new `Txn` fields
  do not touch them. The freshness assertion (`assertFXCasesAreFresh`) passes
  unchanged, and the new `unparsedIngest` builder is exported from the generator
  without being used by any case, deliberately: an unparsed row has no currency,
  takes no part in FX, and pinning one would state a rule about a value that does
  not exist.
- **`conformance/op` / `conformance/blob` / `normalizer` / `templates` /
  `dialect`** are wire-framing and extraction contracts, untouched.
- The Go side needed **no matching change**: `txnPayload` in `pipeline.go`
  already emits `tier` and `unparsed`, and this task teaches the TypeScript half
  to read what Go has been writing since Phase 1.

`go vet ./internal/v2/... ./cmd/ledgerd` and `go test -count=1` ran clean inside
the gate.

---

## 7. Concerns

1. **`parse_error` has no closed set, because the pipeline defines none.**
   `txnPayload` in `pipeline.go` has no such field, so every op in existence omits
   it and it decodes as `null`. Enumerating four plausible reasons here would be
   inventing protocol for a writer that emits none, and would then refuse the
   fifth reason Go eventually adds. What **is** enforced is the half that carries
   the risk and is this executor's to enforce: a short lower-snake token
   (`^[a-z][a-z0-9_]{0,63}$`), never free text. This op rides in the **hot**
   stream, which the hot/cold split exists to keep email bodies out of, so a
   free-text reason would put a fragment of a message body into the one lane
   designed not to hold one — and in Phase 3, into a differently-keyed one. When
   the pipeline gains reasons, the value set belongs in `replay.ts` beside
   `TIERS`.
2. **`canonicalTime` disagrees across executors past year 9999** (§3). Refusing
   the value in `instant()` closes the TypeScript fold's exposure; the Go half is
   unwritten and `wire/op.ts` / `internal/v2/oplog` is a dual-executor contract
   outside this task's file list. Low severity (the range is absurd), but it is a
   *silent byte-level* disagreement, which is the category §3.3:80 cares about.
3. **`countsTowardMoney` has no production caller yet** — only tests and the
   `Txn.unparsed` doc. That is by design (Tasks 18/19/21 own the screens) but it
   means the "every aggregate excludes unparsed rows" claim is enforced by
   convention until those tasks call it. Each of them should, and a reviewer of
   Task 21 should check it does.
4. **`is_transfer` and `normalizer_version` are still undecoded.** Go emits both
   in every `txn_ingested` payload and the TypeScript `Txn` carries neither. Out
   of scope here (the plan names three fields), but `is_transfer` is a budget
   concern — a transfer is not spending — and Task 21 will need it. Not a
   regression; noting it so it is not discovered as one.
5. **This worktree is heavily concurrent.** Three other sessions were editing
   `client/src` during this task: Task 0/4's platform seam landed as `4ddf942`
   **mid-task** (moving `HEAD` under me), Task 6's invite-code work is live in
   `client/src/net/client.ts` right now, and the shared index carried staged
   deletions of `client/src/platform.ts`. Every verification run in this report
   was taken on a `git archive HEAD` scratch tree with only my files overlaid, and
   the commit was built through a temporary index with `client/src/net/client.ts`
   staged as a reconstructed `HEAD + my six lines` blob. `git show --name-only`
   confirms eight files and `git cat-file -e HEAD:client/src/platform.ts`
   confirms nothing was reverted.

---

## 8. Files changed

| file | what |
|---|---|
| `client/src/replay/state.ts` | `ParseTier`; three `Txn` fields; `direction` widened; `countsTowardMoney`; `utcDay`; `fingerprint` unparsed branch; `markPending` guard; header claim corrected |
| `client/src/replay/replay.ts` | `decodeTxnPayload` two-shape contract; `tierOf`; `parseErrorOf`; `PARSE_OWNED` + 3; `instant()` round-trip check; `amount_home_minor` edit guard; `Txn` construction |
| `client/src/invariants/check.ts` | `I12_money_shape` two-sided unparsed rule + flag shape check |
| `client/src/net/client.ts` | `stateToJSON` emits the three fields |
| `client/scripts/gen-fx-conformance.ts` | `unparsedIngest` builder (exported, no case uses it) |
| `client/src/replay/replay.test.ts` | 14 tests; unparsed builders; unparsed rows in the sample log |
| `client/src/invariants/check.test.ts` | 3 `I12` tests incl. the named mutant; unparsed builder |
| `client/src/replay/fx.test.ts` | pending-index invariant extended; unparsed rows in the FX sample log |
