# Tappable tooltips, and cutting the copy — design

**Date:** 2026-08-09
**Status:** approved by the operator, ready for a plan
**Depends on:** nothing

---

## 1. Why this exists

The operator's words:

> "As a general rule across the app we need to utilize tappable tooltips for extra
> information, as the app now is very verbose in its explanations (especially the
> onboarding and settings pages, which while helpful, hurt the ux as the screens
> become overloaded with information and intimidating)."

The verbosity is not accidental. This codebase deliberately says hard things on
the screen where they matter, and several of those sentences are load-bearing —
the earlier copy work identified **12 qualifications that must never be shortened
away**, including that ledger does see each email as it arrives, both
no-way-back warnings, the synced-versus-unsent wipe distinction with its count,
and the four clauses of "trust only your bank".

So this is **not** a copy-deletion job. It is a job about **where** a sentence
lives. The rule this design introduces:

> **The screen carries what a user must know to act. A tooltip carries what a
> user may want to know to understand. Nothing that changes a decision may move
> into a tooltip.**

A warning is not extra information. If a sentence would change whether a person
taps the button, it stays on the screen.

## 2. What exists today

There is **no tooltip or popover primitive** in `web/src/components/ui/`. There is
a `Dialog`, and the component catalog's mobile convention is **Dialog-only
overlays**. There is a `Notice` used for inline warnings.

So this design adds one primitive, and it must fit the existing conventions
rather than introduce a second overlay system.

## 3. The primitive: `InfoTip`

A small control that reveals a short explanation on tap.

**Shape.** A trigger — a pixel "info" glyph — sitting after the label it explains.
On tap it opens a small panel anchored to the trigger, containing text only.

**Behaviour that is not negotiable:**

- **Tap, never hover.** This is a phone app. A hover tooltip is invisible to the
  primary user.
- **The trigger is a real button** with an accessible name of the form
  "About <the thing>", not "info". A screen reader user must know what it explains
  before opening it.
- **44px minimum touch target**, per the mobile conventions. The glyph may be
  smaller than its target.
- **Dismiss on: tap outside, Escape, scroll, and a second tap on the trigger.** A
  panel that survives a scroll ends up floating over unrelated content.
- **It never contains a control.** Text only — no buttons, no links that navigate,
  no forms. A tooltip is a dead end by design, so nothing important can hide in
  one.
- **Content is short.** One or two sentences. If it needs more, it is not a
  tooltip; it is a Dialog or it belongs on the screen.

**Placement.** The panel must stay inside the viewport and must not be covered by
the bottom navigation. This is exactly the class of bug that unit tests cannot
see, so it is a harness check, not a vitest assertion.

**Motion.** Durations and curves come from the motion module — no literal seconds
in the component. Reduced motion is handled globally; do not re-implement it.
**The entrance must not animate opacity from 0** for anything visible on first
paint; the codebase has a rule and a check about this because `LazyMotion`
resolves features in an effect and content renders straight from `initial` until
then.

**Relationship to `Dialog`.** `InfoTip` does **not** replace it. Dialog remains
the overlay for anything with a decision, a control, or more than two sentences.
`InfoTip` is for a definition or a reassurance.

## 4. Applying it

Two screens are named by the operator, and they are done in this order.

**Onboarding first**, because it is where a new user's impression forms and where
the app is most intimidating. For each screen: keep the instruction and any
consequence on the screen; move definitions, mechanism explanations and
reassurances into tips.

**Settings second.** The recently restructured groups make this simpler: a group
label plus a short row, with the "why" behind a tip.

### The rule applied to real cases

| Sentence | Where it goes | Why |
|---|---|---|
| "Ledger sees each email as it arrives" | **stays on screen** | it changes whether a privacy-conscious person proceeds |
| the no-way-back warnings | **stays on screen** | irreversible |
| the wipe distinction, with its count | **stays on screen** | it is the difference between losing data and not |
| "trust only your bank", all four clauses | **stays on screen** | it is the security instruction |
| what a signing domain is | **tip** | a definition |
| why held mail is held | **tip** | mechanism, not a decision |
| what a recovery phrase is for | **stays on screen** | losing it is unrecoverable |
| how forwarding works under the hood | **tip** | mechanism |

The 12 load-bearing qualifications are enumerated in the earlier copy work's
progress log. **The plan must list them explicitly and assert each one is still on
a screen** after this work — a test, not a promise.

## 5. Testing

- **Prove every test bites.** Mutate, watch it fail, revert.
- The trigger is a button with an accessible name that names its subject.
- Escape, outside tap, scroll and re-tap all dismiss.
- The panel contains no interactive element. Assert on the rendered tree, so a
  future edit that puts a link inside a tip fails.
- **A test that every load-bearing sentence is still rendered on its screen**, not
  behind a tip. This is the one that protects the user from this change.
- Harness: the panel is inside the viewport and clear of the bottom nav, on the
  real screens, at a real viewport. `web/harness/v2settings.mjs` is the only
  runner that reaches the v2 product today; onboarding needs an equivalent.

## 6. Out of scope

No visual redesign. No change to information architecture beyond moving sentences.
No new copy voice — the app's copy stays plain and short, one idea per sentence.
