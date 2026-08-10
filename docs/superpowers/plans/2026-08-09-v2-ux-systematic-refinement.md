# ledger 2.0 — systematic UI/UX refinement

**Date:** 2026-08-09
**Branch:** `worktree-ux-refine` (isolated worktree; another agent holds `v2-pwa`)
**Applies to:** `web/` — the v2 PWA only. Nothing in `frontend/` (v1) is touched.

---

## 1. The brief, in the operator's words

> "I need a thorough UI/UX review of the app. We are building a mobile PWA. I don't
> want bullshit overflowing horizontally (e.g. tooltips). I don't want dumb UX
> patterns. I don't want unnecessary friction. The app should be intuitive and
> smooth. The design aesthetic should remain."

Four acceptance criteria, in the order they will be enforced:

1. **Nothing crosses the viewport edge.** At 390px and at 320px, in both themes.
2. **No dumb patterns.** No control that cannot be reached, no destructive action
   without an out, no state the user cannot get back from.
3. **No unnecessary friction.** Every tap on the path to a common task is counted
   and justified. Confirmations only where the action is irreversible.
4. **Smooth.** Response on pointer-down, 1:1 tracking, interruptible motion,
   velocity handoff. `apple-design` is the standard.

**The aesthetic is fixed.** Two-colour press, `--radius: 2px` everywhere, pixel
icons, dither texture, Geist. This work changes *geometry, behaviour and copy
placement*, never the visual language. Any change that would read as a restyle is
out of scope and gets recorded instead of made.

## 2. Why this needs an instrument before it needs opinions

`web/` has 300+ vitest files and a full Storybook. Neither can see the defects in
the brief. vitest renders in jsdom, which has no layout: a tooltip 148px past the
right edge measures the same as one inside it. Storybook renders a component in
isolation, so it never sees the bottom nav that covers the control.

The one v2 runner that reaches the real product, `web/harness/v2settings.mjs`,
covers **Settings and four dialogs**. Every other v2 screen — onboarding, Home,
Transactions, Insights, Review, held mail, and every sheet on them — rests on
vitest alone. `shoot.mjs`, `probe.mjs` and `nav.mjs` next door still drive **v1**;
pointing them at a v2 change reports a clean screen they never loaded.

So Phase 0 is not optional and it is not a detour. **Measuring geometry is the
only thing that has ever found this class of bug in this repo.**

### The bug already confirmed by reading, which sets the bar

`InfoTip` (shipped 2026-08-09, commit 588ab7b) renders its panel as
`absolute left-0 … w-[min(18rem,calc(100vw-2rem))]`. The **width** is capped to the
viewport; the **position** is not. A tip whose trigger sits 250px from the left
opens a 288px panel from x=250 — 148px past a 390px screen. `align="end"` moves the
problem to the other edge rather than solving it, because it is still anchored to
the trigger and not to the viewport.

Six live call sites: `ImportFile`, `ExportData`, `HeldMessageSheet`,
`onboarding/Address`, `onboarding/Verification` (×2), `settings/V2Settings`.

This is the operator's exact complaint, it is a one-component fix, and no existing
test could have caught it. It is the template for the whole exercise.

## 3. Phase 0 — the instrument

Build the v2 harness that should already exist. Deliverables in `web/harness/`:

| file | what it does |
| --- | --- |
| `v2stack.sh` (edit) | ports configurable, so it cannot collide with the other agent's stack |
| `v2nav.mjs` | the ceremony, then a screen map: every v2 surface as the literal taps a user performs |
| `v2seed.mjs` | hostile fixture data, authored through the app's own CSV import — no backdoor |
| `v2shoot.mjs` | screenshot + `audit.mjs` every screen, at 390 **and 320**, light **and dark** |
| `v2probe.mjs` | open every dialog and sheet, type into every input, open every `InfoTip` |
| `v2ios.mjs` | WebKit, iPhone geometry, software-keyboard occlusion |

Rules carried over from v1's harness, which exist because each was learned the
hard way:

- **Never production.** Scratch ports, scratch cluster, scratch data dir.
- **`--dns-fixtures` or nothing.** Without it every message reads `unauthenticated`,
  the verification step never clears and no script reaches the product.
- **Prove every check bites.** For each new check: break the subject, watch it
  fail, revert. A check that cannot fail is this repo's most-repeated defect and
  it has already shipped three times.
- **Two identical segments is a failure, not a pass.** `v2settings.mjs` already
  encodes this; the new capture inherits it.
- **Teach the audit about deliberate exceptions in the same commit.**

### Hostile fixture data, specifically

Bugs hide in the happy path. The seed must contain, at minimum:

- a merchant name wider than any mobile viewport
- `9,999,999.99` — the widest string the formatter emits
- a foreign-currency row, and one in a currency with no configured rate
- a zero-amount row and a refund/credit row
- a category name long enough to wrap a chip
- a held message with a long subject and an unparsed body
- enough rows that the transaction list scrolls and the review deck stacks

## 4. Phase 1 — the audit

Three passes over every surface, because they catch disjoint defects.

**Pass A — geometry, machine-measured.** `audit.mjs` in-page: elements past the
viewport, controls whose centre point hits a different element, controls under the
bottom nav, sub-44px targets, sub-16px inputs, `overflow-hidden` over taller
content, clipped text with no ellipsis, controls with no accessible name, literal
`NaN`/`undefined` on screen. These are facts, not opinions.

**Pass B — interaction, driven.** Open every overlay. Clear every input and check
it stays clear. Fire every gesture. Reach every screen using only taps a user can
perform — if the harness cannot reach a screen, that is a finding about the app.

**Pass C — judgement, from the screenshots.** Hierarchy, rhythm, density, copy,
whether a screen looks finished, whether the path to the common task is the short
one. Read against `apple-design`'s principles and the app's own catalog. Geometry
cannot judge this and neither can a checker.

Findings are filed with severity and a named failure: *what a user does, and what
goes wrong.* A finding nobody can reproduce is not a finding.

### The specific things being hunted

Named because the brief names them, or because this codebase produces them:

- **Horizontal overflow** — tips, chips, long merchants, wide numbers, tables,
  segmented controls, filter rows, the category colour grid at 320px.
- **Unreachable controls** — under the bottom nav, under the keyboard, behind a
  sheet's own footer, past the bottom of a non-scrolling container.
- **Friction** — a confirmation on a reversible action; a sheet where an inline
  edit would do; a field that must be filled to proceed but could be inferred; a
  multi-step flow where the steps do not need to be separate; a destination
  reachable only through Settings.
- **Dead ends** — a refusal with no next action. The product principles call this
  out by name: *"Never let a security rule become a dead end."*
- **Copy the code does not honour** — this branch's second most repeated defect.
  Every promise on a screen gets checked against what the code does.
- **Motion that is not interruptible** — CSS transitions on anything gesture-driven,
  animation from a target value instead of the presentation value, a transition
  that locks input.
- **First-paint invisibility** — `opacity: 0` in an `initial` prop. There is a rule
  and a check for it; the check covers v1's tree.

## 5. Phase 2 — the fixes

Ordered by user-visible harm, not by effort.

**Wave 1 — broken.** Anything that makes a control unreachable or puts content off
screen. `InfoTip`'s positioning leads this wave: replace trigger-anchored
`left-0`/`right-0` with measured viewport collision handling, and make the harness
prove the panel is inside the viewport at every call site, at 320px, on both edges.

**Wave 2 — friction.** Tap-count reductions on the common paths, inferred values
replacing asked ones, confirmations removed where the action is reversible and an
undo exists. Every removal of a confirmation must be paired with a real undo — the
principles allow flexibility bought by reversibility, never by weaker proof.

**Wave 3 — feel.** Springs where a gesture carries momentum, velocity handoff at
the drag/animation seam, response on pointer-down, momentum projection on flicks.
Values come from `lib/motion.ts` and nowhere else; the 300ms ceiling stands.

**Wave 4 — polish.** Type tracking by size, rhythm, empty states that invite an
action, error copy that says what to do next.

Constraints on every wave:

- The op log is append-only and nothing validates a payload server-side. **No UI
  change may alter what an op contains** without the plan for it saying so. A
  malformed op is permanent on every device the user owns.
- The catalog is updated in the same commit as any shared-component change, and so
  are its stories.
- Both executors stay in step: nothing here should touch `norm`/`tmpl`, and if it
  does, `scripts/v2-check.sh` is the only thing that proves it.

## 6. Phase 3 — verification

Nothing is claimed without the command output that shows it.

1. `cd web && bun run test` — the v2 frontend suite.
2. `bash scripts/v2-check.sh` — the gate. It is the build; this repo has no CI.
3. `node harness/v2shoot.mjs` — zero high/medium findings at 390 and 320, both
   themes.
4. `node harness/v2probe.mjs` — every overlay opens, every input clears.
5. `node harness/v2ios.mjs` — WebKit, keyboard geometry.
6. Screenshots re-read end to end, against the before set.
7. `cd web && bun run build`, commit `internal/v2/webui/dist`, and prove the change
   is in the binary — `strings -a ./ledgerd | grep -c '<marker>'` — not merely in
   the tree. A fully green gate shipped a stale Settings screen on 2026-08-09
   because `v2-check.sh` builds the bundle to a temp directory by design.

**Deploy is not in this plan.** `app.sirdab.ae` is public and has beta users on it.
The branch is prepared, verified and reported; pushing it live is the operator's
call.

## 7. Out of scope

- v1 (`frontend/`), which must keep building and must not go down.
- `app/` — the abandoned Expo client.
- Any change to the visual language: palette, radius, iconography, type family.
- New features. A missing screen stays missing; the plan records it.
- Backend changes, except where a UI defect cannot be fixed on the client and the
  server change is named and justified.
- Phase 3 sealing. It is the highest-priority work in the product and it is not a
  UI task.

## 8. How progress is recorded

A findings register lives beside this plan, one row per finding: surface,
severity, the failure in a sentence, the fix, and the evidence that it is fixed.
Findings that are deliberately not fixed stay in the register with the reason, so
"we looked at it and chose not to" is distinguishable from "we missed it".
