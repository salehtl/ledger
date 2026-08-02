# `canonicalTime` — the dual-executor divergence, and the gate that could not see it

**Reported by:** Phase 2 Task 7 (§7.2 of `task-7-report.md`), recorded and deliberately not fixed
because `wire/op.ts` sat outside that task's file list.

---

## 1. What the finding actually was, once measured

The report said:

> Go's `Format(RFC3339)` renders year 10000 as `10000-01-01T…` and JavaScript's `toISOString` as
> `+010000-01-01T…`. So `oplog.canonicalTime` and `wire/op.ts:canonicalTime` **already disagree** on
> this range.

Both halves of that are true, and the conclusion it points at — "the executors spell it differently"
— is the *less* important half. Measured on this box, Go 1.25.0 and Bun 1.3.14:

| wire string (legal by every rule that existed) | Go decode | TypeScript decode |
|---|---|---|
| `9999-12-31T23:59:59-23:59` → UTC year 10000 | **accepted**, `authored_at` = 253402387139000 ms | **refused** (`BlobDecodeError`) |
| `0000-01-01T00:00:00+00:01` → UTC year −1 | **accepted**, −62167219260000 ms | **refused** |

So the live defect was not a *spelling* disagreement on a value both sides carry. It was an
**acceptance** disagreement: an op that lands in the server's log and in **no device's**. That is
the category Task 7's own §7.2 flagged as the one that matters (a *silent byte-level* disagreement
in the sense of §3.3) — a blob is either in the log for both executors or in neither — and it had
been true for as long as the contract has existed.

Two supporting measurements that change the reading:

- **Go never emits `10000-…` on the wire.** `Format(RFC3339)` does, but that is not the wire path.
  The wire path is `json.Marshal`, and `time.Time.MarshalJSON` refuses a year outside `[0,9999]`
  outright: `json: error calling MarshalJSON for type time.Time: Time.MarshalJSON: year outside of
  range [0,9999]`. So Go could *read* the value and could never *write* it back — the whole blob
  failed to encode, with an error naming neither the op nor the field.
- **TypeScript refused it by accident, not by rule.** `decodeOp` canonicalises `authored_at` and
  *then* calls `validateOp`, which re-parses the result; the expanded-year string fails that second
  parse. Reorder those two lines and the refusal vanishes. Task 7 had already been bitten by exactly
  this: `canonicalTime` handed back a string `parseInstantMs` could not read, and `replay.ts` had to
  write the round trip out by hand in `instant()` to stop the fold from crashing.

## 2. Which executor was wrong, and what that is based on

**Go was wrong**, and the basis is the wire format rather than either language's default.

The canonical form is defined by this project, not by ISO 8601: `oplog.rfc3339Shape` and
`wire/op.ts`'s `RFC3339` both mandate **exactly four year digits**, and `oplog.canonicalTime`'s own
doc comment defines the canonical form as *"the one form both executors read identically."* Under
that definition neither spelling is correct — `10000-01-01T23:58:59Z` fails the four-digit rule just
as `+010000-01-01T23:58:59.000Z` does, and both are unreadable by both decoders. ISO 8601 would
prefer JavaScript's (`+` sign, agreed digit count), but ISO 8601 is not the binding document here
and picking a spelling would have meant *widening* the grammar on both sides to admit a year no
`Date` header should ever produce.

The real defect is therefore structural and it is Go's: **canonicalisation was not closed over its
own input grammar.** `parseWireTime` accepted a string whose canonical form the same package could
not express, so `decode ∘ canonical ≠ canonical`. TypeScript's `canonicalTime` had the same open
range in the middle of its pipeline; it merely happened to be caught downstream.

## 3. Is the range reachable?

A bank will not send year 10000. The range is reachable anyway, three ways:

1. **It is wire-legal.** Four digits of year, a real calendar date, an offset inside ±23:59 — every
   rule that existed accepts it. Nothing in the format says "and also the UTC value must be in range."
2. **Task 7 proved it strands a device.** `posted_at` in that exact range reached the replay state,
   `fingerprint` re-parsed the stored string, `BlobDecodeError` escaped `applyOp`'s `PayloadError`
   catch, and the whole fold died — permanently, because every subsequent sync re-folds the prefix.
3. **The op stream has writers this system does not control.** `authored_at` is author-assigned, and
   the format is frozen against a third implementation. A hostile or broken `Date` header is the
   obvious source; a device with a bad clock is the boring one.

Today's Go ingest cannot *produce* it: every `posted_at` source is zoneless and four-digit-year
bounded (`norm.fwdDateLayouts` and `tmpl.goDateLayouts` carry no offset — `tmpl/exec.go:728` states
this — and `receivedAt` is the server clock). That bounds the *writer*, not the *reader*, and the
reader is the half that diverged.

## 4. What was done: both

**Made them agree, by refusing the range at the boundary in both executors — as the same rule, in
the same place.**

Refusing alone would not have been enough: two independently-written refusals drift, which is the
failure mode this whole contract exists to prevent. Making them agree on a *spelling* would have been
worse — it means widening both grammars to carry a year that has no legitimate source, in a format
that is frozen. So the rule is closure, stated identically on both sides:

> A canonical form must itself be a wire timestamp.

and the check is the round trip rather than a year-range test, so it cannot drift from what the
renderer actually produces. (That is Task 7's own reasoning for `instant()`, applied one level down
where it belongs.)

| file | change |
|---|---|
| `internal/v2/oplog/op.go` | `canonicalTime` returns `(time.Time, error)` and refuses a canonical form `rfc3339Shape` will not match. Applied at **four** points: `parseWireTime` (decode), `Op.Validate` (encode + decode), `EncodeBlob`, `EncodeRawBody`. New exported `CanonicalWireTime` is the string half. |
| `client/src/wire/op.ts` | `canonicalTime` refuses a canonical form `RFC3339` will not match, so the refusal is a rule rather than a consequence of statement order. `validateOp` and `decodeRawBody` now check *canonicalisability*, not just parseability. |
| `internal/v2/ingest/pipeline.go` | `wireTime` delegates to `oplog.CanonicalWireTime` instead of restating the expression (see §5); `txnPayloadOf` propagates its error. |
| `internal/v2/ingest/wiretime_test.go` | new — the only direct coverage of that renderer, added because a mutation run reverted it with every other test in the package green (§8). |

Two things this fix deliberately does **not** do:

- It does not touch `replay.ts`'s `instant()`. That guard is now unreachable for `posted_at`, and it
  is kept: it is defence in depth against `canonicalTime` ever being loosened again, and Task 7's
  file is not this task's to rewrite. Its regression test's assertion was widened from Task 7's exact
  wording to the invariant part of the message (`canonicalises to`, `outside the … range this wire
  format`), which holds under both implementations — the behaviour it pins (two `invalid_payload`
  anomalies, third op still folds, fold does not throw) is unchanged.
- It does not narrow the *accepted* range. Years 0000 and 9999 are still legal at both ends, and
  six new accept cases pin that, so the refusal is the range and not the millennium either side.

### A second acceptance gap, found by the new test

`decodeRawBody` in TypeScript validated `received_at` with `parseInstantMs` only, so after Go was
tightened it would have accepted a cold record Go sets aside — the same divergence, moved to the
cold stream. The new cross-path test caught it before the commit. It now checks
canonicalisability, and returns the string unchanged (as Go leaves its parsed value unchanged;
canonicalisation is an encode-side rewrite, this is a decode-side refusal).

## 5. The mirror grep

`canonicalTime` is one of **three** places the two executors render the same instant for the wire.
All three were checked, not assumed.

| site | Go | TypeScript | verdict |
|---|---|---|---|
| op envelope `authored_at` / cold `received_at` | `oplog.canonicalTime` | `wire/op.ts:canonicalTime` | **the divergence — fixed** |
| txn payload `posted_at` | `ingest/pipeline.go:wireTime` | `replay.ts:instant` | **sibling — fixed** |
| normalizer `email_date`, template `posted_at` | `norm.Result.EmailDate` (`Format(time.RFC3339)`), `tmpl.convertDate` | `norm.ts:formatRFC3339UTC`, `tmpl/exec.ts` | **agree; no change** |

- **`wireTime` was the sibling the brief predicted.** It was the same expression as `canonicalTime`
  with the closure check missing (`t.UTC().Truncate(time.Millisecond).Format(time.RFC3339Nano)`), so
  it would have written Go's five-digit spelling into a payload where the TypeScript executor writes
  the expanded-year one. Unreachable today for the reasons in §3; guarded anyway, by *deleting the
  second renderer* rather than adding a second check to it. A second renderer is a second spelling.
- **The normalizer and template mirrors are fine, and for a good reason rather than by luck.** Both
  TypeScript renderers use `padStart(4, "0")` — not `toISOString` — so they produce Go's spelling
  even out of range, and both parse from zoneless layouts with a four-digit year, so the range is
  unreachable from either. They are also the *only* timestamps in the system already pinned
  **byte-for-byte** across executors (`norm/conformance.test.ts:87,157` and
  `tmpl/conformance.test.ts:123` compare the strings, not the instants), which is a stronger claim
  than the op manifest makes and is why nothing was needed here.

The one remaining `toISOString` in production TypeScript is `net/client.ts:864`
(`authored_at: new Date().toISOString()`), which is clock-derived and now validated by `validateOp`.

## 6. The conformance gap — the more important defect

Spec §3.5 says a disagreement fails the build. `scripts/v2-check.sh` **is** the build. It could not
see this one, and the reason is structural rather than an oversight:

> Every timestamp assertion in the suite compared parsed **instants**. The divergence is in a
> **string neither executor can parse**.

That instants-only rule was written down and justified (`conformance_test.go` §3: Go trims trailing
zeros where `toISOString` pads to three digits, so the encoders are byte-different and
instant-identical). The justification is correct and the rule built on it was too strong: it meant
**no test on either side ever handed one executor a timestamp string the other had actually
written.** A canonical form outside the shared grammar was invisible by construction — a check true
by construction rather than by measurement, which is the Phase 1 lesson.

### What the suite can now fail on that it could not before

1. **`expect_canonical_wire`** — a new per-case field in `conformance/op/manifest.json` carrying the
   string **Go** renders. Go pins it as a golden (a change to Go's spelling fails on the Go side);
   TypeScript **reads** it and asserts it decodes to the same instant and canonicalises to the same
   value. This is the first cross-executor claim about a timestamp *string*, and it is deliberately
   not an equality claim — `2026-06-05T10:00:00.5Z` against `.500Z` is pinned as still-different, so
   the byte-inequality the spec documents stays documented and the new claim is the readable one.
2. **The two boundary values in `authored_at_rejects`** — `9999-12-31T23:59:59-23:59` and
   `0000-01-01T00:00:00+00:01`. Both executors loop that shared list, and the list is a shared
   artifact rather than two hand-maintained ones precisely so it cannot drift.

   Measured demonstration that the gate now sees the divergence, run on a `git archive HEAD` export
   with **nothing changed but those two strings appended to `timeRejectCases`**:

   ```
   --- FAIL: TestOpConformanceManifestMatchesThisBuild
       conformance_test.go:879: the manifest lists 17 reject cases, this build has 19
   --- FAIL: TestWriteConformanceFixtures
       conformance_test.go:585: authored_at "9999-12-31T23:59:59-23:59" must be refused
                                before it can be written as a reject case
   ```

   The second is the one that matters: the fixture writer *refuses to bless* a reject case this
   executor accepts. The TypeScript half of the same run stays green, because TypeScript was already
   refusing both — which is the measurement behind §2's claim about which executor was wrong.
3. **Both spellings offered back as input** — `+010000-01-01T23:58:59.000Z` (JavaScript's),
   `10000-01-01T23:58:59Z` (Go's), `-0001-12-31T23:59:00Z`. If either executor ever learns to
   *write* one of these it must not also learn to *read* it. These are the cases that die if either
   executor's spelling changes.
4. **`TestCanonicalTimeIsClosedOverTheWireGrammar`** (Go) and *"canonicalTime is CLOSED over the wire
   grammar, and idempotent"* (TypeScript) — the property, over the same published accept set, rather
   than a list of blessed strings: the canonical form of an accepted timestamp is itself accepted, to
   the same instant, and canonicalising twice changes nothing.
5. **`TestTheExpandedYearRangeIsRefusedByBothExecutors`** and its TypeScript twin — the refusal on
   **every** path a timestamp enters or leaves by: `parseWireTime`/`canonicalTime`,
   `DecodeBlob`/`decodeBlobOps`, `EncodeBlob`/`encodeBlobOps`, `DecodeRawBody`/`decodeRawBody`,
   `EncodeRawBody`/`encodeRawBody`. The Go test also asserts the two spellings *still differ* and
   *still fail the grammar*, so if a future Go release made `Format` agree with `toISOString` the
   contract would say so out loud instead of quietly changing shape.
6. **Named-explicitly and length guards on both lists, both sides.** Both lists are *generated* from
   Go's own slices, so deleting an entry and regenerating would take both executors green together.
   The reject list already had a length pin; the accept list did not, and a mutation run walked
   straight through that hole. Both are now length-pinned against this build, and ten strings (six
   rejects, four accepts) are named literally in Go *and* in TypeScript, the same way the parent-free
   set is.
7. **`Op.Validate` in its own right.** It is exported and documented as the structural contract, so
   a caller holding a hand-built op is a real caller; previously only `EncodeBlob`'s own check stood
   behind it, which made the `Validate` guard look redundant and deletable.

### The other boundaries: covered, or scoped out with a reason

| boundary | disposition |
|---|---|
| **Year 0** | **Covered, accept.** `0000-01-01T00:00:00Z` and `0000-02-29T00:00:00Z` (year 0 is divisible by 400, so it is a leap year — the lowest reachable point of the leap rule, which no case exercised). Both executors agree, instant and canonical form. |
| **Year 9999** | **Covered, accept.** `9999-12-31T23:59:59.999Z`, the latest instant the grammar expresses. |
| **Negative years** | **Covered, reject** — twice. Unreachable as *input* (the grammar has no sign), so the reachable form is via offset: `0000-01-01T00:00:00+00:01`. The literal form `-0001-12-31T23:59:00Z` is pinned too, so a grammar loosened to admit a sign fails. |
| **Offsets at ±24:00** | **Gap closed.** `+24:00` and `+24:60` were pinned; `-24:00` was not, so only one sign of the bound was tested. Added. |
| **DST-free offsets (`+05:45`, `-09:30`)** | **Covered, accept.** Added; both compute the same instant. Note the important one was `-23:59`: only `+23:59` was pinned, and the negative sign is the one that crosses the *upper* year boundary. Added. |
| **Leap seconds (`:60`)** | **Already covered, reject** (`2026-06-05T10:00:60Z`), and left as a refusal. RFC 3339 permits `:60` for a real leap second; Go's `time.Parse` refuses it and so does this grammar. Deliberate: accepting it would require both executors to agree on what instant a leap second maps to, and they have no shared answer. |
| **Go's zero time** | Already covered, reject (`0001-01-01T00:00:00Z`), unchanged. |

**Out of scope, stated rather than tested:** *byte-identical* canonical strings across executors.
The trailing-zero divergence is real, load-bearing (spec §80 makes it a prerequisite for ever
undeferring compaction) and deliberately unfixed; asserting equality would be asserting something
false. What is asserted instead is mutual readability, which is the property that has consequences.

## 7. A case that could not be constructed

**Neither of the two boundary strings can be turned into a *silent wrong-money* case, and the
arithmetic says why.** The tempting stronger test is "both executors accept it and fold it to
different money" — a divergence with no error on either side. It cannot exist here:

- `authored_at` is read for exactly one thing, the fork tiebreak (`replay.ts:486`), and the two
  executors agree on the *instant* for every string in this range (253402387139000 ms on both, as
  measured in §1). The disagreement is entirely in the rendered string, and the rendered string is
  never compared — the chain hashes the bytes as stored, and each blob is encoded once by its author.
- So the only observable consequence is acceptance: in the log or not. Which is what is now pinned.

Writing a "different money from the same log" case for this range would have meant fabricating a
reader of `authored_at`'s string form that does not exist. Recorded here rather than shipped as a
test that cannot fail — the same call Task 7's plan made about the identity-rate float64 case, where
the divergence needed a product past 2^72 against an int64 ceiling of 9.22e18.

## 8. Verification

Counts, both measured in `git archive` exports (`HEAD`, and `HEAD` + only these seven files) with
`client/node_modules` symlinked, so no other session's uncommitted work is in either number:

| | collected | pass | skip | fail | `expect()` |
|---|---|---|---|---|---|
| `19c921d` (pristine) | 1986 | 1949 | 37 | 0 | 13,853 |
| + this change | 1989 | 1952 | 37 | 0 | 13,978 |

+3 TypeScript tests, +125 assertions, **no pre-existing test removed, skipped or weakened** — the
one pre-existing assertion touched (`replay.test.ts`) was widened to hold under both implementations,
not deleted. Go gains two tests (`TestCanonicalTimeIsClosedOverTheWireGrammar`,
`TestTheExpandedYearRangeIsRefusedByBothExecutors`) plus new assertions inside
`TestOpConformanceManifestMatchesThisBuild`.

- `go clean -testcache && bash scripts/v2-check.sh` — see the report reply for the exit code, taken
  as the script's own status (not a pipeline's), in a `git archive` export of the commit.

**`fx.test.ts`'s 5 s fold limit fired once, and it was load, not this change.** Another session was
running four parallel `go test ./internal/v2/...` batteries at the time (load average 13.9). A/B'd
properly rather than guessed — alternating runs so shared load hits both trees equally:

| | run 1 | 2 | 3 | 4 | 5 | failures in 6 further runs |
|---|---|---|---|---|---|---|
| `19c921d` | 4.57 s | 4.06 | 4.78 | 4.56 | 4.69 | 0 |
| + this change | 3.51 s | 3.90 | 4.91 | 3.17 | 5.28 | 0 |

Variance under that load is ±2 s, which dwarfs any difference, and the baseline sits at 4.5 s against
the same 5 s limit — it was equally exposed. Two full-suite runs of each once load dropped: both
trees 0 fail, this change *faster* in both rounds. **The limit was not touched.** Worth knowing
anyway: `validateOp` now costs a `canonicalTime` where it cost a `parseInstantMs`, roughly a
`Date` construction, a `toISOString` and a regex more per op (see §9.2).

### Mutation testing — 19/24 → **22/24**, and the escapes are the finding

`scratchpad/mutate-canonical.mjs`: 24 hand-written defects — 11 in the Go executor, 5 in the
TypeScript one, 4 in the conformance *test file*, 4 in the committed *fixture*. Each is applied to a
scratch copy, `go test ./internal/v2/oplog/ ./internal/v2/ingest/` and `bun test` are run, the copy
is thrown away. Caught = the suite goes red.

Nineteen were caught immediately, including every one that matters most: dropping the closure check
on either side, guarding only one end of the range, `parseWireTime` no longer checking, `decodeRawBody`
and `validateOp` falling back to a bare instant check, widening either grammar to admit a five-digit
or signed year, and corrupting the published canonical string in the fixture to either JavaScript's
spelling or an expanded year.

**The five that escaped were real gaps in my own tests, and they were closed by fixing the tests —
not the threshold.** Recorded because each is a different shape of the same lesson:

| escaped mutant | why it escaped | what closed it |
|---|---|---|
| `Op.Validate` stops checking the canonical form | `EncodeBlob` re-checks one line later, so removing the guard changed only the error message. `Validate` is **exported** and documented as the structural contract, so a caller holding a hand-built op is a real caller. | a direct `Op.Validate` assertion, not only the `EncodeBlob` one |
| `ingest.wireTime` reverts to its inline renderer | the range is unreachable from today's date sources (§3), so no pipeline test can distinguish the two | `internal/v2/ingest/wiretime_test.go` — a direct unit test of `wireTime` and of `txnPayloadOf`'s error path |
| Go stops pinning its own canonical spelling | one `if` was the only reader of `expect_canonical_wire` on the Go side, and the TypeScript side cannot catch a corrupted value (`.5Z` and `.500Z` parse to the same instant) | `TestCanonicalTimeIsClosedOverTheWireGrammar` now cross-reads the published string, so the claim has two independent readers |
| the closure test stops checking the grammar | **the check could never fail.** `parseWireTime`'s first statement is that same regex, so `rfc3339Shape.MatchString(canonical)` was true whenever the round trip on the next line passed | **deleted.** A check true by construction is the exact defect this task exists to close; dressing it up would have been the same mistake one level down |
| the year-9999 accept case is dropped from the fixture | the reject list's length was pinned against Go's own list; the **accept** list's was not, so a case could be deleted and regenerated with both executors green | a length pin plus four boundary wires named literally, on **both** sides |

Re-run of those five after the fixes: **3 of 5 now caught** (`Op.Validate`, `wireTime`, the dropped
accept case). **22/24 overall.**

### The two that still survive are ill-formed mutants, and that is measured, not claimed

Both remaining survivors are *assertion deletions from a passing suite* — "Go stops pinning its own
canonical spelling" and "the closure test stops cross-reading the published canonical string".
Deleting a correct assertion from a green suite cannot turn it red; the mutant asks a question its
own construction answers. Worse, the two were made independent **on purpose** (that was the fix for
the first-run escape), so each covers the other's deletion by design.

The meaningful question is second-order: *with both deleted, does a real defect still get caught?*
Measured — `scratchpad/mutate-2nd-order.mjs`, **2/2**:

| both assertions deleted, plus… | result |
|---|---|
| `canonicalTime` drops the closure check (the primary defect) | **caught** |
| `CanonicalWireTime` changes its rendering (a spelling change) | **caught** |

So neither assertion is load-bearing for the guarantee — the closure rule is pinned by the reject
list and the round trip, and a rendering change still fails the golden op-bytes comparison. They are
kept anyway because they produce the *readable* failure (`canonicalises to X, manifest says Y`)
instead of a byte diff, which is the difference between a five-minute fix and an afternoon.

## 9. Concerns

1. **`replay.ts`'s `instant()` second guard is now unreachable.** It is kept as defence in depth
   (§4) and that is a real property, but an unreachable branch is a mutation-testing blind spot: a
   defect introduced *there* is no longer caught by anything. It is the right shape for a future task
   that owns `replay/` to collapse `instant()` onto `canonicalTime` now that `canonicalTime` carries
   the guarantee.
2. **`Op.Validate`'s new check runs on every op on every decode.** It is one `Format` plus one regex
   match per op, on top of the `parseWireTime` the decoder already runs. Not measured under a large
   fold; if op decode ever shows up in a profile this is the first thing to memoise, because for a
   value that came through `parseWireTime` the answer is already known.
3. **The manifest's `authored_at_cases` are now 15 entries and growing.** They are cheap, but the
   list is starting to be the place boundary knowledge lives rather than the code. If it passes ~25,
   it wants splitting into `authored_at_cases` and `authored_at_boundary_cases` so a reader can see
   which ones are load-bearing.
4. **Nothing pins `norm`/`tmpl`'s renderers against the *op* grammar.** They agree with each other
   byte-for-byte (§5) and are bounded by their parsers, but neither conformance suite asserts that
   the string they produce is one `oplog.parseWireTime` would accept. The join is real — `posted_at`
   comes from `tmpl` and rides in an op — and today it holds by construction on both sides. A
   template format that grew a numeric zone would break it silently in both executors *at once*,
   which is the one shape a cross-executor gate cannot catch.
5. **Concurrency.** Three sessions were editing this tree. `HEAD` moved twice during the work
   (`f0e5979`…`19c921d`), touching none of these seven files; the commit was built through a
   temporary index and every verification run was taken in a `git archive` export of the commit
   itself.
