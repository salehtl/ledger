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

### F5 — The passkey row slices its own badge · low · overflow

At 320px the passkey row put the authenticator name and the "This device" pill
inside one `truncate`. `text-overflow: ellipsis` only ever applies to text, so
the ellipsis landed correctly on the name and the **pill beside it was cut 3px
short**. The name truncates now and the badge is `shrink-0`, which is the way
round it should have been.

Found by a check that did not exist before: `audit.mjs` only looked at leaf text
nodes whose own box clips, and missed the commoner shape — a container with
`overflow-hidden` whose *children* run past its edge. The new
`content-clipped-horizontally` check reports `hidden`/`clip` only, because an
`auto`/`scroll` container whose content is wider is not cut off, and it names the
worst offending child rather than saying "some box is too wide".

**Evidence:** 8 hits on its first run, all this one element across the Settings
scroll positions; 0 after.

---

### F6 — The review card lost three digits off a large amount · medium · overflow

`clamp(1.75rem, 9vw, 3rem)` has a **floor**, and a floor is what clips. At 35px a
tabular glyph advances 0.6em and the card's amount box is 214px, so past ten
glyphs the figure runs off the end of a card that clips its overflow.

The reviewer who filed this called it "everyday amounts", which measurement did
not support — it fits comfortably at −430.00. The true threshold is **six
figures**: rent, a car, a transfer, a property payment. Recorded because a
finding whose severity is wrong is still worth having, and because the honest
number is what justified the fix.

The size is now also capped at whatever makes *this* string fit, using the amount
box's own width (`100cqw`). Ordinary amounts are byte-identical at 35px.

**Evidence:** `harness/v2deck.mjs`, a new runner that walks the whole deck with
its own "Skip for now" rather than auditing only the top card. Before: 13 fit,
`−9,999,999.99 … 60px is cut off`. After: 14 fit, that amount at 19px.

The runner also caught a regression I introduced while fixing it — `containerType`
without `w-full` collapsed the box and pinned every hero at its floor — and then
had to be taught not to be fooled: taking the biggest `.tnum` picked the merchant's
initial-letter avatar and cheerfully reported "hero E at 30px fits" fourteen
times. It requires a digit now.

---

### F7 — The left edge of every drill-in was dead · high · unreachable

Two costs from one 24px `touch-none` overlay, and **two of the eight code
reviewers found it independently**:

- **The back arrow had a dead left half.** It starts at x=8 (`-ml-2`) and the
  strip covered 0..24, so a press there began a drag that never moved and the
  click landed on an `aria-hidden` div. A tap at x=12 did nothing; the same tap
  at the centre worked.
- **Nothing scrolled from that column**, down the whole height of every drill-in.

The gesture is armed from the panel now and the strip is `pointer-events-none`,
kept only as the harness's handle. The header takes `relative z-20`.

**Evidence:** `harness/v2edge.mjs`, five checks, all passing; two of them fail
when the old strip is put back, one naming the culprit —
`blocked by div[edge-back-strip]=none`.

Two of those five exist because the obvious way to write them was wrong, and the
second is the more useful lesson:

- The scroll check asserts the computed `touch-action` chain rather than
  performing a scroll. `Input.synthesizeScrollGesture` does not drive a *nested*
  scroller in headless Chromium — a **control gesture from the middle of the same
  panel moved it 0px too**. Without that control this file would have reported a
  product bug that was its own.
- The edge drag is checked with a mouse *and* a real touch gesture, because a
  mouse ignores `touch-action` entirely and so proves nothing about the risk this
  particular change takes.

---

### F8 — A sheet that opens onto a field took two taps · high · friction

`Dialog` had a guard for exactly this, and it could never fire: it looked for
`panel.querySelector("[autofocus]")`, and **React renders no `autofocus`
attribute** — it focuses the node during commit and leaves nothing behind.
`render(<input autoFocus />)` produces exactly `<input>`, measured rather than
assumed. So the query matched on no sheet in the app, the `else` branch ran every
time, and the two-tap behaviour the code comment describes as fixed was still
shipping. Five sheets pass `autoFocus`; search is the one that stings, because a
search sheet with no caret in it is a sheet that did not open.

It now asks where focus already is, which works whatever put it there.

**Evidence:** two tests, one per branch. The first fails against the old guard.

---

### F9 — Undo was a 20px target · high · friction

A toast's action and dismiss were bare text — one `text-sm` line each, about 20px
tall and 12px apart. That is the app's least forgiving pair of targets on its most
time-limited surface: the action is usually **Undo**, `SwipeDeck.undoCommit` is
one-shot, and it is gone in five seconds. A press that missed hit the dismiss,
which *spends* the toast rather than using it.

Both are 44px now, with the type unchanged. The dismiss is the `X` pixel icon —
this was the last place in the app using a typographic glyph as a standalone
icon, against the catalog's own rule.

**Evidence:** existing Toast and Storybook tests pass; the catalog is updated in
the same commit. Note the gap this exposes: **no capture run has ever had a toast
on screen**, so `audit.mjs`'s 44px check could not have caught it. A harness that
raises a toast is worth building.

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

## The backlog, and how much to trust each row

Eight reviewers read the eight surfaces of the app against the brief and filed
**119 candidate findings** — 26 high, 68 medium, 25 low. Those are candidates,
not facts: a reviewer that has read one file will confidently report something a
parent component already handles. Every one that was acted on in this branch was
re-measured first, and two of them turned out to be overstated (see F6, and the
"partly" row below).

Three levels of confidence, and the register says which applies:

1. **Fixed and measured** — F1 to F9 above. Each has a command whose output says
   so, and most have a mutation test proving the check bites.
2. **Verified by a reader who tried to refute it** — 19 of the 21 unfixed
   high-severity candidates were each given to an agent told to REFUTE, with
   instructions to read the parents, the CSS and the docs before agreeing. One
   came back refuted, three were softened, the rest are below with a repro and a
   smallest-fix. (Two were still running when the branch was closed out.)
3. **Filed but unverified** — the 68 medium and 25 low candidates. Worth reading,
   worth nothing until someone checks.

**A warning about that verification pass, for whoever runs the next one.** The
agents wrote scratch test files into the worktree — `scratchFinish.test.tsx`,
`Quarantine.probe.test.tsx`, `ScratchWindowTotal.test.tsx`,
`DialogExitProbe.test.tsx` — and deleted them again. Three separate gate runs
failed on the wreckage: a stale `tsconfig.tsbuildinfo` naming a file that no
longer existed, and vitest loading a path that vanished mid-run. Nothing was lost
and no real test failed, but **check `git status` for strays before trusting a
red gate that ran alongside a review fleet.**

### Verified, not yet fixed

Ordered by what a user loses. Each was read against the real code by a skeptic
and survived; each carries a repro and a smallest-fix from that reading.

| what breaks | where | severity | fix risk |
|---|---|---|---|
| **A hand-typed transaction can be saved and then appear nowhere.** `saveManual` says nothing on success, so the row appearing in the list is the only feedback — and the optimistic row is filtered by the current period, segment and chips like every other. Enter one outside the open filter and it is saved, invisible, and unacknowledged. The natural response is to type it again, and a manual `ingest_id` is random rather than a content hash, so the second entry is a second real transaction. | `screens/Transactions.tsx` | **high** | small |
| **The held-message form never receives its parsed prefill.** `useState(initial)` reads its argument once and the sheet mounts before the prefill resolves, so the draft stays empty — while the copy says the fields were filled in for you. | `screens/HeldMessageSheet.tsx` | **high** | small |
| **Sorting a card can write a permanent merchant rule that contradicts an earlier one.** The write-back is skipped only when pattern AND category both match, and Review passes only the folded projection's rules — so a second, different answer authors a second permanent `exact` rule, and v2 has no way to remove one. `Transactions.tsx` already merges all three places a rule can live; Review does not. | `screens/Review.tsx` | **high** | small |
| **A failed "Trust this sender" renders its error behind the still-open sheet.** `setOpen(null)` is inside the `try`; the catch sets a message that renders in the page body, underneath the Dialog. The user sees nothing happen. | `screens/Quarantine.tsx` | **high** | small |
| **"Always use this category for X" authors a rule nothing ever applies.** The op is real and replay folds it into `State.rules`, but no code in `web/` matches a merchant against that table. The switch promises an automation the app does not perform. | `screens/Transactions.tsx` | **high** | small (copy) |
| **The finish screen tells a user who skipped setup three things that are false** — "nothing else needs configuring", mail arriving at an address they do not have, totals in a home currency they never set. A fourth clause promises editable exchange rates and no screen in the app can set one. Verified by driving the real walk with every optional step skipped. | `onboarding/Onboarding.tsx` (Finish) | medium | small |
| **"N transactions · X spent" counts only the loaded page**, not the period — `listTransactions` caps at 50, grown to 150 by "Show older", and the sentence never says so. | `screens/Transactions.tsx` | medium | small |
| **One unreadable row refuses the whole import**, with no way to drop it from inside the app. Partly overstated: the all-or-nothing rule is deliberate and documented (the preview is the consent). What is missing is a way to act on it. | `screens/ImportFile.tsx` | medium | medium |
| **The halt wall over a live app prints "Try again" and deliberately withholds every control.** Four of the six halt copies tell the user to do something, and the wall renders no button — the suite even pins the absence. A wall that names an action and then does not offer it is the dead-end rule inverted. | `v2/BootGate.tsx` | **high** | small |
| **Every row in the Insights drill-down presses and does nothing.** The rows are still `Pressable`, still announce "Open ⟨merchant⟩", and the sheet passes no `onOpen`. | `insights/ProjectionDrillSheet.tsx` | medium | small |
| **Deleting an account can pin the button at "Deleting…" forever.** The local wipe is outside the try, and `setBusy(false)` only exists in the other catch, so a rejected wipe is swallowed and the screen never moves. | `settings/DeleteAccountPanel.tsx` | medium | small |
| **The fatal wall tells a user whose account-delete wipe failed that nothing was lost.** `classify` routes that failure into the same arm as "the database would not open", so it shows copy written for a different accident. | `v2/BootGate.tsx` | medium | small |
| **`RecoverWritePanel` blames the recovery phrase for every failure**, including being offline: one `try` wraps a fetch, the Argon2id unwrap and a second fetch, and the single catch says the words were wrong. | `settings/RecoverWritePanel.tsx` | medium | small |
| **Stepping the month blanks the whole Insights screen** — the snapshot query has no placeholder, so each step falls to a skeleton and replays the chart entrance. Same shape as the transaction-list flicker fixed in F12, and the same one-line remedy. | `screens/Insights.tsx` | medium | small |

### One refuted, and one softened

- **"One tap on the address step's *Set this up later* silently skips two steps"** —
  **refuted.** Deliberate, documented at the cited line, and pinned by a test: the
  address and the forwarding rule are one subject, and a forwarding screen with no
  address on it is instructions pointing at nothing. A reviewer reading only the
  call site could not see that. The verifier's one carry-over is a copy nit on
  `SKIP_COPY.address_issued.consequence`.
- **The swipe card's hero "clipped at everyday amounts"** — softened to six
  figures by measurement before being fixed (F6).

These two are the shape of the false positives, and the reason the fixed list is
shorter than the filed list.

### F10 — The recovery step's failure had nothing on it to press · high · dead-end

Verified, then fixed. `RecoveryStep`'s failed branch rendered a title and a
`Notice` and no controls; the step is deliberately not skippable, so the only way
off it was force-quitting the app — which is what the copy asked for. Worse,
`failed` was only ever set to true, so a device that came back online kept the
error on the glass.

**Evidence:** three tests against an empty vault and a refused `/api/v1/keys`;
two fail when the footer is removed again.

---

### F11 — Every tab opened at the last screen's scroll position · medium · friction

One `<main>` scroller, children swapped without a key, nothing zeroing it. Scroll
down Transactions, tap Home, and Home opened part-way down. Tapping the tab you
are already on did nothing, where every iOS app returns to the top.

**Evidence:** two tests, both failing when the reset and the re-tap are removed.

---

### F12 — Two small ones with an outsized effect · medium

- **The list tore down to a skeleton on every keystroke.** Filters and limit are
  in the query key, so each change produced a key react-query had never seen and
  `data` went `undefined` — skeleton, and the scroll position with it.
  `placeholderData: keepPreviousData`, scoped to that one query.
- **Home painted a bucket bar in the over-budget red when there is no budget.**
  The bar is a *share*, so a month where everything went to Needs is `pct = 1.0`,
  and `derivePaceStatus` read that geometrically. Red telling a user they
  overspent a limit they never set.

---

## Notes that are not findings

- **`SettingsPage` does not close on Escape.** Correct on a phone (there is no
  keyboard) and it has both a back button and an edge-swipe. Recorded because it
  surprised the harness, not because it is wrong.
- **`/api/v1/keys` and `/api/v1/push/vapid` 404 on the scratch stack**, four times
  each during the walk. Expected on a stack with no VAPID configured; worth a look
  only if they also 404 in production.
