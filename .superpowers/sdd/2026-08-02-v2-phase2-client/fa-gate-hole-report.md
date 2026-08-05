# Gate coverage hole: app/ was never checked — report

## The hole

`scripts/v2-check.sh` gated `internal/v2/...`, `cmd/ledgerd`, `internal/importer`
and `client/` but never touched `app/` — the whole Expo React Native
application that Phase 2 tasks 3 and 9-27 built every screen of. The gate
reported `exit 0` while `cd app && bun test` independently gave 518 pass / 1
fail. No typecheck of `app/` ran anywhere in the gate either.

## Job 1 — wired app/ into the gate

Added a step to `scripts/v2-check.sh`, mirroring the `client/` step exactly:

- Guards on `app/node_modules` missing, same wording/behavior as the
  `client/node_modules` guard (hard failure naming the fix, no silent skip, no
  `bun install` run by the gate itself).
- Runs `(cd app && bun run typecheck && bun test)` — `bun run typecheck` is
  `app/package.json`'s existing `tsc --noEmit` script; `bun test` runs the
  full `app/src` suite via `app/package.json`'s `test` script (`bun test
  src`). There is no `app/`-side equivalent of
  `client/src/diag/structure.test.ts`, so the app step has two stages where
  client has three.
- Added a comment block in the script's existing voice explaining why the
  step exists (Phase 2 built the whole app here and nothing checked it),
  citing the measured 518/1 gap, and naming what it would have caught
  (`bootstrap.test.ts`, see Job 2).
- Updated the final success line to `v2-check: OK (go + client + app +
  conformance)`.

Did not touch the Postgres boot, `go test`, or `client/` sections.

## Job 2 — fixed the one failing test

`app/src/app/bootstrap.test.ts:44`, *"a complete returning account runs audit
and reaches ready"*.

**Root cause**: `bootstrap.ts:31` calls `runtime.dictionary.sync()`
unconditionally (added by a prior session) before `runAudit()`. The test's
`runtime` fixture (lines 39-43, cast `as never`) did not include a
`dictionary` field, so the call threw `TypeError: undefined is not an object
(evaluating 'runtime.dictionary.sync')`, which `bootstrapRuntime`'s catch
block turned into `{ step: "fatal", error }` instead of the expected `{ step:
"ready", ... }`.

**Which side is wrong, and why**: the fixture, not `bootstrap.ts`. Checked
`AppRuntime` in `app/src/app/runtime.ts:63`: `readonly dictionary:
DictionarySource` is a required (non-optional) field, and `createRuntime`
(runtime.ts:110-167) always constructs a real `sqliteDictionarySource` before
returning the runtime object — there is no code path in production that
produces an `AppRuntime` without a `dictionary`. So calling
`runtime.dictionary.sync()` unconditionally matches the type's contract; a
"tolerate missing dictionary" change to `bootstrap.ts` would be papering over
a fixture gap by loosening production code against a state the type system
already guarantees can't occur. The other bootstrap test in the same file
(the 401/410 one, line 18) also passes a `runtime` without `dictionary`, but
never reaches the `dictionary.sync()` call because its injected `refresh`
throws before that point — which is why only this one test broke.

**Fix**: added `dictionary: { sync: async () => { syncs++; } }` to the
fixture, plus a `syncs` counter asserted to be `1`, alongside the existing
`audits` counter assertion — strengthening the test to also verify the sync
call happens, not just working around its absence. No existing assertion was
loosened or removed; `expect(...).toEqual({ step: "ready", userId: "user-1",
facts })` is untouched, and the fixed-object comparison plus the two call
counters together are what "the call sequence" in the diff (`Expected -7 /
Received +2`) was checking.

## Proving the gate step has teeth

1. Deliberately broke `app/src/app/bootstrap.test.ts:6` — changed the
   expected `{ step: "signed_out" }` to `{ step: "DELIBERATELY_BROKEN" }`
   (not a member of `BootstrapState`'s literal union).
2. Ran `go clean -testcache && bash scripts/v2-check.sh` in full (not just the
   app/ step) — observed exit code **2**, with the failure named directly in
   the output: `src/app/bootstrap.test.ts(6,94): error TS2322: Type
   '"DELIBERATELY_BROKEN"' is not assignable to type '"signed_out" |
   "halted" | "fatal" | "opening" | "onboarding" | "ready"'`. `tsc --noEmit`
   caught it before `bun test` even ran, since the `app/` step is `bun run
   typecheck && bun test` and `&&` short-circuits on the first failure — this
   also confirms the typecheck half of the new step is live, not a no-op.
3. Reverted the break back to `{ step: "signed_out" }`. Confirmed via `git
   diff HEAD -- app/src/app/bootstrap.test.ts` that the tree matched exactly
   my Job 2 fix (the `syncs`/`dictionary` addition), with no trace of the
   deliberate break remaining.
4. Re-ran the full gate clean — exit code **0**.

## Final verification

`go clean -testcache && bash scripts/v2-check.sh`, captured via `; echo
"EXIT:$?"` (never a pipeline) at commit built from this working tree
(`v2-wip-2026-08-05`, parent `0e108348d59e3bc57ea9a99287a7eff348bebcfb`):

- Go: `go vet`/`go test` over `internal/v2/...`, `cmd/ledgerd`,
  `internal/importer` — pass (unchanged by this work).
- `client/`: typecheck pass, `structure.test.ts` pass, `bun test` — **2350
  pass / 0 fail** across 35 files.
- `app/` (new step): typecheck pass, `bun test` — **519 pass / 0 fail**
  across 37 files, 1689 assertions. (518 + the one bootstrap test now fixed =
  519; no other app/ failures were present at this run.)
- Final line: `v2-check: OK (go + client + app + conformance)`.
- **Exit code: 0.**

No `app/` failures other than `bootstrap.test.ts` were observed at any point
in this session — nothing to attribute to other concurrent sessions.

## Files touched

- `scripts/v2-check.sh` — added the `app/` gate step.
- `app/src/app/bootstrap.test.ts` — fixed the stale fixture.
