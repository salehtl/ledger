# v2 feature parity — categorisation, multi-device, and the v1 screens

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the three gaps the live deployment exposed — a cleanly-parsed transaction cannot be categorised at all, a second device cannot be enrolled, and the v1 screens the operator actually uses are unrouted — without inventing ops the server does not have.

**Status of the live system:** `https://app.sirdab.ae` is live and the pipeline works end to end. A real DIB alert has been forwarded, verified (`inner dib.ae`, `direct_dkim`), confirmed, re-ingested, template-parsed (`dib.card.v1`, no empty groups), synced and rendered. 221 merchant rules are seeded and published.

## What each gap actually is

**1. No categorisation surface for a confirmed transaction.** `txn_categorized` exists and works — the operator's own `edit` ops are in the log. But the *only* place that authors it is the Review swipe deck, and the deck is fed by `needs_review`. A template-tier parse is trusted and never flagged, so a cleanly-parsed transaction can never reach the one screen that can categorise it. Task 8 deliberately removed every write path from Transactions ("read-only until Task 9's op authors"), and Task 9 only wired the deck. Nobody owned the gap between them.

**2. Second-device enrolment is impossible, not merely awkward.** The server refuses with `auth: writer registration rejected: no enrolled key authorized this`. That is correct and deliberate — spec §3.4 requires proof of possession of an already-enrolled key so a stolen session token cannot inject a writer whose ops peer devices would replay. But **no UI exists to provide that proof**, so the backend enforces a rule the frontend cannot satisfy. The spec calls for a cross-device comparison code at second-device enrolment; it was never built.

**3. The v1 screens are unrouted.** Task 10 unrouted them because they read v1 HTTP endpoints that v2 does not serve. Porting divides sharply, and the division is what makes this plan tractable:

| Screen | Op support | Verdict |
|---|---|---|
| Insights | `txn_ingested`/`txn_categorized` already carry everything | **Portable now** |
| Rules manager | `rule_added` exists and folds | **Portable now** |
| Category manager | `category` is a free-form `string` in `state.ts` — there is no category entity or op | **Needs a decision, see Task 5** |
| Plan / targets / envelopes | no envelope, target or plan op exists | **Out of scope — needs new ops** |
| Projects, Recurring, Accounts, Reports | no project, recurring or account op exists | **Out of scope — needs new ops** |

Task 8 verified that inventory against `state.ts` when it removed those widgets. Do not re-derive it, and do not invent an op to make a screen work — a new op is a schema change, a fold change, a conformance-suite change and a migration, and it belongs in its own plan.

## Global Constraints

- **Do not add a new op kind.** The fold accepts exactly: `home_currency_set`, `rate_set`, `rate_unset`, `rule_added`, `txn_categorized`, `txn_duplicate_disposition`, `txn_edited`, `txn_ingested`, `txn_split`, `txn_superseded`, `writer_checkpoint`. If a task seems to need another, stop and report — it is a different plan.
- Design aesthetic FROZEN: compose from `web/src/components/`; read `web/src/components/README.md` first; 44px targets, 16px inputs.
- Motion: `lib/motion.ts` is the sole source of durations/curves; `m.*` never bare `motion.*`; no `opacity: 0` in `initial` for first-paint content; tests rendering `m.*` wrap in `MotionProvider`.
- **Money is `bigint`.** Never `Number` for an amount. Insights aggregates money — this is where a `Number()` will slip in.
- Use `useV2OrThrow` for shell-level access; screen-level hooks stay nullable with a disconnected empty state, per the established pattern, and assert `fetch` is never called.
- Never import `@ledger/client/platform` or `@ledger/client/store/open` from browser code.
- **`v2-check.sh` currently rebuilds `internal/v2/webui/dist` as a side effect** (a `bun run build` added so the browser guards run). Do not commit that artifact; the deploy step owns it. Task 0 fixes this.
- The git index is shared with concurrent agents: stage and commit in ONE atomic command with explicit paths, from the repo root.
- Every UI string must be one the code honours. Four review rounds on the onboarding screens found nothing but sentences that were false. If you cannot make a claim true, write the weaker one.

---

### Task 0: Stop the gate rewriting the deploy artifact

**Files:** Modify `scripts/v2-check.sh`

- [ ] The web section runs `bun run build` so the bundler and typecheck guards actually execute — that must stay. But it writes `internal/v2/webui/dist`, a tracked artifact the deploy step owns, so every gate run dirties the tree and the working copy silently diverges from what is deployed.
- [ ] Build to a throwaway directory instead (`vite build --outDir` to a temp path, or set the out dir via an env var the config reads), so the guards run and `dist` is untouched. Verify `git status --porcelain internal/v2/webui/dist` is empty immediately after a full `bash scripts/v2-check.sh`.
- [ ] Commit: `fix(v2-check): run the browser guards without rewriting the deploy artifact`

---

### Task 1: Categorise any transaction

**Files:** Modify `web/src/screens/Transactions.tsx`, `web/src/v2/queries.ts`; reuse the op author in `web/src/v2/writer.ts`. Tests alongside.

The op and its author already exist and are proven — the Review deck writes `txn_categorized` with `rule_added` in the same `enqueueMany`. This task gives that author a second entry point.

- [ ] **Step 1:** Failing test — opening a transaction that is NOT `needs_review` offers a category control, and choosing a category enqueues `txn_categorized`. Assert the parent version is read fresh from `source.version(txn.id)`, not from the row the UI rendered, exactly as the deck does.
- [ ] **Step 2:** Run, see it fail.
- [ ] **Step 3:** Implement. Read `web/src/screens/Review.tsx`'s commit path and reuse it rather than writing a second author — a second implementation of "how a categorisation is recorded" is how the two eventually disagree. Offer the same "also make a rule for this merchant" behaviour the deck offers, since `rule_added` is what stops the merchant asking again.
- [ ] **Step 4:** Pass.
- [ ] **Step 5:** Decide and state in the report whether re-categorising should also be possible for a transaction already categorised (it should — `txn_categorized` supersedes by parent version), and cover it with a test.
- [ ] **Step 6:** Commit.

---

### Task 2: Re-apply the dictionary to existing transactions

**Files:** Modify `web/src/v2/` projection/categorisation path; tests alongside.

The 221 seeded rules were published *after* the operator's first transaction was ingested, so it stayed uncategorised. Newly-arriving mail will categorise; history will not. That is a real gap every alpha will hit, because the dictionary grows after they join.

- [ ] **Step 1:** Read how categorisation is applied today — find whether it runs at ingest only, or during replay/projection. State the answer in the report before changing anything; the fix differs completely between the two.
- [ ] **Step 2:** Failing test: with a transaction already in the projection and uncategorised, publishing a dictionary entry matching its merchant causes it to be categorised on the next sync/replay — **without** authoring a `txn_categorized` op per transaction if the categorisation is derived rather than recorded. If it must author ops, they must be idempotent under replay and must not fork against a user's own manual categorisation, which always wins.
- [ ] **Step 3:** Run, see it fail. **Step 4:** Implement. **Step 5:** Pass.
- [ ] **Step 6:** The precedence rule is the load-bearing part: **a user's explicit categorisation must never be overwritten by a dictionary entry.** Test it directly.
- [ ] **Step 7:** Commit.

---

### Task 3: Second-device enrolment

**Files:** Create `web/src/v2/deviceEnrolment.ts` + screens under `web/src/screens/settings/`; modify `web/src/v2/session.ts`. Tests alongside.

**Read first:** `client/src/net/client.ts`'s `enroll(writerId, opts: {signWith?, publicKey?})` — its doc explains that a peer enrolment must be signed by an already-enrolled writer and why self-signing is refused. `internal/v2/auth/writer.go` and `internal/v2/api/keyhistory.go` are the server side. Spec §3.4 describes the intended UX: a short **cross-device comparison code** over the key-history head and the writer-checkpoint heads, surfaced during second-device enrolment.

- [ ] **Step 1:** Establish and report exactly what the server requires — the challenge shape, what must sign it, and what `POST /api/v1/writers/register` accepts. Do not guess from the client.
- [ ] **Step 2:** Failing test for the flow: an unenrolled device produces an enrolment request; an already-enrolled device authorises it; the server accepts; a `device` writer row results. Drive it against the real endpoints if you can, with the two halves as separate stores.
- [ ] **Step 3:** Run, see it fail. **Step 4:** Implement both halves — the new device shows its request (and the comparison code), the enrolled device has a Settings screen to review and approve it.
- [ ] **Step 5:** **The comparison code is a security control, not decoration.** It exists so a user can detect a server substituting a key. Surface it on BOTH devices and require the user to confirm they match before approving. If you cannot compute it from what the client has, say so plainly rather than showing a placeholder.
- [ ] **Step 6:** The refusal must be honest. Today an unenrolled device says "the server refused the request", which tells the user nothing actionable. It should say the device needs approval from a device already signed in, and how.
- [ ] **Step 7:** Commit.

---

### Task 4: Insights on the projection

**Files:** Create `web/src/v2/sources/insights.ts`; modify `web/src/screens/Insights.tsx`, nav in `AppShell`. Tests alongside.

`web/src/lib/insights.ts` and `web/src/lib/envelope.ts` are already in the tree and are pure, framework-free helpers with co-located tests — they were carried over in the fork. Reuse them; do not rewrite the maths.

- [ ] **Step 1:** Port `sources/insights.ts` following the shape of `sources/budget.ts` and `sources/transactions.ts` (commit `e62eac9`) — a framework-free reader over `SqlDriver`, money as `bigint`, `null` when the projection is unavailable.
- [ ] **Step 2:** Failing tests over a real `fold`+`project` projection, as Task 8's screen tests do. Include a >2^53 amount, since Insights sums.
- [ ] **Step 3:** Run, see them fail. **Step 4:** Implement. **Step 5:** Pass.
- [ ] **Step 6:** **Remove, do not stub**, any panel whose data does not exist in the projection — check `state.ts` before deciding, exactly as Task 8 did. If a panel needs envelopes or targets, it goes; those need ops that do not exist.
- [ ] **Step 7:** Route it in the nav. Assert `fetch` is never called by the screen.
- [ ] **Step 8:** Commit.

---

### Task 5: Rules, and the category question

**Files:** Modify `web/src/screens/RulesManager.tsx`, `web/src/screens/CategoryManager.tsx`, nav. Tests alongside.

- [ ] **Step 1:** Port the rules manager onto `rule_added` — list the user's rules from the projection (`readRules`), and author new ones through the same path Task 1 uses. Deleting a rule needs an op that does not exist; if so, the manager is add-and-list only for now, and **the UI must not offer a delete it cannot perform.**
- [ ] **Step 2:** **The category question, to be answered in the report before any code:** in v2 `category` is a free-form `string` on the transaction (`state.ts:52,91,164`) — there is no category entity, no category op, and no server list. v1's insights bucket categories into `need`/`want`/`saving` (`lib/insights.ts`, `lib/envelope.ts`). So determine and state: where does the set of selectable categories come from, and where does a category's bucket come from? Candidates: derived from the published dictionary; derived from categories already present in the projection; or a fixed list in client code. Pick one, justify it, and note what it forecloses.
- [ ] **Step 3:** Implement whatever Step 2 decided, with tests. If the honest answer is that managing categories needs an op, then **do not build a category manager** — report that instead, and route only the rules manager.
- [ ] **Step 4:** Commit.

---

### Task 6: Gate

- [ ] `bash scripts/v2-check.sh` → OK, and `git status --porcelain internal/v2/webui/dist` empty afterwards (Task 0).
- [ ] `cd web && bun run test` and `bunx tsc -b` clean on a quiet tree.
- [ ] Report which screens are now routed and which remain unrouted with the reason.

## Explicitly out of scope, and why

Plan/targets/envelopes, projects, recurring, accounts and reports all need op kinds the fold does not have. Each is a schema migration, a fold change, a conformance-suite change and a client change — and the op design deserves its own thought, because an op is permanent in an append-only log. They stay unrouted until then. **Do not partially build one**; a screen that reads real data and silently drops writes is worse than an absent screen.
