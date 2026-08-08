# User configuration — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A user declares several banks, chooses their own budget split, and manages their own categories. All of it syncs across devices. A second device never re-runs onboarding.

**Read the spec first:** `docs/superpowers/specs/2026-08-08-user-configuration.md`. It records why configuration goes in the op log rather than on the server, and it reverses an earlier decision — do not re-litigate it in code.

## Global Constraints

- **`SCHEMA_VERSION` goes 2 → 3, and that is the only sanctioned bump.** Adding an op kind is normally forbidden on this branch; this plan is the exception, and the exception does not extend past the three ops in the spec.
- **The hard stop must not be weakened.** `UnknownNewerVersionError` stopping sync on an unknown newer version is a safety property (`client/src/wire/op.ts:53-61`). Do not soften it to ease the upgrade.
- **Go and TypeScript must agree.** `internal/v2/oplog/op.go`'s `Types` and the TS op list are pinned in step by a conformance suite. A change to one without the other must fail the build — verify that it does.
- **The trust path never reads configuration.** Nothing in `internal/v2/origin/` may consult declared banks. A test asserts it.
- **Absent configuration behaves exactly as today.** An account with no configuration ops must render identically to now — `DEFAULT_BUDGET_MAPPING`, today's derived categories. This is what makes the upgrade a no-op for data.
- Money is `bigint`; never `Number` for an amount. Budget percentages are integers, not money.
- Design aesthetic FROZEN: compose from `web/src/components/`; read `web/src/components/README.md` first; 44px targets, 16px inputs.
- Motion: `lib/motion.ts` is the sole source of durations/curves; `m.*` never bare `motion.*`; no `opacity: 0` in `initial` for first-paint content; tests rendering `m.*` wrap in `MotionProvider`.
- Never import `@ledger/client/platform` or `@ledger/client/store/open` from browser code.
- The git index is shared: stage and commit in ONE atomic command with explicit paths from the repo root.
- **Do not run `cd web && bun run build`** — it writes the tracked `internal/v2/webui/dist` artifact the deploy step owns. Verify with `bun run test` and `bunx tsc -b`.
- Every UI string must be one the code honours. Every review round on these screens so far has found a sentence that was not true.
- Commit with a `Co-Authored-By: Claude` trailer.

---

### Task 1: The three ops, end to end

**Files:** `client/src/wire/op.ts`, `client/src/replay/replay.ts`, `client/src/replay/state.ts`, `internal/v2/oplog/op.go`, plus their tests and the conformance fixtures.

This is the foundation and the riskiest task; everything else builds on it.

- [ ] **Step 1:** Read `home_currency_set` and `rate_set` end to end first — wire type, fold case, state field, Go type, conformance entry. They are the shape to copy. Report what the full set of touch points actually is before changing any of them.
- [ ] **Step 2:** Failing tests first, in both languages: an op of each new kind round-trips, folds, and appears in state.
- [ ] **Step 3:** Add `banks_declared`, `budget_split_set`, `category_defined` per the spec's table. Parent-free, folded by position, last write wins per key.
- [ ] **Step 4:** Bump `SCHEMA_VERSION` to 3.
- [ ] **Step 5: prove the hard stop still works.** Write a test where a client at version 3 writes an op and a client pinned at 2 reads the log: it must raise `UnknownNewerVersionError` and stop, not skip the op. This is the safety property the bump trades on.
- [ ] **Step 6: prove Go and TS cannot drift.** Add a type on one side only and confirm the conformance suite fails. Revert.
- [ ] **Step 7:** Validation belongs where the fold is: percentages are integers summing to 100; a category `kind` is one of `spending`/`income`/`excluded`; a `spending` category has a bucket, the others do not. An invalid op must be an `invalid_payload` anomaly, not a crash and not a silent accept.
- [ ] **Step 8:** `bash scripts/v2-check.sh` green. Commit.

---

### Task 2: Budget split, chosen by the user

**Files:** `web/src/v2/sources/budget.ts`, `web/src/lib/envelope.ts` callers, a new onboarding step, `web/src/screens/settings/V2Settings.tsx`. Tests alongside.

- [ ] **Step 1:** Failing test: with no `budget_split_set` op, budget maths is byte-identical to today (`DEFAULT_BUDGET_MAPPING`). This is the backwards-compatibility guarantee and it is tested first, not last.
- [ ] **Step 2:** Failing test: with a split of 60/20/20, Home and Insights use it.
- [ ] **Step 3:** Implement — read the split from folded state, fall back to the default.
- [ ] **Step 4:** An onboarding step to choose it, defaulting to 50/30/20 with a one-line explanation of what the three buckets mean. It must be **skippable** — a user who does not care gets the default and is not blocked.
- [ ] **Step 5:** The same control in Settings.
- [ ] **Step 6:** The percentages must sum to 100. Say so before the user saves, not after. Do not silently normalise — a user who typed 60/30/20 meant something, and quietly changing it to 55/27/18 is the class of lie this branch keeps finding.
- [ ] **Step 7:** Commit.

---

### Task 3: Categories the user owns

**Files:** `web/src/v2/sources/categories.ts` (new), `web/src/screens/CategoryManager.tsx`, the category sheet from `web/src/screens/Transactions.tsx`, the review deck. Tests alongside.

**Read `web/src/screens/CategoryManager.tsx` first** — v1's model is `{ Name, Kind, Bucket, IsActive, Color }` with sections for spending (need/want/saving), income and excluded. That taxonomy is the target; the doc comment there explains why a category is born knowing its kind and bucket.

- [ ] **Step 1:** Failing test: with no `category_defined` ops, the selectable set is exactly what it is today (derived from the projection and the dictionary), so nothing regresses for an account that never opens this screen.
- [ ] **Step 2:** Failing tests: defining a category makes it selectable; retiring it removes it from the picker but leaves existing transactions readable and correctly bucketed.
- [ ] **Step 3:** Implement the source and the manager. Reuse `bucketColor` from `lib/insights` rather than inventing a second palette.
- [ ] **Step 4:** Wire the picker in the category sheet and the review deck to the user's set. **Do not write a second op author** — `sources/review.ts`'s `categorizeOps` is the single author and that property is asserted.
- [ ] **Step 5:** A retired category must not vanish from history. A transaction categorised as "Gym" before "Gym" was retired still reads "Gym" and still counts in its bucket. Test it.
- [ ] **Step 6:** Commit.

---

### Task 4: Multi-bank, and a second device that inherits everything

**Files:** `web/src/v2/onboarding.ts`, `web/src/screens/onboarding/Bank.tsx`, `Onboarding.tsx`, `web/src/screens/settings/V2Settings.tsx`. Tests alongside.

This supersedes Tasks 1–4 of `2026-08-08-multi-bank-and-device-parity.md`, which assumed a server table. Tasks 5 and 6 of that plan (disclosures, gate) still stand and are not repeated here.

- [ ] **Step 1:** `OnboardingFacts.bank: string | null` becomes `banks: string[]`, sourced from the folded log rather than `LocalOnboardingRecord`. `bank_picked` becomes `banks_declared`, satisfied by a non-empty list.
- [ ] **Step 2:** Delete `bank`, `forwardingDeclared` and `finishedAt` from `LocalOnboardingRecord`. Per the earlier analysis: forwarding is demonstrated by `firstMailConfirmedAt` (already folded), and "finished" is the prerequisites being met. That empties the device-local half entirely.
- [ ] **Step 3: the test that matters.** An account that finished onboarding on device A, booting on device B with EMPTY local storage, lands on the main app — not the bank step, not the address step — with the same inbound address and the same banks. Write it first and watch it fail.
- [ ] **Step 4:** `Bank.tsx` becomes a multi-select over the supported set from `GET /api/v1/templates` (note: it returns one entry per TEMPLATE, not per bank, so collapse on `bank` or Dubai Islamic Bank appears twice). Keep its three exits: proceed, waitlist an unsupported bank, and a grammar refusal that is not a dead end.
- [ ] **Step 5:** Editing the list in Settings, reusing the same control.
- [ ] **Step 6: the offline second device must not restart onboarding.** If state cannot be read, say so and offer a retry. Silently re-running the address step on a working account looks like data loss and is the most damaging version of a false UI claim.
- [ ] **Step 7:** Removing a bank does not stop mail, untrust a sender, or delete transactions — the allowlist is separate. Say only what is true.
- [ ] **Step 8:** Commit.

---

### Task 5: Gate, disclosures, and the upgrade

- [ ] `bash scripts/v2-check.sh` green; `git status --porcelain internal/v2/webui/dist` empty afterwards.
- [ ] Update spec §2's breach inventory and `docs/alpha-consent.md` **only if** what the server can read has changed. Under this plan configuration is in the op log, so the honest answer may be "no change" — say which, and do not add a disclosure that is not true.
- [ ] Record in the report what an existing client experiences at the version bump, and confirm it is one reload for the single live user.

## Preparing for the crypto phase

The operator has said Phase 3 is next. Two things in this plan are chosen with that in mind, and the next planner should know:

- **Configuration is in the op log**, so it is sealed by the same mechanism as everything else when crypto lands. No second encryption story is needed for preferences.
- **`SCHEMA_VERSION` moves now, alone.** Doing it here means the crypto migration is not simultaneously a schema migration — one variable at a time, and each provable on its own.

## Self-review notes

- **Covers the four asks:** multi-bank (Task 4), preferences generally (Tasks 2–4 share one mechanism), budgeting configuration at onboarding (Task 2), category personalisation (Task 3). The review-page fix already landed at `51f7d57`.
- **The riskiest task is 1**, because a wrong op shape is permanent in an append-only log. Steps 5 and 6 exist to prove the two properties that make the bump safe — the hard stop still stops, and Go and TS cannot drift.
- **Backwards compatibility is tested first in every task**, not last: an account with no configuration ops must behave exactly as it does today, or the upgrade is not a no-op for data.
