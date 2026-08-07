# Assignment carry-forward

**Date:** 2026-08-07
**Status:** approved, not yet implemented

## Problem

`envelope_assignments` is keyed `(month, category_id)`, so every month starts
blank and the whole plan must be re-entered. The user's position:

> i want my assignments to remain as they are month over month, why would my
> plan change regularly? in the case it does i can adjust my assignements.

That is correct for a stable budget with a fixed salary. Re-typing eighteen
numbers every month to express "same as last month" is the tool failing the
user, not budgeting discipline.

## Decision and its cost

Assignments carry forward. This reverses the recommendation in
`2026-08-07-effective-dated-targets-design.md`, which argued for targets over
carried assignments on the grounds that carrying commits money before income
arrives. The user was told that and chose this anyway, with a sound rationale:
a plan that changes rarely should persist by default, and they will adjust the
months where it doesn't.

The named cost stands: a new month can open with Ready to Assign negative —
exactly as August currently does at −4,551.16, where July's 11,125.34 of
overspend debt lands on August's income. Under carry-forward that becomes a
normal opening condition rather than a signal, and the user has accepted it.

**This largely supersedes effective-dated targets for this user.** Targets
express an envelope's intended size and let auto-assign fill to it; carried
assignments simply are the numbers. Targets stay in the codebase — tested,
deployed, and costless when unused — but the user may never set one. That was
stated plainly before this was approved.

## Model

Seeding is lazy: it happens when a month is first looked at, not on a schedule.

A month `M` is seeded from the most recent earlier month with a plan when ALL
of these hold:

1. `M` has **zero** rows in `envelope_assignments`;
2. some month `P < M` has at least one **non-zero** assignment — take the
   greatest such `P`;
3. `M` is the current calendar month or later.

Only non-zero assignments are copied.

### Why each condition

**(1) zero rows, not "no non-zero rows".** Zeroing a month out through the
assign sheet writes rows — August currently has 18 rows of which 17 are zero.
So "has rows" is a faithful record of "the user has touched this month", and
using it means a month deliberately emptied stays empty instead of refilling
itself. This is the condition that makes the feature feel obedient rather than
pushy.

**(2) greatest prior month with a non-zero plan.** Handles gaps: skipping ahead
to November inherits from August rather than from an empty October. Requiring
non-zero avoids propagating an all-zero month as if it were a plan.

**(3) current month or later.** Browsing back through history must never
rewrite it. Without this, opening March 2025 to look at it would plan it.

## Placement

In the envelope summary path, behind the existing `envelopeMu` mutex
(`internal/server/server.go:128`) that already serialises the envelope
mutation handlers, so two concurrent requests cannot double-seed.

A new store method does the work in one transaction:

    SeedEnvelopeAssignmentsFromPreviousMonth(month string) (seeded int, err error)

It returns the number of rows written (0 when the guards decline), so the
handler and tests can assert on it.

### The trade-off, named

This makes `GET /api/envelopes` write to the database. Reads with side effects
are a genuine smell and this spec does not pretend otherwise.

The alternative considered was a month-rollover job in the background worker:
architecturally clean, no write-on-read, but it can only ever seed the *current*
month. Planning ahead into September during August would still show an empty
screen — the exact confusion this feature exists to remove. The smell is
accepted, contained to one clearly-commented method, and guarded so it can only
fire once per month.

Verified safe: `useEnvelopes(month)` is called only from `PlanScreen` and
`PocketStrip`, both for the currently-selected month, and the app prefetches no
adjacent months. So a seed can only be triggered by a month the user actually
navigated to.

## Out of scope

- No UI. Seeding is invisible; the month simply arrives populated.
- No "copy last month" button — explicitly rejected in favour of automatic.
- No change to targets, auto-assign, carryover, or overspend-debt math.
- No back-fill of past months.

## Testing

- Seeds an untouched current/future month from the most recent planned month.
- Does NOT seed a month that has rows, including all-zero rows.
- Does NOT seed a month earlier than the current calendar month.
- Skips gaps: November inherits from August when September and October are empty.
- Copies only non-zero assignments.
- Is idempotent: a second GET for the same month writes nothing further.
- Concurrent GETs for the same month seed exactly once (mutex).
- Carryover, overspend debt and RTA math are unchanged — these are correct
  today and verified against production data; they must not regress.
- Verify against a scratch copy of the production DB before deploying:
  August (18 rows) must be untouched, September must arrive carrying August's
  non-zero numbers.
