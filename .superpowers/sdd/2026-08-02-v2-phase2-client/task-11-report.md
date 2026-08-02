# Task 11 — the writer: outbox, offline queue, chains, checkpoints

**Status:** complete.
**Branch:** `v2`. **Commit:** see "Commits" below.

---

## What this task actually had to build

Steps 1 and 2 of the plan turned out to be **already done** and I verified that
by reading and by running, not by trusting the ledger:

- Step 1's reviewer scenario — dev-a to hot counter 4, dev-b checkpoints
  `dev-a|hot=4`, the server truncates dev-a to 2, dev-c pushes — exists at HEAD
  as `client/src/net/client.test.ts`'s `describe("withholding is never escaped")`
  (lines 961–1067), and it asserts both halves: dev-c authors **no** checkpoint,
  and `VIOLATION_CHAIN_WITHHELD` is not escapable.
- Step 2's `.every` boundary — an `I11` coverage stop travelling with another
  hard stop — is pinned by `"a coverage stop alongside another hard stop is
  still a refusal"` in the same block. I re-verified it by mutation (M5 below):
  `.every` → `.some` in `invariants/surface.ts` is caught.
- `CHECKPOINT_NAMES_THE_ROSTER` is implemented in `Client.attestableHeads`, and
  the "enrolled but silent device writer at counter 0 / genesis" case is covered
  at `client.test.ts:526`.

What was **not** covered, and is what I built:

1. **The ingest writer's empty chains on a brand-new account.** Every existing
   client-side checkpoint fixture either omitted `ingest` from the roster or
   seeded it with mail. The common path — an account with an ingest writer and
   nothing in its chains — had no client-side test.
2. **Client-side truncation detection of the ingest chain.** Phase 1 proves it
   end to end (`test/e2e/exit.test.ts` step 16) but that needs Postgres.
3. **The outbox** — paging, and surviving termination mid-write. This is where
   the real defects were.

---

## Two Criticals found, reproduced, and fixed

`POST /api/v1/sync` has an ambiguous outcome: the server appends the batch in
one transaction and *then* answers. A process killed in between — a phone whose
app is terminated — cannot tell whether its ops landed. Everything that recorded
the upload (`ClientState.authoredHead`, the emptied `pending`) was written
**after** the answer, i.e. after the step that fails. That is exactly the defect
shape the dispatch named, and it produced two distinct permanent failures. Both
were reproduced against the unmodified code before anything was written.

### C1 — permanent double-append

If the pre-push sync had caught up by the time the device came back, the counters
had moved, so the same ops were re-derived from `pending` and appended **again**
at fresh positions. Measured with the code at HEAD:

```
pending after interrupted push: [ rate_set:01KZ03…, writer_checkpoint:01KZ03… ]
dev-a rows: [ 1n, 2n ]
total ops folded: 5   DUPLICATE op_ids: [ 01KZ03WNET…, 01KZ03WNEZ… ]
```

Two ops in an append-only log, twice, forever. For a versioned entity the second
copy no longer matches its parent version, so the device manufactures a
`ForkNotice` against its own edit.

### C2 — permanent wedge, reported to the user as tampering

If read-after-write lag meant the pre-push sync could *not* see the committed
row, `pending` was re-batched instead — and the packer is greedy, so an op
emitted in the meantime joined the first blob and changed its bytes. Measured at
HEAD:

```
second push: ApiError POST /api/v1/sync: 409 chain_break: that position already
             holds different bytes
third  push: ApiError … (identical)
```

Nothing clears it: every later push rebuilds the same batch. It reaches the halt
surface as `chain_withheld`/tamper copy for a fault that is entirely the
client's own.

The existing straddle test (`client.test.ts:597`) misses this because its ops are
700 KB each, so each fills its own blob and the packer physically cannot regroup
them. That was deliberate for the case it tests; it is also why the ordinary
small-op case had no coverage.

### The fix

`ClientState.inflight` — a durable record of the batch a push is about to send,
written **before** the request and cleared only after the answer comes back.
Recovery is a **measurement**, not a flag: the recorded hash of the last blob is
compared against the chain head the next sync *verified*, i.e. the server's own
bytes re-hashed locally. Two independent sources. Because a chain hash covers
every blob beneath it, agreement at the tip is agreement about the whole prefix.

The bytes are not stored (up to 8 MiB in a state file rewritten whole on every
command). The record keeps the **grouping** (`opIds` per blob) and a resend
re-seals exactly those ops at exactly that counter. That is safe only if sealing
is deterministic, so `rebuildInflight` re-hashes and **refuses to send** anything
that does not reproduce the hash written down — the determinism is checked at
runtime, not assumed.

Disagreement at the tip is this device's own chain forking, which stops the push
**before** `pending` is touched. That ordering is load-bearing: skip the hash
comparison and reconciliation declares a substituted blob "landed", drops the
user's queued edits and commits them away — the push then fails one guard later,
with the edits already destroyed. `outbox.test.ts` asserts the queue depth is
unchanged across that error, which is what makes the guard's absence visible.

### Two smaller fixes in the same path

- **`409 chain_break` on upload now becomes a `ChainBreakError`** rather than a
  raw `ApiError`, so one class means one thing and the outbox's no-blind-retry
  latch and Task 12's halt surface can key on it without string matching.
- **`NetworkError`** — `Client.request` wraps a fetch that got no HTTP answer at
  all. Without it the outbox's "offline" classification is a deny-list, and the
  first draft of that deny-list silently swallowed the client's own determinism
  check as a connectivity blip. It is now an allow-list with one entry.

---

## The outbox

`client_state.pending` **is** the queue — the plan says so, and it is the right
call: `Client.emit` appends and commits in one call, so an op is durable the
instant it is authored and no crash can leave it in one store and not the other.
A second durable queue beside it would be two writes where one is needed.

`client/src/outbox/outbox.ts` adds what a phone needs on top and stores nothing
of its own:

- **Paging.** `Client.push` sends at most `MAX_UPLOAD_BLOBS` (8) blobs and
  reports `remaining`; `Outbox.flush` is the loop. Previously `buildBlobs`
  **threw** `"${n} blobs exceeds the 8 one upload may claim; push more often"` —
  advice for a past that has already happened, and an outbox a week offline could
  never drain. The 12 MiB body cap needs no separate client-side accounting
  (8 top-bucket blobs base64'd is ~11.2 MiB), and `outbox.test.ts` re-measures
  that by weighing an actual request body rather than comparing two expressions
  derived from the same constant.
- **One flush at a time.** A second `flush()` while one runs joins the first —
  Phase 0's 39-request fetch storm rule.
- **A latch.** `ChainBreakError` and `HardStopError` are remembered; every later
  flush throws them back *without touching the network* until `clearHalt()`.
- **A progress guarantee.** A page that reports work left without moving the
  queue raises `OutboxStalledError` instead of spinning.

`Outbox` takes a `Pusher` (the three members of `Client` it uses; `Client`
satisfies it structurally). That exists so the progress guarantee can be tested
against a pusher that reports progress it did not make — the real client cannot
be made to do that, precisely because it is correct, and a guard whose failing
case is unreachable in every test is a guard nobody has seen work.

**Wired, not shelved:** `cli push` goes through `Outbox.flush()`. Before, it sent
one page and reported success with the rest still queued. The paging and
reconciliation themselves live in `Client.push`, which every caller already uses.

---

## The checkpoint questions the dispatch asked

**A checkpoint names a never-written chain** at `{counter: 0, hash: <64 zeros>}`,
one entry per `(roster writer × stream)` pair. It is built from the **roster**,
never from observed heads: a chain nobody has written has no head to observe, so
an observed-heads checkpoint could not name that writer at all and `I11` would
hard-stop the account forever with no emittable checkpoint able to clear it. A
zero entry asserts nothing false — `0 > observed` is never true — so it can hide
no withheld row. New test: `"a brand-new account names the ingest writer's empty
chains at counter 0"`.

**The ingest chain is covered and truncation is still detected.** Production
creates the writer with the user (`auth.UpsertUser` → `TestUpsertUserCreatesThe
IngestWriter`), so it is on the roster from the first sign-in and the checkpoint
names it like any other. New client-side test, no Postgres needed: seed four
ingest blobs on both streams, let a device attest them (`ingest|hot=4`,
`ingest|cold=4`), truncate the ingest chain to counter 2 — a clean prefix, so
contiguity holds, every hash recomputes and `verifyChain` passes — and the next
device's pull raises `chain_withheld` as a hard stop and nothing else.

Also pinned, because it is the *normal* state and not an edge case: a device that
pinned the cold hash list and downloaded no cold body is **not** a withheld
chain. `observedHead()` counts pinned per-blob hashes for exactly this reason
(spec §3.3:70's lazily-synced window).

**The honest limit, stated so nobody reads more into it:** Phase 2 blobs are
plaintext, so a server that truncates **and** rewrites the attesting checkpoint
stays undetectable until Phase 3 seals them. What a checkpoint buys today is
detection behind an *honest* checkpoint — storage loss, a bad restore, a partial
drop. The test comments say this; no code or comment claims more.

**A multi-device account hard-stops until a checkpoint lands.** Correct, and it
has a visible cost I had to encode in a test: `pull` persists nothing over a hard
stop, and the push escape lets the repair through *without* fresh heads, so on a
multi-device account the **first** checkpoint claims 0 for everything and the
**second** attests what the now-unblocked pull verified. The truncation test
therefore pushes twice, with that reasoning written down at the assertion.

**Operation order implemented:** `pull → verify → pin → fold → attest → push`,
unchanged. `Client.push` opens with `syncForAttestation()` (pull + pullColdHashes,
each verifying its own stream) and the checkpoint is built from **pinned** heads
afterwards. Nothing was reordered. The one thing I inserted is
`reconcileInflight()` immediately after the sync and before anything reads
`pending` or the authoring head — both of them lie until the previous flight is
settled, and acting on them is what appends an op twice.

---

## How the crash cases were produced: by crashing

`Bun.spawn` + `proc.kill(9)`. No unwind, no `finally`, no flush. The fake server
**commits the upload and then never answers**, so the signal lands inside the
window where the rows exist and the client does not know it. Three scenarios:

| scenario | killed at | resumed behaviour asserted |
|---|---|---|
| queued offline | after `enqueue`, before any upload | op still queued, pushed on next launch, folded once |
| ambiguous commit, lag resolved | mid-upload, rows committed | ops appended **once**; the only new row is a fresh `writer_checkpoint`; `forks` empty |
| ambiguous commit, lag persists | mid-upload, rows committed | counter 1 re-offered with the **same hash**, so the server's idempotent replay applies; both ops land once |

Anti-vacuity in each: the first asserts `srv.uploaded` is empty (the child really
died before uploading); the other two assert the upload committed, `pending` is
non-empty, `inflight` is non-null and `authoredHead` is still `null` — i.e. the
child really was inside the ambiguous window.

The middle row's "one new row is a fresh checkpoint" is measured behaviour, not a
defect: the bookkeeping that says "this device has attested those heads" is in
the same commit the crash cost, so the resumed device honestly does not know it
checkpointed. A redundant checkpoint is cheap and truthful; a repeated `rate_set`
would not be, and the test asserts the op sequence exactly.

---

## Airplane mode (Step 4)

Two writers, both offline, both `txn_categorized` against `parent_version: 1` of
the same ingested transaction, **separated by ≥5 ms** (`authored_at` is
milliseconds and a tie falls through to a `writer_id` comparison, which would
make the winner depend on machine speed — asserted, not assumed). Reconnected
loser-first, which is the harder half. Both devices materialize the later
`authored_at`, both report **exactly one** `ForkNotice` with the same
winner/loser op ids, and their folds are compared op id for op id rather than
merely both being non-empty.

The test pushes from dev-a first, because a multi-device account hard-stops until
a checkpoint lands. That is stated in the test as the rule working, not a
workaround.

---

## Mutation testing

11 deliberate defects. Run: `bun test src/outbox/ src/net/client.test.ts
src/store/store.test.ts` (127 tests at the fixed tree).

| # | mutation | result |
|---|---|---|
| M1 | `reconcileInflight` does not drop the landed ops from `pending` | **killed** |
| M2 | `inflight` recorded *after* the upload (the old guard's placement) | **killed** (6 tests) |
| M3 | `rebuildInflight` skips the re-hash check | **killed** |
| M4 | `buildBlobs` never stops at a page boundary | **killed** (3 tests) |
| M5 | `escapableDuringPush`: `.every` → `.some` | **killed** |
| M6 | outbox does not latch a hard stop | **killed** |
| M7 | `flush` re-entrancy guard removed | **killed** |
| M8 | `checkpointLanded` → `checkpointed` (attest a checkpoint still queued) | **killed** |
| M9 | outbox progress guarantee removed | **killed** — the suite hangs (the loop never terminates), which is the defect itself; bounded at 30 s |
| M10 | `reconcileInflight` accepts the flight without comparing hashes | **survived at first**, then killed — see below |
| M11 | blobs the server already held are left queued after a 409 resend | **killed** |

**Score: 11/11 after fixing my own test, 10/11 as first written.**

M10 is the one worth recording. It survived because `authoringHead()`'s existing
check raised a `ChainBreakError` with a near-identical message one guard later,
so my assertion matched either way — a test that would have passed with the
property it names false. The fault was in the test, not the bar. Fixed by
asserting the distinguishing wording *and*, more importantly, that the user's
queued ops are still queued: without the check, reconciliation drops and commits
them away before the second guard fires. That is silent loss of a user's edits
behind a correct-looking error, and it is now covered.

A related fixture weakness found the same way: the ported fake server did not
enforce `maxUploadBlobs`, so M4 (paging removed) would have sailed through it and
failed only in production. The fixture now mirrors the real 413.

---

## Files

**New**

- `client/src/outbox/outbox.ts` — `Outbox`, `Pusher`, `FlushResult`,
  `OutboxStalledError`.
- `client/src/outbox/outbox.test.ts` — 26 tests, including the three SIGKILL
  scenarios.

**Changed** (reach-ins are flagged below)

- `client/src/net/client.ts` — `reconcileInflight`, `recordInflight`,
  `rebuildInflight`, `pageOfPending`; `buildBlobs` pages instead of throwing;
  `push` settles the flight and reports `remaining`; `409 chain_break` →
  `ChainBreakError`; `NetworkError`; `MAX_UPLOAD_BLOBS`/`MAX_UPLOAD_BYTES`
  exported.
- `client/src/store/store.ts` — `InflightBlob`, `ClientState.inflight`, its wire
  encoding, `requireStrings`. **No `STATE_VERSION` bump**, deliberately: a file
  written by a build with no in-flight record was written by a build that never
  left one behind, so absent → `null` is the truth about it rather than a default
  standing in for an unknown. (Contrast the v1→v2 bump, which was needed because
  an old file loaded as "synced" over an empty log and `check` passed it
  vacuously.)
- `client/src/net/client.test.ts` — one test adjusted, not weakened. See below.
- `client/src/cli/main.ts` — `push` goes through the outbox.
- `client/README.md` — the outbox, paging and the in-flight record.

### The one pre-existing test I had to touch

`"a partially-applied batch is resent from the chain head, not retried whole"`.
Its scenario is no longer reachable with the in-flight record present, because
the resend is now verbatim and the server replays it idempotently — the straddle
only ever arose from re-deriving a batch. Rather than delete it (the 409 handler
is still the floor under a state restored from a backup, or written by an older
build where the field is absent), the test now drops the in-flight record between
its two rounds, which is exactly what those situations look like. Every original
assertion is kept and the 409 path still runs; `srv.uploaded` is still
`[1n, 1n, 2n, 2n]`.

### Reach-ins to files another session is editing

`client/src/net/client.ts` was mid-flight in the Task 8 session (+253 lines:
imports, `FoldProgress`, `materializeChunked`). **My edits do not overlap any of
their hunks** — theirs are at old lines 46/81/369/478/493/517/1199/1425, mine are
in `push`/`buildBlobs`/`request` and the new private methods. The commit was
built through a temporary index from `HEAD` + my paths only, per AGENT-RULES, and
`git show --stat` was read before reporting.

I did not touch `client/src/invariants/` (Task 12) or `client/src/net/engine.ts`
(Task 8). The outbox lives in its own directory for that reason.

---

## Verification

See "Commits" and "Gate" sections appended below.

## Known-not-mine

Two tests fail in this shared worktree from other sessions' **uncommitted** work,
both timing/memory measurements, both failing in isolation and unrelated to
anything I changed:

- `client/src/invariants/stream.test.ts` — `"a whole-log check holds a chunk, not
  the log — and the measurement can see the difference"` (a `liveBytes()`
  measurement; fails alone, repeatably).
- `client/src/net/engine.test.ts` — `"a SIGKILL mid-sync resumes to the identical
  state"` anti-vacuity check (flaky under contention; passes on a quiet box).

`client/src/categorize/rules.ts` (another session, untracked) has a `readonly
string[]` typecheck error. None of these are in files I own, and per AGENT-RULES
I am not reporting them as my defects — only noting them so the gate result is
readable.
