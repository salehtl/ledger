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

### Onboarding must never wait for a bank transaction

The operator's words:

> "Waiting for a txn to happen is not a good UX. We need the user to be onboarded
> in an easier manner that does not depend on them making a txn."

Today's verification step waits for a real bank alert to arrive. **A bank alert
requires the user to spend money.** So completing setup depends on an event the
user cannot cause on demand, may not cause for days, and should never be nudged
into causing. That is the worst kind of blocking step: it is not slow, it is
outside the user's control entirely.

**The first-mail check becomes a status, not a step.** Setup finishes when the
user has done their part — the rule is set — and not when the world responds.

Four affordances replace the wait, in this order:

1. **Proceed immediately.** After the forwarding rule is set, the user reaches the
   product. The home screen carries a quiet line: "Waiting for your first bank
   email." It resolves itself whenever mail arrives, hours or days later, with no
   screen to return to.

2. **Prove the pipe without a bank.** Offer "send anything to this address" as a
   diagnostic. Any email the user sends themselves proves delivery end to end —
   DNS, MX, the receiver, the account. It proves nothing about *trust*, and the
   copy must say so plainly. It answers the real question a stuck user has, which
   is "is this thing even on?"

3. **Forward one old email, and get real data.** The user almost certainly has
   months of bank alerts already sitting in their mailbox. Forwarding one lands it
   in **lane 2** of the mail redesign, where it becomes a prefilled transaction
   they confirm. This turns the wait into a first success: they see the app work,
   with their own numbers, in under a minute, and they keep the transaction.

4. **Import a file, and skip mail entirely.** **Lane 3 is the strongest answer to
   this problem** and should be presented during onboarding, not buried in
   Settings. A statement export populates months of history at once, so a new
   account is a useful budgeting app before a single email has ever arrived.

Together these mean a user can finish onboarding, see their own data, and
understand whether mail is working — **without a transaction ever occurring.**

### The provider's confirmation is a task, not a gate

Where a provider emails a confirmation, that message is a **task with a link**,
surfaced wherever the user is. It must not sit between them and the app. If it
never arrives — refused by a quota, delayed, lost — the user still has the
product, and the task stays outstanding with an honest explanation and a way to
ask the provider to send it again.

### No step may become unreachable because of a bug in another step

This is the direct lesson of today. Mail verification depended on a held message
being classified correctly; when that classification was wrong, there was no other
door. So: **every screen that depends on an external event — an email arriving, a
provider confirming — must offer a way forward that does not require the event.**
For verification that means: skip, come back later, and a visible explanation of
what is still missing.

## 3b. Ask nothing that can be inferred

The operator's words:

> "I need the user to have ledger up and running quick without unnecessary decision
> making. I don't need them to specify which bank they use if we can parse their
> email and select the correct template later or log that we need to create one. I
> don't want them to specify which mail service provider if this is not 100%
> needed and we can figure it out later. Any steps we can infer later, let's set up
> reliable systems to do so."

**The rule: onboarding asks only what cannot be inferred and cannot be deferred.**
Every other question is a decision the app is making the user carry.

### Which bank — remove it entirely

**Verified in the code: the declared bank list never reaches parsing.** Templates
are selected by the message's own **verified domain**
(`internal/v2/ingest/pipeline.go:618`, `templatesFor(ctx, domain)`); nothing in
`internal/v2/tmpl` or the pipeline reads what the user declared. The question is
UI habit, not a functional requirement.

So the bank list is **inferred from the mail**, and the declaration becomes a
consequence rather than a prerequisite:

- The first message from a verified domain establishes the bank. The projection
  gains it without anyone being asked.
- Settings still shows the list, now as *what ledger has seen*, editable — the
  user can correct or remove an entry.
- **When no published template matches**, the heuristic tier runs, the transaction
  lands in review as it does today, and the system **records that a template is
  needed** for that domain. That signal already has somewhere to go: the operator
  console surfaces template health and the donated-format queue, and
  `parse_diagnostics` already carries sender domains. Wire it, do not invent it.

The failure mode this removes is real: today a user who picks the wrong bank, or
whose bank is not on the list, has told the app something false, and the app
learns nothing from the mail that would correct it.

### Which mail provider — do not ask

The provider is asked only to tailor the forwarding instructions. That does not
justify a decision screen, because a wrong answer costs the user the correct
instructions and the app cannot tell.

Instead: **one generic instruction set**, true for every provider — "make a rule
in your mailbox that forwards mail from your bank to this address" — with
provider-specific help available as an **optional expander**, not a fork in the
walk. Choosing Gmail becomes a hint the user may take, never a state the account
records.

The one provider-specific fact that matters is the confirmation email, and it can
be stated generically and truthfully: *if your provider sends a confirmation, it
will appear in Held mail.*

The provider is then **inferred after the fact** from the outer domain and the ARC
seal of the first arriving message — evidence, not a claim — and used to tailor
any later help.

### Home currency, budget split, monthly total — default, then ask when it means something

- **Home currency**: default from the device locale, and correct it from the
  currency the transactions actually arrive in.
- **Budget split**: default 50/30/20. That is the app's whole premise; it needs no
  ceremony to adopt.
- **Monthly total**: the one number with no honest default. **Do not ask for it in
  onboarding.** Ask once there is data — a user who has seen a week of their own
  spending can answer it, and a user on their first screen is guessing.

### What is left

Invite. Passkey. Recovery phrase. The address and the forwarding rule. Nothing
else is a question.

### The inference systems this depends on

These are the "reliable systems" the operator asked for, listed so the plan builds
them rather than assuming them:

| Inferred | From | State |
|---|---|---|
| the bank | the verified signing domain of arriving mail | **exists** — templates already key on it |
| a missing template | no published template matched a verified domain | partly exists; needs the signal wired to the console |
| the mail provider | outer domain and ARC seal of the first message | new, small |
| home currency | device locale, then observed transaction currency | new, small |

Each must **degrade quietly**: an inference that cannot be made leaves the setting
unset and the app working, never a modal asking the user to resolve it.

## 4. What does not change

- **Account creation stays a gate.** Invite, passkey, keys. There is no account
  without them.
- **The recovery phrase stays mandatory and unconditional.** Losing it is
  unrecoverable, so it is not a "later" task. It is part of creating the account.

  **But verifying it is not.** The operator, 2026-08-09: *"I hate having to write 3
  of the 12 words. Completely kill that step. User should be trusted to store the
  words the way they wish, we don't need to double check."*

  So the type-back quiz is **removed**, not made skippable. The phrase is still
  generated, shown once in full, easy to copy, and still carries its no-way-back
  warning — all of which is load-bearing and stays.

  The reasoning, recorded because this is the one irreversible thing in the
  product: a typed quiz proves the phrase was in short-term memory thirty seconds
  ago. It does not prove it was written down, photographed, or put in a password
  manager. So it buys very little real assurance and costs every user friction in
  their first minute. **The accepted consequence is stated plainly rather than
  hidden:** a user who ignores the warning and saves nothing loses the account, and
  nobody can help them. That is the trade the operator has chosen, knowingly.
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
