# Codebase Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prune dead code, update stale documents, remove unnecessary files, and simplify the two-app tree — with zero production interruption and zero data loss.

**Architecture:** Read-only audit already ran (9 agents, 70 findings, all evidence-backed; baseline fully green at `9fb968d`). This plan executes the accepted findings in dependency order: hygiene → Go → app/ retirement → TypeScript → docs → dist rebuilds → full gates → independent review. The orchestrator makes all commits; workers never run `git add`/`git commit`.

**Tech Stack:** Go 1.25, React 19 + Vite + bun, Postgres (v2) / SQLite (v1), vitest, `scripts/v2-check.sh` as the v2 gate.

## Decisions of record

- **Repo split: NO.** The binary import graphs are already fully disjoint (`go list -deps` on both mains: zero shared internal packages), but the test-level coupling is load-bearing: v2's parse-equivalence gate imports v1's `internal/parse` as the reference implementation over the 7,002-message corpus, and `scripts/v2-check.sh` runs v1's `internal/importer` because it is the Go executor of `conformance/import/vectors.json`. Splitting buys nothing the disjoint graph doesn't already give, and costs two go.mods, cross-repo conformance runs, and history surgery. Instead: add a boundary fence to the gate (Task 12). Endgame, recorded here: when v1 is decommissioned, **delete** v1 from main (`cmd/ledger`, `internal/*` except `v2`, `frontend/`, `internal/web`) — branch `ledger-v1` already preserves the line. Never split.
- **`app/` (abandoned Expo client): remove from main**, preserved via tag `app-expo-final` plus existing branches. Verified: zero code dependents outside comments/testdata strings.
- **Native push-token API surface: remove.** Its only client ever was `app/`; the Expo app never shipped (no Apple Developer Program enrollment happened). The Postgres `push_tokens` table stays — no migration, no data loss.
- **conformance/crypto: KEEP** (32K, may serve Phase 3), but fix the dangling pointer in `cmd/ledgerd/loadcorpus.go:82` to cite `cmd/gen-phase2-corpus`'s doc comment instead of a README that never existed.
- **Documented-intentional survivors (do NOT touch):** the unrouted plan/accounts/projects/recurring/reports tree in `web/src` (per `web/src/app/nav.ts`: "unrouted, not deleted"); the v1↔v2 deliberate duplication (spa.go, stripHTML, usableKey/verifiedByAny triplication — all self-documented); dither-kit unused core files (shadcn `--diff` baseline); the ~40 deadcode-flagged v2 symbols that are test-support, Phase-3 staging, or conformance codecs (audit finding 8); `frontend/src/api/types.ts` DTO exports (deliberate convention).
- **Owner decisions recorded 2026-08-10 (plan review round):** (a) DELETE the superseded v1 Settings cluster in `web/src` (Saleh approved; the "unrouted, not deleted" comment's reasoning no longer holds for Settings — it returned, rebuilt as V2Settings); (b) FIX AND COMMIT `web/harness/addpasskey-repro.mjs` (stale testid → `add-passkey-note`) as a documented v2 runner instead of deleting it.
- **Plan reviewed by independent Opus agent 2026-08-10;** verdict EXECUTE WITH FIXES — all fixes are folded into the tasks below. Key ones: Task 14 must be surgical (shared symbols; config loader hard-rejects unknown TOML keys — an outage vector); Task 2 must not delete `v2-pwa`/`v2-wip-2026-08-05` (they, not `ledger-v1`, preserve app/); Task 11's mode must dispatch before config validation and print `LEDGER_VAPID_*` names; Task 12's fence needs a mutation proof; Task 13 must preserve the bank-grammar two-reader gate.
- **Explicitly skipped:** the three challenge-mint handler clones in v2 api (small, stable, auth-adjacent; the audit itself called extraction optional/lowest-priority).
- **Report-only (owner's call, not executed):** `docs/alpha-consent.md`'s promised export/deletion flows (signable commitment text — flagged as launch blocker, not silently edited); the ~17MB of untracked media at repo root; the two unmerged worktrees (`mail-isolation` 80 commits ahead, `ux-refine` 83 ahead) and branch `v2-wip-partial`.

## Global Constraints

- **Never touch production.** No `systemctl`, no ports 25/80/443/8080/8079/8445, no `/var/lib/ledger`, no `/etc/ledger*`, no deploys. Services run installed binaries; repo changes cannot interrupt them.
- **Baseline is green** (HEAD `9fb968d`: go build, full Go suite, frontend 1396 tests, web 2121, client 2502, `v2-check.sh` OK). Any post-change failure is a regression introduced by this work.
- **Workers never run git write commands.** The orchestrator commits, and checks `git status` + `git diff --cached --name-only` before every commit (parallel sessions share this checkout and the git index).
- **Conformance contract:** any change touching `internal/v2/norm`, `internal/v2/tmpl`, `internal/v2/oplog` exports, or `client/src` must keep Go and TS byte-for-byte and end with a green `scripts/v2-check.sh`. Unexporting TS symbols changes no executor output and is safe; deleting bodies is not in scope. Note (plan-review correction): v2-check does NOT run `client/scripts/crossexec*.ts` — the net for those is `cd client && bun run typecheck` (tsconfig includes `scripts/`) plus web's `tsc -b` for alias consumers.
- **Money/int64, append-only op log, sealed-blob principles:** untouched by this plan; nothing here changes runtime behavior of either service except the deliberate removals listed.
- **Both committed dists rebuilt before finish** (`internal/web/dist`, `internal/v2/webui/dist`) so embedded bundles match source.
- **Go test invocations use `-count=1`.** Final verification runs the full matrix.
- `web/node_modules` and `client/node_modules` were freshly installed at baseline; a `command not found` from vitest means workspace state, not code.
- Commit messages follow the repo's conventional style (`chore(...)`, `refactor(...)`, `docs:`, `build(...)`).

## Finding → task disposition (all 70 audit findings accounted for)

| Findings | Disposition |
|---|---|
| 1,2,3 → T3 · 5 → T4 · 4,44 → T5 · 9 → T6 · 11 → T7 · 10 → T8 · 12 → T9 · 13 → T10 · 7 → T11 · 58,70 → T12 | Go tasks |
| 55,62,65(pointer),40(moot) → T13 · 15 → T14 | app/ + push |
| 22,24,42,59 → T15 · 29 → T16 · 25 → T17 · 26 → T18 · 27,28 → T19 · 31 → T20 · 17,18,19,20,21 → T21 | TS tasks |
| 32 → T22 · 33,64 → T23 · 34,35,61 → T24 · 37,54 → T25 · 38,39,47 → T26 · 30,41 → T27 · 43,68 → T28 · 45 → T29 · 53 → T30 · 69 → T31 · 6,66 → T32 | docs/files |
| 23,46,51,52,56,57,60,63,67 → T1 · 48 → T2 | hygiene |
| 8,14 → no-action (recorded above) · 16 → skipped (recorded) · 36,49,50 → report-only | — |

---

## Phase 1 — Hygiene (orchestrator, inline)

### Task 1: .gitignore fixes and untracked scraps

**Files:** Modify `.gitignore`. Delete (untracked/ignored, never committed): `./ledger` (22MB stale ELF build, Jul 28), root `node_modules/` (orphan vite cache; no root package.json), `.codex/` (empty since Aug 3), `docs/superpowers/plans/2026-07-29-paper-home-page.md` (executed one-off session plan with dead hardcoded paths; plan-draft merge-collision hazard). NOTE: `web/harness/addpasskey-repro.mjs` is NOT deleted — Task 15 fixes and commits it (owner decision).

- [ ] In `.gitignore`: change `.claire/` → `.claude/worktrees/` (the comment above it already says "Agent worktree scratch space"); delete the dead `/web/dist` line (web builds to `../internal/v2/webui/dist`); add `spike/phase2/` (cmd/gen-phase2-corpus's own comments promise this path — which receives real bank data and a private key — is gitignored, but no rule exists).
- [ ] `rm ./ledger && rm -rf node_modules .codex && rm "docs/superpowers/plans/2026-07-29-paper-home-page.md"`
- [ ] Verify: `git check-ignore -v spike/phase2/work/foo` now matches; `git status --porcelain` no longer lists the deleted scraps.
- [ ] Commit: `chore(repo): fix .gitignore (worktrees, spike/phase2), drop stale scraps`

### Task 2: prune merged worktrees (local only, no commit)

Seven of nine worktrees under `.claude/worktrees/` are fully merged with clean status (~1.09 GB): `v2, budget-mode, v2-pwa, ui-bugs-from-video, effective-dated-targets, assignment-carry-forward, dib-transfer-parser`.

- [ ] Safety check first: `ls -l /proc/[0-9]*/cwd 2>/dev/null | grep worktrees` — skip any worktree that is some process's cwd.
- [ ] For each safe one: `git worktree remove .claude/worktrees/<name>` (refuses if dirty — do not force). Removing a worktree never deletes its branch.
- [ ] Branch deletion is EXPLICITLY limited to these five merged branches: `worktree-assignment-carry-forward`, `worktree-budget-mode`, `worktree-dib-transfer-parser`, `worktree-effective-dated-targets`, `worktree-ui-bugs-from-video` (`-d` not `-D`; a refusal means not merged — leave it and report). NEVER delete `v2-pwa`, `v2-wip-2026-08-05`, `ledger-v1`, `main` — `v2-pwa` and `v2-wip-2026-08-05` are (with origin/main) the only refs preserving app/ besides Task 13's tag.
- [ ] Do NOT touch `mail-isolation` (80 ahead) or `ux-refine` (83 ahead) or branch `v2-wip-partial`. Report them.
- [ ] Verify: `git worktree list` shows main + the two unmerged; `git status` clean.

## Phase 2 — Go cleanup (subagents; disjoint files; orchestrator commits per task)

### Task 3: delete three fully dead v2 symbols

**Files:** Modify `internal/v2/verify/verify.go` (~852–865), `internal/v2/blob/encv2.go` (~223–224), `internal/v2/corpus/corpus.go` (~113–115).

- [ ] Pre-check (conformance coupling): `grep -rin "tagof\|tag_of" conformance/ client/src` → expect no hits (audit confirmed; re-confirm).
- [ ] Delete const `heldExpectedSQL` + its doc block; func `TagOf`; method `DB.Path`.
- [ ] Run: `go build ./... && go test -count=1 ./internal/v2/verify/ ./internal/v2/blob/ ./internal/v2/corpus/` → PASS.
- [ ] Commit: `chore(v2): delete dead symbols (verify.heldExpectedSQL, blob.TagOf, corpus.DB.Path)`

### Task 4: retire v1 budget.Compute wrapper

**Files:** Modify `internal/budget/budget.go` (Compute at :39), `internal/budget/budget_test.go` (:18, :72, :81).

- [ ] Read both Compute and ComputeRange signatures. Retarget the three test callsites from `Compute(...)` to `ComputeRange(...)`, passing the month string (`now.Format("2006-01")`) and `MonthProgress(now)` explicitly so behavior asserted is identical. Then delete `Compute`.
- [ ] Run: `go test -count=1 ./internal/budget/` → PASS with same test count.
- [ ] Commit: `chore(v1): fold test-only budget.Compute into ComputeRange callers`

### Task 5: remove dead v1 config keys; fix config.example.toml

**Files:** Modify `internal/config/config.go` (:50–51 fields, :102 defaults), `internal/config/config_test.go` (:195–205), `config.example.toml`.

- [ ] Remove `AutoAcceptThreshold`/`AutoRule` fields + defaults + their default-assertion tests. These keys are loaded but never read — the live thresholds moved to SQLite app settings (`internal/store/settings.go`).
- [ ] In `config.example.toml`: delete the two key lines; in their place one comment: `# Auto-accept thresholds moved into the app: Settings > Categorization.` Also: add commented `senders = []` under `[monitoring]` with the code's explanation (from `internal/config/config.go:60`), and annotate the `[budget]` block: `# This block never became config — the budget plan lives in the database and is edited in the app.` (or delete the block).
- [ ] Run: `go test -count=1 ./internal/config/` → PASS.
- [ ] Commit: `chore(v1): drop unread ai.auto_accept_threshold/auto_rule config keys; sync config.example.toml`

### Task 6: gofmt four files

- [ ] `gofmt -w internal/ingest/ingest.go internal/server/rates_test.go internal/v2/ingest/reprocess_test.go internal/v2/oplog/conformance_test.go`
- [ ] Verify `gofmt -l ./cmd ./internal ./conformance` outputs nothing; `go test -count=1` the two touched test packages.
- [ ] Commit: `style: gofmt four stragglers`

### Task 7: replace hand-rolled max64 with builtin max

**Files:** Modify `internal/v2/dict/dict.go` (:761, :781, :1137 calls; :1145 helper).

- [ ] Replace the three `max64(x, y)` calls with builtin `max(x, y)`; delete the helper. Run `go test -count=1 ./internal/v2/dict/` → PASS.
- [ ] Commit: `chore(v2): use builtin max in dict`

### Task 8: extract shared pass body in v1 recur

**Files:** Modify `internal/recur/runner.go` (rescuePass :187, matchPass :249; clone bodies :215–241 vs :266–292).

- [ ] Extract one unexported helper taking the window `(from, to)` and the matcher func; rescuePass/matchPass keep their own window math and doc comments and delegate. Byte-identical behavior; if the bodies differ anywhere beyond matcher call + counter name, STOP and report instead of merging.
- [ ] Run: `go test -count=1 ./internal/recur/` → all 10 runner tests PASS.
- [ ] Commit: `refactor(v1): deduplicate recur rescue/match pass bodies`

### Task 9: shared pgx begin/rollback helpers in a new leaf package internal/v2/pgtx

**Files:** Create `internal/v2/pgtx/pgtx.go` (NOT in `internal/v2/pg` — pg embeds the goose migrations, and none of the five consumers imports it today; a leaf package importing only pgx avoids five new dependency edges onto the migration owner). Modify `internal/v2/quarantine/quarantine.go` (:1208/:1219), `internal/v2/auth/writer.go` (:874/:885), `internal/v2/addresses/addresses.go` (:894/:905), `internal/v2/tmpl/store.go` (:552/:563), `internal/v2/oplog/append.go` (:279).

**Interfaces — Produces:**
```go
// package pgtx — imports ONLY pgx/pgxpool + context/time/fmt. Never goose, never pg.
// BeginReadCommitted opens a transaction pinned to ReadCommitted.
// <the shared isolation rationale comment moves here, once>
func BeginReadCommitted(ctx context.Context, pool *pgxpool.Pool) (pgx.Tx, error)

// Rollback rolls tx back on a context detached from ctx's cancellation,
// bounded at 5s, so cleanup still runs when the request context is gone.
func Rollback(ctx context.Context, tx pgx.Tx)
```

- [ ] Read all five copies first. If any copy differs semantically (not just error prefix), STOP and report. Otherwise add the two helpers to the new `internal/v2/pgtx`, move the shared rationale comment to the definitions, and convert each package to delegate — keeping each package's error prefix via `fmt.Errorf` at the call site.
- [ ] Run: `go build ./... && go test -count=1 ./internal/v2/quarantine/ ./internal/v2/auth/ ./internal/v2/addresses/ ./internal/v2/tmpl/ ./internal/v2/oplog/ ./internal/v2/pgtx/` → PASS.
- [ ] Commit: `refactor(v2): single pgtx.BeginReadCommitted/Rollback pair replaces four copies`

### Task 10: split cmd/ledgerd/main.go per-mode files (pure code motion)

**Files:** Modify `cmd/ledgerd/main.go` (1867 lines). Create `cmd/ledgerd/{relay.go,seeddictionary.go,purgeuser.go,consent.go,mintinvite.go}`.

- [ ] Move `runRelay` (:1104), `runSeedDictionary` (:1306), `runPurgeUser` (+`purgeDryRun`, `printPurgeReport`), `runRecordConsent` (+`showConsent`), `runMintInvite` (+`showInvites`) and each mode's private helpers/adapter types into per-mode files, matching the existing `verify.go`/`seedtemplates.go`/`loadcorpus.go` convention. NO signature or behavior changes; `runServe` + wiring stay in main.go. Verify with `git diff --stat` that this is motion, and `gofmt -l cmd/ledgerd` is clean.
- [ ] Run: `go build ./cmd/ledgerd && go test -count=1 ./cmd/ledgerd/` → PASS.
- [ ] Commit: `refactor(v2): move remaining ledgerd subcommand runners into per-mode files`

### Task 11: add `ledgerd vapid-keys` mode; drop the v2→v1 setup coupling

**Files:** Modify `cmd/ledgerd/main.go` (dispatch), `internal/v2/config/config.go` (modeOrder ~:308, modeImplemented ~:328–339, and the error string ~:865–869 that currently says "mint them ONCE with \`ledger vapid-keys\`" — the v1 binary). Create `cmd/ledgerd/vapidkeys.go`.

- [ ] CRITICAL dispatch placement: `main()` calls `config.Load` BEFORE `modeHandlers` — so a handler-style mode is unreachable exactly when the operator needs it (push enabled, keys unset → Load fails with the very error naming this command). Dispatch `vapid-keys` BEFORE `config.Load` (as v1's cmd/ledger does for its vapid-keys), or make the mode skip push validation. No config/DB/network needed to mint keys.
- [ ] Print `LEDGER_VAPID_PUBLIC=` / `LEDGER_VAPID_PRIVATE=` — the EXACT names `internal/v2/config` reads (:457/:460; they are shared with v1 — do NOT invent `LEDGERD_*` names, nothing reads them). Output MUST include a warning line: "NEW keys. Replacing keys already in use unsubscribes every device — mint once, then never again." (operational rule: never regenerate).
- [ ] THREE lists must change together or `checkModeHandlers()` panics on every invocation: `modeOrder` (config.go:308), `modeImplemented` (config.go:328–339), `modeHandlers` (cmd/ledgerd/main.go:57) — special-cased if dispatched pre-Load. Fix the config error string to say `ledgerd vapid-keys`.
- [ ] Run: `go test -count=1 ./cmd/ledgerd/ ./internal/v2/config/ ./internal/v2/pushv2/` → PASS. Smoke 1: `go run ./cmd/ledgerd vapid-keys | head -5` prints keypair + warning. Smoke 2 (the failure path the mode exists for): write a scratch TOML (in /tmp, NEVER /etc/ledger-v2) with `push.web_enabled = true`, unset `LEDGER_VAPID_*`, run `go run ./cmd/ledgerd vapid-keys -config <scratch>` → must still print keys, not die in config validation.
- [ ] Commit: `feat(v2): ledgerd vapid-keys mode; stop delegating web-push setup to the v1 binary`

### Task 12: import-boundary fence in the gate + importer rationale comment

**Files:** Modify `scripts/v2-check.sh`.

- [ ] Add a boundary assertion early in the script. PIPEFAIL TRAP: the script runs `set -euo pipefail`, and a no-match `grep` in a pipeline kills it — the naive spelling either fails every green run or (with `|| true`) can never fail. Compute both dep lists into variables/files and use `comm -12` on sorted lists; fail with a clear message if the intersection is non-empty. Comment it: the two apps' binary graphs are disjoint by construction; the three `internal/parse` imports in v2 corpus *tests* are the sanctioned parse-equivalence gate and do not appear in binary deps.
- [ ] MANDATORY mutation proof (a fence that cannot fail is worse than no fence): temporarily add `import _ "ledger/internal/parse"` to a non-test file in cmd/ledgerd's graph, run the gate, confirm it FAILS with the fence's message, revert, re-run green. Record both outputs in the report.
- [ ] Above the bare `go test -count=1 ./internal/importer` line (~:88), add the two-line comment: internal/importer is the Go executor of `conformance/import/vectors.json` (paired with `client/src/importer`); it must run in this gate despite being a v1 package.
- [ ] Run: `bash scripts/v2-check.sh` → OK (full gate; also proves fence passes today).
- [ ] Commit: `chore(gate): assert v1/v2 binary dep graphs stay disjoint; explain the importer step`

## Phase 3 — app/ retirement

### Task 13: remove the abandoned Expo client from main

**Files:** Delete `app/` (181 tracked files, 3.4MB). Modify: `scripts/v2-check.sh` (:107 comment), `internal/v2/auth/idp.go` (:636 comment), `cmd/gen-phase2-corpus/manifest.go` (:54, :227 comments), `cmd/gen-phase2-corpus/gen_test.go` (:409 refuse-list entry), `internal/v2/admin/waitlist_test.go` (:143 comment), `internal/v2/admin/testdata/bank_names.json` (prose strings), `cmd/ledgerd/loadcorpus.go` (:82 dangling pointer).

- [ ] First: `git tag app-expo-final` at current HEAD and `git push origin app-expo-final` (branches `v2-pwa`/`v2-wip-2026-08-05` and origin/main also hold app/ — but `ledger-v1` does NOT; the pushed tag is the durable preservation point. If the push fails on auth, record the tag as local-only in the ledger and report it).
- [ ] PRESERVE the bank-grammar two-reader gate before deleting: `app/src/lib/bank.test.ts` reads the shared fixture `internal/v2/admin/testdata/bank_names.json` (the contract: a grammar change not made to both Go and TS fails one suite). The live port `web/src/v2/bank.ts` does NOT read it. Repoint/extend `web/src/v2/bank.test.ts` to drive the same fixture (same relative-read pattern app's test used) so the invariant survives app/'s removal. Verify: `cd web && bun run test -- bank` passes, then temporarily alter one fixture entry → the web test FAILS → revert.
- [ ] `git rm -r app/`.
- [ ] Rewrite each referencing comment to past tense with the recovery pointer, e.g. "the retired Expo client's digest mirror (app/src/bench/digest.ts, preserved at tag app-expo-final)". Sweep the WHOLE tree: `grep -rn "app/src" --include="*.go" --include="*.ts" --include="*.tsx" --include="*.json" cmd internal client web frontend` — known sites beyond the list above: `internal/v2/auth/idp_test.go:847`, `client/src/cli/main.ts:42`, `client/src/net/client.ts:563`, `client/src/platform.registry.ts:33`, `client/src/invariants/surface.ts:525-526`, `client/src/store/driver.ts:17`, `client/src/store/store.ts:349`. All comments — reword each. In `gen_test.go:409` keep the refuse-list entry (it guards a write path; a nonexistent dir is still a valid forbidden target) but update its comment likewise. In `bank_names.json`, reword the prose strings to name the live readers: `internal/v2/admin/waitlist_test.go` and `web/src/v2/bank.test.ts` (per the repointing step above).
- [ ] Fix `loadcorpus.go:82`: point at `cmd/gen-phase2-corpus/main.go`'s doc comment (the salted-digest rationale) instead of the never-existed `conformance/crypto/README.md`.
- [ ] Update `scripts/v2-check.sh:107`: replace the "app/ (Expo) is retired on this branch" comment with "app/ (Expo) was removed 2026-08-10; preserved at tag app-expo-final".
- [ ] Run: `go build ./... && go test -count=1 ./internal/v2/admin/ ./cmd/gen-phase2-corpus/ && bash scripts/v2-check.sh` → PASS.
- [ ] Commit: `chore!: remove abandoned Expo client app/ (preserved at tag app-expo-final)`

### Task 14: remove the native push-token API surface — SURGICAL, not file deletion

**Files:** Modify `internal/v2/api/push.go`→mostly delete BUT relocate shared symbols first, `internal/v2/api/api.go` (routes :777–780, doc-comment endpoint list :31–34, comment :292 naming `evictPushTokensOverCap`, comment :782), `internal/v2/pushv2/push.go`→remove Expo notifier BUT relocate shared symbols, `cmd/ledgerd/main.go` (Expo wiring), `config.v2.example.toml` (annotate `[push] enabled`/`expo_url` as inert), comment-only edit in `internal/v2/config/config.go` :222.

⚠️ THE TWO DOOMED FILES CONTAIN LIVE SHARED SYMBOLS (plan-review blocker — a naive file delete does not compile):
- `api/push.go` defines `maxWriterIDLen` (:26), `liveDeviceWriter` (:210), `sessionHash` (:231) — all used by the KEPT `api/webpush.go` (:163, :172, :182/:236). Move them to `api/webpush.go` or a new `api/pushcommon.go` FIRST.
- `pushv2/push.go` defines `Disabled` (:135) — the PRODUCTION default pusher (`cmd/ledgerd/main.go:366`) — and `MaxDevicesPerUser` (:122), used by `pushv2/webpush.go` (:197/:213) and `api/webpush.go` + its tests. Move both to `pushv2/webpush.go` (or a small shared file) FIRST.
- Before removing ANY identifier, grep it across cmd/ + internal/ for external users.

⚠️ DO NOT TOUCH `internal/v2/config` beyond the :222 comment. The v2 loader HARD-REJECTS unknown TOML keys (config.go:405-416); the deployed `/etc/ledger-v2/config.toml` may carry `[push] enabled`/`expo_url`, so removing those fields/keys/validation = `ledgerd` refuses to boot on next restart. The TOML keys stay, inert. The deadcode sweep below is scoped to `internal/v2/api` and `internal/v2/pushv2` ONLY.

- [ ] Pre-check: `grep -rn "push/tokens\|PushToken\|pushv2\.Expo\|pushv2\.Disabled\|MaxDevicesPerUser\|liveDeviceWriter\|sessionHash\|maxWriterIDLen" --include="*.go" cmd internal` — enumerate every use before moving/removing anything.
- [ ] Relocate the shared symbols (above), then remove: the four `/api/v1/push/tokens` routes, their handlers/types, the Expo notifier + its HTTP client, their tests. Do NOT touch the Postgres `push_tokens` table or any migration — data stays.
- [ ] Update the stale comments/doc rails this creates: `api/api.go:31-34` endpoint list, `:292`, `:782`; `config.go:222` ("controls content-free Expo push" → Web Push, keys inert); `config.v2.example.toml:87-90` (annotate `enabled`/`expo_url`: "inert since the Expo client's removal 2026-08-10; the struct fields stay because the loader rejects TOMLs with unknown keys, so deployed configs keep loading"). deploy/README-v2.md's push rail is Task 23's item 7.
- [ ] Sweep for now-orphaned helpers: `go run golang.org/x/tools/cmd/deadcode@latest ./cmd/ledger ./cmd/ledgerd`, address newly-flagged symbols in `internal/v2/api` + `internal/v2/pushv2` ONLY.
- [ ] Run: `go build ./... && go test -count=1 ./internal/v2/... && bash scripts/v2-check.sh` → PASS.
- [ ] Commit: `chore(v2)!: remove native push-token API (only client was the retired Expo app; DB table and config keys untouched)`

## Phase 4 — TypeScript cleanup

### Task 15: prune the v1 fork scripts from web/harness; make the README v2-first

**Files:** Delete `web/harness/{stack.sh,shoot.mjs,probe.mjs,nav.mjs,seed.mjs,gestures.mjs,hero.mjs,ios.mjs,sheets.mjs}`. Keep `audit.mjs` (imported by v2settings.mjs:35) and `webauthn.mjs` (imported by operator.mjs:38). Rewrite `web/harness/README.md`. Modify `CLAUDE.md` harness paragraph.

- [ ] Verify before deleting: `grep -rn "stack.sh\|shoot\|probe\|nav.mjs\|seed.mjs\|gestures\|hero\|ios.mjs\|sheets" web/harness/*.mjs web/harness/*.sh | grep -v README` shows no v2 runner importing any of the nine. (Known: the nine drive v1 — stack.sh:65 builds `./cmd/ledger`, :87 cds into frontend/. web/harness/seed.mjs is an OLDER v1 copy missing frontend's `month` fix.)
- [ ] Rewrite README to lead with the v2 stack (`v2stack.sh up` → `v2settings.mjs`, `recovery.mjs`, `vault.mjs`, `operator.mjs`; the `--dns-fixtures` requirement stays prominent), move the trust warning to the top, point v1 work at `frontend/harness/README.md`, and drop sections documenting deleted files.
- [ ] In `CLAUDE.md`, rewrite the "v2 has only partial harness coverage" paragraph: the v1 forks are gone; name the four v2 runners; the coverage-gap statement stays true (screens beyond Settings/recovery/vault/operator rest on vitest). Task 15 is the SOLE editor of this paragraph — Task 24 verifies it, never re-edits.
- [ ] Owner decision (2026-08-10): FIX AND COMMIT `web/harness/addpasskey-repro.mjs` — change the stale testid `welcome-passkey-note` → `add-passkey-note` (live id in `web/src/screens/onboarding/Welcome.tsx:241`), add a two-line header saying what it asserts, `git add` it, and add a README line documenting it beside the other v2 runners.
- [ ] Run: `cd web && bun run test` → PASS (harness files aren't in the vitest graph; this catches accidental src edits).
- [ ] Commit: `chore(web): delete v1 fork harness scripts; adopt addpasskey repro; README and CLAUDE.md describe the real v2 harness`

### Task 16: sunset the superseded v1 Settings cluster in web/src

**Files:** Delete `web/src/screens/Settings.tsx` and the settings pages whose ONLY transitive non-test importer it is, plus their test/story files. Modify `web/src/app/AppShell.tsx` (:5–16 header comment — it currently lists "v1's Settings hub" among the unrouted-not-deleted set; after this task that clause is false) and `web/src/main.tsx` (:43 — "deliberately unmounted rather than deleted while v1 screens are still routed"; reword to what is true afterward). There is NO stale settings comment in main.tsx besides :43 — do not hunt for one. KEEP: `settings/SettingsPage.tsx` (live chrome, mounted in AppShell:178), `V2Settings.tsx` and everything it imports, and the documented-intentional unrouted plan/accounts/projects/recurring/reports tree. This deletion is an OWNER DECISION recorded 2026-08-10 (see Decisions of record) — the AppShell comment's "comes back when its data grows a projection" reasoning is fulfilled for Settings: it came back as V2Settings.

- [ ] Build the import graph first: start from `screens/Settings.tsx`; for each file it imports (SettingsHub, RulesManager, CategoryManager, AiUsagePage, IngestHealthPage, BudgetPage, NotificationsPage, TextSizePage, CategorizationPage, SwipePage, CurrenciesPage, AccountsPage, …), delete it ONLY if all its non-test importers are also in the deletion set. `grep -rn "from.*<name>" web/src --include="*.ts*" | grep -v test | grep -v stories` per file; anything V2Settings/AppShell/nav reaches stays.
- [ ] Delete the files + their colocated `.test.tsx`/`.stories.tsx`/`.stories.test.tsx`.
- [ ] Rewrite `AppShell.tsx:5–16` and `main.tsx:43` per the Files note above.
- [ ] Run: `cd web && bunx tsc -b --noEmit 2>/dev/null || bun run build` (type-check via build) and `bun run test` → PASS; test count drops by exactly the deleted suites.
- [ ] Commit: `chore(web): remove v1 Settings screen cluster superseded by V2Settings (git history preserves it)`

### Task 17: web/src dead exports and v1 REST remnants

**Files:** Modify `web/src/api/client.ts`, `web/src/api/hooks.ts`, `web/src/v2/{sources/review.ts,onboarding.ts,keys.ts}`, others per knip.

- [ ] HARNESS GUARD first: `grep -rn "import(\"/src\|import('/src" web/harness/*.mjs` — every symbol reached this way (`openV2`, `engineFor` in BootGate.tsx; the `keys.ts` module surface used by recovery.mjs/vault.mjs) MUST stay exported.
- [ ] Delete v1 REST functions with zero callers (client.ts `createAccount`:55, `deleteAccount`:59, `bulkUnassignProject`:111; hooks.ts `useSaveSplits`:407, `useRules`:431) plus anything Task 16 newly orphaned (re-run `bunx knip` from web/ and hand-verify each claim by grep — knip's config loaders are degraded here; trust grep, not knip alone).
- [ ] Demote internally-used exports to module-private (e.g. keys.ts `KEY_VAULT_DB`, `indexedDbKeyVault` — unless harness-reached).
- [ ] web/'s copy of the FilterChips orphan (same as frontend's, Task 21): delete `web/src/components/transactions/FilterChips.tsx` + `FilterChips.test.tsx` (only importer is its own test; SearchSheet imports FilterBar, Transactions imports ProjectionFilterBar), fix the false claim at `web/src/components/README.md:879` ("still used by the Insights SearchSheet"), repoint the stale convention comment at `web/src/screens/projects/BulkBackfill.tsx:20`.
- [ ] Run: `cd web && bun run test && bun run build` → PASS.
- [ ] Commit: `chore(web): drop uncalled v1 REST functions, FilterChips orphan, superfluous exports`

### Task 18: client/ unexport pass

**Files:** Modify ~48 export sites across `client/src` (phrase.ts, tmpl/exec.ts, norm/mime.ts, replay/snapshot.ts, test/e2e/smtp.ts, …).

- [ ] Consumers to check per symbol before unexporting (the audit's rescue list): (1) `web/src` via the `@ledger/client` alias (web/vite.config.ts:82); (2) `client/scripts/crossexec.ts` + `crossexec-tmpl.ts` (NOT executed by v2-check.sh or any Go test — they are the operator's manual full-corpus diff tools — but they must keep compiling); (3) conformance fixtures/runners; (4) client's own tests and e2e. Unexport only symbols none of the four reach. Delete nothing in norm/tmpl bodies.
- [ ] The REAL net for a bad unexport (plan-review correction — v2-check does NOT drive crossexec): `client/tsconfig.json` includes `src`, `scripts`, `test`, so `cd client && bun run typecheck` covers the crossexec runners; web/'s `tsc -b` inside the gate covers the alias consumers. Mutation proof, once: unexport a symbol `crossexec.ts` imports → `bun run typecheck` FAILS → revert.
- [ ] Run: `cd client && bun run typecheck && bun test` → PASS, then `bash scripts/v2-check.sh` → OK.
- [ ] Commit: `chore(client): unexport internals no consumer imports`

### Task 19: web/package.json dependency truths

**Files:** Modify `web/package.json`, `web/bun.lock`.

- [ ] Add `"@testing-library/user-event": "^14.6.1"` to devDependencies (imported by ~20 test files; today it resolves only via storybook's hoisting — a phantom).
- [ ] Remove `fflate` and `@noble/hashes` (web/src never imports them; the aliased client/ modules resolve from client/node_modules, and client/package.json declares its own). Move `@noble/curves` to devDependencies (imported only by two test files).
- [ ] After Task 16/17: re-check whether `@tanstack/react-table` (and other deps used only by deleted screens) became unused — remove only with grep proof.
- [ ] Run: `cd web && bun install`, `cd ../client && bun install`, then `cd ../web && bun run test && bun run build` → PASS (build proves aliased client modules still resolve).
- [ ] Commit: `build(web): declare user-event, drop unused fflate/@noble/hashes, test-only @noble/curves to dev`

### Task 20: fix web/scripts/generate-pixel-icons.mjs provenance

- [ ] Fix header comments (:2, :5, :10) and the :94 provenance stamp to say `web/` (`cd web && bun run generate:icons`); run the generator once so `web/src/components/ui/pixelIcons.ts`'s stamped comment matches; verify `git diff` on pixelIcons.ts shows ONLY the comment change (if glyphs changed, STOP — pixelarticons version drift — and report).
- [ ] Run: `cd web && bun run test` → PASS. Commit: `chore(web): pixel-icon generator says web/, not frontend/`

### Task 21: frontend/ (v1) cleanup

**Files:** Modify `frontend/src/api/client.ts`, `frontend/src/components/ui/{PixelIcon.tsx,pixelIcons.ts}`, `frontend/scripts/generate-pixel-icons.mjs`, `frontend/src/components/README.md` (:665), `frontend/src/screens/projects/BulkBackfill.tsx` (:20 comment), `frontend/package.json`; delete `frontend/src/components/transactions/FilterChips.tsx` + `.test.tsx`, `frontend/public/logo-square.svg`; unexport pass per audit finding 21 (SKIP api/types.ts DTO interfaces).

- [ ] Delete dead API functions (`createAccount`:55, `deleteAccount`:59, `unlinkRefund`:75, `bulkUnassignProject`:111 — useTxnActions.ts:60 re-implements unlink inline). Remove `Loader2` export + glyph + generator alias (keep the PixelSpinner.tsx:27 comment).
- [ ] FilterChips: superseded by FilterBar (commit de89217). Delete component + test; fix README.md:665 (currently claims SearchSheet still uses it — false); repoint BulkBackfill.tsx:20's comment at a live example (FilterBar).
- [ ] `rm frontend/public/logo-square.svg` (referenced by nothing; the dist copy drops at the Phase-6 rebuild).
- [ ] `cd frontend && bun remove @vitest/coverage-v8`.
- [ ] Drop stray `export` on in-file-only symbols (hooks.ts keys, fontScale.ts `isFontScale`, insights.ts `CATEGORY_PALETTE`, swipe.ts `bucketKey`/`BucketKey`, Toast.tsx `ToastAction`, PixelIcon.tsx `PixelIconProps`, analysis.ts, reconcile.ts, reports.ts — grep-verify each first).
- [ ] Run: `cd frontend && bun run test` → PASS (expect exactly the FilterChips suite gone).
- [ ] Commit in two: `chore(frontend): prune dead API fns, FilterChips, logo-square, coverage dep` and `chore(frontend): unexport file-local symbols`

## Phase 5 — Docs (after all code tasks; each doc states post-cleanup truth)

### Task 22: rewrite root README.md as the two-app README

- [ ] Open with the v2/v1 table (from CLAUDE.md). Trimmed v1 section: React 19 (not 18), dither-kit + motion (not recharts), CLI table gains `compact`, endpoint table replaced by a pointer to `internal/server` (89 routes; the old table listed 25). v2 section: what it is, `web/` + `cmd/ledgerd`, links to `deploy/README-v2.md` and the PWA direction spec. Label `budgeting-app-build-plan.md` as the historical v1 spec.
- [ ] Commit: `docs: root README describes the two-app tree`

### Task 23: deploy/README-v2.md — six stale claims

- [ ] §1: "Nine modes" → the real count incl. `load-corpus` AND the new `vapid-keys` (Task 11). §4: migration numbering → "through 00029 (00004/00015 vacant)" (re-verify against `internal/v2/pg` migrations at execution time). §7: `ledgerd.service` row → the unit exists (committed 2026-08-09); drop "once D4/D5 land". §6/§8: strike "no production database yet"; mark D1/D4/D5 done; D6 → link `docs/alpha-consent.md` (v1.0, 2026-08-07). §9: rewrite the DIB paragraph around `decodeWitnessed` (card mail auto-trusts when the Arabic literal survives; account/transfer still confirm). §3: add the three `RP_*` vars. Delete the stale config-example callout.
- [ ] Item 7 (created by Task 14): the Expo push rail (~:501–:505, `LEDGER_EXPO_ACCESS_TOKEN` :569) — rewrite to say the native/Expo push half was removed 2026-08-10 (Web Push remains); the `[push] enabled`/`expo_url` TOML keys are inert but still parsed.
- [ ] Commit: `docs(deploy): v2 runbook matches the deployed reality`

### Task 24: CLAUDE.md + AGENTS.md drift

- [ ] Both files: complete the internal/v2 package list (+`addresses, authtest, blob, corpus, diag, samples`, and Task 9's new `pgtx`); v1 architecture gains `recur`; mode list adds `load-corpus` + `vapid-keys`; v1 CLI list adds `compact`; app/ references say removed-at-tag. CLAUDE.md's harness paragraph was already rewritten by Task 15 — VERIFY it, do not re-edit; AGENTS.md:109's single-runner sentence is this task's to fix. Keep the existing one-phrase-per-package style.
- [ ] Commit: `docs: CLAUDE.md and AGENTS.md catch up with the tree`

### Task 25: NOTICE tells the truth

- [ ] Inventory what ships: check `frontend/` and `web/` for bundled third-party assets (Geist fonts? dither-kit vendored code — read its README/license header; pixelarticons glyphs baked into pixelIcons.ts via the MIT-licensed package). Rewrite NOTICE to credit exactly that set with correct licenses; delete the Fugue Icons and XP.css entries (never/no-longer shipped; no Settings>About exists). If nothing bundled requires attribution, NOTICE may instead be deleted — prefer the honest rewrite.
- [ ] Commit: `docs: NOTICE credits what the apps actually bundle`

### Task 26: historical-record banners

- [ ] `docs/superpowers/NEEDS-SALEH.md`: dated banner at top — native-track sections (1/1b/2, parts of 5/8) superseded by `specs/2026-08-07-v2-pwa-direction.md`; still-live items: 4 (relay), 5b (HMAC key window), 6 (Phase-3 cutover promise), 7 (enc-slot gap). Do not rewrite the sections.
- [ ] `docs/superpowers/MAC-TESTING-HANDOFF.md`: one-line superseded header pointing at the PWA direction spec.
- [ ] `docs/v3/README.md` (new, 3 lines): "Historical: the third revision of the v1 single-user app, shipped 2026-07-30. Unrelated to — and older than — ledger 2.0 (internal/v2)."
- [ ] Commit: `docs: mark superseded plans as historical records`

### Task 27: client/README.md names its real consumer

- [ ] Phase-2 table + driver notes: consumer is `web/` (webDriver/sql.js in `web/src/v2/db/driver.ts`, `@ledger/client` alias in web/vite.config.ts); app/ marked removed-at-tag. Reword the expo-secure-store row for the web platform's key storage. Keep the protocol-ordering warning intact.
- [ ] Commit: `docs(client): README points at web/, not the retired Expo app`

### Task 28: deploy/README.md (v1) copy fixes

- [ ] Drop "(Milestone 1)" from the title; §4 placeholder-card sentence → "expect the app's Home screen"; renumber 5a–5d under §6 to 6a–6d. (Install facts verified accurate — do not touch.)
- [ ] Commit: `docs(deploy): v1 runbook drops Milestone-1 leftovers`

### Task 29: verify skill learns v2

- [ ] `.claude/skills/verify/SKILL.md`: scope the existing body as v1; add a short v2 section: `web/harness/v2stack.sh up` (must pass `--dns-fixtures`) → `v2settings.mjs`/`recovery.mjs`, per `web/harness/README.md`.
- [ ] Commit: `docs(skills): verify skill covers both apps`

### Task 30: surface the tracked-but-ignored sdd reports

- [ ] `git mv .superpowers/sdd docs/superpowers/sdd` (31 tracked files currently invisible to git status because `.gitignore` ignores `.superpowers/`). Grep docs for `.superpowers/sdd` path references and fix. Keep the `.superpowers/` ignore (local mockups).
- [ ] Commit: `chore(docs): move sdd reports out of the gitignored directory that was hiding them`

### Task 31: give perf-report.sh a discoverable home

- [ ] One line in `deploy/README.md`'s ops section (or frontend docs): `scripts/perf-report.sh` reports the v1 PWA load weight from the committed dist. (Keep the script — small, working.)
- [ ] Commit: fold into Task 28's commit if convenient.

### Task 32: prune concluded spike code, keep the record

- [ ] Delete `spike/phase0/blobgen/` and `spike/phase0/replay-app/` (own go.mod/package.json; built by nothing; measurements fully recorded). Keep `spike/phase0/RESULTS.md` and add one line: "The spike code this file cites was removed 2026-08-10 (git history preserves it); measurements stand as recorded."
- [ ] Commit: `chore: remove concluded phase-0 spike code; RESULTS.md remains the record`

## Phase 6 — Dist rebuilds + full verification

### Task 33: rebuild both embedded bundles

- [ ] `cd web && bun run build` (writes `../internal/v2/webui/dist`); `cd frontend && bun run build` (writes `../internal/web/dist`; `logo-square.svg` must disappear from dist).
- [ ] `git status` — commit the dist changes: `build: rebuild both embedded bundles after cleanup`

### Task 34: full gate matrix

- [ ] `go test -count=1 ./...` (both apps) · `cd frontend && bun run test` · `cd web && bun run test` · `cd client && bun test` · `bash scripts/v2-check.sh` → ALL green. Compare counts against baseline (1396 / 2121 / 2502) — deltas must equal exactly the suites deliberately removed.
- [ ] `go build -o /tmp/ledger-smoke ./cmd/ledger && go build -o /tmp/ledgerd-smoke ./cmd/ledgerd` then delete — both binaries build clean.

## Phase 7 — Independent review (required: separate non-biased agents)

### Task 35: review workflow

- [ ] Multi-lens review of the full diff since `9fb968d` by SEPARATE agents (Opus 5 reviewers + Fable adversarial verification): (a) deletion-safety — for every deleted symbol/file, independently prove no live reference; (b) docs-vs-code — re-verify every edited doc sentence against the tree; (c) conformance-contract — Go/TS agreement untouched; (d) gate-integrity — no check was weakened, no test now "cannot fail"; (e) behavior — no runtime change beyond the deliberate removals. Verified findings get fixed, gates re-run, fixes committed.

## Phase 8 — Report

- [ ] Final report: what changed, commit list, the report-only items awaiting the owner (media files, alpha-consent gap, two unmerged worktrees, v2-wip-partial), the repo-split decision, and the deploy note (nothing deployed; deploy order in CLAUDE.md applies when the owner chooses).
