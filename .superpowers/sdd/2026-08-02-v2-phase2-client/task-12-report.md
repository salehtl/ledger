# Task 12 — the invariant checker on-device, and the halt surfaces

**Status:** complete for everything reachable from `client/src`. The two React
Native components the plan names (`app/src/components/HaltBanner.tsx`,
`app/src/screens/settings/IntegrityScreen.tsx`) are **specified, not written** —
see "What is left, and why" at the end.

**Commit:** `306a3e9` — *feat(v2): stream the invariant checker, and give every
hard stop a screen* (9 files; `git show --stat` confirmed only those nine).

---

## 1. What the task actually had to fix

Four findings bound this task, and each turned into code:

1. **`I11` was a hard stop with no screen behind it.** Task 12's severity table
   named "chain break, `UnknownNewerVersionError`, `VIOLATION_CHAIN_WITHHELD`"
   as hard stops and filed *everything else in the 17* into the notice lane —
   while Task 11 Step 2 establishes `VIOLATION_ROSTER_COVERAGE` **is** a hard
   stop (escapable during push, and only there). A user therefore reached a full
   stop whose UI was a row on a settings screen.
2. **`I11`'s `kind` split had to survive into the UI.** The benign
   `roster_coverage` and the adversarial `chain_withheld` share an id; Phase 1
   records that treating them as one laundered a withholding attack into a
   notice.
3. **Two Task 11 contracts look like bugs and are not** — a checkpoint names
   every roster writer including one that has authored nothing (counter 0 +
   genesis hash), and a multi-device account hard-stops until the first
   checkpoint lands. Neither may be "helpfully" suppressed by a surface.
4. **`check()` held the whole decoded log in memory.** Task 5 left it
   deliberately and named Task 12 as the owner.

---

## 2. Streaming: `check()` no longer builds the log

### The shape

`CheckInput` keeps its array fields and is now the **front door**;
`StreamCheckInput` is the real input type, with the two fields that grow with the
log — `rows` and `ops` — as re-iterable chunk sources:

```ts
export interface Chunks<T> { each(fn: (chunk: readonly T[]) => void): void }
export function checkAllStream(input: StreamCheckInput): Violation[]
export function checkAll(input: CheckInput): Violation[]   // one line over the above
```

`checkAll` is literally `checkAllStream({...input, rows: arrayChunks(input.rows), ops: arrayChunks(input.ops)})`,
so **there is one implementation** and the array path cannot drift from the
streaming one. `arrayChunks` slices at 250 rather than handing the array over
whole, so the array path exercises chunk boundaries too — a source that yielded
one giant chunk would let a chunk-retaining consumer pass every test.

Nine of the seventeen consume rows and four consume ops; each takes its own pass
and none retains a chunk. The cross-row state each one needs was rewritten to be
bounded:

| check | was | now |
|---|---|---|
| I1 | `rows[rows.length-1]` | last seq carried out of the pass |
| I2 | `byWriter(rows)` — every row grouped into lists | one `{n, want}` per writer |
| I3 | `byPosition` — every row keyed by position | a 512-entry FIFO of `position → blob_hash` (32 B) |
| I3b | row loop | streamed; the pin map is an input, bounded by pins |
| I4, I5, I6, I15, I16 | row/op loops | streamed, O(1) each |
| I11 | `observedHead` re-scanned every row **per checkpoint head** | one row pass builds `writer → max counter` and the writer set |
| I14 | `Set` of **every** op id | a set of the ids the forks actually name (≤ 2 per fork) |
| I9/I10 | `fold(input.ops)` | `applyOp` per chunk into one state |

`Client.check()` now passes `storedRows(...)` / `storedOps(...)`
(`client/src/invariants/source.ts`), which read through `RowStore.range` via
`eachRowChunk` and re-read on every pass rather than caching. The state is folded
a chunk at a time with the ops each chunk produced discarded (`spent.length = 0`).

### Two properties the streaming had to add, not just preserve

- **A source must be re-iterable.** Eight checks take their own pass; a one-shot
  generator leaves every pass after the first reading an *empty* log — which is
  the vacuous-check failure this file exists to prevent, and it would report
  green. `checkAllStream` measures it (two counting passes must agree) and
  raises `REITERABLE_SOURCE` as a hard stop. Tested.
- **No invariant contributes an unbounded number of findings.** A hostile page
  can violate on every row, and an unbounded `Violation[]` is the retention the
  streaming removes. `MAX_FINDINGS_PER_INVARIANT = 64`, and truncation appends a
  line naming exactly how many further findings there were and how many of them
  were hard stops — never silent.

### How boundedness was proven

Three assertions in `client/src/invariants/stream.test.ts`, and the third
validates its own instrument:

1. **Equivalence.** Every chunk size (1, 2, 7, 39, 40, 41, 250) produces a report
   identical to the array run, over all 17 firing fixtures plus the clean one.
2. **No retention.** A `poisoning` source destroys every chunk as soon as the
   next is requested; the report is unchanged. A companion test proves the
   fixture *would* catch a retainer (a deliberate accumulator sees 25 of 30 rows
   zeroed).
3. **Bounded memory, measured.** 500 rows on the 16 KiB rung (~8 MB):
   - live bytes after the streaming run: **< bytes / 8**
   - live bytes after the array run, with the array still referenced: **> bytes / 2**
   The second half is not decoration — without it the first is a memory
   assertion that has never been seen to fail. Plus a survivor count: WeakRefs
   over every blob handed out, at 200 rows and at 800, must not grow by more than
   one chunk.

Two instrument traps were hit and are recorded in the test file so they are not
repeated:

- **`heapUsed` reports ZERO for typed arrays** in Bun. An earlier draft
  "measured" memory while being blind to the only thing on the heap counted in
  megabytes. The metric is `process.memoryUsage().external` after `Bun.gc(true)`.
- **A sample taken mid-pass measures nothing**, because Bun's collector scans the
  stack conservatively and keeps that pass's garbage alive. It read 13 MB for a
  run that retained nothing. The samples are taken at the top of the stack.

**CPU cost, stated honestly.** Each row-consuming check takes its own pass, so a
whole-log `check()` reads the store ~9 times instead of once (the expensive
passes — SHA-256 in I3/I3b, open+decode in I15/I16 — are one each; the rest are
field tests). That is the trade for one chunk of memory instead of the whole log,
and it lands on `cli check` / `Client.check()`, which are diagnostics. The
**product** path (`pull`) is unaffected: it passes a page, which `GET /api/v1/sync`
caps at 8 blobs, through the same array front door.

---

## 3. The halt surfaces

`client/src/invariants/surface.ts` — pure, framework-free, no React (it lives in
`client/src`, which the app imports). Three lanes:

| lane | trigger | shape |
|---|---|---|
| `Halt` | **any `hard_stop`** | `{kind, title, body, action, dismissable: false, syncStopped: true, violations}` — `dismissable` and `syncStopped` are *literal* types, so no value of `Halt` renders a "continue anyway" |
| `NoticeGroup[]` | every other finding | `{id, kind, title, count, routine, details}` — grouped with counts, expandable, capped at 20 details with an exact count |
| `UnreadableNotice` | `state.unreadable` non-empty | `{count, positions, dismissable: true}` |

### Hard stops vs notices, concretely

Severity comes from the checker, unchanged. What is new is that **every hard stop
now classifies into a halt that has copy**:

| halt kind | reached by |
|---|---|
| `update_required` | `VIOLATION_NEWER_VERSION` (I6, I15), `UnknownNewerVersionError` |
| `chain_withheld` | `VIOLATION_CHAIN_WITHHELD` (I11) |
| `not_vouched_for` | **`VIOLATION_ROSTER_COVERAGE` (I11)** |
| `tampered` | I1, I2, I3, I3b, I4, I5, I16, `ChainBreakError` |
| `inconsistent` | I7, I8, I9, I10, I12, I13, I14, I15 |
| `uncertified` | `VIOLATION_CHECK_FAILED` (a check threw, or the source was not re-iterable), and any id with no entry |

Notices are everything at `notice` severity: I11's routine lines, I13, I14's
findings and its unconditional count, I15's set-aside line, and any capped
summary. Routine ones (`no_checkpoint_yet`, `other_stream`, `counts`) sort last,
render collapsed and **do not badge** — collapsed, never dropped, because Phase
1's exit record is explicit that a notice list nobody reads is the same as no
invariants.

### How the benign/adversarial split was preserved

In three places, each with its own test:

1. **Different copy.** `roster_coverage` → *"This device hasn't been vouched for
   yet… open ledger on a device you have already been using."*
   `chain_withheld` → *"Some of your data is being withheld… another of your
   devices has already seen entries that the server is now refusing to send this
   one."* The test asserts `kind`, `title`, `body` and `action` all differ.
2. **Ranking.** `HALT_ORDER` puts `not_vouched_for` **last**. When both fire, the
   user is told about the withholding — showing the benign copy over a
   co-occurring adversarial stop is the same laundering, one layer up. Both are
   still listed in `halts`; the ranking chooses what is *shown*, never what is
   kept.
3. **One escape predicate, not two.** `escapableDuringPush(stops)` is an
   allow-list of exactly `{id: I11, kind: roster_coverage, severity: hard_stop}`,
   `every`, false for an empty list — and **`Client.syncForAttestation` now calls
   it** instead of holding its own inline copy. Phase 1's ledger notes the
   `.every` boundary was asserted but never pinned, because no scenario had I11
   co-occurring with another hard stop. That scenario is now a test
   (`roster_coverage` + `chain_withheld`, and `roster_coverage` + `I3_chain`),
   and mutating `every → some` fails it.

### Task 11's two "looks like a bug" contracts

Neither is treated as an error to suppress:

- A checkpoint naming an enrolled-but-silent writer at `{counter: 0, hash: 0×64}`
  produces **no violation at all** (`0 > observed` is never true), so it reaches
  no lane — asserted.
- A multi-device account with no checkpoint produces exactly the
  `not_vouched_for` halt, whose copy says the fix is to open a device that has
  already synced. That is the enrolment-then-checkpoint ordering surfaced as an
  instruction rather than as an error.

### Where it is wired today

- **`cli check` / `cli pull`** print the halt block (title, body, action,
  co-occurring halts) and the grouped Integrity list under the full violation
  list, and `--json` carries `surface`. The full list is still printed in full —
  that property is deliberate and untouched.
- **`Client.syncForAttestation`** uses `escapableDuringPush`.

---

## 4. Can every one of the 17 actually fail?

**Yes — 17 of 17, measured rather than claimed.** `check.test.ts` gained a
`FIRING` table with one violating fixture per invariant and two tests over it:

- every entry must produce a finding under its own id that the **clean baseline
  does not already produce** (so I11's routine "no checkpoint yet" and I14's
  unconditional count line cannot certify their own invariants), and
- the table's ids must be **exactly `INVARIANT_IDS`**, so an eighteenth
  invariant added without a firing fixture fails here rather than passing
  quietly forever.

The mutations that make each one fire: a repeated seq (I1), a dropped row (I2), a
flipped padding byte (I3), a swapped cold body (I3b), two blobs exchanged (I4), a
bucket off the ladder (I5), `v: 2` (I6), a live index pointing at a superseded row
(I7), a split that no longer sums (I8), a version/head disagreement (I9), an FX
snapshot that a re-fold contradicts (I10), two devices and no checkpoint (I11), a
`number` amount (I12), a supersede with no origin (I13), an anomaly kind outside
the frozen vocabulary (I14), a set-aside record naming no position (I15), and a
cold blob carrying an op list (I16).

---

## 5. Mutation testing

22 deliberate defects, each applied alone, `bun test src/invariants src/cli
src/store src/replay src/wire` run for each (466 tests), then reverted.

**Score: 21 killed / 22 = 95%.**

Killed: `eachOf` restarting its index per chunk · `checkChain` never remembering a
predecessor · a 1-entry predecessor window · the re-fold stopping after one op
chunk · the re-iterability guard removed · silent truncation · one counter run
shared by every writer · `observedHead` ignoring the rows · I14 finding no op ids
· `storedOps` skipping hot rows · `storedRows` memoizing its first pass · the push
escape as `some` · the push escape on the id alone · both I11 conditions
collapsed to one halt · the benign I11 ranked first · nothing ever routine · an
unknown-newer stop described as tampering · the halt lane dropping kindless stops
· a non-dismissable unreadable banner · a dismissable halt · the badge counting
routine notices.

**Two survivors were my tests' fault and are now closed**, per the standing rule:

- *A 1-entry predecessor window survived*, because every chain fixture in the
  suite had a single writer, so a row's predecessor was always the row
  immediately before it. A fixture with one of something cannot tell "correct
  linking" from "no linking". `stream.test.ts` now interleaves two writers and
  breaks one link — which is what a real page looks like, since `seq` is one
  order across all writers.
- *`storedRows` memoizing its first pass survived*, because a cache returns
  identical data. It is `all()` in disguise, which is the method the store was
  refactored to remove. There is now a WeakRef test asserting nothing from the
  first pass survives the second.

**One equivalent mutant was found and replaced**: "`storedOps` yields ops from a
set-aside blob" as written set `ops = []`, which is behaviourally identical to
`continue`. Replaced with "`storedOps` skips the hot rows instead of the cold
ones", which is killed.

**One genuine survivor, reported rather than hidden:**

- **M18 — `Client.check()` keeps every op it folded** (deleting
  `spent.length = 0`). The code is correct; the *test* gap is real. The property
  is memory-only and transient: the array is garbage the moment `check()`
  returns, so a post-run measurement cannot see it, and a mid-run one cannot
  either — Bun's `heapUsed` excludes typed arrays and its collector's
  conservative stack scan keeps a mid-pass sample's garbage alive. The equivalent
  property for the row path *is* covered (the survivor-count test). Closing this
  one properly means giving `applyRows` an op **sink** instead of an array, which
  is a change to `client.ts`'s shared fold path that Task 8's owner is mid-flight
  in; it is left named rather than done blind.

---

## 6. Verification

- `cd client && bun run typecheck` — clean.
- `cd client && bun test src/invariants src/cli src/store src/replay src/wire` —
  **479 pass, 0 fail** (13 more than the 466 baseline before the two
  mutation-driven tests).
- `bash scripts/v2-check.sh` at **commit `306a3e9`**, from a `git archive` export
  with `client/node_modules` copied in, after `go clean -testcache`:
  **`v2-check: OK (go + client + conformance)`**, and the script's OWN exit code
  captured as `EXIT=0` (not a pipeline's). The client half of that run was
  **2,094 pass / 0 fail / 0 skip across 21 files** — collected count up from the
  plan's recorded 1,911 baseline and monotonically non-decreasing, and the e2e
  files RAN rather than self-skipping (`test/e2e/exit.test.ts` printed its step
  4 checkpoint, step 9 fork notice and step 10 snapshot; `LEDGER_TEST_POSTGRES_URL`
  is exported by the gate).
- No pre-existing test was removed, skipped or weakened. One existing assertion
  was **strengthened**: `checkAll(input)` equality now also pins
  `kind: NOTICE_COUNTS` on I14's count line.

**A note on the shared worktree.** Two runs of the *whole* client suite were red
while I worked, both from another session's in-flight `client/src/net/engine.ts`
and `engine.test.ts` (written 01:53–01:55): one assertion failure that passes
when re-run, and one 180 s SIGKILL-resume test that makes the full suite take
three minutes. Neither is caused by this task — verified by re-running the
failing test against my tree, where it passes. My commit does not include those
files.

---

## 7. What is left, and why

**`app/src/components/HaltBanner.tsx` and
`app/src/screens/settings/IntegrityScreen.tsx` are not written.** `app/` was
being scaffolded by another session throughout this task (it landed as commit
`057c144` mid-way and contains only `Shell.tsx` plus the component README).
Writing screens into a tree another agent is actively creating is how sessions
sweep each other's work, and a component built blind against a shell that does
not exist yet is the "written, tested green, never wired" defect this project has
paid for six times.

So the contract is written instead — in `surface.ts`'s closing block, in enough
detail to implement without re-deciding anything:

```tsx
const s = surface({ violations, unreadable: state.unreadable, error });

if (s.halt !== null) return <HaltBanner halt={s.halt} />;   // instead of the app, at the root
// no close button, no back gesture, no "continue anyway"
// title / body / action are the only text; a disclosure lists halt.violations verbatim
// the engine must already be stopped: the banner REPORTS the halt, it does not cause it

{s.unreadable !== null && <UnreadableBanner n={s.unreadable.count} onDismiss={…} />}

<SettingsRow title="Integrity" badge={s.badge} />
// lists s.notices (title + count, tap to expand details); routine groups render
// collapsed and below the rest, never hidden; s.halts renders at the top
```

`app/src/components/README.md` gets its `HaltBanner` row in the same commit as
the component, per that file's own rule. Nothing else in Task 12 is outstanding.

---

## Files

| file | change |
|---|---|
| `client/src/invariants/check.ts` | `Chunks`/`arrayChunks`/`StreamCheckInput`/`checkAllStream`; nine row-consumers and four op-consumers streamed; per-invariant finding cap with an announced truncation; re-iterability guard; five new exported `kind` constants |
| `client/src/invariants/source.ts` | **new** — `storedRows`, `storedOps`: re-iterable, store-backed chunk sources |
| `client/src/invariants/surface.ts` | **new** — the three lanes, the halt copy, `haltKindOf`, `HALT_ORDER`, `escapableDuringPush`, the component contract |
| `client/src/invariants/check.test.ts` | the 17-entry firing roster and its coverage assertion; streaming equivalence; the re-iterability hard stop; the finding cap |
| `client/src/invariants/stream.test.ts` | **new** — equivalence at every chunk size, chunk poisoning (and proof the fixture bites), live-byte measurement with the array arm as the instrument's control, survivor counting, the store sources, `Client.check()` end to end |
| `client/src/invariants/surface.test.ts` | **new** — I11 has a surface; the two conditions never share one; ranking; the escape's `every`/allow-list boundaries; the three lanes; totality over every id and kind |
| `client/src/net/client.ts` | `check()` streams; `syncForAttestation` uses the shared escape predicate |
| `client/src/cli/main.ts` | `printViolations` prints the halt block and the grouped Integrity list; `--json` carries `surface` |

---

# Addendum — the wall-clock ceiling, the last mutant, and the two screens

Three follow-ups from the coordinator, in the order they were raised.

## 1. `stream.test.ts` was failing the gate under load. It is now structural.

**The reading.** The memory measurement took **1.7 s on an idle box and 7.5 s at
load 9** — past bun's 5 s per-test ceiling, so `v2-check.sh` exited 1 on a
machine that was merely busy. Task 13's agent measured it failing 3/3 in
isolation on a 2-core box at load 6.7.

**Why not raise the ceiling.** This repo already carries one wall-clock limit
(`replay/fx.test.ts`) under a standing rule not to raise it, because the reading
that broke it was contention and raising it would have erased the signal. A
second one turns "the gate is red" into background noise, which is how real
failures get waved through. And a duration was never the property anyway: how
long a fold takes is a fact about the machine; what it *retains* is a fact about
the algorithm.

**What replaced it.** A weak reference. `tracked(rows, size)` hands the checker
fresh copies a chunk at a time, weakly holds every blob it hands over, and counts
how many survive a forced collection at the end of each pass. What is asserted is
**reachability**, which reads the same on a loaded two-core box as on an idle
one.

| | before | after |
|---|---|---|
| corpus | 500 blobs × 16 KiB, re-sealed on every pass (~90 MB of gzip) | 120 blobs × 1 KiB, sealed once and copied |
| assertion | live `external` bytes < corpus/8, calibrated by an array arm > corpus/2 | peak reachable ≤ 3 chunks, calibrated by an accumulating consumer that must read the whole log |
| slowest test | 7.5 s at load 9 (**failed**) | 134 ms |
| whole file | 4.1 s | ~0.5 s |

**It is strictly stronger, not merely faster.** The byte version sampled *after*
the run, so a consumer that accumulated every chunk into a local and dropped it
at return read as zero. `checkChain` keeping every row instead of 32 bytes of
hash — a real memory defect — **survived** the old test and is **killed** by the
new one. The calibration arm is kept and sharpened: same source, same instrument,
a consumer that accumulates, which must read the whole log or the honest arm is
measuring nothing.

**Two instrument findings, recorded in the file so they are not rediscovered:**

- `process.memoryUsage().heapUsed` reports **zero** for typed arrays in Bun — the
  first draft measured memory while blind to the only thing on the heap counted
  in megabytes. (`external` is the byte metric; it is no longer needed.)
- A sample taken **mid-pass** keeps that pass's garbage alive through Bun's
  conservative stack scan. Measured directly: adding a debug array to the
  sampler changed the readings (51/100 → 50/50), which is the signature of stack
  layout rather than of retention. The sampler therefore fires **once per pass**,
  at the point where an accumulating consumer holds the most — which also cut 4 s
  of forced collections.

**No wall-clock guard was needed anywhere**, so none is gated behind an env flag.
`PEAKDBG=1` echoes the two peak readings for re-measurement; it asserts nothing.

Three consecutive runs at load 7.8–9.1: green, green, green.

## 2. The last mutant: closed, by making it unrepresentable

The survivor was deleting `spent.length = 0` from `Client.check()`'s fold. Task 8
has landed and does expose a seam — `materializeChunked({ keepOps: false })`,
with its own retention test in `engine.test.ts` — but it is **async**, and
`Client.check()` is synchronous with **eleven synchronous call sites across three
other sessions' files** (`net/client.test.ts`, `outbox/outbox.test.ts`,
`store/store.test.ts`). Converting `check()` would edit all of them mid-flight.
Inappropriate, so the seam was not used.

Instead the property moved somewhere a test can hold it. `discardingOps()` in
`invariants/source.ts` is a `LogEntry[]` whose `push` keeps nothing, and
`check()` folds into that. A truncation inside a sync method is a deletable line
that no instrument can reach — the array dies at return either way. An exported
sink is a contract:

| mutant | before | now |
|---|---|---|
| the fold accumulates the whole log | SURVIVED | **KILLED** (`the fold's op sink keeps nothing`) |

One residue, stated plainly: swapping `discardingOps()` for a plain `[]` **at the
call site** is still invisible, because that is the same unobservable-locals
problem one level up. It is a deliberate substitution rather than a deletion, and
closing it needs the async seam and the eleven call sites above.

## 3. The two screens are real

`app/` exists now, so `HaltBanner.tsx` and `screens/settings/IntegrityScreen.tsx`
are written, tested and catalogued in `app/src/components/README.md`. Both hold
**no policy**: they take `Halt` and `Surface` from `invariants/surface.ts` and
render them; neither switches on an invariant id and neither builds a sentence.

The fixtures are **real `surface()` output**, so the chain under test is
violation → lane → copy → glass. 13 render tests under `jest-expo`, all passing
(app suite: 28 jest, 231 bun).

Five deliberate defects, **five killed**:

| mutant | caught by |
|---|---|
| the banner renders `halt.kind` where `halt.title` belongs | no invariant id or condition name may reach the glass |
| the banner opens its details by default | the details are one tap away |
| the co-occurring halt is dropped | when both `I11` conditions fire, the other is still named |
| routine notices are hidden | routine notices are present, quiet, and last |
| the set-aside row is rendered as a stop | an unreadable blob is a warning row, never a wall |

The first of those is the one worth keeping: rendering the *id* passed a "the two
conditions differ" test, because `not_vouched_for` and `chain_withheld` differ
too. The test now asserts the copy itself.

**What is still not wired, precisely.** `app/` has no `Client` yet — `Navigation.tsx`
says so in as many words ("Task 8 constructs the `Client` … until then the screen
says so on the glass") — so nothing in the app computes a `Surface` to hand these
components. The remaining hop is three lines at whatever root gains the engine:

```tsx
const s = surface({ violations, unreadable: state.unreadable, error });
if (s.halt !== null) return <HaltBanner halt={s.halt} also={s.halts.slice(1)} />;
```

Writing that today would mean inventing the app's `Client` inside another
session's live tree. The components and their contract are done; the call site
belongs to whoever lands sync in `app/`.

## Verification (addendum)

- `cd client && bun test src` — 2,206 pass, 0 fail, 25 files.
- `cd app && npx jest` — 28 pass, 4 suites. `cd app && bun test src` — 231 pass.
- `cd app && bun run typecheck` — my files clean; one pre-existing error remains
  in `screens/onboarding/HomeCurrencyScreen.tsx` (Task 14, another session,
  in-flight).
- `go clean -testcache && bash scripts/v2-check.sh` at **commit `219e345`**, in a
  `git archive` export with `client/node_modules` copied in, on a **loaded box**
  (load average 5.4–6.5 through the run): **`v2-check: OK (go + client +
  conformance)`**, and the script's OWN exit code captured as `EXIT=0` — not a
  pipeline's. Client half: **2,246 pass / 0 fail across 28 files**, up from 2,094
  and monotonically non-decreasing.
- And the specific regression, deliberately provoked: `stream.test.ts` run three
  times with eight CPU burners pinned against it — **3/3 green**, where the
  wall-clock version failed 3/3 at load 6.7.

## Commits (addendum)

| commit | contents |
|---|---|
| `8eb1842` | `fix(v2): assert stream boundedness structurally, not by clock` — `stream.test.ts`, `source.ts`, `client.ts` |
| `219e345` | `feat(v2): the halt banner and the integrity screen` — `app/src/components/HaltBanner*`, `app/src/screens/settings/IntegrityScreen*`, `README.md` |

`client/src/net/client.ts` was again reconstructed as HEAD + my three hunks only:
the worktree copy also carried another session's uncommitted doc-comment edit,
which is not in my commit.
