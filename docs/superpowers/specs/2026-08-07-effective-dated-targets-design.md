# Effective-dated category targets

**Date:** 2026-08-07
**Status:** approved, not yet implemented

## Problem

Envelope *sizes* do not carry across months, so every month starts with no
notion of how big an envelope is meant to be.

The concept already exists — `category_targets`, edited via `TargetSheet` from
the Plan screen, and consumed by `budget.AutoAssign` Phase 1, which funds unmet
targets before spreading the remainder pro-rata. But the table is keyed
`category_id INTEGER PRIMARY KEY`: one row per category, no time dimension.
That makes a target a single global fact. Changing it today silently changes
how *every* past month is judged.

The user's model, in their words:

> the targets i set in a given month should carryover implicitly to the next.
> should i choose to adjust them their adjustment should be scoped to the month
> im adjusting them from only and not impact previous months. next month should
> carry over from the month im on.

That is an effective-dated record.

Note what is *not* broken and must stay that way: `envelope_assignments` is
already keyed `(month, category_id)`, and per-month carryover
(`envelopeEraFold`) is verified correct against production data — July's
per-category leftovers reproduce exactly as August's `carryover_fils`. Money
history already freezes. Only the yardstick is retroactive.

## Decision

Targets carry forward; assignments do not.

Assignments are real money commitments. Carrying them automatically would
commit money before income arrives — with the user's current figures
(AED 52,034 monthly income, AED 11,125 of overspend debt already carried into
August) a new month would open ~51,381 pre-committed and Ready-to-Assign
negative on day one. Keeping the *intent* persistent while each month's funding
reflects actually-available money is why the codebase separates the two
concepts, and Auto-assign is the one-tap bridge between them.

## Model

A target row is a **version**: it applies from `effective_month` onward until
superseded.

```
category_id, effective_month TEXT ('YYYY-MM'), target_type, amount_fils,
cadence, due_date, created_at, updated_at
UNIQUE(category_id, effective_month)
```

Resolution for month M: per category, the row with the greatest
`effective_month <= M`. Both halves of the rule fall out of this:

- a month with no row of its own inherits the most recent earlier version;
- writing a version at M cannot affect any month before M.

### Removal needs a tombstone

Deleting the row for month M would let the *previous* version resurrect and
apply to M and everything after it — the opposite of "remove". So removal
writes a tombstone version at M (`target_type = 'none'`), which resolution
treats as "no target from here on". July keeps its target; August onward has
none.

This is the one non-obvious mechanic in the design.

## Migration

The existing table cannot hold two rows per category, so this is a table
rebuild, not an additive column. The repo has no migration tool — `schema.sql`
is `CREATE TABLE IF NOT EXISTS` plus an `addColumn` helper — so this adds a
one-shot guarded rebuild in `store.Open`:

1. if `category_targets` lacks an `effective_month` column:
2. create the new shape under a temp name;
3. copy every existing row with `effective_month = '0000-01'` — "since
   forever", which preserves exactly today's semantics for anything already
   stored;
4. drop the old table, rename the new one into place.

Idempotent on every subsequent start.

**Production currently holds zero targets**, so the copy step moves nothing and
the rebuild is risk-free today. It stops being free as soon as targets exist,
which is an argument for doing it now rather than later.

## Surface changes

- **store**: `SelectCategoryTargetsForMonth(month)` replaces
  `SelectCategoryTargets()` at the Plan-summary call site.
  `UpsertCategoryTarget` takes an effective month.
  `DeleteCategoryTarget` becomes a tombstone write at a month.
- **server**: `PUT /api/targets/{categoryId}` and
  `DELETE /api/targets/{categoryId}` take the month. `GET /api/targets` resolves
  for a month.
- **budget**: `ComputeEnvelopes` keeps its signature — it already receives a
  target slice, and simply gets the month-resolved one. `AutoAssign` inherits
  the fix with no change, since it reads the same summary.
- **frontend**: `TargetSheet` already has `month` in scope via `PlanScreen`. It
  gains a line stating the scope — "Applies from Aug 2026 onward" — because a
  silently month-scoped edit is precisely what surprises a user three months
  later.
- **`categories.go:603`** counts targets per category for the usage stats behind
  category deletion. With versions that becomes a row count instead of a
  category count; it must count categories with a live (non-tombstone) target.

## Out of scope

- No UI for viewing or pruning a target's version history.
- No back-dating control: a target is changed *from the month you are standing
  in*. Editing a past month is possible by navigating to it, which is the same
  gesture.
- Assignments still do not carry forward (see Decision).

## Testing

- `envelopeEraFold` and carryover behaviour must not regress — they are correct
  today and verified against production data.
- Resolution: inheritance across a gap of months; a version at exactly M;
  a tombstone hiding an earlier version; no version at all.
- Editing at M leaves M-1 unchanged — the property the whole feature exists for.
- Migration: a pre-migration row survives as `'0000-01'` and still resolves for
  every month.
- Verify against a scratch copy of the production DB before deploying, per the
  project's standing practice.
