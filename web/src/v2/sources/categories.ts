/**
 * The categories a user owns, over the local projection.
 *
 * # v1's taxonomy, kept
 *
 * A category is born knowing its kind and its bucket — `{id, name, kind,
 * bucket, color, active}`, the shape `screens/CategoryManager.tsx` established
 * and the fold now carries (`client/src/replay/state.ts`). `spending` carries a
 * bucket; `income` and `excluded` carry none, because "this is income" and
 * "this is a need" are not the same claim and defaulting one to the other puts
 * money in a bucket nobody chose.
 *
 * # Retiring, not deleting, and why every consumer must respect the difference
 *
 * There is no delete op. `active: false` is a definition that says "stop
 * offering this", and the row stays — so a transaction categorised "Gym" before
 * "Gym" was retired still reads "Gym" and still counts as a need.
 * {@link categoryMapping} therefore includes retired categories and the PICKER
 * excludes them; that asymmetry is the whole mechanism, and collapsing it in
 * either direction silently re-buckets money that was already filed.
 *
 * # No second op author
 *
 * `sources/review.ts`'s `categorizeOps` remains the single author of
 * `txn_categorized`/`rule_added`. Nothing here writes either: this module
 * authors `category_defined` and nothing else.
 *
 * # Framework-free
 *
 * Over a `SqlDriver`, like every other source here, and it imports nothing from
 * `budget.ts` — `budget.ts` imports THIS, so the dependency runs one way and
 * the built-in mapping has exactly one home.
 */

import { projectionIsUsable, readCategories } from "@ledger/client/replay/projection";
import type { BudgetBucket, CategoryDef } from "@ledger/client/replay/state";
import type { SqlDriver } from "@ledger/client/store/driver";

export type { CategoryDef };

/** What one authored change to a category looks like on the wire. */
export interface CategoryOpSpec {
  type: string;
  payload: unknown;
}

/**
 * Every definition the log holds, in fold order, RETIRED ONES INCLUDED.
 *
 * Gated on {@link projectionIsUsable} for the same reason `banks.ts` and
 * `budget.ts` are: a projection written by an older build, or one a rebuild has
 * only half-written, is not fact. Empty is the safe answer here — the picker
 * offers nothing and {@link categoryMapping} falls back to the built-in table,
 * both of which the next fold corrects. Reading a half-written table instead
 * would offer the user a category twice, and a second definition of a name is
 * how money moves bucket without anyone asking for it.
 */
export function readCategoryDefs(db: SqlDriver): CategoryDef[] {
  if (!projectionIsUsable(db)) return [];
  return [...readCategories(db).values()];
}

/** Only the ones a picker may offer. */
export function activeCategoryDefs(defs: readonly CategoryDef[]): CategoryDef[] {
  return defs.filter((c) => c.active);
}

/**
 * lower-cased name → bucket, for the user's `spending` categories.
 *
 * Retired categories are included, deliberately: the money filed under them is
 * still in the ledger and still belongs to the bucket it was filed in. Income
 * and excluded categories contribute nothing — they have no bucket, and the
 * built-in mapping's `fallback: null` already leaves an unmapped debit
 * unassigned rather than guessing.
 */
export function categoryMapping(defs: readonly CategoryDef[]): Record<string, BudgetBucket> {
  const out: Record<string, BudgetBucket> = {};
  for (const c of defs) {
    if (c.kind !== "spending" || c.bucket === null) continue;
    out[c.name.toLowerCase()] = c.bucket;
  }
  return out;
}

/**
 * The op one definition authors — the WHOLE record, never a patch.
 *
 * `category_defined` is last-write-per-id, so a partial payload would not merge
 * with what came before, it would replace it with the parts that were sent. A
 * rename, a move and a retirement are all this one op with every field restated.
 *
 * It refuses exactly what the fold refuses (`replay.ts`): a `spending` category
 * without a bucket, any other kind WITH one, and an empty name. Authoring one of
 * those would append a permanent `invalid_payload` anomaly whose only visible
 * effect is a category the user created and cannot see.
 */
export function categoryDefinedOps(def: CategoryDef): CategoryOpSpec[] {
  const name = def.name.trim();
  if (name === "") throw new Error("a category needs a name");
  if (def.id.trim() === "") throw new Error("a category needs an id");
  if (def.kind === "spending" && def.bucket === null) {
    throw new Error("a spending category needs a bucket of need, want or saving");
  }
  if (def.kind !== "spending" && def.bucket !== null) {
    throw new Error(`a ${def.kind} category must not carry a bucket`);
  }
  return [
    {
      type: "category_defined",
      payload: { id: def.id, name, kind: def.kind, bucket: def.bucket, color: def.color, active: def.active },
    },
  ];
}

/** Retiring: the same definition, `active: false`. There is no delete op. */
export function retireCategoryOps(def: CategoryDef): CategoryOpSpec[] {
  return categoryDefinedOps({ ...def, active: false });
}

/** Bringing one back. The inverse of {@link retireCategoryOps}, and the same op. */
export function restoreCategoryOps(def: CategoryDef): CategoryOpSpec[] {
  return categoryDefinedOps({ ...def, active: true });
}
