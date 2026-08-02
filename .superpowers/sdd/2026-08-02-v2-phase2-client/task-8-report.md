# Task 8 — the sync engine: chunked, yielding, resumable, one connection

**Status:** COMPLETE. Steps 1, 2, 3, 4, 6 done. Step 5 (fallback F1) not required
and not done — see "What I assumed pending Task 1".

**Commits** (branch `v2`, each verified to contain only Task 8's paths with
`git show --stat`):

| sha | what |
|---|---|
| `3db995d` | `feat(v2): project the folded state into SQLite for the UI to read` |
| `f83a379` | `feat(v2): the sync engine — chunked, yielding, resumable, one connection` |
| `d296bc3` | `test(v2): make the retention measurement survive a busy box` |
| `3391123` | `test(v2): prove the projection streams, with a poisoning transaction source` |

---

## Where the code went, and why it is not in `app/`

The plan names `app/src/sync/engine.ts` and `app/src/db/projection.ts`.
**`app/` does not exist** — Task 3 builds it and was in flight in another
session while this ran — and my dispatch scoped me to `client/src/net/` and
`client/src/replay/` for exactly that reason. So:

| plan | shipped |
|---|---|
| `app/src/sync/engine.ts` | `client/src/net/engine.ts` |
| `app/src/db/projection.ts` | `client/src/replay/projection.ts` |
| `app/src/sync/engine.test.ts` | `client/src/net/engine.test.ts` |
| `app/src/db/projection.test.ts` | `client/src/replay/projection.test.ts` |

Both modules are **host-free**: `SqlDriver` is a type-only import (the same
arrangement `store/sqlite.ts` uses), so both are reachable from Hermes and drag
no `bun:sqlite` with them. `app/` imports them; nothing needs to move. This also
means the engine inherits `client/`'s entire test corpus — including the
`LEDGER_CLIENT_STORE=sqlite` run — rather than being a fresh untested surface,
which is the same argument `store/driver.ts`'s header makes for living in
`client/`.

**This is a deviation from the plan's file list and the reviewer should confirm
it.** If Task 3 would rather `app/` own these, the move is mechanical (they
import only from `client/src`), but the test corpus does not move with them.

### The `client/src` edits, and their justification

Global Constraints permit `(d) additive exports` to `client/src`. Two additive
methods were added to `Client` (+196 lines, no existing line changed):

- **`materializeChunked(opts)`** — the async twin of `materialize()`. Same rows,
  same `decodeWireRow`, same `applyRows`; the only difference is the `await`
  between chunks. It exists because `materialize()` is *synchronous*, so a
  3,683-row fold is one uninterrupted slab of JS and a synchronous `Store`
  (Decision 3) cannot express a yield. Task 5's report says this in as many
  words: "Task 8's async sync engine is where the yield belongs."
- **`reconcile(stream)`** — the resume path. Task 5's report names it: "Automatic
  resume from a rows-ahead-of-cursor state is Task 8's 'resumable' and is not
  built here."

Neither changes existing behaviour; the suite's collected count went **up** at
every commit and no pre-existing test was removed, skipped or weakened.

---

## The operation order, all seven steps

The canonical order is **`pull → verify → pin → fold → attest → push`**. Task 8's
own prose restates it while dropping `pin`; the Global Constraints section does
not, and the Global Constraints win. In this engine it expands to:

| # | step | where it happens |
|---|---|---|
| 0 | **resume** | `Client.reconcile` — verifies and pins rows already on disk above the cursor, before anything is fetched |
| 1 | **pull** | `Client.pull({ limit: CHUNK_SIZE })` |
| 2 | **verify** | `verifyChain` against the pinned head (hot) / pinned per-blob hashes (cold), before a blob is opened, plus `checkAll` over the page — inside `pull` |
| 3 | **pin** | the new head persisted with the rows and the cursor in one transaction — inside `pull`, and inside `reconcile` for the rows it heals |
| 4 | **fold** | `Client.materializeChunked`, 250 rows per chunk, a yield between chunks |
| 5 | **project** | `project()` into SQLite, same chunk size, same yield |
| 6 | **attest** | a `writer_checkpoint` naming one head per (roster writer × stream), from the heads step 3 pinned — inside `Client.push` |
| 7 | **push** | pending ops uploaded, then a self-sync — `Client.push` |

Steps 4 and 5 run a second time when step 7 actually uploaded, because that
upload's trailing pull brings rows back the projection would otherwise not show
until the next sync. **Once, never in a loop** — a loop here is a sync that never
ends on an account with a busy peer.

Every one of steps 1, 2, 3, 6 and 7 is `Client`'s code, *called*. The engine
reimplements none of it, which is the Global Constraint that matters most here:
"None of them is the `pull → verify → pin → fold → attest → push` ordering, which
Phase 1's own ledger records taking four review rounds to get right."

### `pin` is load-bearing, and it is asserted from the wire

Two tests, and they are the reason the dispatch flagged this:

- **`pin is not skipped: the checkpoint attests real heads, hot AND cold`** — the
  device pulls HOT only (`cursor(cold) === 0`), never downloads a cold body, and
  the checkpoint it uploads still names `ingest|cold` at counter 4. Asserted by
  *decoding the blob the fake server received*, not by reading the client's
  intent.
- **`a device holding cold HASHES but no cold bodies is not reported as being
  withheld from`** — with a **second** device, so the checkpoint under test was
  written by someone else. `observedHead()` counts pinned per-blob hashes; skip
  the pin and this run reports `chain_withheld`, which is a hard stop no device
  can clear.

Mutation M11 (advance the cursor without pinning) and M14 (never push, so never
attest) are both caught.

### The I11 deadlock, and the allow-list I refused to copy

A freshly enrolled second device hard-stops `I11_roster_checkpoint` on every sync
until some device writes a checkpoint naming it — and writing that checkpoint is
a *push*, which the engine reaches only after a pull it cannot complete. Found by
a test, not by reading: the second device's sync returned `halted: true` forever.

`Client.push` already owns the escape, and owns it as an **allow-list**: it
proceeds over `VIOLATION_ROSTER_COVERAGE` and nothing else, because
`VIOLATION_CHAIN_WITHHELD` means a device is being lied to and has nothing
trustworthy to attest. So `pullOrHeal` hands a refused pull **straight to
`Client.push`** rather than classifying the stop itself. If the stop is benign,
push writes the healing checkpoint; if it is anything else, push rethrows the
same `HardStopError` and the engine halts on it.

That is deliberate: the AGENT-RULES defect shape "a check true by construction"
has a sibling here — two copies of an allow-list are two things that can
disagree, and the copy that disagreed on this project laundered a withholding
attack into a notice. The engine's policy is "ask the component that owns the
policy", which is not a policy. (The Task 12 session has since single-sourced the
predicate as `invariants/surface.ts:escapableDuringPush`; the engine needs no
change to benefit.)

Three tests hold this shape in place, and mutations M15 and M16 are both caught:

- a non-roster-coverage hard stop with **push enabled** still halts *and*
  authors nothing (M16's target — the laundering shape);
- the repair does not swallow an error that is not the escape (a stalled cold
  hash cursor must surface as `ProtocolError`, not be stepped over on the way to
  a retry);
- the second device syncs cleanly (M15's target — the deadlock).

---

## How the yield's PROPERTY is asserted, not its call count

The dispatch is right that a `ceil(n/250)-1` assertion proves only that somebody
wrote a `setTimeout`. There are two tests and they are labelled as what they are.

**The weak one, kept and named as weak.**
`foldsInChunksAndYieldsBetweenThem` patches the **global `setTimeout`** and counts
zero-delay calls — not an injected spy, because an engine that yielded with
`await Promise.resolve()` would satisfy an injected hook while never returning to
the event loop. It asserts `2 + 2` (fold gaps + projection gaps) at n=7,
chunk=3, and a companion asserts **zero** yields for a log shorter than one
chunk. Mutation M1 (microtask instead of `setTimeout`) is caught here; M6 (the
off-by-one that yields once per chunk instead of once per gap) is caught by the
memory test.

**The real one: `rssIsBoundedAcrossChunks`, a calibrated retention measurement.**

The instrument: a 4,000-row corpus of `rate_set` ops each carrying 8 KiB of
incompressible padding. The asymmetry is the whole design — a `rate_set` adds one
small map entry to the state and drops everything else, so the *only* thing that
can hold 32 MB of payload alive is the op list. (A `txn_ingested` corpus would
put the payload into `State` and both arms would grow identically, measuring the
state rather than the retention. The home currency is `AAA`, which the currency
generator cannot produce, because a collision folds as an anomaly and anomalies
carry detail *strings*.)

Two arms, **each in a fresh child process**, reading the **same corpus file**, so
they differ in exactly one thing: `keepOps`. Per chunk, `Bun.gc(true)` then
`heapUsed` — retention, not allocation.

The **calibration is a prediction, not a threshold**: a fold that keeps its
decoded ops must retain one chunk's payload for every chunk it folds, so its
slope is `CHUNK_SIZE × PAD_BYTES`. Measured 1.08× predicted, reproducible to two
decimal places across runs. If the instrument cannot see that, the test fails
*there* rather than passing vacuously on the bounded arm.

Then the property: the bounded arm's span over the settled half is under half of
one chunk, its slope under a tenth of the retaining arm's, and its growth
distributed rather than concentrated.

**And the measurement found a real defect in my own first implementation.**
`materializeChunked` originally returned every decoded op, because
`materialize()` does (the checker needs them for I9/I10). That is O(log) in
decoded *payload* bytes — every inflated body's contents alive for the whole
fold, which is precisely the >500 MB shape. **Chunking the read does not help if
the decode's output is accumulated anyway.** So `keepOps` defaults to `false` and
the engine's fold uses it; a caller that genuinely needs the ops asks for them,
visibly, at the call site. The two arms of the calibration are that same flag,
which is why the positive control is real production-shaped code rather than a
fake leaky implementation written for the test.

`the engine's fold is the bounded arm — it asks for keepOps: false` is the wiring
half: the property test proves what the flag buys, this proves the engine asks
for it. A memory property measured on a code path production does not take is
this project's second-most-expensive defect shape.

**Three streaming tests, using Task 5's poisoning technique.** A store/source
that poisons the chunk it handed out last when the next is asked for, so an
implementation that pages through collecting and decodes afterwards reads the
same bytes, produces the same counts, and fails loudly:

- `materializeChunked folds each chunk before it asks for the next` (row store);
- `project writes each chunk before it asks for the next` (a poisoning generator
  over `State.txns`);
- and a **calibration for the calibration** — an explicit read-all-then-decode
  loop that the poisoning store must catch, without which a wrapper that silently
  did nothing would certify a read-all fold as streaming.

### `rssBytes()` does not work on this host — a finding, recorded

The plan names `rssBytes()`. It is not a usable retention instrument here and the
numbers say so plainly: Bun's process floor is ~270 MB of JSC arenas, so 32 MB of
retained payload is inside the noise. Measured **peak** RSS was 285–296 MB for
the arm holding every op against 276–278 MB for the arm holding one chunk; the
per-chunk RSS *span* flipped between 4 MB and 90 MB across runs of the **same
arm**; and even `bounded.peakRss < retaining.peakRss` — a 3 % margin on an idle
box — **crosses under load** (270.4 vs 266.1 MB, measured).

So RSS is asserted for the one thing it can say, which is also the thing the
product needs: the process nowhere near the >500 MB at which Phase 0 froze. **Task
28 must measure the device figure on Hermes rather than infer it from here.**

### Three checkers that cried wolf before this one

Recorded because AGENT-RULES is explicit that a checker which cries wolf gets
ignored, and because each was found by running the test on a *busy* box rather
than by reasoning:

1. **Two arms in one process** contaminate each other — the previous arm's 12 MB
   is still on the heap at the next one's baseline and gets collected during it.
   The retaining arm read `10.4, 2.1, 4.0, 6.2, 8.3, 10.7`, so `last − first` came
   out at 0.3 MB and the *calibration correctly refused the run*. Fixed by a
   fresh process per arm — which is also what a device has: one restore in it.
2. **Strict per-chunk monotonicity** failed under CPU load on a box that was
   merely busy. **"Three quarters of the steps are positive"** failed 6 runs out
   of 6 at eight busy cores — while the slope assertions passed every time.
   Per-*step* anything is a statistic about GC scheduling. What the slope cannot
   rule out is one jump at the end, so the claim is now about where the growth
   sits: half the chunks in, roughly half the growth.
3. **The RSS ratio** above.

Final stability: **10/10 green** — 6 runs under deliberate 8-core load, 4 idle.

---

## How resume survives an interruption, and what interrupted it

Two tests, because the two things being claimed are different.

**The specific window, deterministically.** `rows persisted above the cursor are
verified, PINNED and folded once` reproduces `fileStore`'s residual crash window
by hand — rows on disk, cursor and pinned head wound back — and asserts the
resumed state is **byte-identical to `serializeState()` of a clean sync**, the
cursor reaches 6, **the pinned head reaches 6**, and `anomalies` is empty (a
second application would fork every entity against itself). A sibling asserts
`reconcile` **refuses** rows that do not follow the pinned head: the resume path
must not become a way to launder unverified rows into the log.

**The real interruption: `SIGKILL` to a child process.** `interruptedRun` spawns a
child that opens a `fileStore` profile, runs `engine.sync()` against the parent's
fake server, and is killed with signal 9 at a chosen delay after the parent
serves its first page. No unwind, no `finally`, no flush. `fileStore` is used
deliberately — it is the store whose crash window is *real* (two files, no
journal, rows written first); `sqliteStore` cannot reach the state at all, which
makes it the wrong instrument.

Eight kills at delays `0, 2, 5, 10, 20, 35, 60, 120 ms` across a 400-row log, then
one resume in the test process. Assertions: 400 transactions, no anomalies,
cursor and pinned head both at 400, and `serializeState()` **byte-identical** to a
reference sync that was never interrupted.

Two guards keep it from going green vacuously:

- **at least one kill left `0 < cursor < 400`** — if every signal landed before the
  child did any work, the test would be asserting that a fresh sync works, which
  is covered five times over elsewhere;
- **a separate calibration test** (`the interruption harness really does kill a
  running child`) asserts the child printed `started`, did **not** print
  `finished`, and exited non-zero. A `proc.kill` that silently did nothing would
  otherwise let every run complete.

Stability: 5/5 green in isolation, and green in every full-suite run.

**Honest scope note.** The `rows > cursor` state specifically — the two-file
window — is *measured and reported* by the sweep, not asserted, because the two
writes it sits between have no `await` in them: a signal lands there only if it
interrupts the syscall. Task 5 judged the exposure low for exactly that reason,
and this is the evidence for that judgement. The window's **repair** is pinned
deterministically by the first test. What the sweep does assert for every run is
that rows are never *behind* a cursor that claims them — the unrecoverable
direction.

**The ordering hazard is not reintroduced.** `reconcile` runs *before* `pull`, and
persists the cursor and the pinned heads together inside `Store.transaction`, per
chunk. Task 5's `Store.transaction()` is used, not bypassed.

---

## Test summary

```
cd client && bun run typecheck && bun test
cd client && LEDGER_CLIENT_STORE=sqlite bun test
go clean -testcache && bash scripts/v2-check.sh
```

Verified in a `git archive` export of commit **`3391123`** — my own final code
commit — with `client/node_modules` copied in. Four other sessions have landed
since (Tasks 11, 13, 20 and their gate records); the counts below are from that
export and the branch has grown past them.

| run | result |
|---|---|
| `bun run typecheck` | clean |
| `bun test` ×3 | 2246 collected / 2208 pass / 37 skip / **1 fail** |
| `LEDGER_CLIENT_STORE=sqlite bun test` | 2246 / 2208 / 37 / 1 fail (same test) |
| Task 8's own files | `engine.test.ts` 28 tests, `projection.test.ts` 17 tests — **45 added, 0 failing** |

Baseline at Task 0 Step 3 was 1,911 collected; at the start of this task 2,053
collected / 2,016 pass / 37 skip / 0 fail. Monotonically non-decreasing, and no
pre-existing test was removed, skipped or weakened.

### The 1 failure is NOT Task 8's, and here is the attribution

`invariants/stream.test.ts` → **`a whole-log check holds a chunk, not the log —
and the measurement can see the difference`** (the Task 12 session's streaming
checker).

Three independent pieces of evidence:

1. **It reproduces at `489ce91`, before any Task 8 commit existed** — 2 failures in
   6 full-suite runs, and **3/3 with that test file alone under CPU load**.
2. **With Task 8's two test files deleted from current HEAD, it still fails 3/3.**
   My *code* is still present; only my tests are gone.
3. It passes 4/4 when its own file is run alone on an idle box.

It is the same class of instrument as my own memory test and it has the fragility
mine went through three iterations to shed: it is measuring heap in a process
shared with 2,200 other tests, and it became a consistent failure rather than an
occasional one as the suite grew from 19 to 28 files. **It is not mine to fix and
I have not touched it**, but it currently fails `v2-check` for everyone, so it
needs an owner. The fix shape is in `net/engine.test.ts`: measure in a child
process, calibrate against a prediction, and never assert a ratio between two
quantities that both move with machine load.

`bash scripts/v2-check.sh` at `d296bc3` printed `v2-check: OK (go + client +
conformance)` on one run and exited 1 on another with **only** that test failing.
Go and conformance were green on every run.

---

## Mutation score

**32 mutations, 32 caught (100 %)** — 31 in one clean batch plus M4 re-measured
after its first form was found to be an equivalent mutant (below). Battery and
full log: `$SCRATCH/task8-mutate.py`, `$SCRATCH/mutation-clean.txt`. Each is
applied to a fresh export of the verification commit and scored against
`bun test src/net/ src/replay/ src/store/ src/invariants/check.test.ts`.

**One mutation was rewritten rather than counted.** M4's first form was
`const held = chunk.map(decodeWireRow); applyRows(…, held)` in place of
`applyRows(…, chunk.map(decodeWireRow))` — semantically identical, the array
unreachable after the statement in both spellings. An **equivalent mutant**, and
it was reported as one rather than rounded into the score. It is now a genuine
read-all-then-fold (collect every chunk's rows, fold after the loop), and it is
caught by both of the tests built for it: `rssIsBoundedAcrossChunks` and
`materializeChunked folds each chunk before it asks for the next`.

The battery deliberately does **not** run the whole suite: `invariants/stream.test.ts`
fails 3/3 on this box with Task 8's files removed, so counting it would score
another session's flake as a catch. Narrower is the conservative direction.

Coverage: the yield (M1, M6), retention (M2–M5), one connection (M7, M8), the
`isRunning` guard (M9), the order and the pin (M10–M14), the I11 allow-list
(M15, M16), halting (M17, M18), the projection (M19–M28), progress and the
progress guarantee (M29–M32).

### Eight survivors along the way, and what each one taught

Per AGENT-RULES the fault was checked in the **tests** first, and in all seven
cases that is where it was. Nothing was rounded away.

| id | defect | the gap it exposed | closed by |
|---|---|---|---|
| M11 | reconcile advances the cursor without **pinning** | the anchor matched two places (`pull` and `reconcile`); once disambiguated it was already caught | anchor fixed — the coverage existed |
| M12 | reconcile advances the cursor without **verifying** | same | same |
| M16 | the engine escapes **every** hard stop by pushing over it | *every* halt test ran with `push: false`, so the repair path was never exercised with a non-escapable stop | new test: a stalled cold-hash cursor must surface as `ProtocolError` rather than be swallowed on the way to a retry |
| M18 | `halt()` ignored at chunk boundaries | the projection has its **own** cancellation check, so the sync still ended halted — one phase and a whole corpus later | assert `"projecting"` never appears in the phase trace and the projection is unusable |
| M29 | `progress` hands out the live object | never tested | new test: a subscriber mutating what it receives changes nothing, and two subscribers get different objects |
| M30 | the cold cursor is dropped from the folded state | replay never advances `cursors.cold` (I16), so it must be carried over — dropped, the projection tells the UI the cold stream is at genesis | new test: `readMeta().cursorCold === client.cursor("cold")` |
| M31 | the async fold's progress guarantee removed | `eachRowChunk` has one; this loop is **not** that loop | new test with a store that re-serves the same page forever — and the fixture had to be fixed too, because returning the same row *twice in one chunk* is refused by `foldBlobs` first and leaves this loop untested |

M5 (`the projection materializes every transaction before writing any`) also
survived, once. It had been caught while the memory measurement covered the
engine's whole `sync()`; when that was narrowed to `materializeChunked` in child
processes, the projection lost its only proof. Closed by the poisoning generator
described above (`3391123`) and caught since.

---

## What I assumed pending the Task 1 gate

Task 1 has not run — no Mac, no paid Apple account (`progress.md`: "BLOCKED ON
SALEH"), and `docs/superpowers/specs/v2-phase2-crypto-gate.md` does not exist. The
dispatch's caveat is honoured:

- **Nothing hard-codes oldest-first-to-completion.** `sync()` takes
  `{ stream, push }`, the fold walks whatever the `RowStore` holds, and the
  projection is a full replace of a `State`. A newest-window-first restore (F1)
  needs a `RowStore` that serves a window and a `State` folded over it; the
  engine's chunking, yielding, resume and projection are all indifferent to which
  window that is. **Step 5 was therefore not implemented**, per the plan's own "if
  Task 1 returned CONDITIONAL … otherwise note in the task report that it was not
  required".
- **Where F1 *will* bite**, so nobody rediscovers it: `Client.pull` folds from the
  persisted cursor forward and `materializeChunked` folds from seq 0. A
  newest-first restore needs pending-parent handling *in the fold*, which is
  `replay.ts`'s business and not the engine's — F1 is a Task 7 / Task 9 change
  with an engine consequence, not an engine change.
- **No encryption anywhere.** Phase 2 is plaintext; `openBlob`/`sealBlob` are
  called exactly as `Client` already calls them.

Other assumptions worth a reviewer's eye:

1. **`sync()` pushes by default**, which costs two extra round trips even with
   nothing pending (`push()` pre-syncs both streams). The alternative — pushing
   only when `pending.length > 0` — means a device with nothing to say never
   writes a checkpoint, and a newly enrolled peer is blocked until one does.
   Correctness over round trips; `sync({ push: false })` is documented as a read
   refresh and as *not* the app's only sync.
2. **The projection carries `parse_error`**, which the plan's column list omits.
   Task 7 added it to `Txn` and the review queue needs it. Additive.
3. **`projection_meta` carries `home_currency`**, also not in the plan's list. It
   is log state the UI needs and it has nowhere else to live.
4. **A projection is not atomic as a whole.** A `SqlDriver.transaction` takes a
   *synchronous* function, so an `await` inside one is not expressible and a
   chunked+yielding projection cannot be one transaction. `complete` is cleared
   before the first row and set after the last, so an interrupted projection reads
   back as *unusable* rather than as a short log. That is the difference between
   "rebuild me" and "the user lost half their transactions".
5. **A schema-version mismatch drops and rebuilds, never migrates.** The
   projection holds nothing that is not recomputable from the log, so a migration
   would be code with no reason to exist and one more thing that can be wrong.

---

## Concerns for whoever picks this up

1. **`invariants/stream.test.ts` fails `v2-check` and is not mine.** Attribution
   above. It needs an owner before the next gate run means anything.
2. **`Client.pull` still holds a running `ops` array across pages**, for
   `checkAll`. That is O(log) in decoded payload bytes and it is the one
   remaining unbounded hold in a sync. Task 12 landed `checkAllStream` for the
   standalone `check()`; the per-page path in `pull` was not converted. Whoever
   owns Task 12's follow-up should look at `pull`'s `const { state, ops } =
   this.materialize()`.
3. **The engine folds twice per sync** — once inside `pull`, once for the
   projection — and a third and fourth time when a push uploads. Task 9's
   snapshot is the fix; until then a cold restore pays for it. `materializeChunked`
   accepts a chunk size and a `between` hook so Task 9 can drive it from a
   snapshot cursor without changing the engine.
4. **`sharedDriver` lives in `net/engine.ts`**, which is a poor address for a
   database connection cache. It is there because rule 2 is a Task 8 rule and
   `client/src/store/` was being edited by another session. It should probably
   move to `store/` once the tree is quiet, and `app/src/db/driver.ts`'s
   `expoDriver` must be reached *only* through it — that is the whole rule, and it
   cannot be enforced from here.
5. **`readTxns` builds a `Map` of the whole table.** It is documented as a test
   accessor and a small-account convenience; the UI must query slices with its own
   SQL. If a screen ever calls it on a 3,683-row account, that is the `all()` this
   codebase deleted, reintroduced by the back door.
