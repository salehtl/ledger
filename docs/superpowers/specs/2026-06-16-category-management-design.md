# Category Management — Design

**Date:** 2026-06-16
**Status:** Approved (design)
**Branch context:** built on top of the period-scope app-shell work.

## Problem & motivation

Users can currently only *re-bucket* existing categories (the read-only "Categories → buckets" card in Settings). There is no way to create a new category, rename one, or remove one. We want full category management — create, rename, re-bucket, delete — without overhauling the backend, and with graceful handling of the data-integrity cases (categories referenced by past transactions or by rules).

## Key finding: the backend is already ~80% there

Investigation showed most of the infrastructure already exists, so this is mostly a frontend feature plus one careful delete path:

- **Schema** (`categories`): `id`, `name` (UNIQUE), `kind` (`spending` | `income` | `excluded`), `bucket` (`need` | `want` | `saving`), `parent_id`, `is_active`.
- **`POST /api/categories`** — create. Exists, validates name/kind and requires bucket when kind is `spending`. No UI.
- **`PUT /api/categories/{id}`** — update name/kind/bucket, plus an `apply_to_past` flag that stamps `bucket_snapshot` onto historical transactions so past 50/30/20 math doesn't retroactively shift. Frontend only uses it for bucket reassignment today.
- **`transactions.bucket_snapshot`** already freezes historical bucket assignment; budget/insights honor `COALESCE(t.bucket_snapshot, c.bucket)`.

What is genuinely missing: a delete/deactivate path (no route at all) and the create/rename UI.

## Decisions (locked during brainstorming)

1. **Delete semantics — block if in use.** A hard `DELETE` is allowed only when **0 transactions and 0 rules** reference the category. Otherwise the API refuses with the counts. This aligns with the project principle "nothing is ever silently dropped, everything recoverable" — a transaction can never be orphaned. (`transactions.category_id` and `rules.category_id` are FKs with `foreign_keys=ON`; `rules.category_id` is `NOT NULL`.)
2. **Edit scope — name + bucket only.** Rename is added to the existing bucket-reassignment UI. Renaming is safe because transactions and rules reference categories by `id`, not name, so a rename propagates everywhere automatically. **`kind` is immutable after creation** — set once at create time, avoiding retroactive budget surprises. A mis-typed kind is fixed by deleting (if unused) and recreating.
3. **Categories stay flat.** `parent_id` is declared in the schema but never read or written anywhere, and the misleadingly-named `SubcategoryPanel` is just a category grid, not a hierarchy. No parent/child CRUD (YAGNI). The column is left untouched but unused.
4. **UI placement — dedicated full-screen overlay launched from Settings.** There is **no router** in the app: `AppShell` navigates via a `tab` state across exactly 4 tabs, `BottomNav` is hard-coded `grid-cols-4`, and `ReviewSwipe` is a full-screen overlay toggled by `inSwipeMode`. The Category Manager follows the `ReviewSwipe` precedent — a genuinely dedicated screen (full viewport, own header), reached from a "Manage categories" row in Settings, with no new routing infrastructure and no change to the bottom nav. Categories are not period-scoped, so the manager does not use the period TopBar.
5. **Usage check — keep a dedicated `/usage` endpoint.** The manager fetches usage counts up front so the delete control can be disabled/explained before the user taps; the 409 on `DELETE` remains the server-side hard guard.

## Operation set

- **Create** — name + kind (`spending` | `income` | `excluded`) + bucket (required only when `spending`). Uses existing `POST /api/categories`.
- **Rename + re-bucket** — uses existing `PUT /api/categories/{id}`. Kind not editable.
- **Delete** — block-if-in-use; allowed only when 0 transactions and 0 rules reference the category.

## Backend changes

All changes are contained to `internal/server/categories.go` and `internal/store/categories.go`.

### New endpoints

- **`GET /api/categories/{id}/usage`** → `{ "transactions": N, "rules": M }`.
  Backed by new `store.CategoryUsage(id)` doing two `COUNT(*)` queries (transactions and rules by `category_id`). Drives the pre-delete confirm UI.
- **`DELETE /api/categories/{id}`** → new `handleDeleteCategory`.
  Re-checks usage server-side (never trusts the client). If either count > 0, returns **409 Conflict** with `{"error":"in use","transactions":N,"rules":M}`. If clean, calls `store.DeleteCategory(id)` which hard-deletes the row (safe under `foreign_keys=ON` because nothing references it). Returns 200/204 on success.

### Polish

- **Duplicate-name handling.** `POST` and `PUT` currently return a generic 500 on the `UNIQUE(name)` violation. Map that specific error to **409 Conflict** with `{"error":"name exists"}` so the UI can show a friendly message.

### No recalculation

A deletable category has zero transactions by definition, so `bucket_snapshot` and 50/30/20 math are unaffected by delete. No budget/insights recalculation is ever needed.

## Frontend changes

### New component: `<CategoryManager>`

Full-screen overlay, sibling of `ReviewSwipe`. **Settings owns the open state** (a local `useState` flag) and renders `<CategoryManager>` when open, so the entry point and the overlay stay co-located and `AppShell` needs no change. Structure:

- **Header** — title "Categories" + back/close button (`onClose`).
- **List** — scrollable, grouped by `kind` (Spending / Income / Excluded).
- **Row** — name with inline-editable rename; bucket control for spending rows (reuses today's reassign logic); delete (trash) button mirroring the existing Rules row pattern in Settings. Delete is disabled with explanatory subtext when usage > 0.
- **Add form** — name input + kind select; bucket select appears only when kind = `spending`. Submit → `POST /api/categories`.

Reuses `getJSON`/`postJSON`/`del` and the `["categories"]` query key already in use, so any open Settings/Insights views refresh on change.

### Settings entry

Replace the read-only "Categories → buckets" card with a single **"Manage categories →"** row that opens the overlay. The bucket-reassign logic moves *into* the manager rather than being duplicated.

### API client / types

Add `getCategoryUsage(id)` and `deleteCategory(id)` helpers in `frontend/src/api/client.ts`. The `Category` type already exists.

## Data flow & error handling

- **Create / rename** — on success invalidate `["categories"]` (plus `["summary"]` when a bucket changes, matching the current `reassign`). On **409 name-exists** → inline "A category with that name already exists." On `spending` without bucket → form blocks submit client-side; backend also enforces.
- **Delete** — row shows usage counts from `/usage`; if either > 0 the trash button is disabled with subtext "In use — reassign or remove its transactions/rules first." If clean, tapping prompts a confirm, then `DELETE`. A 409 race (a transaction added in the meantime) falls back to an error toast with fresh counts.
- **Loading / empty / offline** — standard react-query states; offline mutations surface the existing error toast pattern (`show({ tone: "error" })`).

## Testing

### Go

- `store.CategoryUsage` — returns correct transaction + rule counts.
- `store.DeleteCategory` — succeeds when clean.
- Handler tests (extend `internal/server/categories_test.go`):
  - `DELETE` clean → 200/204.
  - `DELETE` in-use → 409 with counts.
  - Create / rename duplicate name → 409.

### Frontend (vitest)

New `CategoryManager.test.tsx`:

- Renders grouped list (by kind).
- Add form shows bucket select only when kind = `spending`.
- Delete control disabled when usage > 0.
- Rename and delete fire the correct API calls and invalidate `["categories"]`.

## Out of scope

- Subcategory / hierarchy CRUD (`parent_id` stays unused).
- Editing a category's `kind` after creation.
- Soft-delete / archive (delete is block-if-in-use only; `is_active` stays as-is).
- Reassign-then-delete or bulk transaction reassignment flows.
- Any router introduction or bottom-nav change.
