# v2 Repo Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move ledger v2 out of the two-app monorepo into a fresh repo `salehtl/ledgerd` (module `ledgerd`, checkout `/root/Coding/ledgerd`, flattened `internal/` layout, filtered git history), leaving the current repo as the v1 repo — with zero service interruption and no data loss.

**Architecture:** Filter-repo extracts v2's history with path renames (`internal/v2/` → `internal/`); a vendor commit adds five byte-frozen v1 reference packages under `internal/v1ref/` so the corpus-equivalence and import-conformance gates keep running in-repo; targeted rewrites re-point imports, path literals, and the gate script; fresh single-app root docs replace the two-app set. The old repo then prunes v2 from its main and becomes the v1 repo. Production is touched exactly once, at the sanctioned first-deploy step, following the standard runbook.

**Tech Stack:** git filter-repo, Go 1.25, bun/vite/vitest, gh CLI (account `salehtl`, verified ACTIVE with `repo` scope), Postgres/scratch harness for verification.

## Decisions of record

- **Owner decisions (asked and answered 2026-08-11):** repo+module name **`ledgerd`**; **filtered history** (blame survives); **flatten** `internal/v2/*` → `internal/*`; old repo **becomes the v1 repo** (v2 pruned from its main).
- **This plan supersedes the 2026-08-10 "NO repo split, ever" decision of record.** That decision's technical grounds (conformance gates import v1's parser; Go `internal/` cannot cross repos) are answered by vendoring five frozen reference packages; the owner's motivation is smaller per-repo context for agents and humans. The cleanup memory and the new repo's docs must both record the supersession (Task 15).
- **Vendor whole packages, byte-frozen where it matters:** `internal/v1ref/{parse,categorize,store,anthropic,importer}` copied from the split-point tag. Only import lines change (`ledger/internal/X` → `ledgerd/internal/v1ref/X`); **`parse/dib.go` changes by ZERO bytes** — `corpus_gate_test.go:653-683` reads it as raw source and derives Arabic anchors from its literal shape. dib.go imports no ledger package (verified), so this is achievable trivially. No pruning of processor.go/reprocess.go: the pruned variant saves only the modernc.org/sqlite dep, which v2 needs anyway (`internal/corpus`), so pruning buys nothing and risks the freeze.
- **`@ledger/client` TS alias stays verbatim** (274 occurrences, all relative-path based, zero coupling to the Go module name — inventory-verified). Renaming it is 263-file cosmetic churn for nothing.
- **New repo visibility: PRIVATE** (default; the old repo is public — flag to owner in the final report if they want the new one public too). Note the old repo being public makes the spike/phase2 never-push rule (below) existentially important on BOTH repos.
- **conformance/ moves whole**, including the TS-only `fx` suite and the orphaned `crypto` suite (32K, Phase-3 asset, decision from the cleanup stands).
- **`app/` history and the `app-expo-final` tag come along:** the filter keep-list includes `app/` (v2's retired Expo client) so the tag's promise ("check it out there if you ever need it") stays true inside the new repo. The old repo keeps both regardless.
- **Root two-app docs (README, CLAUDE.md, AGENTS.md, NOTICE, .gitignore, go.mod/go.sum) are EXCLUDED from the filter** and minted fresh in the new repo — their history is two-app noise, which is the thing this migration exists to shed.

## Global Constraints

- **Never touch production outside Task 12 (deploy) and Task 9's read-only snapshot command.** No systemctl, no ports 25/80/443/8080/8079/8445, no `/var/lib/*`, no `/etc/ledger*` — except the one sanctioned deploy task, which follows deploy/README-v2.md's order verbatim.
- **NEVER-PUSH hazard:** `spike/phase2/` on this box holds real bank data and a private key (gitignored). The new repo's very first commit must carry a `.gitignore` with `spike/phase2/`; no `git add -f`, no bulk `cp` into the new checkout, and Task 10 greps the new repo for `recipient.key|corpus.bin` before the first push.
- **PROTECTED STRINGS — a blanket `ledger`→`ledgerd` rewrite is FORBIDDEN.** Only Go import strings, `go.mod`'s module line, and `v2-check.sh`'s `'^ledger/'` greps are renamed. These literals are wire/at-rest cryptographic domains mirrored in TS and committed vectors; corrupting any one bricks every beta user's data: `"ledger-phase2-encv2"` (blob EncInfo, also in conformance/crypto/vectors.json), `"ledger/v2 account-delete\x00"` (purge; twin web/src/v2/deleteAccount.ts:62), `"ledger-v2-address-rotation\x00"`, `"ledger-v2-smtp-refused-attempt\x00"`, `"ledger/dict/key-epoch/v1"`, `"ledger-v2-account-keys-prf\x00"`, `"ledger-v2-prf-wrap-v1"`, plus `ledger-v2-writer-registration` / `ledger-v2-wrap-1` / `ledger-v2-account-keys-1` in client/src. Task 8 proves by grep that all survive byte-identically.
- **Rewrites must reach build-tagged code:** `cmd/gen-phase2-corpus` (6 files, `//go:build phase2corpus`) is invisible to `go list ./...`. Every mechanical rewrite works from `git ls-files '*.go'`, never from go-list package walks; verification compiles it explicitly with `-tags phase2corpus`.
- **Conformance byte-contract intact:** every gate that exists today must exist and PASS in the new repo, and the adapted ones (fence, importer step, corpus gates) each get a mutation proof — a check that cannot fail is this repo's most-repeated defect.
- **Workers never run git push; the orchestrator pushes.** All review gates use independent Opus/Fable agents (owner's standing requirement). Ledger + per-task review per subagent-driven-development.
- **The old checkout stays untouched until Phase E.** Two-checkout window hazards: `v2stack.sh` resolves the repo from its own path (run harness only from the intended checkout); Agent-tool subagents spawn cwd-pinned to `/root/Coding/ledger` (every dispatch in the new repo must mandate `cd /root/Coding/ledgerd && git branch --show-current` first).
- Baseline: the monorepo is fully green at `8999738` (all suites + v2-check). Any new-repo failure is migration-caused.

---

## Phase A — Extraction (Tasks 0-4)

### Task 0: pre-split fixes in the OLD repo (plan-review blockers that are live defects today)

- [ ] Commit the two untracked plan docs (this file + the inventory companion) — Task 2's keep-list needs them IN a commit, and Task 1 needs a clean tree.
- [ ] **Fix `web/src/styles/tokens.test.ts:102`**: it reads `../internal/web/dist/assets` — that is **v1's** bundle; v2's motion-budget ceiling and palette-token assertions have never once measured v2's own bundle (`../internal/v2/webui/dist/assets`). Re-point it, run the suite, and land whatever that reveals as its own commit — if v2's real numbers break the ceiling, that is a v2 finding to fix or re-budget honestly, not to paper over. (Post-flatten in the new repo the literal becomes `../internal/webui/dist/assets` — Task 7.)
- [ ] **Re-anchor `web/src/lib/paletteColor.test.ts` to v2's own authority** (owner decision 2026-08-11): rewrite it against the client fold's accepted-color validation (the thing that actually governs v2 category colors); if the fold accepts any string, DELETE the test and record the gap in CLAUDE.md instead. Either way it stops reading `../internal/store/categories.go`. Land in the old repo.
- [ ] Settle dist staleness once, cheaply: `cd web && bun run build`; if `internal/v2/webui/dist` changes, commit it (per the standing rule). Task 8's untouched-dist assertion depends on entering the split fresh.
- [ ] Run `cd web && bun run test` → green after all of the above.

### Task 1: split-point tag and tooling

- [ ] In `/root/Coding/ledger`: confirm clean tree + green `bash scripts/v2-check.sh` (redirect to a log; ~5 min). Tag the split point: `git tag ledger-v2-final && git push origin ledger-v2-final`.
- [ ] Install git-filter-repo if absent (`pip install git-filter-repo` or the single-file script into ~/bin). Verify `git filter-repo --version`.

### Task 2: filtered clone with path renames

- [ ] Fresh clone (filter-repo refuses dirty/used repos): `git clone /root/Coding/ledger /root/Coding/ledgerd && cd /root/Coding/ledgerd && git remote remove origin`.
- [ ] Run filter-repo with the keep-list + renames. Keep paths: `cmd/ledgerd`, `cmd/gen-phase2-corpus`, `internal/v2`, `web`, `client`, `conformance`, `app`, `scripts/v2-check.sh`, `deploy/README-v2.md`, `deploy/ledgerd.service`, `config.v2.example.toml`, `spike/phase0/RESULTS.md`, and the v2-era docs list (the ~30 files the census enumerated: docs/superpowers/specs/2026-07-31-v2*, 2026-08-07-v2-pwa-direction.md, v2-template-format.md, v2-phase1-exit-record.md, 2026-08-09-product-principles.md, 2026-08-09-parity-and-housekeeping.md, plans/2026-07-31-v2-phase0-kill-risks.md, 2026-08-01-v2-phase1-backend.md, 2026-08-02-v2-phase2-client.md, 2026-08-08-phase3-crypto.md, 2026-08-08-multi-bank-and-device-parity.md, 2026-08-08-user-configuration.md, 2026-08-09-parity-and-housekeeping.md, 2026-08-10/11 cleanup+migration plan pair, sdd/2026-08-02-v2-phase2-client/, plus the remaining v2-flagged files in the census — extract the exact list from the companion inventory file `2026-08-11-v2-repo-migration-inventory.md` (census agent, docs/** finding) into the filter args and record it in the task report). **`docs/superpowers/specs/2026-07-31-multi-user-beta-design.md` MUST be in the keep-list by name** — no `v2` in its filename so globs miss it, and it is runtime-read by three test packages (`internal/v2/dict/dict_test.go:169`, `samples/samples_test.go:132`, `diag/diag_test.go:299`, each `t.Fatalf` on a missing read), same protection as `v2-template-format.md`. Acceptance sweep, not glob-trust: `git grep -nE 'superpowers.*(specs|plans)' -- '*.go' '*.ts'` filtered to ReadFile/Join/resolve must return exactly the four runtime-read call sites, all pointing at kept files. Renames: `internal/v2/webui/dist` → *(handled by parent rename)*; `internal/v2/` → `internal/`; `docs/superpowers/specs/v2-template-format.md` stays put (runtime-read at `../../../docs/superpowers/specs/v2-template-format.md` by dialect_test.go:700 — keep the docs path shape).
- [ ] Verify: tag `app-expo-final` survived and `git show app-expo-final:app/package.json` resolves; `git log --oneline | wc -l` is plausibly large (filtered history, not one commit); `git log --follow internal/api/api.go` shows pre-rename history.
- [ ] NEVER-PUSH check: `git ls-files | grep -E 'recipient.key|corpus\.bin|spike/phase2'` → only `internal/blob/corpus.bin`-style committed fixtures if any are tracked today (expect: none; conformance .bin files are fine), nothing from spike/phase2.

### Task 3: fresh root files (first new commit)

**Files:** Create `.gitignore`, `go.mod`, `go.sum`, `README.md`, `CLAUDE.md`, `AGENTS.md`, `NOTICE`, `.claude/skills/verify/SKILL.md`.

- [ ] `.gitignore` FIRST, **derived by DELETION from the old file, never re-typed** (plan-review finding: enumeration dropped `*.env`, the secrets guard): take the old `.gitignore` and remove exactly the v1-only lines (`/ledger`, `frontend/node_modules`, `frontend/harness/shots/`); everything else survives — `*.env`, `ledger.env`, `*.db`/`*.db-wal`/`*.db-shm`, `/data/`, `pid`, `smoke.pid`, `/ledgerd`, `/dist`, `web/harness/shots/`, `spike/phase2/`, `.claude/worktrees/`, the machine-local entries. Diff old-vs-new in the report; the delta must be only the removed v1 lines.
- [ ] `go.mod`: `module ledgerd`, `go 1.25.0`, the 17 carried direct requires + excelize (per inventory; go-imap stays behind). `go mod tidy` after Task 5 populates go.sum.
- [ ] Root docs: single-app README (what ledgerd is, build, gate, deploy pointer); CLAUDE.md rewritten v2-only (keep: principles, package list — now `internal/*` — modes, gate description incl. the NEW fence, harness section, deploy order, the two failure classes, dist-staleness warning; drop every v1 table/section; add a short "History" note: extracted 2026-08-11 from salehtl/ledger, v1 lives there, tag ledger-v2-final is the split point, this plan supersedes the no-split decision; and one line recording the palette gap: category colours are TS-authoritative, nothing cross-checks the palette since the Go mirror stayed with v1); AGENTS.md condensed to match; NOTICE = v2 half only (Geist, dither-kit/EvilCharts MIT, pixelarticons, sql.js, Go/JS deps); verify skill = v2 section only.
- [ ] Commit: `chore: fresh single-app root — module ledgerd, v2-only docs`

### Task 4: vendor the frozen v1 reference packages

**Files:** Create `internal/v1ref/{parse,categorize,store,anthropic,importer}/` copied from `/root/Coding/ledger` at tag `ledger-v2-final`. Create `internal/v1ref/README.md`.

- [ ] Copy the five packages' **tracked files only, enforced by the command** (plan review): `git -C /root/Coding/ledger archive ledger-v2-final internal/parse internal/categorize internal/store internal/anthropic internal/importer | tar -x` into the v1ref layout — never `cp -r` from a working tree. Rewrite ONLY import lines: `"ledger/internal/{anthropic,categorize,store,parse,importer}"` → `"ledgerd/internal/v1ref/..."` (affects: parse/ai.go, parse/processor.go, parse/reprocess.go, importer/importer.go, importer/normalize.go, categorize's anthropic import, store-internal — enumerate by grep, expect <15 lines). `parse/dib.go` MUST be byte-identical: `diff /root/Coding/ledgerd/internal/v1ref/parse/dib.go /root/Coding/ledger/internal/parse/dib.go` → empty, recorded in the report.
- [ ] `internal/v1ref/README.md`: FROZEN reference copies of five v1 packages at split tag `ledger-v2-final`; they exist for the corpus-equivalence gate (parse as the reference parser over the operator's 7,002-message corpus) and the import-conformance contract (importer as the Go executor of conformance/import/vectors.json paired with client/src/importer); product code must never import them (the gate's fence enforces it); do not extend, do not fix — a "bug" here is the reference behavior; dib.go is byte-frozen (corpus_gate_test derives anchors from its literal source).
- [ ] Their `_test.go` files come along (they self-test the frozen behavior); `internal/v1ref/importer/conformance_test.go`'s runtime.Caller-relative vectors path recomputes to `../../../conformance/import/vectors.json` — verify the depth (it gained one level: internal/v1ref/importer vs internal/importer) and fix the `filepath.Join` accordingly.
- [ ] **The freeze must be enforced, not promised** (plan review): write `internal/v1ref/frozen.sha256` — a manifest over every `internal/v1ref/**` file (post-import-rewrite bytes) — plus a small test `internal/v1ref/frozen_test.go` that recomputes and compares, running in the default `go test ./...` sweep and therefore in the gate. Mutation proof: flip one byte in a vendored file → test FAILS → revert. Without this, v1's living parse can drift in the other repo while `TestSeedAnchorsAreByteIdenticalToV1` keeps passing against a stale reference.
- [ ] `internal/v1ref/README.md` must also state the CONTRACT FORK plainly: after the split, nothing anywhere checks that v1's LIVING importer still agrees with `client/src/importer` — the frozen v1ref copy is the contract's reference now, and the v1 repo's importer is a separate product. (The v1 repo's CLAUDE.md says the same — Task 13.)
- [ ] Verify: `go build ./internal/v1ref/... && go test -count=1 ./internal/v1ref/...` (config env-var trap from v1 memory does not apply — config pkg not vendored).
- [ ] Commit: `chore: vendor frozen v1 reference packages for the corpus and import gates`

## Phase B — The rewrite (Tasks 5-9)

### Task 5: import-path rewrite (399 lines, 162 files + 3 gate tests)

- [ ] Over `git ls-files '*.go'` (NOT go list — must reach the 6 phase2corpus files): `"ledger/internal/v2/` → `"ledgerd/internal/` and the exactly-three corpus test imports `v1 "ledger/internal/parse"` → `v1 "ledgerd/internal/v1ref/parse"`. No other `ledger` token changes (protected strings!).
- [ ] **Line 400 (plan review): `internal/v2/origin/config_test.go:29`** carries `"ledger/internal/v2/oplog"` as a forbidden-import NEEDLE in `TestTrustPathNeverReadsUserConfiguration`, not as an import — an import-syntax-anchored rewrite misses it and the needle goes silently dead. Rewrite it to `"ledgerd/internal/oplog"`, then mutation-proof: add `import _ "ledgerd/internal/oplog"` to a non-test file in `internal/origin/` → the test FAILS → revert. Record both outputs.
- [ ] `go mod tidy`; `go build ./... && go vet ./...` and explicitly `go vet -tags phase2corpus ./cmd/gen-phase2-corpus/`.
- [ ] Commit: `refactor: module ledgerd, flattened internal/ imports`

### Task 6: path-literal and regen-string sweep — SWEEP-DRIVEN, never list-driven

**Method (plan review demoted the hand list):** run `git grep -nE '"\.\./\.\.|Join\([^)]*"\.\."' -- '*.go'` over `git ls-files` and produce a disposition (rewrite/no-change + why) for EVERY hit in the task report. The list below is the expected inventory, not the authority. Known hits the original list missed, all `filepath.Join` form: `oplog/conformance_test.go:308`, `norm/norm_test.go:23`, `diag/structure_conformance_test.go:22`, `dict/dict_test.go:169`, `samples/samples_test.go:132`, `diag/diag_test.go:299` (each drops one `..` on flatten). Two hits that need NO change — state so, so nobody "fixes" them: `tmpl/seed/deploy_test.go:59` (`../../origin/testdata`, intra-internal) and `diag/diag_test.go:1102` (`Join("..","pg","migrations")`).

**Files (from the inventory, verify each in place):** `internal/dict/conformance_test.go:78`, `internal/norm/conformance_test.go:20`, `internal/tmpl/conformance_test.go:44`, `internal/tmpl/corpus_test.go:59` (depth 3→2: `../../../conformance/...` → `../../conformance/...`); `internal/norm/twin_test.go:51` (`../../../client/...` → `../../client/...`); `internal/tmpl/dialect_test.go:700` (docs spec path, depth change); `internal/tmpl/seed/corpus_gate_test.go:655` (`../../../parse/dib.go` → `../../v1ref/parse/dib.go` — COMPUTE against the final tree: internal/tmpl/seed → up 2 = internal/ → v1ref/parse/dib.go); the 4 config-test reads of `config.v2.example.toml` (depth 3→2); `internal/verify`'s `filepath.Join(root, "v2")` + `inboundHandlers("../..")` (flatten: the verify self-audit walks the source tree — re-point to the new layout and re-run its test); `cmd/gen-phase2-corpus/gen_test.go:408` refuse-list entry `internal/v2/blob/corpus.bin` → `internal/blob/corpus.bin`; the 28 embedded regen-command strings (`./internal/v2/X` → `./internal/X`) in Go sources; the 13 conformance JSON `note` fields carrying `go test ./internal/v2/...` commands (data-file comment fields — safe, but do them in this dedicated commit so the conformance diff is reviewable in isolation).
- [ ] **Generated-pair rule (plan review):** `internal/norm/twin_test.go`'s generator emits a header containing `./internal/v2/norm/` (:314-317) and `TestTwinArtifactsAreFresh` byte-compares the on-disk `client/src/norm/charset-tables.ts:1-4` against it — editing one side without the other fails the freshness test. Resolution: after the Go-side regen-string edits, RE-RUN the writers (`LEDGER_WRITE_CONFORMANCE=1 go test ./internal/norm/ -run TestWriteTwinArtifacts` and the equivalent for `conformance/normalizer/edge-cases.json` per twin_test.go:675) so every generated artifact is refreshed by its generator — which also proves the generators still run in the new tree. Diff the regenerated files: only header/command strings may change.
- [ ] **`deploy/README-v2.md` re-path (plan review):** 14 `internal/v2/...` occurrences (lines ~249,392,457,543,587,613,616,674,757,785,1136,1162,1221,1282) → `internal/...`, plus one short new paragraph: v1 now lives in `salehtl/ledger`; the old "check both apps afterwards" step becomes "check v1's service too if you touched shared infrastructure — its repo is separate now". Task 12 follows this file verbatim, so it must be true BEFORE the deploy.
- [ ] **`internal/verify` exact spelling (plan review):** the walk root becomes `filepath.Join(root)` over `internal/` from `inboundHandlers("..")` (test-only caller, verified); add one sentence to `inbound.go`'s comment: the scan now covers all of `internal/` including `v1ref/`, which is safe because no v1ref package implements `smtpd.Handler` — and if one ever did, flagging it would be correct.
- [ ] Verify: `go test -count=1 ./...` (full; corpus gates skip without env — that's expected here), plus `go test -tags phase2corpus -run TestRefuse ./cmd/gen-phase2-corpus/`.
- [ ] Commit: `refactor: re-depth path literals and regen commands for the flattened tree`

### Task 7: web/, client/, harness, gate script

- [ ] `web/vite.config.ts:175` outDir → `../internal/webui/dist`. `web/harness/v2stack.sh:56` boot path → `./internal/pgtest/cmd/boot`; `:93` dns-fixtures → `$REPO/internal/origin/testdata/dns.json`. `web/harness/v2settings.mjs:44` corpus .eml path — this runner is documented-broken; fix the path anyway (one line) so it fails for its known reason, not a wrong one.
- [ ] **client/ is in scope too (plan review — three functional literals, all inside the gate):** `client/src/diag/nul.test.ts:52` EXCLUDED entry `internal/v2/webui/dist/` → `internal/webui/dist/` (else the NUL scan sweeps the committed .woff2/.wasm bundle and fails hard) and drop the now-dead `:51` `internal/web/dist/` entry; `client/test/e2e/harness.ts:71` `repoPath("internal/v2/origin/testdata", ...)` → `internal/origin/testdata`; `client/test/e2e/harness.test.ts:345` likewise. Acceptance: `git grep -n 'internal/v2' -- client web` → zero functional hits (accept-list any prose).
- [ ] Also fix `web/src/styles/tokens.test.ts` (re-pointed in Task 0 to v2's dist): flatten depth → `../internal/webui/dist/assets`.
- [ ] `scripts/v2-check.sh` five points: (a) fence: replace the cmd/ledger comparison with product-graph ∩ v1ref: `go list -deps ./cmd/ledgerd | grep '^ledgerd/'` vs `go list ./internal/v1ref/...`, same comm -12 file-backed spelling (pipefail-trap comment stays); update the sanctioned-imports comment to name the three v1ref test imports; (b) `'^ledger/'` greps → `'^ledgerd/'`; (c) `./internal/v2/...` → `./internal/...` — NOTE this now sweeps v1ref too (deliberate: the frozen packages' self-tests run in the gate; state it in a comment); (d) importer step → `go test -count=1 ./internal/v1ref/importer` with its rationale comment updated; (e) header regen-command comments re-pathed.
- [ ] MANDATORY fence mutation proof: add `import _ "ledgerd/internal/v1ref/parse"` to a non-test file in cmd/ledgerd's graph → gate FAILS with the fence message → revert → green. Record both outputs.
- [ ] Verify: `cd web && bun install && LEDGER_WEB_OUT_DIR="$(mktemp -d)" bun run build` (proves alias + outDir resolution WITHOUT rewriting the committed dist — plan review: a bare build here would clobber the artifact Task 8 asserts untouched, exactly as v2-check.sh:186 avoids), `bun run test`; `cd client && bun install && bun run typecheck && bun test`; `bash scripts/v2-check.sh` → OK.
- [ ] Commit: `chore(gate): v2-check for the single-app repo — v1ref fence with mutation proof`

### Task 8: protected-strings and layout-integrity proof

- [ ] **Census-diff proof, not an allow-list (plan review — the ten named strings are documentation; ~20 more `ledger*` literals exist: storage identities like IndexedDB `"ledger-v2"`, key vault `"ledger-v2-keys"`, localStorage prefixes, the PWA manifest name, `revocationDomain`, `COMPARISON_DOMAIN`, `WRAP_DOMAIN`, admin token key, push tag, pg role prefix):** BEFORE Task 5, capture `git grep -haoE '"ledger[^"]*"|\x60ledger[^\x60]*\x60' -- ':!internal/v2/webui/dist' ':!*.lock' | sort | uniq -c > /tmp/ledger-literals-before.txt`; after Task 7, capture the same from the new tree and diff. The ONLY permitted delta is the `"ledger/internal/..."` import-path family (and the origin/config_test needle). Any other changed literal is a stop-the-line defect.
- [ ] Diff `conformance/` (minus the regenerated files from Task 6's generated-pair step) against the old repo → empty; diff `internal/webui/dist` files against old `internal/v2/webui/dist` → identical (the committed bundle moved untouched — Task 7's build went to a temp dir).
- [ ] Prove no stray old-module references: `git grep -n '"ledger/internal'` → zero; `git grep -n 'internal/v2'` → only historical docs/ mentions (enumerate and accept-list them in the report).
- [ ] Commit (if fixes needed): `fix: layout-integrity findings`

### Task 9: corpus-gate bite proof (the gates this whole vendoring exists for)

- [ ] Make a fresh snapshot per the sanctioned recipe (root, read-only source): `sudo sqlite3 "file:/var/lib/ledger/ledger.db?mode=ro" ".backup '/scratch/corpus-migration.db'"` + chown. (Read-only against v1's DB; not a production mutation.)
- [ ] `LEDGER_CORPUS_DB=/scratch/corpus-migration.db go test -count=1 ./internal/norm/ ./internal/tmpl/seed/ -run 'Corpus|Seed'` → PASS (the equivalence gates actually ran — confirm via -v that they did not skip).
- [ ] Mutation proofs: (1) flip one byte in a vendored `dib.go` Arabic anchor → `TestSeedAnchorsAreByteIdenticalToV1` FAILS → revert; (2) alter one normalization in `client/src/norm` or `internal/norm`... (pick the cheaper: perturb `internal/norm`'s stripHTML blockTags) → corpus equivalence FAILS → revert. Record all outputs.
- [ ] Delete the snapshot or leave at /scratch per convention (note in report).

### Task 9b: comment/README debt in the new repo (live files only)

- [ ] Fix live files that reference the tree that left (plan review's list): `web/harness/README.md` (:6,:7,:11,:12,:345 frontend/harness cross-refs → point at the v1 repo by name), `web/harness/v2nav.mjs:8`, `v2settings.mjs:10,28,86,118`, `v2stack.sh:4`, `client/src/invariants/surface.ts:25,563` (frontend/src cites → "v1's frontend, now in salehtl/ledger"), `client/scripts/crossexec.ts:17` + `crossexec-tmpl.ts:17` + `client/src/tmpl/dialect.test.ts:224` regen commands (`./internal/v2/` → `./internal/`); `web/src/components/transactions/merchantRename.ts:1-8` (header names the wrong tree `frontend/src/...` and cites v1's categories.go/ruleMatches — past-tense with v1-repo pointer). POLICY stated in the commit: `docs/superpowers/{plans,sdd}/**` are frozen historical records and are NOT rewritten; `MAC-TESTING-HANDOFF.md`'s hardcoded old clone URL stays (it is a superseded historical doc).
- [ ] Commit: `docs: live files stop pointing at the tree that left`

## Phase C — New origin (Task 10) and full verification (Task 11)

### Task 10: create and push salehtl/ledgerd

- [ ] `gh repo create salehtl/ledgerd --private --description "..."` (account verified ACTIVE with repo scope). `git remote add origin git@github.com:salehtl/ledgerd.git`.
- [ ] Pre-push NEVER-PUSH sweep (Global Constraints command) → clean. Push: `git push -u origin main && git push origin app-expo-final`.

### Task 11: full battery in the new repo

- [ ] `go test -count=1 ./...` (zero FAIL), `go test -a ./internal/verify/` (the self-audit against the new layout — memory: stale test binaries lie), client typecheck+test, web test+build (dist unchanged or committed), `bash scripts/v2-check.sh` → OK. Scratch harness smoke: `web/harness/v2stack.sh up` → v2nav ceremony + one sweep runner (`v2shoot --fast`) → down. Counts compared against the monorepo baseline (same suites, same numbers modulo none).

## Phase D — First deploy from the new checkout (Task 12)

- [ ] Standard runbook, from `/root/Coding/ledgerd`: pg_dump backup → migrations check (expect none) → `CGO_ENABLED=0 go build -o ledgerd ./cmd/ledgerd` → `strings` marker proof (a hashed asset name from the committed dist) → `sudo install` → restart → `/proc/PID/exe` hash == installed hash (re-measure if raced) → healthz + app bundle check + v1 health untouched. This is the ONLY production-touching task.

## Phase E — Old repo becomes the v1 repo (Tasks 13-15)

### Task 13: prune v2 from old main

- [ ] In `/root/Coding/ledger`: `git rm -r cmd/ledgerd cmd/gen-phase2-corpus internal/v2 web client conformance spike/phase0/RESULTS.md scripts/v2-check.sh deploy/README-v2.md deploy/ledgerd.service config.v2.example.toml` + the v2-era docs list (complement of Task 2's keep-list, with ONE deliberate overlap — the cleanup+migration plan pair stays in BOTH repos as each one's history; the complement diff in the report excludes exactly that pair). Plan-review corrections baked in: **no `app` in the rm** (zero tracked files today — the command would error), **never `spike` wholesale** — only the explicit `spike/phase0/RESULTS.md`; `spike/phase2/` is the operator's real bank data and must never appear in ANY rm in either checkout. conformance/import moves out with the rest (its Go executor lives in the new repo now).
- [ ] Rewrite root docs v1-only: README (v1 app, plus a pointer: "ledger 2.0 lives at github.com/salehtl/ledgerd since 2026-08-11; tag ledger-v2-final is the split point"), CLAUDE.md (v1-only; gate = `go test ./... && cd frontend && bun run test`; remove the two-app table, v2 harness, v2 deploy; keep v1 principles/architecture verbatim), AGENTS.md, NOTICE (v1 half), .gitignore (drop v2 entries), verify skill (v1 body only).
- [ ] `internal/importer`: keep (it is LIVE v1 code — `ledger import`); its conformance_test.go now reads a vectors.json that left → move that one test file's vectors into `internal/importer/testdata/vectors.json` (frozen copy) and re-point the read, with a comment naming the CONTRACT FORK plainly (plan review): the cross-language Go↔TS import agreement is no longer checked anywhere — the new repo tests client/src/importer against the frozen v1ref executor, this repo tests its living importer against a frozen vector copy, and the two can drift. The v1 CLAUDE.md records the same. Verify `go test ./internal/importer/`.
- [ ] Verify: `go test -count=1 ./... && cd frontend && bun run test` → green; `go build -o /tmp/ledger-smoke ./cmd/ledger` → clean; rm.
- [ ] Commit: `chore!: this is the v1 repo now — ledger 2.0 moved to salehtl/ledgerd (split tag ledger-v2-final)`

### Task 14: push old repo + v1 service sanity

- [ ] Push main. Confirm `ledger.service` still active and healthy (it runs the installed binary; repo changes cannot touch it — this is a recorded observation, not an action).

### Task 15: Claude-side closure

- [ ] New repo already carries CLAUDE.md/AGENTS.md (Task 3). Seed `/root/.claude/projects/-root-Coding-ledgerd/memory/` (create dir on first session or write directly): re-seed the v2/both memories per the census list (dinosaur-is-deploy-target, deploy-verify-running-binary, committed-dist-goes-stale, v2 flakes, ceremony-runners-broken, parallel-agents, go-test-cache, NUL-trap, sunset-dont-delete, gh note, subagent-cwd-pinned — REWRITTEN: subagents pin to /root/Coding/ledger, so new-repo dispatches must mandate cd until the pinning follows).
- [ ] Old workspace memory updates: codebase-cleanup memory's "NO repo split, ever" → superseded 2026-08-11 with pointer; new memory `v2-moved-to-ledgerd-repo` in the OLD workspace so sessions landing in /root/Coding/ledger know v2 work belongs in /root/Coding/ledgerd.

## Review gates

- **Plan review** (before any execution): independent Opus agent verifies this plan against the inventory and the tree.
- **Post-Phase-B review:** Opus reviews the full new-repo diff-from-filter (rewrites, vendor commit, gate script) with deletion-safety + protected-strings + gate-integrity lenses.
- **Post-Phase-E review:** Opus reviews the old-repo prune commit (nothing v1 lost; docs true).
- **Final whole-migration review:** Fable, both repos, ledger'd deferred items triaged.

## Scope honesty (for the owner, from the plan review)

The new repo lands near **1,226 tracked files** vs the monorepo's 1,912 — a 36% context cut, not half; it stays the larger of the two repos (v1 lands near 800). The vendored `v1ref/store` alone is 63 files (a full SQLite schema v2 never opens; the gates use only `store.TransactionRow`). If context reduction later matters more than freeze simplicity, a follow-up can prune v1ref to the gate-reachable subset — deliberately NOT done now, because pruning risks the byte-freeze and buys no dependency savings.

## Rollback

Everything before Task 12 is side-effect-free outside `/root/Coding/ledgerd` (a directory that can be deleted) and two pushed artifacts (tag `ledger-v2-final` — harmless; repo `salehtl/ledgerd` — deletable). Task 12 rolls back by redeploying from the old checkout (unchanged until Phase E). Phase E rolls back by `git revert` of the prune commit; old origin retains full history forever.
