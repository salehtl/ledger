# ledger 2.0 UX refinement — findings register

Companion to `2026-08-09-v2-ux-systematic-refinement.md`. One row per finding:
what a user does, what goes wrong, what was changed, and the evidence it is fixed.

Findings deliberately **not** fixed stay here with the reason, so "we looked and
chose not to" is distinguishable from "we missed it".

**Evidence column rule:** a finding is only "fixed" when a command's output says
so. Not "the code now looks right".

---

## Fixed

### F1 — A tooltip opens 170px off the side of the screen · high · overflow

**Where:** `web/src/components/ui/InfoTip.tsx`, and every one of its six call
sites.

**What a user does:** taps the ⓘ next to "Where does your bank mail arrive?" on
the forwarding step of onboarding.

**What goes wrong:** the explanation panel opens from x=272 and is 288px wide, on
a 390px screen. 170px of it is off the right edge and unreadable. The same tip in
the Forwarding-instructions sheet loses 162px; the export sheet's loses 6px.

**Why nothing caught it:** the panel was `absolute left-0` with
`w-[min(18rem,calc(100vw-2rem))]`. **A width cap is not a position cap.** jsdom
has no layout, so every vitest assertion about this measured a zero-sized
rectangle; Storybook renders the component alone, where there is no edge to cross.
`align="end"` was not a fix either — it moves the same overflow to the other side,
because both alignments are anchored to a trigger that is itself near an edge.

**Fix:** the panel measures itself on open, in a `useLayoutEffect` so it lands
before paint, and shifts along x by whatever keeps it inside the viewport with a
16px gutter. It also flips above the trigger when there is no room below. The
shift is a `margin`, not a `transform`, because the entrance animates `y` through
Framer and a second transform on the same element would fight it. `align` survives
as the *preferred* side; collision handling overrides it when preference does not
fit.

**Evidence:** `node harness/v2shoot.mjs` — **14 tips measured across 390px light,
390px dark and 320px light; 0 off-screen.** Before: `panel 272..560 in a 390px
viewport — 170px past the right edge`. After: `panel 86..374 inside 390px`, and
`16..304 inside 320px`.

---

### F2 — Finishing setup puts you back on the step you just finished · high · dead-end

**Where:** `web/src/v2/onboarding.ts`.

**What a user does:** declares forwarding ("I have set up forwarding"), picks a
home currency, reaches "That is setup done", and presses **Open ledger**.

**What goes wrong:** they land back on "Send your bank mail here" — the step they
just completed — with no explanation. The only way through is to answer "Set this
up later" to something they already did.

**Why:** `done()` re-runs boot, and `resumeFacts` derives `forwardingDeclared`
from `firstMailConfirmedAt` alone — *demonstrated, not remembered*, which is the
right rule and stays. But the user's declaration was an in-memory fact that
nothing wrote down, so at the next boot the `forwarding_configured` milestone was
unmet, it was not in `skipped` either, and `stepFor` walled on it. This directly
contradicts the product principle that a refusal must never be a dead end, and the
spec that onboarding proposes and never blocks.

**Fix:** a second device-local list beside `skipped` — `answered`, the steps the
user says they have *done* where doing it leaves no evidence until later. It never
makes anything true: the milestone stays unmet, `remainingSetup` still lists the
step, and Home still shows the task until real mail arrives. It only stops the
walk treating an unverifiable claim as a wall. Nothing is recorded once mail has
proved it, because then the milestone is met by evidence and a claim adds nothing.

**Evidence:** 5 new tests in `src/v2/onboarding.test.ts`, including one that pins
the *old* behaviour so the regression stays visible. Proved to bite by mutation:
dropping the `isAnswered` check in `stepFor` fails "lets the walk continue once the
declaration is recorded"; dropping the field from `decodeLocal` fails that plus
"filters an answered step by the same rule as a skipped one". Restored: 52/52 pass.
End to end, `harness/v2shoot.mjs` no longer reports
`onboarding sent the walk back to "Send your bank mail here"` — 0 occurrences,
where every prior run had one.

---

### F3 — "20 transactions added to your ledger." then an empty ledger · high · copy-vs-code

**Where:** `web/src/v2/writer.ts` (root cause) and `web/src/screens/ImportFile.tsx`.

**What a user does:** imports a bank statement CSV. The screen confirms *"20
transactions added to your ledger."*

**What goes wrong:** Transactions says **"No transactions"**. Home says
**0.00**. Review says **"All caught up"**. The rows exist and are durable, but
nothing shows them until the app is relaunched.

**Root cause, and it is not where it looks.** `authored.ts` keeps the optimistic
memory of what this device has authored in a `WeakMap<Writer, Authored>` — the
only thing that puts a just-created row on a list before the next sync. That
keying is correct only if every screen holds the *same* `Writer` object, and
`writerFor(handle)` minted a fresh object literal on every call. So `ImportFile`
recorded 20 rows into its own store and the Transactions list read a different,
empty one. `outboxFor` next door already keyed on the handle, and `authored.ts`'s
own header claims to be keyed "exactly as `outboxFor` is" — it was not.

The second half: the projection only folds on launch, `visibilitychange` and
pull-to-refresh. `invalidateQueries` re-reads a projection that has not moved, so
Home and Insights stayed at zero even once the list was right.

**Fix:** (a) `writerFor` returns one stable `Writer` per handle, so the optimistic
store is per-device as intended; (b) after a successful import the screen pushes,
syncs and invalidates — not awaited and with failures swallowed, so an import on a
plane still completes exactly as it does online.

**Evidence:** `harness/v2debug.mjs`, same script before and after. Before:
`transactions body: … No transactions …`, and only `AFTER RELOAD: … 20
transactions | 10,003,230.09 spent …`. After: **20 rows on the first read, with no
reload.** 1120 existing tests in `src/screens` and `src/v2` still pass.

---

### F4 — The harness was measuring an empty app and calling it clean · high · instrument

Not a product defect, but it invalidated a whole round of results and is the exact
failure mode this repo keeps producing.

Because of F3, the first full harness run audited Transactions, Insights and
Review while all three were rendering their **empty states**, and reported every
one "clean (0 low)". Nothing was on the glass to be wrong.

**Fix:** `v2shoot.mjs` now asserts, after seeding, that the Transactions screen
actually shows at least as many rows as the importer accepted — and fails loudly
that "the findings that follow mean nothing" if it does not.

---

## Deliberately not fixed

### D1 — Every `Dialog` leaves the layer beneath it focusable · medium · a11y

**Measured:** `background-layer-not-inert` on all 10 Settings sheets, at all three
viewport/theme combinations — "27 control(s) on the screen underneath this overlay
are still focusable".

**Why it is being left, tonight:** the realistic paths are already covered.
`Dialog` sets `aria-modal="true"` (which VoiceOver and NVDA honour), runs a
hand-rolled Tab trap that cycles focus inside the panel, and puts a
pointer-blocking scrim in front. The remaining exposure is narrow.

**Why it is not a one-liner:** the sheet renders **inline** where it is used, not
through a portal, so its "background" is its own ancestors — there is no element
that can be marked `inert` without marking the dialog inert too. A real fix means
portaling `Dialog` to `document.body`, and `useScrollLock` walks
`rootRef.parentElement` to freeze ancestor scrollers; after a portal that chain is
`body` and the background-scroll lock silently stops working. That lock has its own
dedicated harness runner (`sheets.mjs`) which currently drives **v1** and would not
catch the regression.

**What it needs:** port `sheets.mjs` to the v2 stack first, then portal `Dialog`,
mark the app root inert while one is open, and delete the hand-rolled Tab trap in
the same commit. Sized as its own piece of work, not a drive-by.

---

## Notes that are not findings

- **`SettingsPage` does not close on Escape.** Correct on a phone (there is no
  keyboard) and it has both a back button and an edge-swipe. Recorded because it
  surprised the harness, not because it is wrong.
- **`/api/v1/keys` and `/api/v1/push/vapid` 404 on the scratch stack**, four times
  each during the walk. Expected on a stack with no VAPID configured; worth a look
  only if they also 404 in production.
