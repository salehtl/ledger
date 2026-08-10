# Onboarding Third Pass Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The walk remembers what the user did, stops asking what mail can prove, and turns Google's confirmation into one tap — so finishing onboarding is final.

**Architecture:** Three defects share one root: the walk trusts *derived* facts over *recorded* ones. `resumeFacts` re-derives `forwardingDeclared` from "has trusted mail arrived" (`web/src/v2/onboarding.ts:567`), so the user's declaration evaporates on every reload and BootGate bounces them back into "Send your bank mail here". The fix direction is uniform: a user's answer is a fact, recorded where `skipped` already lives (`LocalOnboardingRecord`); the world's answers (which bank, which provider, has mail arrived) are *statuses* read from evidence, never questions. The bank step leaves the walk entirely (verified: the declared list never reaches parsing — templates key on the verified domain, `internal/v2/ingest/pipeline.go:618`); the provider picker collapses into optional expanders; the held Gmail confirmation becomes a task whose primary action opens the extracted, domain-pinned link.

**Tech Stack:** React 19 + TypeScript (web/), vitest + jsdom, the existing pure-module conventions in `web/src/v2/`.

## Global Constraints

- Copy is plain and short: simple words, one idea per sentence. Do not re-lengthen copy that was deliberately shortened.
- The 12 load-bearing qualifications asserted by `web/src/screens/onboarding/qualifications.test.tsx` must all still render on screens (never inside an InfoTip). Keep that suite green.
- No new op type; `SCHEMA_VERSION` stays 3. This plan authors **no ops at all**.
- Account creation stays a hard gate (`signed_in`, `invited`, `keys_secured`). Nothing here softens a security step.
- Motion from `lib/motion`; never `opacity: 0` in an `initial` prop for first-paint content.
- Every test must be **proven to bite**: mutate the implementation, watch the test fail, revert, note it in the commit or report.
- Shared git index: never `git add -A` / `git commit -a`; always pass explicit pathspecs to `git commit` itself.
- `cd web && bunx tsc -b` clean and `bun run test` green before every commit. Do **not** run `bun run build` (the coordinator owns the bundle rebuild).

---

### Task 1: Remember the user's answers — kill the resume loop

**Files:**
- Modify: `web/src/v2/onboarding.ts` (LocalOnboardingRecord ~:492, `encodeLocal`/`decodeLocal` ~:514-540, `resumeFacts` ~:552-575, module header ~:33-60)
- Modify: `web/src/screens/onboarding/Onboarding.tsx` (the `onFinish` path, ~:369)
- Test: `web/src/v2/onboarding.test.ts`, `web/src/screens/onboarding/notAGate.test.tsx`

**Interfaces:**
- Produces: `LocalOnboardingRecord` gains `forwardingDeclared: boolean` and `finishedAt: string | null`. `LOCAL_RECORD_KEYS` becomes `["inboundAddress", "skipped", "forwardingDeclared", "finishedAt"] as const`. `resumeFacts` honours both. Tasks 2–4 rely on these exact names.
- Consumes: nothing from other tasks. **This task runs first.**

The defect, verbatim from `web/src/v2/onboarding.ts:566-567`:

```ts
    // DEMONSTRATED, not remembered. Mail in the log is the only evidence a
    // forward works, and it is evidence a second device has too.
    forwardingDeclared: args.firstMailConfirmedAt !== null,
```

Declaring forwarding and *demonstrating* it are different facts. The declaration is the user's part and must be remembered (exactly as `skipped` is); arrival stays a status (`mailStatus`). And once "Open ledger" is tapped, this device must never re-enter the walk — `finishedAt` is the belt over that suspender: even if a future fact regresses, re-entry is impossible on a device that finished.

- [ ] **Step 1: Write the failing regression tests** (in `web/src/v2/onboarding.test.ts`):

```ts
describe("the walk remembers what the user did", () => {
  it("keeps a declared forward across a reload, before any mail arrives", () => {
    // The user declares; the device reloads; no mail has ever arrived.
    const declared = reduce(initialFacts(), { type: "forwarding_declared" });
    const resumed = resumeFacts({
      hasSession: true,
      accountId: "acct-1",
      keysReady: true,
      banks: [],
      inboundAddress: "u-x@in.sirdab.ae",
      firstMailConfirmedAt: null, // Google's confirmation still held; nothing trusted yet
      homeCurrency: "AED",
      local: decodeLocal(JSON.parse(JSON.stringify(encodeLocal(declared)))),
    });
    expect(resumed.forwardingDeclared).toBe(true);
    // THE loop: this must never again resolve to the forwarding screen.
    expect(stepFor({ ...resumed, skipped: resumed.skipped })).not.toBe("address_issued");
  });

  it("a finished device never re-enters the walk, even if a fact regresses", () => {
    const finished = resumeFacts({
      hasSession: true,
      accountId: "acct-1",
      keysReady: true,
      banks: [],
      inboundAddress: null, // regressed: address fetch failed on this launch
      firstMailConfirmedAt: null,
      homeCurrency: null,
      local: { inboundAddress: null, skipped: [], forwardingDeclared: false, finishedAt: "2026-08-09T18:00:00Z" },
    });
    expect(onboardingComplete(finished)).toBe(true);
  });

  it("a record from the previous build (no new keys) still decodes", () => {
    const r = decodeLocal({ inboundAddress: "u-x@in.sirdab.ae", skipped: ["home_currency_set"] });
    expect(r).not.toBeNull();
    expect(r!.forwardingDeclared).toBe(false);
    expect(r!.finishedAt).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify they fail.** `cd web && bunx vitest run src/v2/onboarding.test.ts` — expect the first to fail on `forwardingDeclared` being `false` after resume, and type errors on the new record fields (that is the point).

- [ ] **Step 3: Implement.** In `web/src/v2/onboarding.ts`:

```ts
export interface LocalOnboardingRecord {
  /** A resume hint, not a display value. See the header. */
  inboundAddress: string | null;
  /** The steps this person said "later" to. (existing doc comment stays) */
  skipped: readonly SkippableStep[];
  /**
   * The user said "I have set this up" on the forwarding screen.
   *
   * A DECLARATION, not a demonstration — mail arriving is still the only
   * evidence the rule works, and {@link mailStatus} still reports that
   * separately. But the declaration is the user's answer to a question, and a
   * question answered must stay answered: deriving this from mail arrival made
   * the walk bounce every finished user back to "Send your bank mail here"
   * until the world happened to respond (2026-08-09, the resume loop).
   */
  forwardingDeclared: boolean;
  /**
   * When "Open ledger" was tapped on this device, or null.
   *
   * Once set, this device NEVER re-enters the walk. The walk is a corridor for
   * account creation and first setup; everything after it is a task in
   * SetupStatus/Settings. Without this, any future fact that regresses (an
   * address fetch failing offline, a milestone redefined) silently drags a
   * finished user back into onboarding — the exact class of bug this field
   * retires. A second device does not inherit it and walks once; that is
   * correct, and mail already flowing means it walks straight through.
   */
  finishedAt: string | null;
}

export const LOCAL_RECORD_KEYS = ["inboundAddress", "skipped", "forwardingDeclared", "finishedAt"] as const;
```

`encodeLocal` carries the two new fields off `OnboardingFacts` (add `finishedAt: string | null` to `OnboardingFacts`, default `null` in `initialFacts`, set by a new reducer event `{ type: "finished"; at: string }`). `decodeLocal`: absent keys read as `false` / `null` (a record from the previous build is complete in every way that decides a step — mirror the existing comment style). In `resumeFacts`:

```ts
    forwardingDeclared: local?.forwardingDeclared === true || args.firstMailConfirmedAt !== null,
```

and derive `setupSeen` as before **or** `local?.finishedAt != null` (find the existing `setupSeen` derivation just below `base` and OR it in; keep `onboardingComplete` untouched).

In `Onboarding.tsx`, the Finish screen's `onFinish` dispatches `{ type: "finished", at: new Date().toISOString() }` through the same commit path that already persists the record after `forwarding_declared` / skip events (find where `encodeLocal` is written to the secret store on state change — the persistence seam already exists for `skipped`; the event only needs to flow through it).

- [ ] **Step 4: Run the suite.** `bunx vitest run src/v2/onboarding.test.ts src/screens/onboarding/` — all green, including `notAGate.test.tsx` and `qualifications.test.tsx` untouched.

- [ ] **Step 5: Prove the tests bite.** Revert the `resumeFacts` line to `args.firstMailConfirmedAt !== null` alone → test 1 fails. Set `finishedAt` handling to ignore the local field → test 2 fails. Restore.

- [ ] **Step 6: Commit.**

```bash
git add web/src/v2/onboarding.ts web/src/v2/onboarding.test.ts web/src/screens/onboarding/Onboarding.tsx
git commit -m "fix(onboarding): a question answered stays answered" -- web/src/v2/onboarding.ts web/src/v2/onboarding.test.ts web/src/screens/onboarding/Onboarding.tsx
```

---

### Task 2: The bank question leaves the walk

**Files:**
- Modify: `web/src/v2/onboarding.ts` (`ONBOARDING_STEPS` :102, `MILESTONES` :307, `SKIPPABLE_STEPS` :148, `STEP_TITLES`/screen table ~:771-801, `remainingSetup`)
- Modify: `web/src/screens/onboarding/Onboarding.tsx` (drop the Bank screen from the walk)
- Delete: `web/src/screens/onboarding/Bank.tsx` + its test **if and only if** nothing else imports it (`grep -rn "from \"./Bank\"\|onboarding/Bank" web/src` first; Settings uses `components/BankPicker` directly, so expect it dead)
- Test: `web/src/v2/onboarding.test.ts`, `web/src/screens/onboarding/Onboarding.test.tsx`

**Interfaces:**
- Consumes: Task 1's record shape (rebase on its commit).
- Produces: `ONBOARDING_STEPS` without `"banks_declared"`; `SkippableStep` narrows accordingly. Task 3/4 do not read these; Settings' `remainingSetup` consumers must not list a bank task any more.

Why this is safe, so the implementer does not re-litigate it: the declared bank list **never reaches parsing** — `templatesFor(ctx, domain)` selects templates by the message's verified domain (`internal/v2/ingest/pipeline.go:618`), and nothing in the pipeline reads the declaration. The question is UI habit. Banks remain manageable in Settings (already built); the walk simply stops asking. A stored `skipped: ["banks_declared"]` from an old record must decode without error and be ignored.

- [ ] **Step 1: Failing tests.**

```ts
it("never asks which bank", () => {
  expect(ONBOARDING_STEPS).not.toContain("banks_declared");
  // A fresh account with keys and nothing else goes straight to the address.
  const f = { ...initialFacts(), hasSession: true, accountId: "a", keysReady: true };
  expect(stepFor(f)).toBe("keys_secured"); // next screen: address, not bank
});

it("an old record that skipped the bank step still decodes and is ignored", () => {
  const r = decodeLocal({ inboundAddress: null, skipped: ["banks_declared", "home_currency_set"] });
  expect(r).not.toBeNull();
  expect(r!.skipped).toEqual(["home_currency_set"]); // unknown steps filtered, not refused
});
```

- [ ] **Step 2: Run, watch them fail** (`banks_declared` present; decode currently keeps it or refuses).
- [ ] **Step 3: Implement.** Remove `"banks_declared"` from the three tables and the screen map; in `decodeLocal`, filter `skipped` through `isSkippable` (it may already — verify, and keep the "unreadable skips read as none" behaviour). Remove the Bank screen import/branch from `Onboarding.tsx`. Delete `Bank.tsx` + test if unimported. Update `remainingSetup` so no bank task is emitted.
- [ ] **Step 4: Full onboarding suite green**, including `SetupStatus.test.tsx` (its task list must not name a bank).
- [ ] **Step 5: Bite.** Re-add `"banks_declared"` to `ONBOARDING_STEPS` → both new tests fail. Restore.
- [ ] **Step 6: Commit** with explicit pathspecs, message `feat(onboarding): the bank is inferred from mail, not asked`.

---

### Task 3: The provider fork becomes an expander

**Files:**
- Modify: `web/src/screens/onboarding/Address.tsx` (the `phase === "forwarding"` branch, ~:235 on; the provider picker currently rendered as a fork)
- Modify: `web/src/v2/providers.ts` only if copy strings need the generic lead (do not restructure it)
- Test: `web/src/screens/onboarding/Address.test.tsx`

**Interfaces:**
- Consumes: nothing new. Independent of Tasks 1–2 except shared test files' imports.
- Produces: no exported shape change. The `providerId` state stays internal to the screen.

The screen leads with **one generic instruction set**, true everywhere — "In your mail app, make a rule: mail from your bank forwards to this address." — with the address card and copy button above it. Provider-specific steps (Gmail / iCloud / Outlook) become collapsed expanders ("Show the Gmail steps"), not a fork the user must answer before seeing anything. The existing `GENERIC` provider copy is the lead; the pickers' per-provider `caveat`s (load-bearing) render inside their expanders, still as `Notice`, still on-screen-when-open. The confirmation sentence stays generic and truthful: "If your provider sends a confirmation, it appears in Held mail — ledger will point you at it."

- [ ] **Step 1: Failing tests.**

```ts
it("shows the forwarding instructions without asking who the provider is", () => {
  renderForwarding(); // existing helper for phase "forwarding"
  expect(screen.getByTestId("forwarding-generic")).toBeInTheDocument();
  expect(screen.queryByTestId("provider-picker")).toBeNull(); // no fork
  // Provider help exists, collapsed, and is optional:
  expect(screen.getByRole("button", { name: /gmail/i })).toBeInTheDocument();
});

it("expanding Gmail shows its steps and its caveat, on screen", async () => {
  renderForwarding();
  await user.click(screen.getByRole("button", { name: /gmail/i }));
  expect(screen.getByTestId("provider-steps-gmail")).toBeInTheDocument();
});
```

- [ ] **Step 2: Run, fail** (picker exists today).
- [ ] **Step 3: Implement** the expander (plain `<details>`-style disclosure or the codebase's existing pattern — check `components/` for a disclosure primitive before inventing one; if none exists, a `useState`-per-provider list of `Pressable` headers is fine and needs no new shared component).
- [ ] **Step 4: Suite green**, including the 12 qualifications (the four `TRUST_ONLY_YOUR_BANK` clauses and provider caveats must still render).
- [ ] **Step 5: Bite.** Hide the caveat inside the collapsed state permanently (never render) → qualification/caveat test fails. Restore.
- [ ] **Step 6: Commit**, `feat(onboarding): one instruction set, provider help on request`.

---

### Task 4: Google's confirmation is one tap

**Files:**
- Modify: `web/src/v2/verificationCode.ts` (new pure helper at the bottom)
- Modify: `web/src/screens/onboarding/SetupStatus.tsx` (the task list)
- Modify: `web/src/app/AppShell.tsx` (feed held items to SetupStatus)
- Modify: `web/src/screens/onboarding/Address.tsx` (same task shown on the forwarding screen when present)
- Test: `web/src/v2/verificationCode.test.ts`, `web/src/screens/onboarding/SetupStatus.test.tsx`

**Interfaces:**
- Consumes: `readQuarantine` (`web/src/v2/onboardingIO.ts:262`), `couldBeConfirmation` / `verifiedOuterDomain` / `scanForCode` (all exported from `verificationCode.ts`), `QuarantineItem.blob` via `include_blob`.
- Produces: `export function confirmationTask(items: readonly QuarantineItem[]): { domain: string; url: string | null; code: string | null; itemId: string } | null` — Task 5's copy review and AppShell both read exactly this shape.

The pieces all exist — candidate detection, the domain-pinned link scan, the held blob — and no surface composes them. `confirmationTask` picks the **newest** candidate (`couldBeConfirmation`), scans its blob with `linkHost` = its verified outer domain, and returns the link/code. SetupStatus renders it as its **first** task: "Google needs one tap to start forwarding" with a primary action that opens `url` (`window.open(url, "_blank", "noopener")`) — the one place a tooltip is wrong and a button is right. No `url` extracted → the action falls back to `onOpenHeldMail` (never a dead end). The blob is only scanned, never rendered here; scanning is already ReDoS-bounded by the module's four rules.

- [ ] **Step 1: Failing tests** (pure helper first):

```ts
it("finds the newest confirmation and its pinned link", () => {
  const items = [
    heldItem({ id: "old", receivedAt: "2026-08-09T10:00:00Z", outerDomain: "google.com", dkim: "pass", arc: "pass", blob: b64(GMAIL_CONFIRM_BODY) }),
    heldItem({ id: "new", receivedAt: "2026-08-09T15:15:34Z", outerDomain: "google.com", dkim: "pass", arc: "pass", blob: b64(GMAIL_CONFIRM_BODY) }),
    heldItem({ id: "bank", innerDomain: "dib.ae", attested: true }), // never a candidate
  ];
  const task = confirmationTask(items);
  expect(task?.itemId).toBe("new");
  expect(task?.url).toMatch(/^https:\/\/([a-z0-9-]+\.){0,4}google\.com\//);
});

it("returns null when nothing could be a confirmation", () => {
  expect(confirmationTask([heldItem({ outerDomain: "gmail.com", dkim: "fail", arc: "none" })])).toBeNull();
});
```

(`GMAIL_CONFIRM_BODY` reuses the existing `GMAIL` fixture in `verificationCode.test.ts`.)

- [ ] **Step 2: Run, fail** (`confirmationTask` undefined).
- [ ] **Step 3: Implement the helper**, then the SetupStatus task row (test: renders the domain, tapping calls the injected `openUrl` seam — inject `openUrl?: (u: string) => void` as a prop, defaulting to `window.open`, exactly the codebase's test-seam pattern), then AppShell's `useQuery` over `readQuarantine(handle, { includeBlob: true })` gated on `mailStatus(facts) !== "arrived"` so it costs nothing once mail flows.
- [ ] **Step 4: Suites green.**
- [ ] **Step 5: Bite.** Make `confirmationTask` return the oldest item → newest test fails. Let `url` pass unpinned (scan without `linkHost`) → the pinned-host regex fails on a body carrying an attacker link. Restore.
- [ ] **Step 6: Commit**, `feat(onboarding): the provider's confirmation is one tap, surfaced where the user is`.

---

### Task 5: UX pass (apple-design) + copy audit

**Files:** whatever Tasks 1–4 touched; no new surfaces, **no new motion**.

The checklist, produced by running the apple-design skill over this plan (Agency, Simplicity, Wayfinding, the feedback taxonomy, Restraint). Verify each on the built screens; land findings as small commits proven by the existing suites:

- [ ] **The confirmation task reads as status, never error.** No red, no warning tone. Title "One tap to start forwarding"; body "Your mail provider sent a confirmation. Open it to switch forwarding on."; primary action **"Open the confirmation"** (specific, names the consequence); the verified domain shown verbatim beneath as evidence, no prettifying. First task in the list.
- [ ] **Expanders are quiet disclosures.** 44px `Pressable` headers, chevron state, content appears below its header (grouping: control next to what it affects). **No bespoke animation** — either none, or the codebase's existing pattern; nothing new from `lib/motion`. A collapsed caveat must still render when its provider is opened (the qualifications suite guards this).
- [ ] **Labels are direct and specific.** "Show the Gmail steps", never "More options". "I have set this up" on the forwarding declaration, and its consequence is final (Familiarity: tapping it again never re-asks).
- [ ] **The waiting line is calm and resolves in place.** "Waiting for your first bank email" in muted text; when mail arrives it resolves without fanfare — text change, not celebration.
- [ ] **No trap in either direction.** Walk → product is final (`finishedAt`); verify nothing only the walk can do is lost to a finished device (home currency, address, forwarding instructions, verification — all confirmed reachable in Settings). The confirmation task with no extractable URL falls back to opening held mail — never a dead end.
- [ ] **Restraint.** No animation added anywhere by Tasks 1–4; entrance rules unchanged; nothing pulses for attention.

---

## Execution notes (coordinator)

- Order: Task 1 → Task 2 (same files, same agent or sequential); Tasks 3 and 4 in parallel after 2 (disjoint files — 3 owns `Address.tsx`, 4 owns `SetupStatus/AppShell/verificationCode`; both touch `Address.tsx`? **No** — Task 4's Address change is one conditional render; sequence 4 after 3 or give 4 the Address diff as a follow-up commit after 3 lands. Simplest: 3 then 4's Address bit; 4's other files parallel with 3.)
- After all tasks: coordinator rebuilds the bundle, runs `scripts/v2-check.sh`, merges, deploys per `deploy/README-v2.md` §4.1 (including `verify --repair-usage` — not needed here, no schema change, but the hash check is).
- Known non-goals, recorded: automatic `bank_declared` authoring from confirmed senders needs template→domain metadata the API does not expose (SupportedBank carries `id` and `templates` only, `onboardingIO.ts:98-103`) — follow-up, server-side. Provider inference for tailored help post-hoc — follow-up. Neither blocks anything above.
