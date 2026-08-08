# Multi-bank, and a second device that does not start over

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A user can declare several banks at onboarding and change them later in Settings. A second device on the same account inherits the whole setup — same mailbox, same banks — and never re-runs onboarding.

## The problem, precisely

`resumeFacts` (`web/src/v2/onboarding.ts`) reassembles onboarding state from four sources. Three of its facts are already account-wide and a second device inherits them correctly:

- `inboundAddress` — the server issues it (`GET /api/v1/address`); the local copy is a cache used only to answer "has an address ever been issued", which is monotonic.
- `firstMailConfirmedAt` — folded from the op log.
- `homeCurrency` — folded from the op log.

Three are **device-local**, held in `LocalOnboardingRecord` in browser storage:

- `bank` — a single value, and the reason multi-bank has nowhere to live.
- `forwardingDeclared`
- `finishedAt`

Because the resume rule is a strict prefix ("a gap is never skipped, however much sits behind it"), a second device with `bank: null` re-runs the bank step and everything after it — even though mail is already flowing into the shared mailbox.

## Decisions taken 2026-08-08

1. **Declared banks live on the server, not in the op log.** Operator's decision, and the reasoning holds: the server already records the sender domain per ingest in `parse_diagnostics`, so spec §2's breach inventory already discloses which bank each user uses. A declared list adds very little. Storing it server-side avoids bumping `SCHEMA_VERSION` (2→3), which would hard-stop every client that had not upgraded (`UnknownNewerVersionError`, `client/src/wire/op.ts:53-61`).
2. **`forwardingDeclared` and `finishedAt` are derived, not stored.** Neither needs a home:
   - Forwarding demonstrably works when mail has arrived, and `firstMailConfirmedAt` already folds from the log.
   - "Finished" is exactly "the prerequisites are met", which the fact set already answers.
   Deleting them from `LocalOnboardingRecord` removes two of the three device-local facts outright.
3. **§2 and the consent document must be updated.** The declared list includes banks a user *intends* to use and unsupported banks they waitlisted — slightly more than diagnostics reveals. We committed to keeping the breach inventory accurate, so it changes with the code, in the same commit.

## Global Constraints

- **Do not add an op kind.** The fold accepts exactly: `home_currency_set`, `rate_set`, `rate_unset`, `rule_added`, `txn_categorized`, `txn_duplicate_disposition`, `txn_edited`, `txn_ingested`, `txn_split`, `txn_superseded`, `writer_checkpoint`. `SCHEMA_VERSION` stays 2. That is the whole point of choosing the server.
- The server keeps a **declared list**, not a trust input. Bank selection must never influence parsing, the allowlist, or any trust decision — it routes the waitlist and drives the UI, nothing else. A test must assert nothing in the trust path reads it.
- Money is `bigint`; never `Number` for an amount.
- Design aesthetic FROZEN: compose from `web/src/components/`; read `web/src/components/README.md` first; 44px targets, 16px inputs.
- Motion: `lib/motion.ts` is the sole source of durations/curves; `m.*` never bare `motion.*`; no `opacity: 0` in `initial` for first-paint content; tests rendering `m.*` wrap in `MotionProvider`.
- Never import `@ledger/client/platform` or `@ledger/client/store/open` from browser code.
- The git index is shared: stage and commit in ONE atomic command with explicit paths from the repo root.
- **Do not run `cd web && bun run build`** — it writes the tracked `internal/v2/webui/dist` embed artifact the deploy step owns. Verify with `bun run test` and `bunx tsc -b`.
- Every UI string must be one the code honours. Across the last two plans, every review round on these screens found a sentence that was not true.
- Commit with a `Co-Authored-By: Claude` trailer.

---

### Task 1: The server keeps the declared banks

**Files:** Create `internal/v2/pg/migrations/000NN_user_banks.sql`, `internal/v2/api/banks.go` + test; modify `internal/v2/api/api.go`.

- [ ] **Step 1:** `ls internal/v2/pg/migrations/` immediately before writing, and claim the next free number. **Never claim `00004` or `00015`** — both are deliberately vacant, and `00004` is vacant by controller ruling because goose hard-fails if a migration appears below an applied version. The live database is at 25.
- [ ] **Step 2:** Failing test first, against `pgtest`.
- [ ] **Step 3:** Table `user_banks(user_id … REFERENCES users ON DELETE CASCADE, bank text NOT NULL, declared_at timestamptz NOT NULL, PRIMARY KEY (user_id, bank))`. **Mirror the grant recipe in `internal/v2/pg/migrations/00003_writers.sql`'s header** — the runtime role needs explicit DML grants and the `ALTER DEFAULT PRIVILEGES` line, or every write fails with `permission denied` **in production only**. That recipe has caught this before.
- [ ] **Step 4:** `GET /api/v1/banks` → `{banks: string[]}` and `PUT /api/v1/banks` `{banks: string[]}` → 204. Session-gated like the rest. Validate each name against the same rule the waitlist uses (`admin.bankRe` — 64 **bytes**, Go's whitespace set); Task 7 already mirrored that client-side, so reuse rather than restate it. Cap the list length and say what the cap is in the error.
- [ ] **Step 5:** Tests: round-trip; replacing the list removes the absent ones; an over-long name is refused with the rule, not a bare 400; another user's list is never returned; deleting the account cascades.
- [ ] **Step 6:** `go test ./internal/v2/...` and `go vet ./...` green. Commit.

---

### Task 2: Multi-select at onboarding

**Files:** Modify `web/src/v2/onboarding.ts`, `web/src/v2/onboardingIO.ts`, `web/src/screens/onboarding/Bank.tsx`, `Onboarding.tsx`. Tests alongside.

- [ ] **Step 1:** `OnboardingFacts.bank: string | null` becomes `banks: string[]`. `bank_picked` becomes `banks_declared` carrying the array; the milestone is satisfied when the list is non-empty. Keep the strict prefix rule intact — do not loosen it.
- [ ] **Step 2:** Failing tests: selecting two supported banks declares both; selecting an unsupported one waitlists it and does not add it to the declared list; selecting none does not satisfy the milestone.
- [ ] **Step 3:** `Bank.tsx` becomes a multi-select over the supported set from `GET /api/v1/templates` (Task 7 already collapses that per-bank — it returns one entry per TEMPLATE, so a naive list shows Dubai Islamic Bank twice). Keep the three exits it has: proceed, waitlist an unsupported bank, and a grammar refusal that is not a dead end.
- [ ] **Step 4:** On declare, `PUT /api/v1/banks`. A failed PUT must not strand the user — it is retryable and says so.
- [ ] **Step 5:** Commit.

---

### Task 3: A second device inherits everything

**Files:** Modify `web/src/v2/onboarding.ts` (`resumeFacts`, `LocalOnboardingRecord`), `web/src/v2/session.ts` or the boot path. Tests alongside.

This is the task the operator actually asked for. Verify it by simulating a genuinely fresh device — empty local storage, same account — not by unit-testing `resumeFacts` in isolation.

- [ ] **Step 1:** Failing test: an account that finished onboarding on device A, then boots on device B with EMPTY local storage, lands on the main app. Not the bank step, not the address step. It must show the SAME inbound address, and the same declared banks.
- [ ] **Step 2:** Run, see it fail (today it re-runs the bank step).
- [ ] **Step 3:** `resumeFacts` reads `banks` from the server. Delete `forwardingDeclared` and `finishedAt` from `LocalOnboardingRecord` and derive them per Decision 2 — forwarding is demonstrated by `firstMailConfirmedAt`, and finished is the prerequisites being met.
- [ ] **Step 4:** **Handle the offline second device honestly.** If the banks GET fails, the app does not know whether onboarding was done. It must not silently restart onboarding — that is the "sentence the code does not honour" failure in its most damaging form, because re-running the address step on a working account is alarming. Show that it cannot reach the server and offer a retry. Test the offline path explicitly.
- [ ] **Step 5:** Verify the address genuinely does not change: assert the second device's `GET /api/v1/address` returns device A's address, and that no code path can request a new one.
- [ ] **Step 6:** Commit.

---

### Task 4: Change banks in Settings

**Files:** Modify `web/src/screens/settings/V2Settings.tsx`. Tests alongside.

- [ ] **Step 1:** Failing test: Settings lists the declared banks, adds one, removes one, and both survive a reload (i.e. they went to the server).
- [ ] **Step 2:** Run, see it fail. **Step 3:** Implement, reusing Task 2's multi-select rather than writing a second one. **Step 4:** Pass.
- [ ] **Step 5:** **Removing a bank must state what it does and does not do.** It does not stop mail arriving, does not untrust a sender, and does not delete transactions — the allowlist is separate (`sender_allowlist`, populated by the quarantine trust decision). If the copy implies otherwise it is wrong. If removal should also untrust that sender, that is a different feature; report it rather than building it.
- [ ] **Step 6:** Commit.

---

### Task 5: Keep the disclosures true

**Files:** Modify `docs/superpowers/specs/2026-07-31-multi-user-beta-design.md` §2, `docs/alpha-consent.md`.

- [ ] Add the declared bank list to §2's breach inventory, beside the existing parse-diagnostics entry, and note it covers intended and waitlisted banks as well as ones that have sent mail.
- [ ] Update the consent document in the same terms and plain language.
- [ ] Commit together with nothing else, so the disclosure change is legible in the history.

---

### Task 6: Gate

- [ ] `bash scripts/v2-check.sh` → OK, and `git status --porcelain internal/v2/webui/dist` empty afterwards.
- [ ] Apply the new migration to the live database **as `ledger_migrate`**, before the new binary starts. `ledgerd verify` must exit 0 as `ledger_runtime` afterwards — that is what proves the grants are right, and it has caught a missing grant before.

## Self-review notes

- **Covers the ask:** multi-select at onboarding (Task 2), adjustable in Settings (Task 4), and a second device that inherits the mailbox and the setup without starting over (Task 3).
- **The riskiest task is 3**, because its failure mode is showing a fully set-up user the address step — which looks like data loss. Step 4 makes the offline case explicit rather than letting it fall through to "start over".
- **No op kind is added and `SCHEMA_VERSION` stays 2**, so no client hard-stops and no user is forced to upgrade. That was the point of the decision.
