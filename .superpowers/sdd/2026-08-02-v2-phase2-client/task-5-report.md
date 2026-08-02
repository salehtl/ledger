# Task 5 — the SQLite store, and the end of the whole-state write

Commit **`72ce132`**, parent `4816ff6`, branch `v2`. 15 files, +2,097 / −153.

---

## What the task was, restated as a defect

`ClientState` carried `rows: Record<Stream, WireRow[]>` and `Client.commit()`
called `store.save(this.st)` after every mutation, so **every command rewrote
the whole op log**. `store/store.ts`'s own module doc said so: *"O(log) work per
command and O(log) bytes on disk … the correct trade for a test instrument and
the wrong one for a phone."*

The plan's Decision 3 is correct and was verified before anything was written:
`Store` stays **synchronous**, and the defect really is `save()` writing `rows`.
`expo-sqlite@16.0.10` — the exact version the plan names — is in this box's Bun
cache, and all six APIs Step 1 asks about are present in its own `.d.ts`:

| needed | found |
|---|---|
| `openDatabaseSync` | `build/SQLiteDatabase.d.ts:322` |
| `execSync` | `:135` |
| `prepareSync` | `:151` |
| `runSync` | `:249` |
| `getAllSync` | `build/SQLiteStatement.d.ts:208` |
| `withTransactionSync` | `:190` |

So no async widening, and no re-opening of Decision 3.

---

## What was built

```
client/src/store/
  store.ts     ClientState (no `rows`), RowStore, SecretStore, memStore,
               eachRowChunk, arrayRowStore, encode/decodeState  — NO host imports
  file.ts      fileStore + fileSecretStore                       — node:fs
  sqlite.ts    sqliteStore + SCHEMA + seqKey                     — no host imports
  driver.ts    SqlDriver/SqlStatement + bunDriver                — bun:sqlite
  open.ts      openStore/openMemStore, the LEDGER_CLIENT_STORE switch
  store.test.ts
```

`fileStore` moved **out of `store.ts`** on purpose. Task 4 got `client/src` off
Bun primitives so it can load on Hermes and left `store/store.ts`'s
`node:fs`/`node:path` as "Task 5's". `app/` has to import `Store`, `RowStore`
and `sqliteStore`; if they sit in a module that statically imports `node:fs`,
every Metro config needs a shim for a function the device never calls.
`sqlite.ts` imports `driver.ts` with `import type` only, so `bun:sqlite` is
erased at compile time — the store is reachable from Hermes, the driver is not.

### `Store` and `RowStore`

```ts
interface RowStore {
  append(stream, rows): void;            // idempotent; refuses DIFFERING bytes at a held seq
  range(stream, afterSeq, limit): WireRow[];   // THE ONLY READ PATH
  count(stream): number;
  prune(stream, beforeSeq): void;
}
interface Store {
  readonly location: string;
  load(): ClientState;
  save(state): void;                     // does NOT write rows
  rows(): RowStore;
  transaction<T>(fn: () => T): T;        // added — see "the defect I found", below
}
```

### The schema

```sql
client_state (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL)
wire_rows (stream, seq, seq_key, writer_id, writer_counter, type_flag,
           size_bucket INTEGER, blob_hash, prev_hash, created_at, blob,
           PRIMARY KEY (stream, seq_key))
```

Two deviations from the plan's literal schema, both deliberate:

- **`seq_key`, and the primary key is `(stream, seq_key)` not `(stream, seq)`.**
  `seq_key` is the seq with its digit count in front (`"019"`, `"0210"`), which
  makes lexicographic order numeric order at every magnitude *and* makes the key
  canonical, so `"007"` and `"7"` cannot occupy two rows at one position. The
  plan offered `ORDER BY length(seq), seq` or a padded key and said to test the
  choice against a digit-count boundary; this is tested at 9→10, 99→100,
  999→1000, across 2^63, and — because a *fixed-width* pad survives all of those
  — at 9×10^20 → 10^21, which is where a 20-wide pad gets the order backwards.
  That case was added *because* mutation M02 survived without it.
- **`blob` is TEXT holding the base64 verbatim**, not a decoded `BLOB`. The
  chain hashes those bytes. Decoding on write and re-encoding on read inserts a
  normalisation step between "the bytes that were verified" and "the bytes that
  are re-verified", to save 25 % of a few megabytes. It also keeps every bind
  parameter a string, which removes the one place `bun:sqlite` and `expo-sqlite`
  could plausibly differ (blob binding).

### Secrets (Step 5)

`sqliteStore(db, { secrets })` — **required, not optional**: an optional
parameter for "the two fields that must never reach the database" is an optional
defect. `save()` moves `session_token` and every writer's `d` to the
`SecretStore` and stores only `{x}`; `load()` puts them back. A writer whose
private half the secret store has lost is left with **no `d` at all**, so
`decodeState`'s existing *"writer X has no usable key"* refuses it — rather than
an empty-string placeholder that would sign with a key nobody holds.

`app/src/auth/keys.ts` (expo-secure-store) is Task 13's; `fileSecretStore` is
the host-side stand-in so the CLI's separate processes still work under
`LEDGER_CLIENT_STORE=sqlite`.

---

## What I did about `RowStore.all()`

**There is none.** The plan is right that a method named `all()` makes the
>500 MB shape look sanctioned, and `check`/`materialize` — the callers the
earlier draft's doc named — are exactly the on-device ones.

`range()` is the only read path. `eachRowChunk(rows, stream, fn, 250)` is the
sanctioned full pass, with a guard that throws rather than looping forever if a
store answers with rows at or below the cursor it was given.

**What each caller actually gets, stated honestly:**

- **`materialize()` is genuinely bounded.** It folds each chunk before asking
  for the next, so at most 250 *decoded* rows — opened, inflated, parsed, which
  is where the memory goes — are live at once. This is measured, not asserted:
  `store.test.ts` folds 507 rows through a row store that **poisons the previous
  chunk when the next one is requested**. An implementation that pages through
  `range()` and decodes the accumulated array at the end reads identical bytes,
  passes every other test here, and decodes poison against this one. Mutation
  M09 is exactly that implementation, and it is caught.
- **`check()` is not, and the loop does not pretend otherwise.** `checkAll` is a
  whole-log API by construction — I2 walks counters across the run, I9/I10
  re-fold from 0, I14 counts forks over everything — so `check` pages the store
  250 at a time and then keeps all of them. The chunking bounds what the *store*
  holds, not what the *checker* does. The comment in `client.ts` says this in
  those words so nobody reads the loop as a fix it is not. Streaming the checker
  is Task 12's job (the invariant checker on-device).
- **`rowsFor()` survives as a test accessor**, documented as one, used only by
  assertions that count rows.
- **No yields.** `Store` is synchronous by Decision 3, so a yield is not
  expressible here. Task 8's async sync engine is where the yield belongs, and
  Phase 0's own numbers say the yield buys the GC, not responsiveness.

---

## The defect I found while testing, and the interface change it forced

Splitting one write into two split the crash window, and the first ordering I
shipped was wrong in a way that a test — not a review — caught.

With "append the rows, then save the cursor", a crash between them leaves rows
*above* the saved cursor. The next run then folds those rows (the folded state's
cursor is at the last stored row), asks the server for everything after the
*saved* cursor, and gets the same page back — which the replay ordering guard
refuses:

```
ReplayOrderError: blob at seq 1 does not follow 3: one blob is one row, one seq
```

That is the real output of the crash test before the fix. The other ordering is
worse: a cursor claiming rows that are gone is a silent, permanent loss.

So `Store` gained **`transaction<T>(fn)`**, and `pull` step 4 persists the rows,
the cursor and the heads inside it. `sqliteStore` implements it with the driver's
transaction and **flattens** nested calls rather than nesting them, because
`expo-sqlite`'s `withTransactionSync` has no savepoint form — `append` opens one
of its own and must join the outer one. On the device the window is gone.

`memStore` and `fileStore` implement it as a plain call. Two files cannot be
committed together without a journal; `fileStore` therefore keeps the *ordering*
(rows first) so its residual window lands on the recoverable side, and this is
recorded in its doc and below under Concerns. It is a CLI instrument on a box
that does not get killed mid-pull. **Automatic resume from a rows-ahead-of-cursor
state is Task 8's "resumable" and is not built here.**

---

## `fileStore`'s properties: kept, or dropped on purpose

| property | status |
|---|---|
| directory 0700 | **kept**, `ensureStateDir` on every write |
| state file 0600, re-chmod'ed after write | **kept** (mode on `open` applies only at creation) |
| temp file + rename for the state | **kept** |
| sidecar `.gitignore` containing `*` | **kept**, and now also covers the rows file |
| rows written 0600 | **new** — the log left the state file, so it needed the same treatment |
| whole-state write | **gone**: rows go to `<profile>.rows.jsonl`, appended, never rewritten by a save |
| holds the whole log in memory once read | **kept, deliberately** — it is the instrument; this is what `sqliteStore` exists not to do |
| private key in a plain file | **kept for the CLI**, replaced by `SecretStore` on the device |

Under `LEDGER_CLIENT_STORE=sqlite`, `openStore` `chmod`s the database 0600
(SQLite gives `-wal`/`-shm` the database's own mode, so one chmod covers all
three) and creates the directory the same way.

`STATE_VERSION` went **1 → 2**. A v1 file carries the log inside itself and its
cursors mean nothing without it; read as a v2 file it would produce a client
whose cursor says "fully synced" over an empty log — and `check` over an empty
log passes *vacuously*, so nothing downstream would notice. It is refused with
the version named. Recovery is to delete the profile and re-pull.

---

## The equivalence gate (Step 4)

```
cd client && bun test                                # 2016 pass / 37 skip / 0 fail / 2053 collected
cd client && LEDGER_CLIENT_STORE=sqlite bun test     # 2016 pass / 37 skip / 0 fail / 2053 collected
```

and with `LEDGER_TEST_POSTGRES_URL` exported, so the e2e files RUN rather than
skip — including the two-device Phase 1 exit scenario against a real `ledgerd`,
a real Postgres and real SMTP:

```
cd client && bun test                                # 2052 pass / 0 fail / 0 skip
cd client && LEDGER_CLIENT_STORE=sqlite bun test     # 2052 pass / 0 fail / 0 skip
```

Against Task 0 Step 3's recorded baseline (1,917 collected / 1,880 pass / 37
skip) and Task 4's (1,969 / 1,932 / 37): **collected 2,053, pass 2,016, skip 37,
fail 0.** Monotonically non-decreasing, skip count *identical* — which is the
check that matters, because a weakened suite shows up there.

The gate found five real couplings, all of which are now store-agnostic rather
than papered over:

1. `harness.ts` and `exit.test.ts` read the bearer token by `JSON.parse`ing
   `c.location`. Under SQLite that is a database, and the token is deliberately
   not in it. Replaced by a `Client.sessionToken` accessor — which is what the
   file read was approximating ("cannot drift from what the client would
   actually send"), only more directly.
2. `harness.test.ts` asserted `existsSync(b.location) === false` to mean "dev-b
   is signed out". A store that creates its database on open cannot satisfy
   that, and the assertion said nothing about contents anyway. Replaced by a
   *fresh handle* on dev-b's profile still throwing `not signed in` — a claim
   about what was persisted, and strictly stronger.
3. `roundtrip.test.ts` asserts `statSync(a.location).mode === 0600`. Fixed in
   the store, not the test: `openStore` chmods the database.
4. + 5. Two call sites that constructed `fileStore` directly now go through
   `openStore`, which is what makes the switch reach the CLI and the e2e.

---

## TDD evidence

The test file was written first and run first:

```
error: Cannot find module './driver' from '.../src/store/store.test.ts'
 0 pass / 1 fail
```

Then, after the first implementation, one deliberate red that was a *test*
defect and not an implementation one — the "stuck row store" returned a SHORT
chunk, which ends the walk on its own, so the non-advancing guard was never
reached (56 pass / 1 fail). The store now returns a *full* chunk that does not
advance, which is the actual looping shape.

Two failures during the gate were real implementation defects, both found by
tests rather than by review:

- the **`ReplayOrderError`** above, which produced `Store.transaction`;
- **`onPrune` rewriting the one-file log from a single stream's rows**, which
  deletes the other stream. Invisible in memory — the two arrays are right
  either way — so the durability block prunes and then **reopens**. (Found while
  reading the code, then pinned by a test that fails without the fix; mutation
  M26 is that defect.)

A third, found the same way: `arrayRowStore.append` applied rows as it validated
them, so a batch whose second row was bad left the first behind — while the
SQLite store rolled the whole batch back. A divergence on the failure path only,
which is the hardest kind to find. Both are now two-phase.

---

## Mutation score: 23 / 25, plus 2 controls that survived as required

27 mutations, run against `src/store src/net src/cli src/invariants
src/replay/replay.test.ts` plus `tsc`. Full log:
`/tmp/claude-0/-root-Coding-ledger/…/scratchpad/mut-run2.log`.

| # | mutation | verdict |
|---|---|---|
| M01 | `seqKey` drops the digit-count prefix | CAUGHT |
| M02 | `seqKey` uses a fixed 20-wide pad | CAUGHT *(after the test was strengthened — see below)* |
| M03 | `range` inclusive on `afterSeq` | CAUGHT |
| M04 | `range` drops `ORDER BY` | **SURVIVED** — analysed below |
| M05 | a differing row at a held seq is accepted | CAUGHT (6 tests) |
| M06 | `INSERT OR REPLACE` | **SURVIVED** — unreachable, analysed below |
| M07 | the whole state, secrets included, goes into SQLite | CAUGHT |
| M08 | a lost private key becomes `""` instead of a refusal | CAUGHT |
| M09 | `materialize` reads the whole log, then decodes | CAUGHT |
| M10 | `check` sees only the first chunk | CAUGHT *(after the test was rewritten)* |
| M11 | the persist step is not wrapped in a transaction | CAUGHT |
| M12 | the non-advancing guard is dropped | CAUGHT (hang) |
| M13 | `save()` rewrites the whole rows file | CAUGHT *(after the test was rewritten)* |
| M14 | the rows file gets the default mode | CAUGHT |
| M15 | a truncated last line is skipped, not refused | CAUGHT |
| M16 | `STATE_VERSION` not bumped | CAUGHT |
| M17 | a stored row is trusted, not re-validated | CAUGHT |
| M18 | `range` hands back the store's own objects | CAUGHT |
| M19 | *control*: two independent statements swapped | survived, as required |
| M20 | `prune` inclusive of `beforeSeq` | CAUGHT |
| M21 | `count` ignores the stream | CAUGHT |
| M22 | a row filed under the wrong stream is accepted | CAUGHT |
| M23 | `rowsFor` returns only the first chunk | CAUGHT |
| M24 | *control*: a no-op rewrite | survived, as required |
| M25 | `prune` never tells the file store to rewrite | CAUGHT |
| M26 | `onPrune` reports only the pruned stream | CAUGHT |
| M27 | a batch is applied as it is validated | CAUGHT |

**Three mutations survived the first run and three were closed by fixing the
TESTS, which is the interesting part:**

- **M02** — the boundary battery stopped at 2^63, and every value below a
  20-wide pad's width orders correctly under either implementation. Adding
  9×10^20 vs 10^21 — two values that straddle a digit-count boundary *above* the
  pad width — is what makes the test able to tell the plan's two sanctioned
  implementations apart.
- **M10** — the coverage test asserted `check().length > 0` over a synthetic
  chain, which a checker reading only the first chunk satisfies just as well. It
  was true by construction. Rewritten: the log is now honestly chained, the
  defect is a substituted blob in the **last** chunk, and the assertion is that
  I3 fires. (Plus the same defect in the first chunk, so the assertion is about
  *where the checker looked* and not about I3 being unreachable.)
- **M13** — "save does not rewrite the rows file" compared `mtimeMs` and `size`
  across five saves. Five saves inside one millisecond, of a file rewritten with
  identical content, change neither. Now the file is **deleted** before the
  saves and asserted still absent — which cannot be faked — plus an append
  afterwards, so the absence is about `save` and not about a store that has
  stopped persisting rows.

**The two remaining survivors are unreachable rather than untested**, and I am
recording the analysis rather than claiming a higher score:

- **M04** (`ORDER BY seq_key` removed) is a no-op *under the current query plan*:
  `WHERE stream = ? AND seq_key > ?` is served by the `(stream, seq_key)`
  primary-key index, whose scan is already in order. Catching it would need a
  plan that scans by rowid, which this schema will not produce. The clause stays
  because correctness must not depend on a planner decision — but no behavioural
  test can distinguish it today, and a test that greps the SQL text would be the
  "check true by construction" shape this project keeps getting bitten by.
- **M06** (`INSERT OR REPLACE`) is unreachable: `append` reads the existing row
  and calls `sameRowOrThrow` *before* inserting, so the conflict clause is never
  exercised. M05 covers the behaviour that matters.

---

## Files changed

| file | change |
|---|---|
| `client/src/store/store.ts` | rewritten: `ClientState` loses `rows`; `RowStore`, `SecretStore`, `eachRowChunk`, `ROW_CHUNK`, `arrayRowStore`, `Store.transaction`; `STATE_VERSION` 1→2; `fileStore` moved out; no host imports |
| `client/src/store/file.ts` | **new** — `fileStore` (state file + append-only JSONL rows) and `fileSecretStore` |
| `client/src/store/sqlite.ts` | **new** — `sqliteStore`, `SCHEMA`, `seqKey`, secret splitting |
| `client/src/store/driver.ts` | **new** — `SqlDriver`/`SqlStatement` + `bunDriver`; documents the `expoDriver` mapping |
| `client/src/store/open.ts` | **new** — `openStore`/`openMemStore`, the `LEDGER_CLIENT_STORE` switch |
| `client/src/store/store.test.ts` | **new** — 63 tests; the contract runs three times, once per implementation |
| `client/src/net/client.ts` | `rowsFor`/`materialize`/`check` onto `eachRowChunk`; `pull` step 4 in one transaction; `sessionToken` accessor |
| `client/src/net/client.test.ts` | `openMemStore`; +1 test: a pull whose save fails stores neither rows nor cursor |
| `client/src/cli/main.ts`, `main.test.ts` | `openStore`; `fileStore` import moved |
| `client/test/e2e/{harness,harness.test,exit.test,roundtrip.test}.ts` | `openStore`; two store-specific assertions made store-agnostic |
| `client/README.md` | Step 6: what Phase 2 reuses vs replaces, why the protocol logic is the thing not to reimplement, the three stores, the no-`all()` rule, the two-mode gate |

**Not created: `app/src/db/{driver,schema.sql,store,rowstore}.ts` and
`app/src/db/store.test.ts`.** `app/` does not exist (Task 3 builds it), there is
no Metro and no `expo-sqlite` in the tree, so an `expoDriver` written now could
not be run — the *code written, tested green, never wired* shape, which Task 4
refused for the same reason. What `expoDriver` must do is a ~20-line adapter and
is documented as a table in `driver.ts`, against APIs verified present in
`expo-sqlite@16.0.10`'s own declarations. Everything else the plan wanted in
`app/src/db/` is in `client/src/store/`, which is where the plan's own
Interfaces section puts it ("`app/` contributes exactly one function"); the
schema is an exported const rather than a `.sql` file so Metro needs no loader.

---

## Verification

Measured on an **isolated `git archive 72ce132` export** with
`client/node_modules` copied in, because three sessions are editing this tree.

```
$ go clean -testcache && bash scripts/v2-check.sh
V2CHECK_EXIT=0
 2052 pass / 0 fail / Ran 2052 tests across 19 files
v2-check: OK (go + client + conformance)

$ cd client && LEDGER_CLIENT_STORE=sqlite bun test     # LEDGER_TEST_POSTGRES_URL set
 2052 pass / 0 fail / 0 skip

$ cd client && bun test                                 # no Postgres
 2016 pass / 37 skip / 0 fail / Ran 2053 across 19 files
$ cd client && LEDGER_CLIENT_STORE=sqlite bun test      # no Postgres
 2016 pass / 37 skip / 0 fail / Ran 2053 across 19 files
```

`fx.test.ts`'s 5 s limit was **not** touched and did not need to be. It *did*
fail twice mid-task, in the shared worktree, at load average **13.5** — and
passed 1-of-1 and 3-of-3 at load average 0.3 in the export. That matches Task 4
Step 3's finding exactly: contention, not the change.

---

## Concerns

1. **`fileStore`'s crash window is real and is not closed.** A crash between the
   rows append and the state save leaves rows above the cursor, and the next
   pull hits `ReplayOrderError` rather than resuming. The device store cannot
   reach that state (one transaction), and the CLI is not killed mid-pull, so
   the exposure is judged low — but the *recovery* is "delete the profile and
   re-pull", not "it heals". Automatic reconciliation (advance the cursor from
   the stored rows, and re-derive the pinned heads with it) is real protocol
   logic in exactly the area the Global Constraints say not to redesign, and it
   is Task 8's "resumable". Whoever takes Task 8 should read
   `Store.transaction`'s doc first.

2. **Hot retention is untouched, and the plan says not to over-claim it.**
   `wire_rows` keeps every hot blob forever. `prune` is the mechanism, Task 10's
   window is the policy for cold, hot is open. `client/README.md` now says which
   of its three original objections are addressed (the whole-state write, the
   plain-file key) and which is not (retention).

3. **`openStore` opens a new `bunDriver` per call and never closes it.** The
   e2e harness calls `clientFor` repeatedly, so a long run accumulates SQLite
   handles. Harmless in a test process, and *pointedly* not the device pattern —
   Phase 0's freeze was partly one native connection leaked per button press.
   Task 8's "one connection" requirement owns this for `app/`; `driver.ts` says
   so in its header.

4. **The `SecretStore` is not inside the transaction.** A rolled-back `save`
   leaves the keystore holding what it wrote. The consequences are bounded — an
   orphaned private key for a writer the state does not list, or a session token
   that will be rewritten identically on the next save — but it is a real seam
   between two stores with different atomicity, and Task 13 should know about it
   before it wires the Keychain up.

5. **`client/src/net/client.ts` was mid-flight in another session.** Its
   worktree copy carries a one-line doc-comment edit (pointing at
   `store/store.test.ts`'s fixtures) that is **not** in this commit: the blob
   was reconstructed as `HEAD` + only this task's edits and staged directly. The
   other session's line is still an uncommitted worktree diff, and it is also
   factually wrong about my file — `client.test.ts` is what pins the `WriterKey`
   encoding (Task 4's M18), not `store.test.ts`.

6. **Task 1's gate is still unsatisfied.** `docs/superpowers/specs/v2-phase2-crypto-gate.md`
   does not exist, so by Global Constraints no task numbered ≥3 has been
   unblocked. This was executed on explicit instruction, as Tasks 4, 6 and 7
   were. Nothing here is crypto-dependent — Phase 3 swaps `blob.ts`'s open path,
   not the store — so the exposure is judged low, but it should be a decision
   rather than an oversight.
