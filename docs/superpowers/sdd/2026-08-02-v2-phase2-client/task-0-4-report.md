# Task 0 + Task 4 — report

Branch `v2`, parent `34e7a43`. Task 0 is the Phase 1 inheritance check; Task 4 is
the platform seam that gets `client/src` off Bun primitives.

---

## Task 0 — the Phase 1 inheritance check

**Verdict: Phase 1 delivers everything Phase 2 assumes. Nothing missing.** All
five steps pass, and every value the plan pinned at `f0ac846` still holds at
`34e7a43` except the test baseline, which moved up.

### Step 1 — the ingest-writer chain fix: LANDED

```
$ git log --oneline --all | grep -i 'cover the ingest chain'
f0ac846 fix(v2): cover the ingest chain with device checkpoints

$ grep -n 'ensureIngestWriterTx' internal/v2/auth/writer.go internal/v2/auth/session.go
internal/v2/auth/writer.go:606:	if err := ensureIngestWriterTx(ctx, tx, userID, w.now()); err != nil {
internal/v2/auth/writer.go:615:// ensureIngestWriterTx is the statement pair, inside the caller's transaction.
internal/v2/auth/writer.go:629:func ensureIngestWriterTx(ctx context.Context, tx pgx.Tx, userID uuid.UUID, now time.Time) error {
internal/v2/auth/session.go:357:	if err := ensureIngestWriterTx(ctx, tx, userID, time.Now().UTC()); err != nil {
```

Line numbers are unchanged from the plan's (`session.go:357`, `writer.go:606`).
Both client-side halves are present and Tasks 11/12 can build on them:

- `checkRosterCheckpoint` (`client/src/invariants/check.ts:1135`) iterates
  `live` — every live roster writer — not `liveDevices`. The comment at
  `check.ts:1176-1185` states the reason (the ingest chain is server-written and
  is the one chain a user cannot re-derive from any device they hold).
- `observedHead()` has `pinnedBlobHashes` as its fourth evidence source
  (`check.ts:222`, consumed at `:651` and `:1278`; the "four sources, and the
  fourth is not optional" comment is at `:1260`).

### Step 2 — the I11 escape hatch: both ids exist

```
client/src/invariants/check.ts:154:export const VIOLATION_ROSTER_COVERAGE = "roster_coverage";
client/src/invariants/check.ts:165:export const VIOLATION_CHAIN_WITHHELD = "chain_withheld";
```

Recorded only, per the step. Whether the push-time escape actually covers only
the benign one is Task 11 Step 1's assertion, not this task's.

### Step 3 — the baseline the whole plan measures against

`git rev-parse --short HEAD` → **`34e7a43`**

`cd client && bun test`:

```
 1880 pass
 37 skip
 0 fail
 11180 expect() calls
Ran 1917 tests across 17 files. [4.45s]
```

`bash scripts/v2-check.sh` → exit **0**, prints
`v2-check: OK (go + client + conformance)`. Its client step (with
`LEDGER_TEST_POSTGRES_URL` exported, so the e2e file runs instead of skipping)
reports `1916 pass / 0 fail / Ran 1916 tests across 17 files`.

**This differs from the plan's recorded `f0ac846` baseline of 1,911 / 1,875 / 35
/ 1.** The tree gained tests: **1,917 collected / 1,880 pass / 37 skip / 0 fail**.
Skips are 37, not 35 — still the e2e files self-skipping without Postgres.

**The 1 known fail did not reproduce.** `fx.test.ts` was run three times on an
otherwise-idle box:

```
run 1: 51 pass, 0 fail, Ran 51 tests across 1 file. [2.03s]
run 2: 51 pass, 0 fail, Ran 51 tests across 1 file. [2.01s]
run 3: 51 pass, 0 fail, Ran 51 tests across 1 file. [1.90s]
```

The whole file — all 51 tests — completes in ~2.0 s against the 5,000 ms
per-test limit that the *"incremental application in seq order equals a full
re-fold from 0, at EVERY prefix"* test overshot at 5,708 ms when the plan was
written. `grep` confirms **no explicit timeout was added to `fx.test.ts`**; it
still runs on Bun's 5,000 ms default, so nobody has quietly raised the limit and
the limit has not been touched here either.

Reading this honestly: three consecutive idle-box runs at ~2.0 s against a 5 s
limit is a 2.5x margin, which is a very different picture from a 14 % overshoot.
That is consistent with the concurrent-load explanation and *not* consistent
with a genuine fold-performance problem on Bun. It is **not** evidence about
Hermes, and it does not discharge Task 1b — it only removes the Bun-side
corroboration the plan expected Task 1b to be able to lean on. Task 1b should be
told that its "independent second observation" is not reproducible on an idle
box, so it stands alone.

### Step 4 — migrations

```
00001 00002 00003 00005 00006 00007 00008 00009 00010 00011 00012 00013
00014 00016 00017 00018 00019
```

Highest is **`00019_push_token_device_link.sql`**, next free is **`00020`**, and
`00004`/`00015` are both still vacant and must not be claimed. Unchanged from
the plan. (Re-list at the moment of writing a migration — three sessions are
concurrent and two were observed committing during this task.)

### Step 5 — Phase 1's unreviewed surface, and what Phase 2 leans on

Critics still owed at Phase 1 close: **21, 23, 25, 26, 27, 28, 30, 31, 32, 35,
36, 37, 38** (13 of 38). Blast radius for Phase 2, as the step asks:

| Phase 1 task | Area | Phase 2 task that leans on it |
|---|---|---|
| 25, 26 | origin trust (`internal/v2/origin/`) | Task 2 |
| 27 | quarantine | Tasks 15, 17 |
| 29 | push (`pushv2/`) | Task 25 |
| 31 | samples | Task 16 |
| 33 | dictionary | Task 20 |

**Neither Task 0 nor Task 4 touched any file in those trees.** Task 4's edits are
confined to `client/src/{platform,wire,net,invariants,store,norm}`.

**One observation to add to that list.** During the final gate run,
`internal/v2/admin`'s `TestNoConsoleRouteReturnsADonatedBody` failed once:

```
--- FAIL: TestNoConsoleRouteReturnsADonatedBody (0.44s)
    gate_test.go:677: GET /admin/diagnostics returned donated content "4321"
```

It then passed 3/3 when re-run alone, and the full gate passed on re-run. This
task changed **zero Go files**, so it cannot be caused by this work. The failing
response carried diagnostics rows from three *different* `user_id`s, which points
at cross-test visibility inside the one shared Postgres cluster
`v2-check.sh` boots, under package-parallel `go test`. Recorded here because it
is a **redaction gate on an admin route** flaking, which is the sort of flake
that should not simply be re-run away — it belongs to whoever owns Phase 1 Task
31/33 follow-up.

---

## Task 4 — the four platform seams

### Steps done, and steps deliberately not done

Steps 1, 2, 3 and 6 are complete. **Steps 4 and 5 are not started and cannot be**:
both run on the P2 device against `app/`, which does not exist (Task 3 builds
it), and both sit behind Task 1's hard gate —
`docs/superpowers/specs/v2-phase2-crypto-gate.md` is absent, so by Global
Constraints no task numbered ≥3 has been unblocked yet.

For the same reason **`app/src/platform/{hash,gzip,signing,bytes,index}.ts` were
NOT created**, even though Task 4's Files list names them. There is no `app/`, no
Metro, no `@noble/*`, no `fflate` and no `expo-crypto` in the tree. Writing those
five files now would produce exactly the Phase 1 defect shape the brief warns
about — *code written, tested green, and never wired*, except worse, because it
could not even be run. The seam's contract is instead pinned as executable
vectors in `client/src/platform.test.ts`, which Step 4 is meant to re-run
on-device unchanged.

### The reconciliation grep — how the tree differs from the plan's table

Re-ran the plan's command at `34e7a43` (90 hits). **The plan's table is accurate
on every line it lists — every file:line matched exactly**, including the
multi-site rows (`wire/op.ts:373,613,648,654,663,705,706` and
`net/client.ts:198,204,217,611,613,1210,1345,1364,1365`). That is unusual for a
table pinned four commits back and is worth recording as a positive.

Two differences, one of them real:

1. **`norm/mime.ts:800` is a live `TextEncoder` call site and is missing from the
   plan's table entirely.**

   ```ts
   const pushUTF8 = (s: string) => {
     for (const b of new TextEncoder().encode(s)) out.push(b);
   };
   ```

   It sits inside `decodeWords()`, the RFC 2047 encoded-word decoder — i.e. on
   the normalizer's hot path for every inbound subject line. Task 4's opening
   sentence claims the layer above the seam is "already clean" and lists
   `norm/unwrap.ts` and `norm/charset-tables.ts` by name; `norm/mime.ts` is in
   neither the clean list nor the conversion table. **Left unconverted, Task 4's
   own premise — "exactly four modules block it from running on Hermes" — would
   have been false, and a device would have hit a bare global in the
   normalizer.** Converted, and `norm/mime.ts` added to the modified-file set.

2. `tmpl/exec.ts:922` matches the grep but is a **comment**, not a call site —
   it documents *why* `utf8Length()` counts bytes by hand instead of calling
   `new TextEncoder().encode(s).length`. Correctly absent from the table; noted
   so the next person to run the grep does not "fix" it.

I also re-checked the plan's *verified-absent* list, since it is the part nobody
re-derives. It still holds at `34e7a43`: no `atob`/`btoa`, no `structuredClone`,
no `crypto.subtle`, no `Intl`, no `String.normalize`, no `Math.random`, and the
only `Date.now()` hit in the tree is the comment at `replay/state.ts:13` saying
there isn't one.

**Post-conversion, the only host primitives left in `client/src` are the ones
the plan says must stay:** `platform.ts` itself, `cli/main.ts` (explicitly out of
scope), `norm/charset.ts:87`'s `TextDecoder` (plan: *"leave the call, pin the
behaviour"* — Step 4 tests it on-device), `norm/charset-tables.ts` (comments),
and `store/store.ts:49,50`'s `node:fs`/`node:path`, which is Task 5's.

### Design notes worth carrying forward

- **`Platform` has no `ed25519Verify`, by design.** Recorded at the top of
  `platform.ts` with the reasoning, so it does not read as an omission to the
  next reader.
- **`Platform` has no filesystem method, by design** — it must not make
  `fileStore()` portable, because Task 5 deletes it. `store/store.ts` keeps its
  `node:fs` imports untouched; only its two hex helpers moved to the seam. Task 5
  is not constrained by anything here.
- **Hermes loadability.** `bunPlatform` needs `node:zlib` and `node:crypto`
  statically (the only import form Bun, `tsc` and Metro all accept). `app/`'s
  `metro.config.js` must either map them to `{ type: "empty" }` in
  `resolveRequest` or shadow the file with a `platform.native.ts` sibling; both
  options are documented in `platform.ts`'s header for Task 3. The auto-install
  at the bottom of the file **measures** whether the builtins actually resolved
  (`typeof gzipSync === "function" && …`) rather than sniffing for a runtime, so
  a stubbed import leaves the registry empty and `platform()` throws a sentence
  naming the fix instead of installing an object of `undefined`s.
- **Two contract details are now load-bearing and pinned by tests**, because a
  second implementation would plausibly get either wrong: `gzip` is **level 9**
  (it decides the compressed length, hence the size bucket, hence the framed
  bytes the chain hashes), and `utf8Decode` is **BOM-stripping** (`TextDecoder`'s
  default `ignoreBOM: false` *removes* the BOM — the opposite of what the option
  name reads like, and the opposite of what a hand-rolled decoder does).
- **`chainHash` now concatenates** instead of calling `update()` twice, because
  the seam's `sha256` takes one buffer. That is one extra memcpy of
  `prev.length + blobBytes.length` per blob. Negligible against the hash itself,
  but it is a real change to Task 28's cost model input and is flagged rather
  than hidden. The concatenation order is pinned by mutation M14.
- **`publicKeyBytes` was deliberately NOT strengthened.** Deriving the public
  half from the private one would additionally catch an x/d mismatch — a genuine
  improvement, and a behaviour change, which does not belong in a task whose
  contract is "no behaviour change". A peer's key is stored public-half-only and
  would break. The 32-byte check `createPublicKey` used to provide is kept.

### Step 3 — the equivalence gate

Measured on an **isolated tree** (`git archive HEAD` + only this task's files +
a copy of `client/node_modules`), because two other sessions were editing
`client/src` throughout — see Concerns.

```
$ cd client && bun run typecheck        # exit 0
$ cd client && bun test
 1932 pass
 37 skip
 0 fail
 11272 expect() calls
Ran 1969 tests across 18 files. [6.16s]

$ go clean -testcache && bash scripts/v2-check.sh   # exit 0
 1968 pass
 0 fail
Ran 1968 tests across 18 files.
v2-check: OK (go + client + conformance)
```

Against the Step 3 baseline: collected **1,917 → 1,969** (+52), pass
**1,880 → 1,932** (+52), skip **37 → 37 unchanged**, fail **0 → 0**. The +52 is
51 tests in the new `platform.test.ts` plus 1 added to `net/client.test.ts`. **No
pre-existing test was removed, skipped or weakened**; the skip count is
identical, which is the check that matters — a weakened suite would show up
there.

### Mutation score: 16 / 18

Twenty mutations, of which two are declared no-op controls that **must** survive
(M13 `.slice(0,32)` on an already-32-byte digest; M19 a `"" +` concatenation).
Both survived, so the harness is not reporting false kills. Score over the 18
real mutations: **16 caught, 2 survived.** Full log:
`/tmp/.../scratchpad/mutation-task4.json`.

| # | Mutation | Result |
|---|---|---|
| M01 | `gzip` level 9 → default | CAUGHT (2) |
| M02 | cap enforced *after* inflation, not during | CAUGHT (1) — see below |
| M03 | `toHex` upper case | CAUGHT (21) |
| M04 | `toHex` via `toString(16)`, drops the leading zero | CAUGHT (21) |
| M05 | `fromHex` lenient (Buffer truncation) | CAUGHT (typecheck) |
| M06 | `fromBase64` lenient | CAUGHT (typecheck) |
| M07 | `toBase64` emits base64url | CAUGHT (12) |
| M08 | decoder keeps the BOM | CAUGHT (1) |
| M09 | decoder `fatal: true` | CAUGHT (1) |
| M10 | Ed25519 x/d halves swapped | CAUGHT (1) |
| M11 | seed length unchecked | CAUGHT (1) |
| M12 | `randomBytes` returns zeros | CAUGHT (typecheck) |
| M13 | *control* | survived, as required |
| M14 | `chainHash` concatenation order reversed | CAUGHT (1) |
| M15 | `MAX_PLAINTEXT + 1` → `MAX_PLAINTEXT` | **SURVIVED** |
| M16 | store's hex guard degraded to a silent empty read | **SURVIVED** |
| M17 | base64url `-_` translation dropped | CAUGHT (3) |
| M18 | stored `WriterKey` keeps `=` padding | CAUGHT (1) |
| M19 | *control* | survived, as required |
| M20 | `compareUTF8` encodes `a` twice | CAUGHT (typecheck) |

**The first run scored 14/18. Four survivors were closed rather than reported**,
and two of those closures are the interesting part:

- **M02 was the important one.** The plan calls the gunzip cap load-bearing and
  says *"test with a real bomb"* — but a bomb test only proves the cap
  *throws*, and "inflate 32 MiB, then measure, then throw" also throws. That is
  precisely the defect the plan warns about (`fflate` has no `maxOutputLength`),
  and my first test could not see it. Closed with a test that compares the capped
  path against **the same implementation inflating the same bomb with a cap that
  never trips** — self-calibrating, so machine speed, engine and background load
  cancel out, and no magic millisecond threshold. Measured separation: a correct
  implementation is **272–446x** cheaper; the inflate-then-check mutant is
  **0.41–1.02x**, i.e. never cheaper at all. The 4x assertion sits ~70x from one
  and ~4x from the other. The test carries a comment saying that if it ever goes
  red the fix is an implementation that bounds output during inflation, **not** a
  smaller ratio.
- **M18** exposed that nothing pinned the on-disk `WriterKey` encoding. It was
  previously produced by `node:crypto`'s JWK export; now the seam mints it, and a
  padded or standard-alphabet variant still round-trips through this module, so
  every other test would stay green while an already-enrolled device's state file
  silently changed format. Closed with an explicit unpadded-base64url assertion
  in `net/client.test.ts`.
- **M16** was closed by *removing the mutable surface*: my first conversion
  rewrote `store.ts`'s `unhex` into a `try`/`catch`, which was both a needless
  divergence from the identical guards in `client.ts` and `op.ts` and a new place
  to hide a bug. Reverted to the original regex guard with only the decoder
  swapped.

**The two remaining survivors are pre-existing gaps in Phase 1's suite, not gaps
this task introduced — and that is measured, not asserted.** Both mutations were
re-applied to a pristine `git archive HEAD` tree in their HEAD-equivalent form:

```
M15-HEAD: SURVIVED (0 failing) — on the PRE-EXISTING HEAD code
M16-HEAD: SURVIVED (0 failing) — on the PRE-EXISTING HEAD code
```

- **M15** is an error-*message* property, not a correctness one. Both variants
  reject a payload inflating past `MAX_PLAINTEXT`; they differ only in whether
  the `BlobDecodeError` reads `gzip: …` or `decompressed payload exceeds …`.
  Catching it needs a hand-framed blob whose payload inflates to exactly
  `MAX_PLAINTEXT + 1` (`sealBlob` refuses to build one), which is an
  internals-coupled test of low value. Left, with the reasoning on the record.
- **M16** is a real gap: nothing in the suite feeds `store.ts`'s `unhex` a
  malformed hash, so a decoder that returned empty bytes for a corrupt chain
  head would go unnoticed. There is no `store/store.test.ts` at all. **Task 5
  rewrites this layer and should close it there** — flagged as inherited work,
  not fixed here, because adding a store test file is outside this task's scope.

---

## Files changed

| File | Change |
|---|---|
| `client/src/platform.ts` | **new** — the seam: `Platform`, `setPlatform`, `platform()`, `bunPlatform` |
| `client/src/platform.test.ts` | **new** — 51 contract vectors; the file Step 4 re-runs on-device |
| `client/src/wire/chain.ts` | `Bun.CryptoHasher` → `sha256`; `Buffer` hex → `toHex` |
| `client/src/wire/blob.ts` | `node:zlib` → `gzip`/`gunzip`; `TextEncoder` → `utf8Encode` |
| `client/src/wire/op.ts` | `TextEncoder`/`TextDecoder`/`Buffer` base64 → seam (strictness preserved) |
| `client/src/net/client.ts` | `node:crypto` → `ed25519*`/`randomUUID`; `Buffer` hex/base64/base64url → seam |
| `client/src/net/client.test.ts` | +1 test pinning the stored `WriterKey` encoding (closes M18) |
| `client/src/invariants/check.ts` | `Buffer` hex, `TextDecoder` → seam |
| `client/src/store/store.ts` | two hex helpers → seam; `node:fs`/`node:path` untouched (Task 5) |
| `client/src/norm/mime.ts` | `TextEncoder` → `utf8Encode` — **the site the plan's table missed** |

Not created, with reasons above: `app/src/platform/*`.

---

## Concerns

1. **Task 4 was executed while Task 1's gate is unsatisfied.** Global Constraints
   say no task numbered ≥3 may start until
   `docs/superpowers/specs/v2-phase2-crypto-gate.md` exists with a signed-off
   verdict. It does not exist. This was executed on explicit instruction; flagged
   because a CONDITIONAL verdict from Task 1 changes the content of later tasks,
   and if it changes Task 4's it will do so *after* this landed. The seam's shape
   is not crypto-dependent, so the exposure is judged low — but it is real and
   should be an explicit decision rather than an oversight.

2. **This worktree is being edited by at least two other live sessions, and it
   materially affected verification.** Mid-task, `client/src/invariants/check.ts`
   gained Task 7's `unparsed` work and `client/src/net/client.ts` gained Task 6's
   `inviteCode` work — both files I was editing, and Task 7's half-landed state
   (tests referencing `Txn.unparsed` before `replay/state.ts` declares it) makes
   `bun run typecheck` fail in the shared worktree for reasons unrelated to this
   change. Everything above was therefore measured on an isolated
   `git archive HEAD` tree, and **the two collided files were reconstructed as
   HEAD + only this task's edits and staged as explicit blobs** rather than
   `git add`-ed from the worktree. Consequence for whoever merges: the worktree
   copies of those two files still carry the other sessions' in-flight work, and
   this commit does not contain it.

3. **`internal/v2/admin`'s redaction gate flaked once** (Step 5 above). Not
   caused by this change — no Go file was touched — but a leak-detection test
   that intermittently sees another user's diagnostics rows deserves a look from
   whoever owns it, rather than a re-run.

4. **Steps 4 and 5 remain the real risk and are untouched.** Step 5 in
   particular — re-deriving `MAX_BOUND_PRODUCT` and `MAX_UNBOUNDED_PER_BRANCH`
   on Hermes, and re-running the U+212A case-folding divergence — is the one
   that can invalidate already-published templates. The plan is explicit that
   doing it at Task 4 costs a day and discovering it at Task 24 costs a day plus
   everything built on the old bounds. Nothing here reduces that risk; it is
   simply deferred until a device and a dev client exist.

5. **The `fx.test.ts` timeout Task 0 Step 3 was told to corroborate did not
   reproduce** (three idle runs, ~2.0 s against a 5 s limit). Task 1b should be
   told its expected second observation is not there.
