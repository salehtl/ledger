# Onboarding is not a gate — design

**Date:** 2026-08-09
**Status:** approved by the operator, ready for a plan
**Depends on:** nothing. Touches the same screens as the tooltip and mail specs.

---

## 1. Why this exists

The operator's words, written while locked out of his own app:

> "From a user friendliness pov, we need the onboarding to not be a blocker to app
> access. And all the setup to be possible to be done or adjusted after the fact."

This is not a hypothetical. **It happened today, twice, from two unrelated
causes:**

1. The mail quota silently ate Google's forwarding-confirmation email, so the
   verification step could never complete.
2. `verifiedOuterDomain` began `if (!item.attested) return null`, which refused
   the one message onboarding cannot proceed without — a provider's confirmation
   is sent direct, so nothing attests it. One predicate, and the whole product was
   unreachable.

Both were bugs and both are fixed. **The lesson is not "fix those two bugs".** It
is that onboarding is currently a *chain*, and any broken link in a chain is a
locked door. The next bug in that chain will do the same thing again.

## 2. The principle

> **Onboarding proposes. It never blocks.** A user reaches the product after
> creating an account. Every later step is a task they may do now, later, or never
> — and every one is available afterwards, in Settings, in the same words.

Nothing in onboarding is load-bearing for *access*. The only genuine gate is
account creation itself: an invite, a passkey, and the key ceremony, because
without keys there is no account to hold data.

## 3. What changes

### Every step after account creation becomes skippable

Each screen keeps a plain, always-enabled way past it. Not a hidden link — a real
control, with honest copy about what does not work yet. "Set this up later" is a
first-class answer.

Screens affected: choosing banks, the inbound address, the forwarding rule, mail
verification, the budget split, the monthly total, home currency.

### The product must be usable with nothing set up

A brand-new account that skipped everything shows the real app — not a wall. It
shows an empty state that says what is missing and offers the one action that
fixes it. **Manual transaction entry already exists**, so an account with no mail
set up is still a working budgeting app on day one. That is the fallback, and it
is already built.

### Every step exists in Settings, permanently

Not only reachable — *adjustable*. The recently restructured Settings groups are
the home:

| Step | Settings home |
|---|---|
| Your banks | Plan |
| Budget split, monthly total | Plan |
| Inbound address, forwarding rule, verification | Automation |
| Held mail | Automation |
| Home currency | Library |

Verification in particular must be re-runnable **at any time**, because a
forwarding rule can be broken or re-made long after onboarding. Today it is
reachable only during the walk.

### A resumable checklist, not a corridor

The home screen carries a small, dismissible "finish setting up" list showing what
remains. Tapping an item opens the same screen the walk would have. It disappears
when the list is empty or the user dismisses it.

**It must be dismissible for good.** A checklist that returns is a nag, and the
operator's standing instruction is that the app is already too intimidating.

### No step may become unreachable because of a bug in another step

This is the direct lesson of today. Mail verification depended on a held message
being classified correctly; when that classification was wrong, there was no other
door. So: **every screen that depends on an external event — an email arriving, a
provider confirming — must offer a way forward that does not require the event.**
For verification that means: skip, come back later, and a visible explanation of
what is still missing.

## 4. What does not change

- **Account creation stays a gate.** Invite, passkey, keys. There is no account
  without them.
- **The recovery phrase stays mandatory and unconditional.** Losing it is
  unrecoverable, so it is not a "later" task. It is part of creating the account.
- **No security step is softened.** Skipping means *not doing* a thing, never
  doing it with less proof.
- Copy stays plain and short.

## 5. Testing

- **Prove every test bites.** Mutate, watch it fail, revert.
- A brand-new account that skips **every** optional step reaches the product and
  can add a transaction by hand. This is the test that encodes the whole principle
  — if it passes, the app cannot be locked behind onboarding.
- Each skipped step is present and completable in Settings afterwards.
- Verification is re-runnable from Settings, with no account in an onboarding
  state.
- The checklist disappears when dismissed and does not return.
- Harness: the empty states are reachable and clear of the bottom nav on a real
  viewport.

## 6. Note for the plan

This overlaps the tooltip spec (the same screens) and the mail spec (verification
and the deprecated direct route). Sequence it **after** the mail lane 1 work, so
verification is fixed before it is made optional — otherwise the skip becomes a
way to hide a broken screen rather than a choice.
