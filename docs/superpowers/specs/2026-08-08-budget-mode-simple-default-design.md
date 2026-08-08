# Budget mode: simple monthly budgets by default, envelope logic sunset

**Date:** 2026-08-08
**Status:** approved, not yet implemented

## Problem

The Plan screen implements envelope budgeting: underspending carries forward as
`carryover_fils`, and overspending is charged to the next month as
`overspend_debt_fils`. The user does not want that model:

> i just wanna assign some cash and track whether i am exceeding my planned
> assignent or not. this assigned value should be retained month over month. so
> say i set my budgets across each category, how miuch i wanna spend, next month
> this should still be set but the amount eaten from it should revert to zero.

That is a **monthly budget**: the budget persists, the spending against it
resets each month, and nothing accumulates in either direction.

The persistence half already shipped (`8fa1817`, assignment carry-forward). This
spec covers the reset half.

## Decision

Do not delete envelope budgeting. The user was explicit:

> Lets not completely kill the envelope budgeting mechanism and logic we've
> built but sunset it into a hidden state that we can later pick up and i decide
> how it would show up for the user. but as a default the simple monthly budget
> should be the standard enabled budgeting method.

So: a `budget_mode` setting, defaulting to `simple`. The envelope path stays in
the codebase, tested and reachable, but unreached by default. No UI for the
switch — the user will decide separately how (or whether) it surfaces.

`envelopeEraFold` and its machinery are hard-won and verified correct against
production data. They become **dormant, not dead** — a later pruning pass must
not mistake them for unused code.

## Effect on the user's live numbers

August currently reports Ready to Assign −15,894.93, a large part of which is
July's overspend debt charged forward. In `simple` mode that debt does not
exist, so RTA becomes `income − assigned` and the red number reflects only
genuine over-assignment. Underspend stops accumulating too: Investments'
carried 8,000 and Utilities' 2,242.72 will no longer appear.

This is the intended, user-approved behaviour change, and it takes effect the
moment the new default lands.

## Model

`app_settings.budget_mode TEXT NOT NULL DEFAULT 'simple'`, values `'simple'` or
`'envelope'`.

In `simple` mode, `EnvelopeMonthSummary` skips the prior-month era-fold entirely
and returns every row with `CarryoverFils = 0` and `OverspendDebtFils = 0`.

**Nothing else changes.** That is the whole design, and it works because
`internal/budget/envelope.go` derives everything downstream from those two
fields:

- `available = clamp0(carryover) + assigned − activity` → `assigned − activity`
- `overspent = available < 0` → `activity > assigned`, which is exactly "am I
  exceeding my planned assignment"
- `ReadyToAssignFils = income − assigned − overspendDebt` → `income − assigned`

So the `budget` package needs no edit, auto-assign inherits the new RTA, and
budget-threshold notifications follow automatically.

Skipping the fold in simple mode is also the cheaper path: it avoids the
prior-month scan that `envelopeEraFold` requires.

## Frontend

No change required, verified:

- `ReadyToAssignBanner.tsx:35` already renders the overspend term only when
  `overspend_debt_fils > 0`, so it disappears.
- `EnvelopeRow.tsx:50` shows `carryover_fils + assigned_fils`, which becomes
  just the budget.

## Surface

- `EnvelopeMonthSummary(month string, mode string)` — explicit parameter rather
  than reading settings inside the store, so both paths stay directly testable.
  One production caller (`internal/server/envelopes.go:61`).
- `store.BudgetModeSimple` / `store.BudgetModeEnvelope` constants; an unknown or
  empty stored value is treated as `simple` (the default) rather than erroring.
- `AppSettings.BudgetMode`, read by `SelectAppSettings`.
- `GET /api/settings` reports `budget_mode`; `PUT /api/settings` accepts it.
  This is the hidden switch — flippable with curl for testing, with no UI.

## Out of scope

- No UI, no settings screen entry, no toggle.
- No change to `envelopeEraFold` or any carryover/overspend logic — it must
  remain byte-identical and tested.
- No migration of existing data. The mode is a read-time policy; assignment and
  transaction data are untouched, so flipping the mode back restores the old
  numbers exactly.

## Testing

- `simple` mode returns carryover 0 and overspend debt 0 for a month that would
  otherwise carry both — assert against a fixture where the envelope path
  demonstrably produces non-zero values, so the test cannot pass vacuously.
- `envelope` mode still produces the old numbers — the sunset path must stay
  provably alive.
- RTA in simple mode equals `income − assigned` exactly.
- `overspent` is true iff `activity > assigned` in simple mode.
- An unset/unknown stored mode behaves as `simple`.
- Round-trip: `PUT /api/settings` with each mode, then `GET /api/envelopes`
  reflects it.
- Flipping to `envelope` and back reproduces the original figures bit-for-bit —
  this is what proves the sunset is reversible.
- Verify against a scratch copy of production: in `simple`, August's RTA equals
  `income − assigned` and no envelope reports carryover; flipping to `envelope`
  restores Investments 800000, Utilities 224272, Entertainment 64050.
