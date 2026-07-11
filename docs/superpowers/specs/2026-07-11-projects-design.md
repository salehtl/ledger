# Projects — design

**Date:** 2026-07-11
**Status:** approved (design), pending spec review

## Problem

Some spending belongs to a temporary, bounded life effort — building a project car,
furnishing a house — with its own budget and (loosely) an end date. Today every
transaction is forced into the monthly 50/30/20 model, so a 30,000 AED car build over
several months either blows up the monthly "want" bucket or gets mis-modelled. The
user wants to **bucket certain transactions into a named Project** with its own
lump-sum budget, tracked separately from the monthly plan, without those transactions
being treated as a permanent category.

## Goals

- A **Project** is an orthogonal tag on transactions (a transaction keeps its
  category/bucket **and** may belong to one project).
- Each project has an **optional lump-sum budget** and tracks **net spend** against it.
- Project spend is **carved out of the monthly 50/30/20 by default**, with a
  per-project toggle to include it.
- Assign transactions **manually** (one at a time) and via a **bulk backfill** tool
  (projects usually start before they're set up).
- Projects have a **status** (active / completed) and an **end date that is a label
  only** (no pacing math, no auto-close).
- Surfaced on **Home** as cards, with a drill-in Project screen.

## Non-goals

- No burn-rate / pacing / overdue math (end date is informational).
- No auto-assignment rules (shared merchants make them mis-tag; deferred).
- No multi-project membership (one project per transaction).
- No change to the parse/categorize/ingest pipeline.

## Core principle

Money stays integer minor units (int64 fils / AED). Project spend is **net**
(debits − credits) and **AED-normalized** (uses `amount_aed` when present, else
`amount`), exactly like the existing budget math — so it reconciles with the rest of
the app.

---

## Data model (`internal/store`)

### New table `projects`

```sql
CREATE TABLE IF NOT EXISTS projects (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  name             TEXT    NOT NULL,
  budget_fils      INTEGER,                          -- AED minor units; NULL = no budget set
  color            TEXT,                             -- optional hex for chips, e.g. '#c2703d'
  starts_on        TEXT,                             -- optional ISO date (label/context)
  ends_on          TEXT,                             -- optional ISO date (LABEL ONLY)
  status           TEXT    NOT NULL DEFAULT 'active',-- 'active' | 'completed'
  count_in_monthly INTEGER NOT NULL DEFAULT 0,       -- 0 = carved out of 50/30/20 (default), 1 = counted
  completed_at     TEXT,                             -- set when status flips to 'completed'
  created_at       TEXT    NOT NULL,
  updated_at       TEXT    NOT NULL
);
```

### `transactions` — additive column

```sql
-- via addColumnIfMissing (no migration tool; store.Open applies it)
project_id INTEGER REFERENCES projects(id)   -- nullable; one project per transaction
```

Plus `CREATE INDEX IF NOT EXISTS idx_tx_project ON transactions(project_id);`

**Deleting a project** sets `project_id = NULL` on its transactions (un-assign), then
deletes the project row. Transactions are never deleted. (The FK is intentionally
un-`ON DELETE`-constrained; the store handles the two-step in one transaction.)

### Typed rows / methods

- `ProjectRow{ ID, Name, BudgetFils *int64, Color, StartsOn, EndsOn string, Status string, CountInMonthly bool, CompletedAt string }`.
- `ProjectRollup{ Project ProjectRow; NetSpentFils int64; PendingFils int64; TxnCount int; ByCategory []ProjectCategorySpend }` — computed spend.
  - `NetSpentFils` = Σ(AED-normalized) debits − credits over **confirmed** assigned txns.
  - `PendingFils` = same over **needs_review** assigned txns (shown separately).
  - `ByCategory` = net spend grouped by category name (for the mini-breakdown).
- Store methods:
  - `InsertProject`, `SelectProjects(includeCompleted bool)`, `SelectProject(id)`,
    `UpdateProject`, `DeleteProject` (un-assigns then deletes),
    `ProjectRollup(id)` / `ProjectRollups()` (batch for the list/cards).
  - `AssignTransactionProject(txnID int64, projectID *int64)` — single.
  - `BulkAssignProject(projectID int64, txnIDs []int64)` and
    `BulkUnassignProject(txnIDs []int64)`.
  - AED normalization mirrors the existing `SelectMonthSpend` FX handling
    (`COALESCE(amount_aed, amount)`).

---

## Budget carve-out (the core interaction)

`SelectMonthSpend(period, frozen)` (`internal/store/budget.go:72`) currently returns
the `SpendRow`s that `budget.Compute` nets into jars. Change its query to **exclude**
transactions whose project is carved out:

```sql
-- add to the WHERE of SelectMonthSpend:
AND (t.project_id IS NULL
     OR EXISTS (SELECT 1 FROM projects p
                WHERE p.id = t.project_id AND p.count_in_monthly = 1))
```

This is computed **live** — toggling `count_in_monthly`, reassigning, or deleting a
project immediately changes the monthly jars (no snapshot). `bucket_snapshot` is
unaffected (still records the jar at categorization time for the row itself).

**Reconciliation note.** Add `SelectMonthProjectExcluded(period, frozen) (int64, error)`
returning the net AED spend for that period that was carved out (project txns with
`count_in_monthly = 0`). The summary payload carries it so the monthly budget screen
can show *"Excludes AED 8,400 in project spend."* Without this, a user seeing lower
"want" spend than their statement would be confused.

`budget.Summary` gains `ProjectExcluded int64 json:"project_excluded"`. `budget.Compute`
/ `ComputeRange` take it through (the server sums it; the pure math just passes it into
the payload). Range/multi-month budget sums the excluded figure across the span too.

---

## Project spend semantics (edge cases handled)

- **Net of refunds/resales**: a credit assigned to the project reduces `NetSpentFils`
  — selling old car parts lowers project spend. (Existing refund-linking is orthogonal
  and still works; a linked refund is just a credit.)
- **Multi-currency**: `COALESCE(amount_aed, amount)` — same as the budget.
- **Confirmed vs pending**: headline = confirmed; `PendingFils` shown as a "+ AED Y
  pending review" sub-line so nothing is hidden.
- **Optional budget**: `budget_fils NULL` → the detail shows net spend only; the
  over-budget flag (`NetSpentFils > budget_fils`) applies only when a budget is set.
- **Excluded/income categories inside a project**: carve-out removes assigned txns from
  the monthly budget regardless of category kind — project money is its own world. A
  credit in a project reduces project spend (not monthly income).

---

## Assignment

- **Per-transaction**: an "Add to / change / remove project" control on the transaction
  action surface (the sheet that today offers categorize / link-refund). Rows that
  belong to a project show a small **color chip** with the project name.
- **Bulk backfill** (from the Project screen): a sheet that filters existing
  transactions by **date range**, **merchant contains**, and/or **category**, lists the
  matches with a running count, and assigns all to the project in one call. A matching
  bulk-remove path (unassign selected).
- Assignment is allowed regardless of transaction status (needs_review or confirmed).
  Assigning does not change a transaction's category or status.

---

## Lifecycle

- **States**: `active` (default) and `completed`. "Mark complete" sets
  `status='completed'` + `completed_at`; a completed project moves to a **Completed**
  section (still fully viewable — net cost, duration, breakdown) and can be **reopened**
  (`status='active'`, clear `completed_at`).
- `starts_on` / `ends_on` optional; **open-ended** projects omit `ends_on`. `ends_on` is
  a label only — no pacing, no auto-complete.
- Completed projects still hold their transactions; assignment is still allowed (e.g. a
  late-arriving receipt) — completion is organizational, not a lock.

---

## API (`internal/server`)

- `GET /api/projects?include_completed=1` → `[{project + rollup}]` (cards/list).
- `POST /api/projects` (create: name required; budget/color/dates/count_in_monthly optional).
- `GET /api/projects/{id}` → project + rollup + `by_category` + recent assigned txns.
- `PUT /api/projects/{id}` (edit any field incl. `status`, `count_in_monthly`).
- `DELETE /api/projects/{id}` (un-assign txns, then delete).
- `POST /api/transactions/{id}/project` `{ "project_id": <id|null> }` — single assign/clear.
- `POST /api/projects/{id}/assign` `{ "transaction_ids": [...] }` — bulk assign.
- `POST /api/projects/{id}/unassign` `{ "transaction_ids": [...] }` — bulk remove.
- Existing `GET /api/summary` (+ range) extended: carve-out applied to the jars, and
  `project_excluded` added to the payload.
- `GET /api/transactions` rows gain `project_id` (+ the client resolves name/color from
  the projects list, or the row carries a denormalized `project_name`/`project_color` —
  decided in the plan; prefer denormalized on the row to avoid an N+1 client join).

Money crosses the API as integer fils, consistent with the rest of the app.

---

## Frontend (`frontend/src`)

- **Home** (`screens/Home.tsx`): a "Projects" section — a horizontal/stacked list of
  **active** project cards (name, color, net-spent/budget bar, or "no budget"), plus an
  "All ›" link to the Projects list. Hidden entirely when there are no projects.
- **Projects list screen**: Active + Completed sections; "+ New project".
- **Project detail screen**: header (budget · net spent · remaining or "no budget",
  dates, `count_in_monthly` toggle, edit, mark-complete/reopen, delete), a by-category
  mini-breakdown, the assigned-transactions list, and a "Add transactions" (bulk
  backfill) entry.
- **Create/edit project form**: name, optional budget (shared `Input`, decimal),
  optional start/end dates, color picker (small preset swatches), count-in-monthly
  toggle.
- **Transaction assignment**: an "Add to project" action in the transaction action
  sheet; a project chip on `TransactionRow` when assigned.
- **Monthly budget screen**: the reconciliation note when `project_excluded > 0`.
- **api/types.ts + api/client.ts**: `Project`, `ProjectRollup`, `ProjectDetail` types
  and the CRUD/assign client functions.
- **Pure `lib/` helpers** (framework-free, co-located tests): project spend math
  (net, remaining, pct-used, over-budget) and card/label formatting. Follow the
  `lib/`-first convention.

Mobile conventions from `frontend/src/components/README.md` apply (44px targets, 16px
inputs, `.press`, Dialog-only overlays, shared `Input`/`Button`/`Switch`/`Card`).
Update the component catalog if a shared component is added.

---

## Testing

**Go**
- `store`: projects CRUD; `project_id` column additive; assign / bulk-assign / unassign;
  delete un-assigns (txns survive, `project_id` NULL); `ProjectRollup` net spend
  (debit − credit), multi-currency (`amount_aed`), confirmed vs pending split,
  by-category grouping, optional-budget over-flag.
- `store` budget carve-out: `SelectMonthSpend` excludes carved-out project txns and
  includes them when `count_in_monthly=1`; `SelectMonthProjectExcluded` sums the right
  figure; toggling the flag flips inclusion live.
- `budget`: `Summary.ProjectExcluded` passes through Compute/ComputeRange.
- `server`: projects endpoints (CRUD, single + bulk assign, unassign), summary carries
  `project_excluded`, transaction rows carry project fields.

**Frontend (vitest)**
- `lib/projectMath.test.ts`: net/remaining/pct/over-budget incl. no-budget and
  over-budget edges.
- Project card, detail screen (rollup render, toggle, mark-complete), bulk-backfill
  filter+assign, transaction chip + assign action, budget reconciliation note.

## Rollout

- Additive schema (`CREATE TABLE IF NOT EXISTS projects` + `addColumnIfMissing` for
  `transactions.project_id`) — backward compatible; an old binary ignores the new
  table/column. Rebuild the embedded `internal/web/dist` before finishing.
- Deploy is local on `dinosaur`: back up the DB, install, restart, verify (health +
  a projects endpoint 200 + running-binary hash).

## Confirmed decisions (from brainstorming)

1. Carve out of 50/30/20 by default, per-project `count_in_monthly` toggle.
2. Manual + bulk-backfill assignment (no auto-rules).
3. End date is a label only; manual complete; open-ended allowed.
4. Placement: Home cards + drill-in Project screen.
5. Net spend (credits reduce), optional budget, delete un-assigns (never deletes txns),
   one project per transaction, live carve-out, confirmed-drives-headline + pending
   shown, monthly reconciliation note. (All confirmed by the user.)
