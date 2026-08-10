# Audit findings — companion evidence for 2026-08-10-codebase-cleanup.md (raw, 70 findings)
```

############################## dead Go code across both apps (v1 cmd/ledger + internal/**, v2 cmd/led

[1] Unused const heldExpectedSQL in v2 verify
    cat=dead-code risk=low effort=small
    paths: /root/Coding/ledger/internal/v2/verify/verify.go
    evidence: staticcheck: 'internal/v2/verify/verify.go:856:7: const heldExpectedSQL is unused (U1000)'. Repo-wide grep finds only the definition and its doc comment ('// heldExpectedSQL counts the distinct message identities the diagnostics ledger', verify.go:852). No caller in any .go file, tests included.
    action: Delete the heldExpectedSQL const together with its doc-comment block (verify.go:852-~865).

[2] blob.TagOf is fully dead — no caller anywhere, tests included
    cat=dead-code risk=low effort=small
    paths: /root/Coding/ledger/internal/v2/blob/encv2.go
    evidence: deadcode: 'internal/v2/blob/encv2.go:224:6: unreachable func: TagOf'. Clean repo-wide grep for 'TagOf' across *.go/*.ts/*.tsx/*.json (excluding node_modules) returns only the definition at encv2.go:223-224 (plus worktree copies). Sibling accessors EncOf/NonceOf are used by encv2_test.go:153/178; TagOf has zero test callers and no TS mirror named tagOf exists in client/ or conformance/.
    action: Delete TagOf. Conformance coupling note: the blob frame format is mirrored in client/src/crypto, but no tagOf accessor exists on the TS side and no conformance vector references it, so removal does not touch the byte-for-byte contract — re-confirm with a grep for 'tag' in conformance/blob before deleting.

[3] corpus.DB.Path is fully dead
    cat=dead-code risk=low effort=small
    paths: /root/Coding/ledger/internal/v2/corpus/corpus.go
    evidence: deadcode: 'internal/v2/corpus/corpus.go:114:14: unreachable func: DB.Path'. grep -rn '\.Path()' over internal/ and cmd/ (tests included) returns no callers. The sibling methods DB.Count and DB.Each ARE alive via the fixture tools (internal/v2/corpus/cmd/extract-fixtures/main.go:132,146 and cmd/arc-corpus-scan/main.go:52,69).
    action: Delete the Path method (corpus.go:113-115). Keep Count/Each/gunzip — they serve the corpus dev commands.

[4] v1 config keys ai.auto_accept_threshold and ai.auto_rule are loaded but never read
    cat=dead-code risk=low effort=small
    paths: /root/Coding/ledger/internal/config/config.go; /root/Coding/ledger/config.example.toml; /root/Coding/ledger/internal/config/config_test.go
    evidence: Fields defined at config.go:50-51 (AutoAcceptThreshold, AutoRule) and defaulted at :102. Repo-wide grep finds no reader outside internal/config — the live thresholds come from SQLite app settings instead (internal/store/settings.go:52,64,111: ai_auto_accept, ai_threshold columns; internal/server/settings.go:23). config.example.toml:31-32 still documents them as live ('auto_accept_threshold = 0.85 # >= this → confirmed + rule proposed'), a copy-promise the code does not honour. The only tests assert the unread defaults (config_test.go:195-205), i.e. tests of dead configuration.
    action: Remove the two struct fields, their defaults() entries, the two config.example.toml lines, and the default-assertion tests — or, per the owner's sunset-don't-delete preference, keep the TOML keys but mark them '# no longer read; managed in-app under Settings' in the example file.

[5] budget.Compute is a test-only wrapper; production uses ComputeRange
    cat=dead-code risk=low effort=small
    paths: /root/Coding/ledger/internal/budget/budget.go; /root/Coding/ledger/internal/budget/budget_test.go
    evidence: deadcode: 'internal/budget/budget.go:39:6: unreachable func: Compute'. Production callers use ComputeRange (internal/server/budget.go:139) and ComputeEnvelopes (internal/server/envelopes.go:74); Compute's only callers are budget_test.go:18,72,81. Both Compute and ComputeRange are one-line delegates to the shared computeJars (budget.go:42,53), so the tests do exercise real logic and lose nothing by retargeting.
    action: Retarget the three budget_test.go callsites to ComputeRange (passing now.Format("2006-01") and MonthProgress(now) explicitly) and delete Compute. This is the only deadcode hit in all of v1.

[6] spike/phase0/blobgen is a concluded Phase-0 spike module referenced by nothing
    cat=unnecessary-file risk=low effort=small
    paths: /root/Coding/ledger/spike/phase0/blobgen/go.mod; /root/Coding/ledger/spike/phase0/blobgen/main.go; /root/Coding/ledger/spike/phase0/blobgen/main_test.go
    evidence: Nested module (spike/phase0/blobgen/go.mod) — absent from the main module's go list ./... (47 packages, none under spike/), so no build, test, or gate ever compiles it. Its header says: 'Package main: Phase-0 spike. ... Throwaway quality.' The only references are in docs/superpowers/plans/2026-07-31-v2-phase0-kill-risks.md, which states 'Spike code is committed but quarantined under spike/phase0/'. Phase 0's decisions are recorded and Phases 1-3 have shipped since.
    action: Owner decision: delete the directory or move it to an archive branch now that Phase 0 is concluded (the quarantine was deliberate, so this is a confirm-then-remove, not an unconditional delete). No build artifact depends on it.

[7] v2 VAPID key minting is unwired; its own error message delegates to the v1 binary
    cat=structure risk=low effort=small
    paths: /root/Coding/ledger/internal/v2/pushv2/webpush.go; /root/Coding/ledger/internal/v2/config/config.go; /root/Coding/ledger/cmd/ledgerd/main.go
    evidence: deadcode: 'internal/v2/pushv2/webpush.go:288:6: unreachable func: GenerateVAPIDKeys' — its only caller is webpush_test.go:264. cmd/ledgerd has no vapid-keys mode (modes: serve, relay, verify, seed-dictionary, seed-templates, purge-user, record-consent, parse-rate, mint-invite). The v2 config validator instead instructs: 'mint them ONCE with `ledger vapid-keys`' (internal/v2/config/config.go:~868) — the v1 binary — coupling v2 web-push setup to v1's continued existence.
    action: Either add a vapid-keys mode to cmd/ledgerd that calls the existing pushv2.GenerateVAPIDKeys, or accept the v1 dependency and leave the function as the test-support helper it currently is. Do not delete it outright: webpush_test.go uses it to mint keys for real send-path tests.

[8] Classification record: ~40 deadcode-flagged v2 symbols are staged or conformance-coupled — do not prune
    cat=other risk=low effort=small
    paths: /root/Coding/ledger/internal/v2/auth/session.go; /root/Coding/ledger/internal/v2/auth/writer.go; /root/Coding/ledger/internal/v2/blob/encv2.go; /root/Coding/ledger/internal/v2/oplog/op.go; /root/Coding/ledger/internal/v2/tmpl/dialect.go; /root/Coding/ledger/internal/v2/tmpl/exec.go; /root/Coding/ledger/internal/v2/dict/dict.go; /root/Coding/ledger/internal/v2/pg/pg.go
    evidence: Every remaining deadcode hit has real test or tooling callers: the auth revocation cluster (Sessions.Revoke, RevokeAllForUser, Writers.Revoke, RevocationMessage, forgetPushTokens, EnsureIngestWriter, UpsertUser) is exercised by api/keyhistory_test.go:56-57, sync_test.go:505,533, session_test.go:217, quarantine_test.go:37 — staged ahead of revocation endpoints (no production caller exists yet; prod user creation goes through UpsertUserInvited, api/sync.go:268). The blob EncSealer family feeds encv2_test.go and the build-tagged cmd/gen-phase2-corpus vector generator (//go:build phase2corpus) — Phase-3 sealing machinery. The oplog checkpoint codec (KindOf, Encode/DecodeCheckpointPayload, compar
    action: No deletion. Recorded so later cleanup passes do not misread the raw deadcode output as a kill list; any pruning of internal/v2/norm, internal/v2/tmpl, or internal/v2/oplog exports must change the TypeScript mirror in client/src and the conformance/ suites in the same commit (the Go/TS byte-for-byte contract).

############################## Go simplification and duplication (cmd/, internal/, internal/v2/) — re

[9] 4 files are not gofmt-clean
    cat=tooling risk=low effort=small
    paths: internal/ingest/ingest.go; internal/server/rates_test.go; internal/v2/ingest/reprocess_test.go; internal/v2/oplog/conformance_test.go
    evidence: `gofmt -l ./cmd ./internal ./conformance` lists exactly these 4 files. Diffs are pure formatting: struct-field alignment in internal/ingest/ingest.go (HealthSnapshot comments) and internal/server/rates_test.go / internal/v2/oplog/conformance_test.go (field alignment), and spacing around `+` string concatenation in internal/v2/ingest/reprocess_test.go:1767,1840.
    action: Run `gofmt -w` on the 4 files and commit. No semantic change; keeps future diffs from carrying alignment noise.

[10] v1 recur: rescuePass and matchPass are ~45-line near-clones
    cat=simplify risk=low effort=small
    paths: internal/recur/runner.go
    evidence: dupl (-t 100) flags internal/recur/runner.go:215-241 vs 266-292 as a clone group. Reading both functions (rescuePass at :187, matchPass at :249) confirms the fetch-loop-mark-advance body is byte-identical except for the matcher called (`MatchRescue(...)` vs `Match(...)`) and the counter name; only the from/to window computation at the top differs.
    action: Extract one unexported pass helper taking the window (from, to) and the matcher `func(Txn, []Schedule) (int64, bool)` as parameters; rescuePass and matchPass keep their own window math and docs and delegate the shared ~40-line body. runner_test.go's 10 tests cover the behavior.

[11] Hand-rolled max64 duplicates the Go 1.21+ builtin max
    cat=simplify risk=low effort=small
    paths: internal/v2/dict/dict.go
    evidence: internal/v2/dict/dict.go:1145 defines `func max64(a, b int64) int64` with exactly three call sites in the same file (:761, :781, :1137). go.mod declares `go 1.25.0`, so the builtin `max` (Go 1.21+) covers all three calls with identical semantics. staticcheck's S1* set does not flag this (it is a gopls-modernize-class fix), verified by hand.
    action: Replace the three `max64(x, y)` calls with the builtin `max(x, y)` and delete the helper.

[12] Identical begin/rollback pgx pair copied across four v2 packages
    cat=simplify risk=low effort=medium
    paths: internal/v2/quarantine/quarantine.go; internal/v2/auth/writer.go; internal/v2/addresses/addresses.go; internal/v2/tmpl/store.go; internal/v2/oplog/append.go
    evidence: Four packages carry the same two methods differing only in the error prefix: `begin` pinning `pgx.TxOptions{IsoLevel: pgx.ReadCommitted}` and `rollback` on `context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)` — quarantine.go:1208/1219, auth/writer.go:874/885, addresses.go:894/905, tmpl/store.go:552/563; oplog/append.go:279 inlines the same ReadCommitted BeginTx. Each copy's doc comment cross-references the others ("for the same reason auth.Writers and oplog.Appender do"), i.e. one rationale maintained in four places.
    action: Add two helpers to internal/v2/pg (e.g. `pg.BeginReadCommitted(ctx, pool)` and `pg.Rollback(ctx, tx)`), keep the per-package error prefix at the call site via fmt.Errorf wrapping, and move the isolation-level rationale comment to the one definition. Removes ~60 duplicated lines and pins the shared invariant in one place.

[13] cmd/ledgerd/main.go (1867 lines) carries five subcommand runners the directory convention puts in their own files
    cat=structure risk=low effort=medium
    paths: cmd/ledgerd/main.go; cmd/ledgerd/verify.go; cmd/ledgerd/seedtemplates.go; cmd/ledgerd/loadcorpus.go
    evidence: main.go is 1867 lines. The verify, seed-templates and load-corpus modes already live in sibling files (verify.go, seedtemplates.go, loadcorpus.go), but five other modes remain inline: runRelay (main.go:1104), runSeedDictionary (:1306), runPurgeUser (:1407, plus purgeDryRun :1480 and printPurgeReport :1642), runRecordConsent (:1535, plus showConsent :1600) and runMintInvite (:1808, plus showInvites :1837), alongside the adapter types (:1684-1807).
    action: Pure code motion within package main: move each remaining mode's runner and its private helpers into a per-mode file (relay.go, seeddictionary.go, purgeuser.go, consent.go, mintinvite.go), matching the existing convention. No signature or behavior changes; runServe and its wiring stay in main.go.

[14] Observation: deliberate, documented duplication between v1 and v2 (and within v2's key-check helpers) — keep as-is
    cat=structure risk=low effort=small
    paths: internal/server/spa.go; internal/v2/webui/spa.go; internal/parse/body.go; internal/v2/norm/norm.go; internal/v2/auth/writer.go; internal/v2/addresses/addresses.go; internal/v2/purge/purge.go
    evidence: internal/v2/webui/spa.go:13 says "Modeled on v1's internal/server/spa.go, with one deliberate addition" (the /api/ guard); internal/v2/norm/norm.go documents its blockTags as "exactly v1's" next to stripHTML (:350) mirroring internal/parse/body.go:85. Within v2, usableKey/verifiedByAny exist three times (auth/writer.go:836, addresses.go:847/:862, purge.go:1102/:1113) and the copies document themselves: "The three copies cannot drift into disagreement because the test is a fixed mathematical fact" (purge.go, above :1102).
    action: No action. Recorded per the audit brief: the two apps are intentionally separate and the v2-internal crypto-helper triplication is a documented decision; do not merge or extract.

[15] Native push-token API surface exists only for the abandoned Expo client, and is a file-level clone of the Web Push surface
    cat=dead-code risk=medium effort=medium
    paths: internal/v2/api/push.go; internal/v2/api/webpush.go; internal/v2/pushv2/push.go; app/src/push/service.ts
    evidence: The /api/v1/push/tokens routes (registered at internal/v2/api/api.go:777-780, implemented in api/push.go, 347 lines, backed by pushv2.Expo in internal/v2/pushv2/push.go, 349 lines) have exactly one client in the tree: app/src/push/service.ts:57,70 — and app/ is the abandoned Expo native client per CLAUDE.md; web/src has no reference to push/tokens. dupl also flags api/push.go:305-326 vs api/webpush.go:300-321 (handleDeletePushToken vs handleUnsubscribePush) as clones — the two files are parallel implementations of the same surface over push_tokens vs push_subscriptions.
    action: Owner decision, not an edit: confirm push_tokens is empty/unused in production, then sunset the native-token surface (routes in api.go:777-780, api/push.go, the pushv2.Expo notifier) behind a disabled flag per the repo's sunset-don't-delete rule. This is a public-API removal, so it needs the owner's call; reported here because it is the largest single duplication in the v2 API layer.

[16] Three challenge-mint handlers in v2 api are 13-line clones
    cat=simplify risk=low effort=small
    paths: internal/v2/api/account.go; internal/v2/api/addresses.go; internal/v2/api/sync.go
    evidence: dupl flags account.go:111-123 (handleAccountChallenge), addresses.go:107-119 (handleAddressChallenge) and sync.go:299-311 (handleChallenge) as one clone group: each checks a per-user limiter, calls its Issue/RotationChallenge/Challenge backend, logs, and writes `ChallengeResponse{Nonce: base64...}` — identical shape, differing only in the limiter field, backing call, and copy strings.
    action: Optional (lowest priority): extract a shared `(s *Server) mintChallenge(w, r, userID, limiter, issue func(context.Context, uuid.UUID) ([]byte, error), rateMsg, logWhat string)` helper; each handler keeps its doc comment and becomes a one-line delegation. Skip if the team prefers the current handler-per-route explicitness — the three copies are small and stable.

############################## v1 frontend (/root/Coding/ledger/frontend)

[17] Dead exports: four unused API client functions and one unused icon
    cat=dead-code risk=low effort=small
    paths: frontend/src/api/client.ts; frontend/src/components/ui/PixelIcon.tsx; frontend/src/components/ui/pixelIcons.ts; frontend/scripts/generate-pixel-icons.mjs
    evidence: grep -rnw across all of src (including tests) finds only the definitions: createAccount (client.ts:55), deleteAccount (client.ts:59), unlinkRefund (client.ts:75), bulkUnassignProject (client.ts:111) have zero call sites — hooks/useTxnActions.ts:60 re-implements unlink inline via postJSON('/api/transactions/:id/unlink-refund'). Loader2 (PixelIcon.tsx:92, export const Loader2 = makeIcon("Loader2")) is imported by nothing; its only other refs are the glyph data (pixelIcons.ts:35) and a PixelSpinner.tsx:27 doc comment explaining why it is NOT used as the spinner.
    action: Delete the four functions from api/client.ts. For Loader2, remove the export plus its glyph entry in pixelIcons.ts and its alias in scripts/generate-pixel-icons.mjs (keep the PixelSpinner comment — it documents the design decision); if the owner prefers keeping the glyph as a documented alternative, leave it and note it as deliberate.

[18] Orphaned FilterChips component + false claim about it in the component catalog
    cat=stale-doc risk=low effort=small
    paths: frontend/src/components/transactions/FilterChips.tsx; frontend/src/components/transactions/FilterChips.test.tsx; frontend/src/components/README.md; frontend/src/screens/projects/BulkBackfill.tsx
    evidence: The only import of FilterChips is its own test (FilterChips.test.tsx:3) — knip --production flags the file as unused. components/README.md:665 states 'FilterChips (the older sheet-per-dimension picker) is still used by the Insights SearchSheet', but SearchSheet.tsx:7 imports FilterBar, not FilterChips (git log -S shows commit de89217 made the switch). BulkBackfill.tsx:20 also cites FilterChips in a comment as a live convention example.
    action: Fix the README.md:665 sentence now (it is the 'UI sentence the code does not honour' class this repo tracks). Then, per the owner's sunset-don't-delete convention, either delete FilterChips.tsx + FilterChips.test.tsx or mark them superseded-by-FilterBar in the catalog; update the BulkBackfill.tsx:20 comment to point at a live example either way.

[19] Stale asset public/logo-square.svg referenced by nothing
    cat=unnecessary-file risk=low effort=small
    paths: frontend/public/logo-square.svg; internal/web/dist/logo-square.svg
    evidence: grep for 'logo-square' across index.html, vite.config.ts (PWA manifest lists only manifest-icon-192/512.jpg), src/, .storybook/, harness/, scripts/, and the Go side (internal/**/*.go) finds no reference; push-sw.js uses /manifest-icon-192.jpg for icon and badge. The only repo-wide hits are 2026-07-03 perf docs (docs/perf/2026-07-03-baseline.txt). Because it sits in public/ it is copied wholesale into every build, so a stale copy also sits in the committed internal/web/dist.
    action: Delete frontend/public/logo-square.svg, then rebuild the v1 frontend (cd frontend && bun run build) so the committed internal/web/dist drops its copy in the same commit.

[20] Unused devDependency @vitest/coverage-v8
    cat=tooling risk=low effort=small
    paths: frontend/package.json
    evidence: knip flags it (package.json:44), and grep for 'coverage' across vite.config.ts, package.json scripts, .storybook/, src/test/, harness/, and scripts/ finds no coverage configuration and no script passing --coverage — the only hits are prose in harness docs. Its two knip co-flags (pixelarticons, playwright) were verified as false positives, but this one holds.
    action: Remove @vitest/coverage-v8 from devDependencies (bun remove) unless the owner wants ad-hoc `vitest --coverage` runs to keep working offline; if kept, record that purpose in a comment or the harness README so future sweeps stop flagging it.

[21] Stray `export` keywords on ~15 symbols used only inside their own file
    cat=simplify risk=low effort=small
    paths: frontend/src/api/hooks.ts; frontend/src/api/types.ts; frontend/src/lib/fontScale.ts; frontend/src/lib/insights.ts; frontend/src/lib/swipe.ts; frontend/src/components/Toast.tsx; frontend/src/components/ui/PixelIcon.tsx; frontend/src/lib/analysis.ts; frontend/src/lib/reconcile.ts; frontend/src/lib/reports.ts
    evidence: knip default mode (tests count as entries) flags these, and grep -w confirms each is referenced only within its defining file: envelopesKey/accountBalancesKey/balanceHistoryKey (api/hooks.ts:56,266,267), isFontScale (fontScale.ts:12, used only at :21), CATEGORY_PALETTE (insights.ts:49, used only at :55), bucketKey + type BucketKey (swipe.ts:51-53, used only at :98), and in-file-only types AIUsageRow/FXRateDTO/ProjectCategorySpend (api/types.ts:21,45,78), ToastAction (Toast.tsx:7), PixelIconProps (PixelIcon.tsx:20), CategoryBreakdownRow (analysis.ts:20), UnparsedEmail (reconcile.ts:41), TxnSplitLine (reports.ts:35). Equivalent dither-kit hits (isDitherColor, dither-paint constants, useRevisio
    action: Drop the `export` keyword on the in-file-only symbols (cosmetic; makes future unused-export sweeps signal-clean). The api/types.ts DTO interfaces are the weakest candidates — exporting all DTO shapes may be deliberate convention, so treat those as optional and skip them if the owner prefers.

############################## v2 frontend (/root/Coding/ledger/web) and shared TypeScript library (/

[22] web/harness carries 9 v1-only scripts, 8 byte-identical to frontend/harness and 1 stale dead fork
    cat=unnecessary-file risk=low effort=small
    paths: /root/Coding/ledger/web/harness/stack.sh; /root/Coding/ledger/web/harness/nav.mjs; /root/Coding/ledger/web/harness/shoot.mjs; /root/Coding/ledger/web/harness/probe.mjs; /root/Coding/ledger/web/harness/seed.mjs; /root/Coding/ledger/web/harness/ios.mjs; /root/Coding/ledger/web/harness/gestures.mjs; /root/Coding/ledger/web/harness/sheets.mjs; /root/Coding/ledger/web/harness/hero.mjs
    evidence: The docs' claim that these still drive v1 is verified. web/harness/stack.sh:65 builds the v1 binary ('go build -o "$BIN" ./cmd/ledger'), :87 seeds via '( cd "$REPO/frontend" && node harness/seed.mjs "$API" )' — i.e. it executes frontend's seed, never web's own copy — and :92 starts vite from "$REPO/frontend" on v1's harness ports 8099/5199. nav.mjs taps 'nav button[aria-label="Plan"]' and Settings rows "AI & API usage"/"Email ingest"/"Rules" — v2 has no Plan tab (web/src/app/nav.ts: TabId = "home"|"transactions"|"insights"|"review") and no such rows. cmp shows nav/shoot/probe/audit/ios/gestures/sheets/hero/stack byte-identical to frontend/harness; seed.mjs DIFFERS — it lacks frontend/harness
    action: Delete these 9 files from web/harness (the canonical, newer copies live in frontend/harness and are runnable from there; web/harness/README.md itself already tells the reader to 'cd frontend'). Keep audit.mjs and webauthn.mjs, which the v2 runners import.

[23] Untracked addpasskey-repro.mjs waits on a testid that no longer exists; the bug it probed now has product handling
    cat=unnecessary-file risk=low effort=small
    paths: /root/Coding/ledger/web/harness/addpasskey-repro.mjs
    evidence: Untracked (git status '?? web/harness/addpasskey-repro.mjs'). Line 82 waits for getByTestId("welcome-passkey-note"); grep of web/src finds no such testid — the current one is "add-passkey-note" (web/src/screens/onboarding/Welcome.tsx, created-step note paragraph), so the script's on-screen-copy assertion always .catch()es to null. The path it reproduced (second passkey on an authenticator already holding one, via excludeCredentials) is now handled in product code: Welcome.tsx addAnother() renders failureCopy(kind) per PasskeyError kind, and V2Settings.tsx:273 addPasskeyNow() does the same in Settings.
    action: Delete the untracked file, or — if the raw-DOMException view is still wanted — fix the testid to add-passkey-note and commit it beside the other v2 runners with a header saying what it asserts.

[24] web/harness/README.md leads with the v1 workflow ('cd frontend') and buries the only real v2 runner at line 282
    cat=stale-doc risk=low effort=small
    paths: /root/Coding/ledger/web/harness/README.md
    evidence: Quick start (lines 15-18) reads: '```bash\ncd frontend\nharness/stack.sh up          # scratch DB + seed data + Go API + vite (HMR)\nnode harness/shoot.mjs```' — in web/'s own harness README the first instruction is to leave web/. The honest correction only appears at line 282: '## `v2settings.mjs` — the only runner that actually loads `web/src`' / line 285-287: 'was forked from `frontend/` with the tree and still drives **v1** … Point them at a v2 change and they [go green against code that was never loaded]'.
    action: Rewrite the README to lead with the v2 stack (v2stack.sh up → v2settings.mjs / recovery.mjs / vault.mjs / operator.mjs) and drop the duplicated v1 sections, pointing v1 work at frontend/harness/README.md instead. Do this in the same commit as deleting the duplicate scripts.

[25] ~65 unused exports + 24 unused exported types in web/src, including uncalled v1 REST functions
    cat=dead-code risk=low effort=medium
    paths: /root/Coding/ledger/web/src/api/client.ts; /root/Coding/ledger/web/src/api/hooks.ts; /root/Coding/ledger/web/src/v2/sources/review.ts; /root/Coding/ledger/web/src/v2/onboarding.ts; /root/Coding/ledger/web/src/v2/keys.ts
    evidence: knip (run from web/, hand-verified): 65 unused exports + 24 unused types even counting test files as entries. Grep-confirmed samples with zero callers anywhere in web/: api/client.ts createAccount (:55), deleteAccount (:59), bulkUnassignProject (:111); api/hooks.ts useSaveSplits (:407), useRules (:431) — v1 REST remnants. Most of the rest are internally-used symbols whose export keyword is superfluous (e.g. keys.ts KEY_VAULT_DB/:222 and indexedDbKeyVault/:236 are consumed only inside keys.ts). Verified exclusions the raw knip list must not touch: openV2 (BootGate.tsx:109) is imported dynamically by harness/recovery.mjs:124,371, and keys.ts's browserKeyVault/installAccountKeys/openIngestPriva
    action: Delete the uncalled v1 API functions; demote internally-used exports to module-private. Before each deletion, grep web/harness for a dynamic '/src/...' import of the symbol (recovery.mjs, vault.mjs, addpasskey-repro.mjs use them), since knip's graph excludes the harness. Reproduce with: cd web && bunx knip.

[26] ~48 client/src exports are unused by every consumer (web, conformance runners, CLI, tests) — unexport candidates
    cat=dead-code risk=low effort=medium
    paths: /root/Coding/ledger/client/src/crypto/phrase.ts; /root/Coding/ledger/client/src/tmpl/exec.ts; /root/Coding/ledger/client/src/norm/mime.ts; /root/Coding/ledger/client/src/replay/snapshot.ts; /root/Coding/ledger/client/test/e2e/smtp.ts
    evidence: knip in client/ flagged 69 exports + 23 types. Consumers checked before believing it: (1) web/src via the @ledger/client→../client/src alias (web/vite.config.ts:82) — this rescued 17 symbols knip called unused (ApiError, PROJECTION_SCHEMA, TXN_COLUMNS, decodeTxnRow, emptyState, fingerprint, INGEST_WRITER_ID, SnapshotBindingError, SnapshotDecodeError, SECRET_SESSION, SECRET_WRITER, produced, AuditAbandoned, …); (2) client/scripts/crossexec.ts and crossexec-tmpl.ts, which knip wrongly lists as unused files — they are executed by the Go conformance tests internal/v2/tmpl/crossexec_test.go and internal/v2/norm/crossexec_test.go, and rescue UnsupportedCharsetError, compileDefinition et al; (3) co
    action: Remove the export keyword (and the phrase.ts re-export of WORDLIST/WORD_PREFIX_LENGTH) from the ~48 survivors; delete nothing in norm/tmpl bodies — unexporting changes no executor output, so the byte-for-byte Go/TS conformance contract is untouched. Re-run scripts/v2-check.sh afterwards since it drives the crossexec runners.

[27] @testing-library/user-event is a phantom devDependency of web/ — imported by ~20 test files, declared nowhere
    cat=tooling risk=low effort=small
    paths: /root/Coding/ledger/web/package.json; /root/Coding/ledger/web/bun.lock
    evidence: knip lists '@testing-library/user-event' as an unlisted dependency at ~20 sites (e.g. src/components/BankPicker.test.tsx:3, src/screens/settings/V2Settings.test.tsx:11, src/v2/BootGate.test.tsx:3). web/package.json declares @testing-library/jest-dom and @testing-library/react but not user-event. It resolves today only because storybook@9.1.20 lists it as a direct dependency (web/bun.lock:1227), so bun hoists it into web/node_modules — removing or major-bumping storybook would break every one of those suites.
    action: Add "@testing-library/user-event": "^14.6.1" to web/package.json devDependencies (then bun install to refresh the lockfile).

[28] web/package.json declares fflate and @noble/hashes that web/src never imports; @noble/curves is test-only but sits in dependencies
    cat=tooling risk=medium effort=small
    paths: /root/Coding/ledger/web/package.json
    evidence: grep of web/src finds zero imports of fflate or @noble/hashes (knip agrees: 'Unused dependencies: @noble/hashes package.json:19, fflate package.json:28'). The client sources bundled via the @ledger/client alias do use them (client/src/platform.web.ts, crypto/hkdf.ts), but module resolution for those files walks up from /root/Coding/ledger/client/src — client/node_modules then the repo root — and never passes through web/node_modules, and client/package.json declares its own copies. @noble/curves is imported only by two test files (src/v2/keys.test.ts:18, src/screens/settings/RecoverWritePanel.test.tsx:13) yet lives in dependencies.
    action: Drop fflate and @noble/hashes from web/package.json and move @noble/curves to devDependencies; then bun install in web/ AND client/ and run cd web && bun run build to prove the aliased client modules still resolve (the build requires client/node_modules to be present, which scripts/v2-check.sh already enforces).

[29] The unrouted v1 Settings cluster in web/src (~part of a 10.6k-LOC unrouted tree) is superseded by V2Settings and kept alive only by its tests
    cat=structure risk=medium effort=medium
    paths: /root/Coding/ledger/web/src/screens/Settings.tsx; /root/Coding/ledger/web/src/screens/settings/SettingsHub.tsx; /root/Coding/ledger/web/src/screens/settings/AiUsagePage.tsx; /root/Coding/ledger/web/src/screens/settings/IngestHealthPage.tsx; /root/Coding/ledger/web/src/screens/RulesManager.tsx; /root/Coding/ledger/web/src/screens/CategoryManager.tsx; /root/Coding/ledger/web/src/main.tsx; /root/Codi
    evidence: The broad unrouted tree (plan/, accounts/, projects/, recurring/, reports/) is DOCUMENTED-intentional — web/src/app/nav.ts: 'Plan left the bar, and the screens behind it are **unrouted, not deleted** … The files stay because they come back the moment their data grows a projection' — so it must not be pruned. But inside it, screens/Settings.tsx has no production importer at all (grep: only its 5 test files import it; AppShell.tsx:64-65 mounts SettingsPage + V2Settings instead), and it is the sole non-test importer of SettingsHub, RulesManager, CategoryManager, AccountsPage, AiUsagePage, BudgetPage, IngestHealthPage, NotificationsPage, TextSizePage, CategorizationPage, SwipePage, CurrenciesPag
    action: Owner decision, not unilateral deletion (the repo convention is sunset-don't-delete): split the Settings cluster into pages that could return v2-side and v1-only pages that cannot (AI usage, IMAP ingest health), sunset the latter with their test suites to stop paying gate time for unshippable screens, and fix the stale main.tsx comment; revisit the three @tanstack packages when that decision lands.

[30] client/README.md still presents the abandoned app/ (Expo) as Phase 2's consumer of the library
    cat=stale-doc risk=low effort=small
    paths: /root/Coding/ledger/client/README.md
    evidence: Line 18: '| `wire/` (op, blob, chain), `replay/` (the fold and FX), `invariants/` (the seventeen), `norm/`, `tmpl/` | **Reused as-is.** `app/` imports them. |'; line 30: 'A second implementation in `app/` re-opens every one of those.'; line 285: '`bunDriver` here, `expoDriver` in `app/`'. Per CLAUDE.md, app/ is the abandoned Expo native client and the shipped consumer is web/ (via the @ledger/client alias in web/vite.config.ts) — which the README never mentions.
    action: Update the Phase-2 table and driver notes to name web/ as the consumer (webDriver/sql.js in web/src/v2/db/driver.ts) and mark app/ as abandoned, keeping the protocol-ordering warning intact.

[31] web/scripts/generate-pixel-icons.mjs header still claims to be frontend's script
    cat=stale-doc risk=low effort=small
    paths: /root/Coding/ledger/web/scripts/generate-pixel-icons.mjs
    evidence: Line 2: '// frontend/scripts/generate-pixel-icons.mjs'; line 5: 'the `pixelarticons` devDependency (frontend/node_modules/pixelarticons/svg)'; line 10: 'cd frontend && bun run generate:icons'. The code itself is correct for web/ (paths are built from __dirname, lines 25-28), so only the instructions send the operator to the wrong package; the generated-file footer at line 94 also stamps 'frontend/node_modules/...' into web/src/components/ui/pixelIcons.ts.
    action: Fix the three header comments and the line-94 provenance string to say web/ (cd web && bun run generate:icons); regenerate pixelIcons.ts once so the stamped comment matches.

############################## Documentation audit — every doc in /root/Coding/ledger verified agains

[32] Root README.md predates v2 entirely and misdescribes today's v1
    cat=stale-doc risk=low effort=medium
    paths: /root/Coding/ledger/README.md
    evidence: Dated Jun 20. Line 3: 'A private, self-hosted, real-time budgeting PWA for a single user' — no mention anywhere of ledger 2.0, cmd/ledgerd, web/ or app.sirdab.ae, though main IS ledger 2.0 since 2026-08-09 (CLAUDE.md). Line 184: 'React 18 + TypeScript + Vite, … recharts' — frontend/package.json has "react": "^19" and zero recharts hits (charts are vendored dither-kit). CLI table omits `ledger compact` (cmd/ledger/main.go:79 `case "compact":`). The HTTP API table lists ~25 endpoints; internal/server defines 89 distinct routes (accounts, envelopes, targets, scheduled, reports/networth, rates, ai/usage all absent). Line 202 calls budgeting-app-build-plan.md 'the authoritative spec' with no v1 q
    action: Rewrite as the two-app README: open with the v2/v1 table from CLAUDE.md, keep a trimmed v1 section (fix React 19, dither-kit/motion, add `compact`, replace the endpoint table with a pointer to internal/server), and link deploy/README-v2.md. Label budgeting-app-build-plan.md as the historical v1 spec.

[33] deploy/README-v2.md contradicts itself and the code in six places since the 2026-08-09 deploy
    cat=stale-doc risk=low effort=medium
    paths: /root/Coding/ledger/deploy/README-v2.md
    evidence: (1) §1 'Nine modes' — modeOrder (internal/v2/config/config.go:308) has ten; `load-corpus` is dispatched (cmd/ledgerd/main.go:67) but absent from the list that claims it 'cannot silently drift'. (2) §4 'Numbering runs 00001–00003, 00005–00014, 00016–00021' — migrations now run to 00029. (3) §7 'deploy/ledgerd.service — not written yet' — the unit exists in deploy/ with full sandboxing. (4) §6 'v2 has no production database yet' and §8 'D5 … Cluster is down' / 'D4 … not done' contradict §0's own verified-2026-08-09 table (PG16 up, public :443 live). (5) §8 D6 'the consent document, which does not exist and no task writes it' — docs/alpha-consent.md v1.0 is dated 2026-08-07. (6) §9 DIB section 
    action: Fix in place: 'Ten modes' + load-corpus; migration range → 'through 00029 (00004/00015 vacant)'; §7 row → points at the existing unit; strike §6's 'no production database' intro and mark §8 D4/D5 done, D6 → link docs/alpha-consent.md; rewrite §9's DIB paragraph around decodeWitnessed (card mail auto-trusts when the Arabic literal survives; account/transfer still confirm); delete the stale config-example callout; add the three RP_* vars to §3.

[34] CLAUDE.md mode list, package lists and v2-harness claim have drifted from the code
    cat=stale-doc risk=low effort=small
    paths: /root/Coding/ledger/CLAUDE.md
    evidence: (1) 'Modes: serve, relay, verify, seed-dictionary, seed-templates, purge-user, record-consent, parse-rate, mint-invite' — cmd/ledgerd/main.go:67 also dispatches `load-corpus`. (2) The internal/v2 package list omits six real packages: addresses, authtest, blob, corpus, diag, samples (all contain .go files). (3) v1 'CLI subcommands' lists import/vapid-keys/serve but not `compact` (cmd/ledger/main.go:79). (4) v1 Architecture omits `internal/recur` (recurring-bill detection: detect.go/match.go/runner.go/sweep.go). (5) 'web/harness/v2settings.mjs is the one runner that reaches the v2 product … Other v2 screens rest on vitest alone' — web/harness/README.md also documents recovery.mjs, vault.mjs an
    action: Five one-line edits: add load-corpus to the mode list; add the six packages; add `ledger compact`; add a `recur` bullet to the v1 architecture; change the harness sentence to name v2settings/recovery/vault/operator as the v2 runners while shoot/probe/nav/stack.sh still drive v1.

[35] AGENTS.md repeats CLAUDE.md's package-list and single-v2-runner drift
    cat=stale-doc risk=low effort=small
    paths: /root/Coding/ledger/AGENTS.md
    evidence: Lines 37-41 list internal/v2 packages omitting addresses, authtest, blob, corpus, diag, samples. Line 109: '`web/harness/v2settings.mjs` is the one runner that reaches the v2 product' — recovery.mjs/vault.mjs/operator.mjs also drive the v2 tree per web/harness/README.md lines 320-386.
    action: Mirror the two CLAUDE.md fixes: complete the package list and pluralize the v2-runner sentence.

[36] docs/alpha-consent.md promises in-app export and account deletion that the v2 PWA does not have
    cat=stale-doc risk=medium effort=small
    paths: /root/Coding/ledger/docs/alpha-consent.md; /root/Coding/ledger/web/src/screens/settings/V2Settings.tsx
    evidence: Consent doc: 'You can export everything from inside the app at any time' and 'You can delete your account from inside the app at any time.' Grep of web/src/screens/settings finds no export flow and no delete-account flow (V2Settings.tsx's only destructive action is sign-out, line 851: 'Nothing recorded on this device is deleted'); deploy/README-v2.md §1 itself states there is 'no in-app deletion UX'. DELETE /api/v1/account exists server-side but nothing in the PWA calls it from a user-facing screen. This is a signable commitment document, so it is the 'UI sentence the code does not honour' class in its most consequential form.
    action: Before any alpha signs: either amend the two sentences to describe what exists today (deletion on request to the operator, export not yet built) or treat the missing flows as launch blockers. Flag to the owner rather than silently editing a consent text.

[37] NOTICE credits two third-party assets that are no longer (or were never) shipped
    cat=stale-doc risk=low effort=small
    paths: /root/Coding/ledger/NOTICE
    evidence: NOTICE credits Fugue Icons ('attribution is shown in Settings > About') and XP.css. Grep for xp.css/Fugue/Kamiyamane/'CC BY' across frontend/src, web/src and app/src: zero hits; frontend/public/icons/ does not exist; no About/attribution section in any Settings screen. docs/superpowers/plans/archive/README.md records xp.css dropped in the 2026-06-15 spending-first overhaul, and docs/superpowers/notes/m7-verify.md records the Fugue pack download 404'd and placeholders shipped instead.
    action: Rewrite NOTICE to credit what the products actually bundle (e.g. the vendored dither-kit registry code, any bundled fonts) or delete it if nothing bundled requires attribution. Its current content is entirely false.

[38] docs/superpowers/NEEDS-SALEH.md presents the abandoned Expo track as live blockers
    cat=stale-doc risk=low effort=small
    paths: /root/Coding/ledger/docs/superpowers/NEEDS-SALEH.md
    evidence: Header: 'Blocked on you — v2 beta. Updated 2026-08-01.' §§1/1b/2 and parts of 5/8 are Apple Developer Program, ae.sirdab.ledger App ID, Sign in with Apple, TestFlight, EAS Build and the floor-device gate — all for the Expo client that specs/2026-08-07-v2-pwa-direction.md abandoned ('app/ … is not carried forward here'). Passkeys replaced the IdPs (config.v2.example.toml lines 122-127). deploy/README-v2.md still cites items 0 and 4 as live references.
    action: Add a dated banner at the top: sections on the native track are superseded by specs/2026-08-07-v2-pwa-direction.md; still-live items are 4 (relay), 5b (HMAC key window), 6 (Phase 3 cutover promise), 7 (enc-slot gap). Do not rewrite the sections themselves — they are the reasoning of record.

[39] MAC-TESTING-HANDOFF.md instructs running the abandoned Expo app with no superseded marker
    cat=stale-doc risk=low effort=small
    paths: /root/Coding/ledger/docs/superpowers/MAC-TESTING-HANDOFF.md
    evidence: Written 2026-08-05: 'Get the v2 Expo app running on an iOS simulator … You are the first eyes on this app in a simulator.' Two days later specs/2026-08-07-v2-pwa-direction.md replaced the Expo client with the PWA; nothing in the handoff says so, and it sits at docs/superpowers/ top level beside NEEDS-SALEH.md as apparent current guidance.
    action: Add a one-line superseded header pointing at the PWA direction spec (or move the file under docs/superpowers/plans/archive/). Keep the content as a historical record.

[40] app/ contains no abandonment marker; its README speaks in active future tense
    cat=stale-doc risk=low effort=small
    paths: /root/Coding/ledger/app/src/components/README.md
    evidence: No app/README.md exists. app/src/components/README.md: 'every later Phase 2 task that adds a shared component adds its row below in the same commit' — but app/ is abandoned per CLAUDE.md ('do not extend it') and specs/2026-08-07-v2-pwa-direction.md ('not carried forward'; kept only for the fold harness and app/test/device vectors). An agent or contributor landing in app/ has no in-tree signal.
    action: Add a short ABANDONED banner at the top of app/src/components/README.md (or a two-line app/README.md): abandoned 2026-08-07 in favour of web/, kept for the app/test/device measurement rig, do not extend; link the PWA direction spec.

[41] client/README.md names the abandoned app/ as its Phase-2 consumer
    cat=stale-doc risk=low effort=small
    paths: /root/Coding/ledger/client/README.md
    evidence: The 'What Phase 2 reuses' table says wire/replay/invariants/norm/tmpl are 'Reused as-is. `app/` imports them', and the SecretStore row describes expo-secure-store Keychain storage. The live consumer is the PWA: web/src/v2/engine.ts:51 imports '@ledger/client/net/engine' and web/vite.config.ts carries the @ledger/client alias with platform.web rules.
    action: Update the consumer references from app/ to web/ (noting app/ is abandoned), and reword the expo-secure-store row to describe the web platform's key storage. A few sentences; the protocol content is accurate.

[42] web/harness/README.md's 'only runner that loads web/src' heading is contradicted by its own later sections, and the v1-fork warning sits below the quick start
    cat=stale-doc risk=low effort=small
    paths: /root/Coding/ledger/web/harness/README.md
    evidence: Line 282 heading: '`v2settings.mjs` — the only runner that actually loads `web/src`'. Lines 320-386 then document recovery.mjs, vault.mjs and operator.mjs, all driving web/src (recovery.mjs 'creates an account, walks the recovery step'; operator.mjs 'the whole path, in WebKit'). Meanwhile the Quick start at the top says `cd frontend; harness/stack.sh up` with no hint until line 284 that 'Everything above … still drives v1' (web/harness/stack.sh:87-92 cds into $REPO/frontend).
    action: Move the 'Read this before trusting any green run' fork warning to the top of the file, and retitle the section to name all four v2 runners (v2settings, recovery, vault, operator) instead of 'the only runner'.

[43] deploy/README.md (v1 runbook) keeps Milestone-1 leftovers
    cat=stale-doc risk=low effort=small
    paths: /root/Coding/ledger/deploy/README.md
    evidence: Title: 'Deploying ledger on dinosaur (Milestone 1)'. §4: 'Expect the XP-styled placeholder card showing health: ok (db: ok)' — xp.css was dropped 2026-06-15 (archive README) and no xp reference exists in frontend/src; the app now boots the full PWA. Section numbering is also scrambled: '## 6. Dedicated mailbox (Milestone 2 — ingest)' contains subsections '### 5a'–'### 5d', after a '## 5. Web Push'.
    action: Three small edits: drop '(Milestone 1)' from the title, replace the placeholder-card sentence with 'expect the app's Home screen', renumber 5a-5d to 6a-6d. Everything else verified accurate (unit name, paths, vapid flow, backup command).

[44] config.example.toml omits monitoring.senders and carries a never-implemented [budget] block
    cat=stale-doc risk=low effort=small
    paths: /root/Coding/ledger/config.example.toml; /root/Coding/ledger/internal/config/config.go
    evidence: internal/config/config.go:60 parses `senders` under [monitoring] ('from_addr substrings to drift-check; empty = all senders') — absent from the example. Lines 36-43's commented [budget] block ('consumed by later milestones … inert today') references keys the Config struct never gained; the budget plan lives in the DB and is edited from the PWA Settings screen (README.md lines 123-124 says exactly this).
    action: Add a commented `senders = []` line with the code's explanation; delete the [budget] block or annotate it 'never became config — the budget plan lives in the database'.

[45] The project 'verify' skill only knows the v1 app
    cat=stale-doc risk=low effort=small
    paths: /root/Coding/ledger/.claude/skills/verify/SKILL.md
    evidence: Description: 'Build, launch, and drive the ledger PWA end-to-end' — generic name, but the body is v1-only: `cd frontend && bun run build`, `go build -o ledger ./cmd/ledger`, scratch config on :18091, LEDGER_AI_API_KEY. An agent invoking it for a v2 change gets instructions that never load web/ or ledgerd.
    action: Scope the description to v1 explicitly and add a short v2 section (or a pointer): web/harness/v2stack.sh up + v2settings.mjs/recovery.mjs, per web/harness/README.md.

[46] Untracked draft: docs/superpowers/plans/2026-07-29-paper-home-page.md is an executed one-off session plan
    cat=unnecessary-file risk=low effort=small
    paths: /root/Coding/ledger/docs/superpowers/plans/2026-07-29-paper-home-page.md
    evidence: Untracked (git status '??'). It is a plan for exporting the v1 Home screen into Paper Desktop over an SSH-tunneled MCP bridge — 'a quick end-to-end test of the code→Paper bridge', 'no repo files change, no tests, no commits' — and hardcodes a dead session scratchpad path (/tmp/claude-0/-root-Coding-ledger/e51aa8d0-…/paper_mcp.py). Memory records the Paper bridge was used, and separately that untracked plan drafts collide when a branch commits the same path.
    action: Ask the owner to either commit it deliberately as a historical record or delete it; it should not stay untracked in plans/ where a merge can collide with it. (No repo change made — read-only audit.)

[47] docs/v3/ now reads as if it postdates ledger 2.0
    cat=stale-doc risk=low effort=small
    paths: /root/Coding/ledger/docs/v3/scope.md; /root/Coding/ledger/docs/v3/api-contract.md; /root/Coding/ledger/docs/v3/critic-charter.md; /root/Coding/ledger/docs/v3/ynab-teardown.md
    evidence: docs/v3/scope.md: 'v3 turns ledger from a 50/30/20 tracker into a full budgeting engine…' — this 'v3' is the v1 single-user app's envelope-engine rebuild, merged and deployed 2026-07-30, i.e. it PREDATES 'ledger 2.0'. Nothing in the directory says so, and with main now branded v2 the name ordering (v3 < v2.0) actively misleads a newcomer.
    action: Add one header line to docs/v3/scope.md (or a tiny docs/v3/README.md): 'Historical: the third revision of the v1 single-user app, shipped 2026-07-30. Unrelated to — and older than — ledger 2.0 (internal/v2).' Do not rename or rewrite the contents.

############################## Unnecessary files and repo hygiene, whole tree

[48] ~1.09 GB of merged, clean worktrees under .claude/worktrees
    cat=unnecessary-file risk=low effort=small
    paths: .claude/worktrees/v2; .claude/worktrees/budget-mode; .claude/worktrees/v2-pwa; .claude/worktrees/ui-bugs-from-video; .claude/worktrees/effective-dated-targets; .claude/worktrees/assignment-carry-forward; .claude/worktrees/dib-transfer-parser
    evidence: git worktree list shows 9 worktrees; git branch -a --merged main lists worktree-assignment-carry-forward, worktree-budget-mode, worktree-dib-transfer-parser, worktree-effective-dated-targets, worktree-ui-bugs-from-video, v2-pwa, v2-wip-2026-08-05 as merged; .claude/worktrees/v2 sits at 9fb968d, the exact same commit as main. Per-worktree `git status --porcelain | wc -l` is 0 for every one. du: v2=619M, budget-mode=326M, v2-pwa=69M, ui-bugs-from-video=29M, effective-dated-targets=21M, assignment-carry-forward=11M, dib-transfer-parser=11M. The only leftover-suffix hit in the whole tree (.claude/worktrees/v2/spike/phase0/replay-app/.expo/dev/logs/start.log) also lives here.
    action: git worktree remove each of the 7 merged worktrees, then delete their worktree-* local branches (all merged into main). Also delete stray branch v2-wip-partial (1 ahead, 179 behind) if the owner confirms its single commit is dead.

[49] Two worktrees hold 80+ unmerged commits each — owner decision required
    cat=other risk=high effort=small
    paths: .claude/worktrees/mail-isolation; .claude/worktrees/ux-refine
    evidence: git rev-list --count main..worktree-mail-isolation = 80 ahead, 0 behind (97M); main..worktree-ux-refine = 83 ahead, 0 behind (67M). Both working trees are clean, but the branches contain all of main plus unmerged work — they are not stale copies.
    action: Do not remove. Ask the owner whether this work is pending, superseded, or ready to merge; only after that decision can the worktrees be pruned.

[50] ~17 MB of the owner's media files sitting untracked at the repo root
    cat=unnecessary-file risk=high effort=small
    paths: Frame 5.png; IMG_8675.PNG; IMG_8677.PNG; IMG_8680.PNG; ScreenRecording_07-30-2026 15-56-22_1.MP4; ScreenRecording_07-30-2026 15-56-55_1.MP4; cloudflare-dns-setup-image.png; dns-records-new.png; ledger media.zip; weird bug video.MP4
    evidence: git status --porcelain lists all 10 as ??; du -ch totals 17M. Dates span Jun 22 to Aug 7; 'weird bug video.MP4' and the screen recordings look like bug-report inputs from 07-30, the DNS PNGs look like one-off setup references from the v2 deploy.
    action: These are the owner's files — do not delete without his say-so. Recommend he move them to a folder outside the repo (or delete the ones whose bugs/DNS work are done, e.g. the 07-30 recordings if ui-bugs-from-video is merged, which it is). Do not gitignore them; hiding them is how they got stale.

[51] Stale 22 MB local build ./ledger from Jul 28
    cat=unnecessary-file risk=low effort=small
    paths: ledger
    evidence: ls: -rwxr-xr-x 22039051 Jul 28 15:46 ledger; od header 177 E L F confirms an ELF binary. git check-ignore -v: .gitignore:2:/ledger and .gitignore:3:/ledgerd both match, so neither binary can be committed; no ./ledgerd currently exists.
    action: Delete ./ledger. It predates the v3 UI work and every deploy since; the deployed binary lives at /usr/local/bin/ledger and a fresh build is one command.

[52] .gitignore entry `.claire/` is a typo; .claude/worktrees/ is not ignored
    cat=tooling risk=low effort=small
    paths: .gitignore; .claude/worktrees
    evidence: .gitignore contains "# Agent worktree scratch space (never commit)" followed by `.claire/` — no .claire directory has ever existed here, while git status shows 9 `?? .claude/worktrees/...` entries polluting every status call. Also stale: `/web/dist` is ignored but web/ builds to ../internal/v2/webui/dist (ls web/dist: No such file or directory).
    action: Change `.claire/` to `.claude/worktrees/` (the comment already describes exactly that). Optionally drop the dead `/web/dist` line.

[53] 31 tracked files live inside gitignored .superpowers/
    cat=structure risk=low effort=small
    paths: .superpowers/sdd; .gitignore
    evidence: git ls-files .superpowers returns 31 sdd fix/task reports (e.g. .superpowers/sdd/2026-08-02-v2-phase2-client/writer-enrollment-report.md), last committed cb6904e 2026-08-05, while .gitignore ignores `.superpowers/` as "Brainstorming visual companion (local mockups)". Consequence: any NEW report written there never appears in git status and silently stays uncommitted.
    action: Pick one side: either move the sdd reports to docs/superpowers/ (where the plans already live) and keep the ignore, or narrow the ignore to the mockups subpath so future sdd reports are visible to git.

[54] NOTICE attributes assets the app no longer bundles
    cat=stale-doc risk=low effort=small
    paths: NOTICE
    evidence: NOTICE (Jun 14) claims "This product bundles third-party assets": Fugue Icons with "attribution is shown in Settings > About", and XP.css. git ls-files | grep -ci fugue = 0 (no icon assets tracked); git grep -il for fugue/xp.css matches only NOTICE, budgeting-app-build-plan.md and docs/superpowers/plans/archive/* — nothing in frontend/src, web/src, or either public/ dir. No Settings > About attribution exists in either frontend. This is the repo's known failure class 2: a sentence the code does not honour.
    action: Delete NOTICE, or rewrite it to list only what the current apps actually bundle (Geist fonts, dither-kit).

[55] Abandoned app/ Expo client: 3.4 MB, 181 tracked files, still on main
    cat=unnecessary-file risk=medium effort=small
    paths: app
    evidence: du -sh app = 3.4M; git ls-files app | wc -l = 181, including app/assets/icon.png (1 MB) and app/assets/splash.png (328K). Last commit 8365532 on 2026-08-05. Only references are retirement notes: scripts/v2-check.sh:107 "app/ (Expo) is retired on this branch" and AGENTS.md:31 "abandoned ... do not extend it". No script builds or tests it.
    action: Remove app/ from main in one commit (git history and the pre-pivot branches preserve it fully — this matches the owner's sunset-don't-delete preference since nothing is lost). Get the owner's nod first; also delete the v2-check.sh comment line in the same commit.

[56] Two untracked working files need a disposition before the next merge
    cat=unnecessary-file risk=medium effort=small
    paths: docs/superpowers/plans/2026-07-29-paper-home-page.md; web/harness/addpasskey-repro.mjs
    evidence: Both are ?? in git status. The plan draft is exactly the shape of the recorded plan-draft merge collision hazard (untracked drafts in the main checkout collide when a branch commits the same path). addpasskey-repro.mjs ("Repro: adding a SECOND passkey...") has never been committed on any branch (git log --all -- path is empty), yet v2 harness coverage is a documented gap.
    action: Commit web/harness/addpasskey-repro.mjs if the passkey bug it reproduces is still open (it is the only add-passkey coverage that exists); commit or remove the paper-home-page plan draft — owner's call on both.

[57] Orphan root node_modules (vite caches only, no root package.json) and empty .codex/
    cat=unnecessary-file risk=low effort=small
    paths: node_modules; .codex
    evidence: No package.json/bun.lock exists at the repo root, yet node_modules/ contains only .vite/vitest and an empty .vite-temp (touched Aug 9 15:20) — a cache some tool wrote with cwd at the root. .codex/ is the tree's only empty directory (find -type d -empty) and has been empty since Aug 3. Both are gitignored/invisible to git.
    action: Delete node_modules/ and .codex/ at the root. If a tool recreates node_modules/.vite, that is harmless; the gitignore already covers it.

############################## Repo structure, module boundaries, and the v1/v2 split question

[58] Repo split recommendation
    cat=structure risk=low effort=small
    paths: go.mod; scripts/v2-check.sh; internal/v2/norm/corpus_test.go; internal/v2/norm/corpus_probe_test.go; internal/v2/tmpl/seed/corpus_gate_test.go; internal/importer/conformance_test.go; conformance/import/vectors.json; internal/v2/corpus/corpus.go; CLAUDE.md
    evidence: RECOMMENDATION: keep one repo; never split — delete v1 at decommission instead. (1) Binary boundary is already clean: `go list -deps ./cmd/ledger | grep ^ledger` yields 13 internal packages, `go list -deps ./cmd/ledgerd` yields 26 internal/v2 packages, intersection empty. (2) But test-level coupling is real and load-bearing: internal/v2/norm/corpus_test.go:10 and corpus_probe_test.go:8 and internal/v2/tmpl/seed/corpus_gate_test.go:112 all contain `v1 "ledger/internal/parse"` — v2's parse-equivalence gate runs v1's parser as the reference implementation over the 7,002-message corpus (skips when LEDGER_CORPUS_DB unset, corpus_test.go:142). (3) scripts/v2-check.sh runs `go test -count=1 ./inter
    action: Keep one repo. Add one fence now: a boundary assertion in scripts/v2-check.sh (or a small Go test) that `go list -deps ./cmd/ledger` and `go list -deps ./cmd/ledgerd` share no ledger/internal packages, so today's proven disjointness cannot silently regress; the three corpus _test.go imports of internal/parse stay sanctioned by name as the equivalence gate. Do not move v1 into a subdirectory. Trigger for the endgame: when the owner stops daily v1 use and decommissions ledger.service, do not split — delete v1 from main (cmd/ledger, internal/* except v2, frontend/, internal/web) and drop go-imap + excelize from go.mod; branch ledger-v1 already preserves the line, and deletion is strictly simple

[59] web/harness carries 10 stale v1 harness files that cannot test v2
    cat=unnecessary-file risk=low effort=small
    paths: web/harness/stack.sh; web/harness/shoot.mjs; web/harness/probe.mjs; web/harness/nav.mjs; web/harness/seed.mjs; web/harness/gestures.mjs; web/harness/hero.mjs; web/harness/ios.mjs; web/harness/sheets.mjs; web/harness/README.md
    evidence: cmp loop over web/harness vs frontend/harness: stack.sh, shoot.mjs, probe.mjs, nav.mjs, audit.mjs, gestures.mjs, hero.mjs, ios.mjs, sheets.mjs are byte-IDENTICAL to the v1 copies; web/harness/stack.sh:87 runs `cd "$REPO/frontend" && node harness/seed.mjs` — it boots v1, not v2. web/harness/seed.mjs is worse than a duplicate: diff shows it is an OLDER v1 copy missing frontend/harness/seed.mjs's effective-dated `month` fix (frontend has `[byName["Rent"], { month, ... }]`, web lacks `month`). The real v2 runners import only two locals: v2settings.mjs:35 imports ./audit.mjs and operator.mjs:38 imports ./webauthn.mjs — nothing references the other nine. CLAUDE.md already warns these forks 'still 
    action: Delete web/harness/{stack.sh,shoot.mjs,probe.mjs,nav.mjs,seed.mjs,gestures.mjs,hero.mjs,ios.mjs,sheets.mjs} (the canonical copies live in frontend/harness; audit.mjs must STAY because v2settings.mjs imports it, and webauthn.mjs stays because operator.mjs imports it). Update web/harness/README.md in the same commit so it stops documenting the removed v1 runners, and drop the now-moot warning paragraph from CLAUDE.md's harness section.

[60] Stale build binary and stray media files at repo root
    cat=unnecessary-file risk=low effort=small
    paths: ledger; Frame 5.png; IMG_8675.PNG; IMG_8677.PNG; IMG_8680.PNG; ScreenRecording_07-30-2026 15-56-22_1.MP4; ScreenRecording_07-30-2026 15-56-55_1.MP4; cloudflare-dns-setup-image.png; dns-records-new.png; ledger media.zip; weird bug video.MP4; web/harness/addpasskey-repro.mjs
    evidence: Root `ledger` is a 22MB ELF binary dated Jul 28 15:46 (od -c: \177 E L F; git ls-files: 'did not match any file(s) known to git' — gitignored via /ledger) — 13 days stale, predating the v2-is-main merge, and deployable by accident. git status --short lists 9 untracked media files at root (screenshots, two screen recordings, 'ledger media.zip', 'weird bug video.MP4', DNS setup images) plus untracked web/harness/addpasskey-repro.mjs and docs/superpowers/plans/2026-07-29-paper-home-page.md.
    action: rm the stale root ./ledger binary (rebuilt on demand; gitignored anyway). Move the media files the owner wants to keep into a gitignored directory (or docs/ if they belong to a bug report) and delete the rest; decide whether addpasskey-repro.mjs and the paper-home-page plan draft should be committed or removed — memory notes untracked plan drafts collide with merges.

[61] CLAUDE.md package tables omit 7 existing packages
    cat=stale-doc risk=low effort=small
    paths: CLAUDE.md; internal/v2/addresses; internal/v2/authtest; internal/v2/blob; internal/v2/corpus; internal/v2/diag; internal/v2/samples; internal/recur
    evidence: ls internal/v2/ shows 27 directories; CLAUDE.md's 'Packages (internal/v2/)' paragraph lists 21 — missing addresses, authtest, blob, corpus, diag, samples (all real: e.g. internal/v2/corpus/corpus.go is in cmd/ledgerd's dep graph, internal/v2/blob is imported by the binary). On the v1 side, ls internal/ shows `recur`, which is in cmd/ledger's dep graph (`ledger/internal/recur` in go list -deps) but absent from CLAUDE.md's v1 Architecture package list.
    action: Add one-line entries for addresses, authtest, blob, corpus, diag, samples to CLAUDE.md's v2 package list and recur to the v1 architecture list, keeping the existing one-phrase-per-package style.

[62] Abandoned app/ Expo client sits on main with no rot gate
    cat=structure risk=low effort=small
    paths: app/; scripts/v2-check.sh
    evidence: git ls-files app/ counts 181 tracked files (3.4M). app/src imports @ledger/client (e.g. app/src/db/reviewQueue.ts, app/src/components/HaltBanner.tsx), but scripts/v2-check.sh:107 says 'app/ (Expo) is retired on this branch' and runs nothing against it — so client/ API changes will silently break app/ with no signal, and AGENTS.md:31 already calls it 'the abandoned Expo native client — do not extend it'.
    action: Per the owner's sunset-don't-delete preference: tag the current commit (e.g. app-expo-final) or note that branch v2-wip-2026-08-05 preserves it, then git rm -r app/ from main so the dead client stops shadowing client/'s consumers; alternatively, if it must stay, add a top-level app/README.md line stating it is frozen and excluded from all gates. Deletion is the cleaner option since git history and the tag preserve every byte.

############################## scripts/, deploy/, conformance/, frontend/harness/, web/harness/, spik

[63] spike/phase2/work is documented as gitignored but no ignore rule exists — the path receives real bank data and a private key
    cat=tooling risk=low effort=small
    paths: cmd/gen-phase2-corpus/main.go; cmd/gen-phase2-corpus/corpus.go; .gitignore
    evidence: cmd/gen-phase2-corpus/main.go:23 — "They go to $W (spike/phase2/work, gitignored in its entirety) and are never committed"; corpus.go:217 — "Write to spike/phase2/work, which is gitignored". But `git check-ignore -v spike/phase2/work/foo` exits 1 (not ignored) and root .gitignore contains no spike entry. Only corpus.db would be caught by the generic *.db rule; corpus.bin, recipient.key and the ops fixture would appear as untracked files that `git add -A` stages. Memory notes concurrent agents share the git index, making accidental staging plausible.
    action: Add `spike/phase2/` to the root .gitignore (one line), making the tree match what the tool's own comments promise. The refuseCommittedPath guard in corpus.go protects the write path but not git.

[64] deploy/README-v2.md §7/§8 contradict §0 and the tree: unit 'not written yet', D4/D5 'not done', 'cluster is down'
    cat=stale-doc risk=low effort=small
    paths: deploy/README-v2.md; deploy/ledgerd.service
    evidence: Line 844: "`deploy/ledgerd.service` | **not written yet** — model it on `deploy/ledger.service`" — the file exists (committed, 2.2K, dated 2026-08-09). §7's heading is "Where things live (once D4/D5 land)". §8 rows: D4 "not done. Adds autocert to runServe...", D5 "not done. Cluster is down". §0 of the same file (verified 2026-08-09) says: ledgerd.service "active and enabled, running since 2026-08-08 18:56", "Public listener 198.51.100.1:443", "PostgreSQL 16 cluster 16/main up". §0 even records that this exact staleness pattern happened before ("This section said the opposite until then").
    action: Update §7 (drop "once D4/D5 land", replace the ledgerd.service row with a pointer to the real unit) and mark §8 D1/D4/D5 rows done/current. This is the 2am runbook; internal contradictions defeat its stated purpose.

[65] conformance/crypto is an orphaned suite: no reader anywhere, and it cites a README that never existed
    cat=dead-code risk=medium effort=small
    paths: conformance/crypto/vectors.json; conformance/crypto/manifest.synthetic.json; cmd/ledgerd/loadcorpus.go; app/src/bench/vectors.ts
    evidence: Repo-wide grep for `conformance/crypto|manifest.synthetic` matches only cmd/gen-phase2-corpus/gen_test.go:406 (a refuse-list entry proving corpus.bin must NOT be written there) and cmd/ledgerd/loadcorpus.go:82 (a comment: "see conformance/crypto/README.md for why the digests are salted" — `git log --all -- conformance/crypto/README.md` is empty; the file never existed; the actual rationale lives in cmd/gen-phase2-corpus/main.go's doc comment). The intended consumer was the retired app/ bench: app/src/bench/vectors.ts says "vectors.test.ts beside them runs them under bun test src on every gate" but no vectors.test.ts exists in app/src/bench/, and v2-check.sh line 107 says app/ is retired. The
    action: Owner decision, not unilateral deletion: either wire the intended reader (a client/-side crypto vector test) or retire conformance/crypto/ (32K) together with the abandoned app/ bench. Either way, fix cmd/ledgerd/loadcorpus.go:82 to point at cmd/gen-phase2-corpus's doc comment instead of the nonexistent README. Not part of the byte-for-byte Go/TS executor contract (norm/tmpl/dict/blob/op/ts/fx/import/structure/dialect all have live readers; this one does not).

[66] spike/phase0 code subdirs (blobgen, replay-app) are imported by nothing; RESULTS.md is the only part still referenced
    cat=unnecessary-file risk=low effort=small
    paths: spike/phase0/RESULTS.md; spike/phase0/blobgen/; spike/phase0/replay-app/
    evidence: Purpose: the Phase-0 kill-risk spikes (port-25 probe + on-device replay benchmark for the since-retired Expo direction), verdicts recorded in RESULTS.md. blobgen has its own go.mod and replay-app its own package.json/bun.lock, so neither is built or tested by the root module; repo-wide grep finds no imports. Inbound references: deploy/README-v2.md §8 D2 row cites "spike/phase0/RESULTS.md covers the primary only", and plan docs cite the spike; RESULTS.md itself cites spike/phase0/blobgen/main.go:75 and replay-app/crypto.ts. replay-app is ~800K including Expo PNG icon assets and bun.lock. Note spike/phase2/ is a separate, runtime-only destination for cmd/gen-phase2-corpus and does not exist in
    action: Keep RESULTS.md (it is cited evidence for the port-25 GO verdict and the mandatory Phase-2 native-crypto benchmark). The two code subdirs are safe to delete — measurements are fully recorded in RESULTS.md — at the owner's discretion per the repo's sunset-don't-delete convention; note RESULTS.md's file/line citations into them would dangle, acceptable for a historical record.

[67] web/harness/addpasskey-repro.mjs is untracked and unmentioned in the harness README
    cat=unnecessary-file risk=low effort=small
    paths: web/harness/addpasskey-repro.mjs; web/harness/README.md
    evidence: `git status --porcelain` shows `?? web/harness/addpasskey-repro.mjs` (3.1K, dated 2026-08-09); `grep -n addpasskey web/harness/README.md` exits 1. It is a Playwright repro for adding a SECOND passkey on an authenticator already holding the first (BeginAdd sends enrolled credentials in excludeCredentials — the iCloud Keychain scenario). Every other web/harness file is tracked and documented in the README.
    action: If the repro still has value against the shipped passkey-list/removal work, `git add` it and add a README line; otherwise delete it. Either way, stop it drifting as untracked scratch in a directory whose convention is fully-documented tracked runners.

[68] deploy/README.md (v1) carries Milestone-1-era copy and broken section numbering
    cat=stale-doc risk=low effort=small
    paths: deploy/README.md
    evidence: Title: "Deploying ledger on dinosaur (Milestone 1)". §4: "Expect the XP-styled placeholder card showing `health: ok (db: ok)`" — v1 has been a full budgeting PWA for months (v3 rebuild deployed 2026-07-30). Numbering: "## 5. Web Push (VAPID)" is followed by "## 6. Dedicated mailbox (Milestone 2 — ingest)" whose subsections are "### 5a"–"### 5d". All install facts (paths, user, ports, EnvironmentFile=-/etc/ledger/ledger.env) do match deploy/ledger.service — only the narrative copy is stale.
    action: Refresh the verification copy in §4 to describe the current PWA, fix the 5a-5d subsection numbers under §6, and drop the Milestone-1 framing from the title.

[69] scripts/perf-report.sh is an orphan: referenced only by a completed 2026-07-03 plan doc
    cat=dead-code risk=low effort=small
    paths: scripts/perf-report.sh
    evidence: Repo-wide grep finds references only in docs/superpowers/plans/2026-07-03-slow-network-load-performance.md (the plan that created it); no script, README, package.json or Makefile invokes it. git log shows a single commit (7dc8eae "chore(perf): add load-weight report script and record baseline"). It still works against the current tree: it reads internal/web/dist/index.html and sw.js directly, both present — so it is functional-but-unadvertised rather than broken.
    action: Keep it (small, working, v1-relevant) but give it a discoverable home: one line in deploy/README.md's ops section or frontend docs. Alternatively sunset it per repo convention — but do not delete unilaterally.

[70] v2-check.sh runs go test ./internal/importer with no comment, in a script where every other step carries its rationale
    cat=tooling risk=low effort=small
    paths: scripts/v2-check.sh; internal/importer/conformance_test.go; client/src/importer/importer.test.ts
    evidence: Line 88: `go test -count=1 ./internal/importer` — internal/importer is a v1 package (imported only by cmd/ledger/main.go:24), and CLAUDE.md's app table assigns v1 a separate gate. The actual reason it belongs here: internal/importer/conformance_test.go:15 reads conformance/import/vectors.json, the Go half of a Go(v1)<->TS(client/src/importer) cross-executor contract, so the v2 gate must run it. Every other step in v2-check.sh (lines 59-138) has a comment explaining exactly this kind of non-obvious inclusion; this line is the only bare one, inviting a future "simplification" that silently drops the import contract's Go half.
    action: Add a two-line comment above line 88 stating that internal/importer is the Go executor of conformance/import/vectors.json and must run in this gate despite being a v1 package.

TOTAL 70
```
