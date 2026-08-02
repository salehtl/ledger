# Task 20 — Categorization: rules, the global dictionary, on-device matching

**Commit:** `4abd77c` *feat(v2): on-device categorization, and the floor the dictionary publishes at*
**Branch:** `v2` (parent `d296bc3`, compare-and-swap)
**Status:** built, tested, committed. Two pieces deliberately not built (below), one wiring
seam left open on purpose and named.

---

## What was built

| file | what it is |
|---|---|
| `client/src/categorize/canon.ts` | canonicalization: Go's `unicode.IsSpace` set and `strings.ToLower`, per code point |
| `client/src/categorize/rules.ts` | the matcher: validation, precedence, `contains`/`exact`/`regex`, the cost gate |
| `client/src/categorize/dictionary.ts` | the local dictionary tables, the delta applier, the re-categorization scan |
| `internal/v2/dict/conformance_test.go` | writes `conformance/dict/matching.json` and asserts this build still produces it |
| `conformance/dict/matching.json` | Go's own answers: limits, `IsSpace`, `ToLower`, `Canonicalize`, and Postgres's match verdicts |

Plus four test files: `canon.test.ts`, `rules.test.ts`, `dictionary.test.ts`, `conformance.test.ts`.

### Where it lives, and why that is not where the plan said

The plan's Task 20 names `app/src/lib/categorize.ts` and `app/src/db/dictionary.ts`. The
dispatch scoped this task to `client/src/` and gave `app/` to a concurrent session. Building
it in `client/src/categorize/` is the better placement anyway and is what shipped:

- `client/src` is the library `app/` imports (`client/README.md`, Task 5), and this is pure
  logic over a `SqlDriver` — no React, no Expo, no host import. Both modules import
  `SqlDriver` with `import type` exactly as `replay/projection.ts` does, so they reach Hermes
  and drag no `bun:sqlite` with them.
- It inherits `client/`'s test corpus and runs inside `bash scripts/v2-check.sh` today.
  In `app/` it would run only under `cd app && bun test`, which the gate does not call.
- The Global Constraints permit **additive exports** to `client/src`. This is a new directory:
  no existing file's behaviour changed, and no pre-existing test was touched.

---

## Precedence: how it resolves, and how it was tested

Both tiers are sorted by one total comparator (`comparePrepared`), and the tiers are
consulted in order — every user rule first, then every dictionary entry, then uncategorized.

1. **`priority` ascending — LOWER WINS.** v1's convention (`internal/categorize/categorize.go:19`,
   "ordered by Priority (lower = higher priority)"), kept rather than inverted because the
   operator's seeded rules and their write-back path (priority 100 for a generated rule) both
   assume it.
2. **`exact`, then `contains`, then `regex`.** The first two are specificity. Putting `regex`
   last is specificity *plus* cost: the one match kind whose running time is not linear in the
   subject only runs when nothing cheaper matched.
3. **Longer pattern first.** `carrefour hyper` is a more specific claim than `carrefour`, and a
   user should not have to encode that as a priority. Length is in **runes**.
4. **Pattern, then category, then entity id, by code point.** Arbitrary and deliberate: a
   tiebreak that exists so the answer is never "whichever the Map yielded first".

**Why step 4 is not decoration.** `State.rules` is a `Map` (fold order) and the projection's
`rule` table is read with no `ORDER BY` (page order). A matcher walking either in natural
order gives two devices holding the *same log* different categories for the same merchant.

**A user rule at priority 9999 still beats a dictionary entry** — the tiers are not merged
and sorted together.

### The tests, and what each one rules out

Every precedence fixture has **at least two competing entries that both match the subject and
disagree about the category**, and every "A beats B" test is paired with a control:

- `priority decides between two rules that both match` asserts the answer, then **swaps which
  rule carries which priority and asserts the answer flips** — with `a` first in the array
  both times. That is what distinguishes "priority is read" from "the first element is
  returned".
- `the answer does not depend on the order the rules arrive in` runs the same pair in both
  input orders.
- `exact beats contains` / `contains beats regex` each remove the winner and assert **the
  loser then wins on the same subject** — without that control, the assertion is also
  satisfied by a `contains` implementation that never matches anything.
- `priority outranks match kind` pairs a low-priority `contains` beating a high-priority
  `exact` with the same fixture at equal priority, where `exact` wins. One test measures
  priority; the pair measures the *order between the two rules*.
- `the longer pattern wins, both ways round` swaps which pattern carries which category.
- `a full tie is broken deterministically` compares both input orders for equality.
- `a user rule beats the dictionary` is paired with the same dictionary entry resolving the
  same merchant alone.

Mutations M01-M06 (reverse priority, drop priority, reorder match kinds, invert specificity,
drop sorting entirely, consult the dictionary first) are all caught — see the battery below.

---

## The 4-rune `contains` floor on the device

`MIN_CONTAINS_RUNES = 4`, enforced in **two** places, for two different threats:

- **Dictionary entries** are refused at the network boundary (`applyDictionaryDelta` never
  stores one) *and* at match time (`prepare` skips one that reached the table some other way —
  a restored file, an older build). The first guards the network, the second guards the disk;
  `dictionary.test.ts` tests them separately, the second by `INSERT`ing a bad row directly.
- **The user's own rules.** `rule_added` is an opaque payload inside an end-to-end blob;
  `replay.ts` validates its *shape* and not its *sense*, and the server never sees it. So a
  two-rune `contains` rule can arrive from the user's other device and swallow their whole
  transaction list. It is **skipped and reported** (`PreparedRules.defects`), never applied
  and never silently dropped, and a competing four-rune rule in the same fixture still
  applies — so the refusal is targeted rather than a matcher giving up.

Tests use the migration's own scenario: `on -> charity` must not match AMAZON, NOON or
TALABAT ONLINE — and the fixture *proves the danger is real* by carrying Postgres's verdict
that `on` **does** contains-match all three. The floor is a publication rule, not a matching
rule. A control asserts a **two-rune `exact`** entry is legal and matches, so the tests are not
passing on "short patterns never work", which is a different and wrong rule. Another control
uses three vs four **astral** code points (six vs eight UTF-16 units), which a floor written
against `String.length` gets wrong.

**Go/TS agreement is explicit and mechanical.** `conformance/dict/matching.json` carries
`min_contains_runes` from Go's `dict.minContainsRunes`; Go's existing
`TestTheContainsFloorMatchesTheSQLLiteral` pins that constant to the SQL CHECK in
`00017_dict_key_epoch.sql`. So the chain is **SQL <-> Go <-> TypeScript**, and it was proven
live in both directions: changing Go's constant to 3 fails the Go fixture test ("matching.json
is stale") *and* the SQL pin; changing the TypeScript constant fails `conformance.test.ts`
(mutation M07).

---

## What the conformance fixture measures, and what it caught

Go authors the fixture (`LEDGER_WRITE_CONFORMANCE=1 go test ./internal/v2/dict/ -run
TestWriteDictConformanceFixtures`); the device compares against it. Four sections:

1. **limits** — the numbers both sides hard-code.
2. **`unicode.IsSpace` / `strings.ToLower`**, probed one code point at a time.
3. **`dict.Canonicalize`'s verdict and output** for 35 whole entries, accepted and refused.
4. **`contains`/`exact` verdicts computed by Postgres**, using the expression `dict.List`'s
   `AlsoMatches` LATERAL runs — the only server-side matcher that exists. If the device
   disagrees with it, the moderator's breadth preview is describing a different matcher than
   the one on the phone.

No Go matcher was written for this. A Go implementation of the device's matcher would be a
function nothing calls, tested green, drifting from both sides — the second defect shape in
AGENT-RULES.

**Four real divergences the naive one-liner has**, all now pinned:

| input | `.trim().toLowerCase().replace(/\s+/g," ")` | Go | consequence |
|---|---|---|---|
| U+0085 (NEL) | kept | collapsed | server and device store different patterns |
| U+FEFF (BOM) | collapsed | kept | same, mirrored |
| U+0130 (İ) | `i` + U+0307 | `i` | `exact` never matches again |
| word-final Σ | `ς` | `σ` | same |

So `foldCase` folds **per code point** (which removes JavaScript's Final_Sigma context) and
collapses the one expanding mapping, and the whitespace set is written out as Go's rather than
`\s`. `canon.test.ts` asserts each divergence against `String.prototype.toLowerCase` directly,
so a future "simplification" fails rather than silently changing what matches.

The fixture also caught a defect while it was being built: `Canonicalize` refuses a line break
in the **raw** input before collapsing (a two-line paste must not be silently joined), which
the device did not. Mutation M17 (removing that check) is caught **only** by the conformance
test — the fixture earns its place empirically, not by argument.

One **deliberate, asserted divergence**: Go's `Canonicalize` defaults a blank `match` to
`contains` because it is the write path; the device refuses it, because it is a read path over
a column that is `NOT NULL` with a `CHECK (match_type IN ('contains','exact'))`, so a blank one
did not come from that schema. Asserted in `conformance.test.ts` rather than skipped, so it
stays a decision instead of becoming a gap.

Homoglyphs stay split, deliberately: `carrefour`, `ＣＡＲＲＥＦＯＵＲ`, Cyrillic-С and
`carrefour.` are four strings and four entries, on both sides. Case and whitespace only.

---

## Hermes vs the Bun-calibrated dialect — what I assumed, and what I measured

**The assumption, stated:** `tmpl/dialect.ts`'s `MAX_UNBOUNDED_PER_BRANCH = 1` and
`MAX_BOUND_PRODUCT = 64` are "Measured in Bun 1.3.14". Phase 2 runs on Hermes. I use
`validatePattern` as the *structural* gate on user regex rules — no lookaround, no
backreference, at most one unbounded quantifier per branch — because its structural rules are
engine-independent even though its *calibration* is not. What I do **not** do is rest the cost
argument on those numbers.

**The cost argument that replaces them** is `MAX_SUBJECT_RUNES = 512`: a categorization subject
is a merchant name, not an email body. The dialect's blow-ups were measured at n = 400..8,000
on attacker-writable inbound mail; this path truncates to 512 code points before any pattern
touches it, which is a bound on `n` rather than on the engine. Removing the truncation fails a
test (M13).

**And then I measured it anyway, which found a real hole.** Every pattern below is **accepted**
by `validatePattern` today. Bun 1.3.14, 512-rune subject, single match:

| pattern | bound product | time |
|---|---|---|
| `^(?:[a-z]{8}){8}z$` | 64 | 0.7 ms |
| `^[a-z]{1,64}z$` | 64 | 1.0 ms |
| `^(?:[a-z0-9 ]{1,4}){8}z$` | 32 | 0.9 ms |
| `[0-9]+z` | - | 0.55 ms |
| `^(?:[a-z0-9 ]{1,8}){8}z$` | 64 | **216 ms** |
| `^(?:(?:[a-z]{1,4}){4}){4}z$` | 64 | **6,327 ms** |

216 ms per row is 13 minutes across a 3,683-row pass; 6.3 s is a frozen phone. The cheap rows
and the catastrophic rows have the **same bound product**, so no tightening of that number
separates them. What separates them is a **variable-length repetition inside a quantified
group** — the bounded analogue of the dialect's existing `unbounded_inside_quantified_group`,
which nothing checks.

So `rules.ts` adds `nestedVariableRepetition()`, a structural scanner (escape- and
character-class-aware) that refuses exactly that shape on the categorization path, with defect
code `regex_nested_variable_repetition`. It is **not** put in `tmpl/dialect.ts`: that file is a
two-engine agreement contract with a Go mirror and a committed fixture, and this is a
device-side cost policy for user-authored rules the server never sees. If templates need it
too, it moves — in both languages, with the fixture regenerated.

**What remains genuinely unmeasured**, recorded rather than papered over:

- Whether Hermes *agrees* with Bun and Go about what a pattern matches. Phase 1 already
  recorded one divergence in this family (Bun's `/[a-z]/iu` does not match U+212A; Go, V8 and
  WebKit's does). A user rule landing on such a character can categorize differently on the CLI
  and on the phone. Failure mode: a wrong-or-absent category, never a hang.
- Whether a pattern this now accepts is slower on Hermes than on Bun. The structural rule does
  not inherit Bun's numbers, but it does not predict Hermes's either. **Task 28's device run is
  where this gets measured** — it should re-run the table above on-device.
- I did not re-measure `MAX_UNBOUNDED_PER_BRANCH` itself on Hermes. Nothing on this path
  depends on the value being 1 rather than 2 given the 512-rune bound, but the dialect's own
  standing note still applies to the template executor.

---

## Chunked, and yielding

`proposeCategories` is keyset-paged at 250 rows (`CANDIDATE_CHUNK`, the projection's own
number) and awaits `between()` after each page — the yield is the load-bearing part, not the
chunking. It **streams** proposals to a sink rather than returning an array: the caller is the
writer, which batches ops, and collecting 3,683 proposals before anyone can act on one is the
read-everything shape the codebase is written against. `countUncategorized` is a SQL aggregate.

Exclusions, all in SQL and each tested on its own with **two** rows of its kind in the fixture:
`category IS NULL` (never rewrite a user's decision), `unparsed = 0` (no merchant to match),
`superseded_by IS NULL` (history). Dropping any one of the three fails a test (M18-M20).

**Never rewriting a decision has a cost, stated:** once a row is auto-categorized there is no
way to tell it from a user's own confirmation (both are `txn_categorized`), so a later
dictionary correction never reaches it. The user re-categorizes from the transaction screen,
which is a visible action, and their rule then wins forever. That is the fail-safe reading of
the ambiguity, and it is what the plan asks for.

The dictionary lives in its **own** tables, not the projection's. `project()` drops and rebuilds
its tables on every version mismatch; if the dictionary were in that list, every re-projection
would silently reset the cursor and re-download the feed. There is a test for exactly that.

---

## What I did NOT build, and why

- **`POST /api/v1/dictionary/submissions` (plan Step 3).** The dispatch is explicit, and
  `internal/v2/dict`'s own package doc agrees: `Submit` has **no rate limit and no per-user
  entry cap**, and both must land before any client endpoint reaches it. Building the route now
  would ship the DoS surface the previous review identified. The device therefore **consumes
  published entries and contributes nothing**, which is stated in `dictionary.ts`'s module doc
  so a later reader does not assume the opt-in exists.
- **The consent copy (plan Step 4).** It describes a disclosure the beta does not make — there
  is nothing to consent to until the route above exists. Writing it now would be a false
  statement to users. It belongs in the same commit as the route.
- **No migration.** Step 3's migration was for the submission route. Nothing here needs one;
  the device's tables are SQLite and created by `ensureDictionary`.

## Wiring: what exists, what is a seam, what needs a screen I did not write

Per AGENT-RULES ("if the thing you'd wire it into does not exist yet, say so and stop"):

1. **`Client.dictionary(since)` does not exist.** `net/client.ts` owns every authenticated
   request and is being edited by a concurrent session. `syncDictionary(db, fetch)` takes an
   injected `DictionaryFetch` instead, and the module doc names the one line needed:
   `dictionary(since: bigint) { return this.request("GET", ` + "`/api/v1/dictionary?since=${since}`" + `); }`.
   The applier is fully tested against a fake fetch; the HTTP call is not written.
2. **Nothing calls `proposeCategories` in production yet.** Its consumer is the writer/outbox
   (a concurrent session) plus Task 18/19's screens, which do not exist. A proposal
   deliberately carries **no `parent_version`**: the head must be re-read from the projection at
   emit time, never carried from the scan.
3. **Rule authoring (Task 19 Step 3's `rule_added` write-back) has no screen.** The floor is
   enforced at match time, so a bad rule is skipped and reported rather than silently applied —
   but the authoring UI should refuse it up front and surface `PreparedRules.defects`. That
   contract is `prepare()`'s return value; the screen is not mine.
4. **`prepareFromStore(db)` is the one call a screen makes** — rules from the projection,
   entries from the dictionary tables, validated, compiled and ordered once per pass, never
   per row.

I did not touch `client/README.md` or `client/src/cli/main.ts`: both were mid-flight in other
sessions (`git status` showed `MM`), and AGENT-RULES is explicit about that collision.

---

## Verification

```
cd client && bun test src/categorize/   ->  80 pass, 0 fail, 275 expect() calls, 4 files
cd client && bunx tsc --noEmit          ->  clean for my files
go test ./internal/v2/dict/ -count=1    ->  ok (32.5 s, includes the new fixture test)
gofmt -l internal/v2/dict/              ->  clean
```

Full gate, run in a `git archive` export of **`4abd77c`** with `client/node_modules` copied in,
after `go clean -testcache`:

```
bash scripts/v2-check.sh   ->  exit 1
   go vet ./internal/v2/... ./cmd/ledgerd     clean
   go test -count=1 ./internal/v2/... ./cmd/ledgerd   all packages ok
   (cd client && bun run typecheck && bun test)  ->  2217 pass / 1 fail / 2218 across 27 files
```

**The one failure is pre-existing and not mine**, and that was checked rather than asserted:
`client/src/invariants/stream.test.ts` -> "a whole-log check holds a chunk, not the log" times
out at its own 5,000 ms limit. It fails **identically in a clean archive of the parent commit
`d296bc3`, with none of my files present** (12 pass / 1 fail, same test, same timeout). It is
another session's file — the shared index has its deletion staged — and it is the same
measurement-under-load family as the flake AGENT-RULES documents in `fx.test.ts`; the parent
commit is literally titled "make the retention measurement survive a busy box".

Test-count property, same conditions on both sides (no `LEDGER_TEST_POSTGRES_URL`, so the 37
e2e tests self-skip):

| | collected | pass | skip | fail |
|---|---|---|---|---|
| parent `d296bc3` | 2,139 | 2,101 | 37 | 1 (above) |
| mine `4abd77c` | **2,219** | 2,181 | 37 | 1 (the same one) |

+80, exactly the tests I added. No pre-existing test removed, skipped or weakened.

The working tree itself is transiently red from other sessions (`net/client.ts` mid-edit lost
`reconcileInflight`, then gained two `possibly undefined` typecheck errors; a new
`src/outbox/outbox.ts` has an unused local). None of that is mine, which is why every number
above comes from an exported commit rather than the tree.

### A flake I introduced and removed before it could cost anyone a debugging session

The first version of two regex tests asserted wall-clock ceilings (`Date.now() - started <
2000`). Running the suite *while the gate was running* made both fail: the categorize suite went
from 0.5 s to 89 s under contention, and a 1-2 s ceiling on a 1 ms operation is not a big margin
at 180x. Both assertions are gone. The cost policy is asserted **structurally** instead — the
pattern is refused, so it is never compiled and never run — and the measurements live in
comments and in the table above. Timing the catastrophic pattern to prove it does not run would
have put a six-second regex in the suite to prove the six-second regex is not there.

### Mutation battery: 30/30

Thirty deliberate defects, each applied alone, suite run, reverted
(`scratchpad/task20/mutate.py`).

| # | defect | caught by |
|---|---|---|
| M01 | priority direction reversed | rules, dictionary |
| M02 | priority ignored entirely | rules |
| M03 | regex ordered before contains | rules |
| M04 | specificity inverted (shorter first) | rules |
| M05 | no ordering at all (input order wins) | rules |
| M06 | dictionary consulted before user rules | rules, dictionary |
| M07 | contains floor lowered to 2 | **conformance**, rules, dictionary |
| M08 | floor not applied to user rules | rules |
| M09 | floor not applied to dictionary entries | **conformance**, rules, dictionary |
| M10 | `foldCase` uses `String.toLowerCase` wholesale | canon, **conformance** |
| M11 | U+0085 dropped from the space set | canon, **conformance** |
| M12 | U+FEFF added to the space set | canon, **conformance** |
| M13 | subject not truncated | rules |
| M14 | `contains` arguments swapped | conformance, rules, dictionary |
| M15 | `runeLength` counts UTF-16 units | canon, conformance, rules |
| M16 | dictionary may carry a regex | rules, dictionary |
| M17 | line-break refusal removed | **conformance only** |
| M18 | scan drops `category IS NULL` | dictionary |
| M19 | scan drops `unparsed = 0` | dictionary |
| M20 | scan drops `superseded_by IS NULL` | dictionary |
| M21 | delta stores entries unvalidated | dictionary |
| M22 | retractions ignored | dictionary |
| M23 | cursor may go backwards | dictionary |
| M24 | version accepted as a JSON number | dictionary |
| M25 | no yield between pages | dictionary |
| M26 | nested-variable-repetition check removed | rules |
| M27 | `{n,m}` treated as fixed-length | rules |
| M28 | scanner ignores character classes | rules |
| M29 | quantified group does not multiply its contents | rules |
| M30 | escaped atoms not skipped by the scanner | rules |

**M28 survived the first run** — the class-handling tests happened to pass under it. The gap
was in the tests, not the bar: added `(?:[a{1,4}]x){4}` (a quantifier-shaped run inside a class
is literal text) and `[)]{1,4}` (a parenthesis inside a class does not close a group), and it
is caught. That is the fault being in the tests rather than the code, which AGENT-RULES says is
the usual cause here — checked before lowering anything.

Two mutations are worth singling out: **M17 is caught only by the Go-authored fixture**, and
**M10/M11/M12** are caught by the canonicalization tests *and* the fixture, from opposite
directions.

---

## Residual risks

1. **Hermes is still unmeasured** for regex agreement and for the cost table above. Task 28.
2. **A merchant longer than 512 canonical runes** is matched on its first 512. Unreachable from
   the template tier (`MAX_CAPTURE_RUNES` is also 512) but reachable via `txn_edited`.
3. **A dictionary cursor gap** still leaks aggregate suppressed-submission volume. Known,
   recorded in `internal/v2/dict`'s doc, not this task's to close.
4. **Canonicalization is case and whitespace only**, so an operator can approve two visually
   identical entries. Fail-safe (the k threshold splits rather than merges) and unchanged here
   by design.
5. **Unicode version skew.** Go's `ToLower` tables and the device engine's could differ for a
   recently-cased script. The fixture pins the probes that matter today; a divergence outside
   them fails toward "no match", i.e. uncategorized.
