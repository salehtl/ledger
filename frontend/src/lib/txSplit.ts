// frontend/src/lib/txSplit.ts
//
// Pure split-transaction math and display shaping (v3 piece 6). All money is
// integer fils in the PARENT transaction's currency minor units — the wire
// contract for PUT /api/transactions/{id}/splits (docs/v3/api-contract.md §6).
// Components stay thin: remainder computation, rounding absorption, validation
// (sum === parent, category-kind rules) and label shaping all live here.
import type { Category, Txn } from "../api/types";
import { formatFils } from "./money";

/** One split line as the transaction-list payload decorates it (Go-name keys). */
export interface TxnSplit {
  ID: number;
  TransactionID: number;
  CategoryID: number;
  AmountFils: number;
  Note?: string;
}

/**
 * A transaction as the v3 list payload decorates it. `Splits` is absent for
 * unsplit rows; `Note`/`DisplayName` are "" or absent when unset. The shared
 * Txn type gains these at integration; until then this piece-local extension
 * carries them.
 */
export interface TxnDepth extends Txn {
  Note?: string;
  DisplayName?: string;
  Splits?: TxnSplit[];
}

/** Wire shape of one PUT /splits request line (snake_case per the contract). */
export interface SplitLineBody {
  category_id: number;
  amount_fils: number;
  note: string;
}

/** One editable line of the split sheet's draft. */
export interface SplitDraftLine {
  categoryId: number;
  amountText: string;
  note: string;
}

/** Whether a decorated transaction currently has split lines. */
export function isSplitTxn(t: TxnDepth): boolean {
  return (t.Splits?.length ?? 0) > 0;
}

/** The name a merchant should print as: the rule clean-name, else the raw string. */
export function displayMerchant(t: TxnDepth): string {
  return t.DisplayName || t.MerchantRaw;
}

/**
 * Parse amount text ("150", "39.50", "1,250.75") into integer fils without any
 * float arithmetic on the value: whole and fraction digits are parsed
 * separately and recombined as integers. Returns null on anything that is not
 * a plain non-negative amount with at most two decimals.
 */
export function parseAmountToFils(text: string): number | null {
  const t = text.trim().replace(/,/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  const [whole, frac = ""] = t.split(".");
  const cents = (frac + "00").slice(0, 2);
  return Number(whole) * 100 + Number(cents);
}

/** Prefill text for an amount input: 15000 → "150", 3950 → "39.50". */
export function filsToAmountText(fils: number): string {
  const v = Math.max(0, fils);
  const whole = Math.trunc(v / 100);
  const cents = v % 100;
  return cents === 0 ? String(whole) : `${whole}.${String(cents).padStart(2, "0")}`;
}

/**
 * Display label for a split-line amount. Split amounts live in the parent's
 * currency, so non-AED parents carry the currency code the way row native
 * tags do ("USD 10.09"); AED prints bare.
 */
export function splitAmountLabel(fils: number, currency: string): string {
  const text = formatFils(fils);
  return !currency || currency === "AED" ? text : `${currency} ${text}`;
}

/**
 * Categories a split line may target, mirroring the server's rules exactly:
 * active categories only; `spending` kind for debit parents; `spending`
 * (refund) or `income` for credit parents. Excluded-kind never qualifies —
 * those fils would vanish from every aggregate.
 */
export function eligibleSplitCategories(categories: Category[], direction: string): Category[] {
  return categories.filter((c) => {
    if (!c.IsActive) return false;
    if (c.Kind === "spending") return true;
    return direction === "credit" && c.Kind === "income";
  });
}

/** Parse every draft line's amount; null marks an empty/invalid entry. */
export function draftAmounts(lines: Array<{ amountText: string }>): Array<number | null> {
  return lines.map((l) => parseAmountToFils(l.amountText));
}

/**
 * Fils still unplaced: parent − Σ(parsed amounts). Unparsed lines contribute
 * nothing. Negative means the lines overshoot the parent.
 */
export function splitRemainder(parentFils: number, amounts: Array<number | null>): number {
  let sum = 0;
  for (const a of amounts) sum += a ?? 0;
  return parentFils - sum;
}

/**
 * The amount line `index` must hold for the set to sum exactly to the parent
 * (the "last line absorbs the rounding" move). Null when the balancing value
 * would not be a positive amount.
 */
export function absorbRemainder(
  parentFils: number,
  amounts: Array<number | null>,
  index: number,
): number | null {
  let others = 0;
  for (let i = 0; i < amounts.length; i++) {
    if (i !== index) others += amounts[i] ?? 0;
  }
  const value = parentFils - others;
  return value > 0 ? value : null;
}

/**
 * Divide a parent evenly across n lines in integer fils; the LAST line absorbs
 * the rounding remainder so the set always sums exactly to the parent.
 * evenAmounts(10000, 3) → [3333, 3333, 3334].
 */
export function evenAmounts(parentFils: number, n: number): number[] {
  if (n <= 0) return [];
  const base = Math.floor(parentFils / n);
  const out = new Array<number>(n).fill(base);
  out[n - 1] = parentFils - base * (n - 1);
  return out;
}

export type SplitValidation =
  | { ok: true; body: SplitLineBody[]; unsplit: boolean }
  | { ok: false; error: string };

/**
 * Validate a draft against the server's rules so a request that would 400
 * never leaves the sheet: every line needs an eligible category and a positive
 * amount, and a non-empty set must sum exactly to the parent. An empty draft
 * is valid and means un-split (the parent returns to the review queue).
 */
export function validateSplitDraft(
  parent: { amountFils: number; direction: string },
  lines: SplitDraftLine[],
  categories: Category[],
): SplitValidation {
  if (lines.length === 0) return { ok: true, body: [], unsplit: true };

  const eligible = new Set(eligibleSplitCategories(categories, parent.direction).map((c) => c.ID));
  const body: SplitLineBody[] = [];
  let sum = 0;
  for (const line of lines) {
    if (!eligible.has(line.categoryId)) {
      return { ok: false, error: "A line points at a category this transaction can't use." };
    }
    const fils = parseAmountToFils(line.amountText);
    if (fils === null) return { ok: false, error: "Every line needs an amount." };
    if (fils === 0) return { ok: false, error: "Amounts must be more than zero." };
    sum += fils;
    body.push({ category_id: line.categoryId, amount_fils: fils, note: line.note.trim() });
  }
  if (sum !== parent.amountFils) {
    return { ok: false, error: "Lines must add up to the full amount." };
  }
  return { ok: true, body, unsplit: false };
}

/** Category id → name lookup for split-line display. */
export function categoryNamesById(categories: Category[]): Record<number, string> {
  const out: Record<number, string> = {};
  for (const c of categories) out[c.ID] = c.Name;
  return out;
}

/** One split-line category's display facts (dot colour + label). */
export interface SplitCategoryInfo {
  name: string;
  bucket: string;
  kind: string;
}

/** Category id → name/bucket/kind lookup for split-line display. */
export function categoryInfoById(categories: Category[]): Record<number, SplitCategoryInfo> {
  const out: Record<number, SplitCategoryInfo> = {};
  for (const c of categories) out[c.ID] = { name: c.Name, bucket: c.Bucket, kind: c.Kind };
  return out;
}

/**
 * The list-row category label for a split parent: named lines when the lookup
 * knows them ("Groceries + Dining", "Groceries + 2 more"), a plain part count
 * otherwise. Calm, no shouting — the stack underneath carries the detail.
 */
export function splitLabel(splits: TxnSplit[], nameById?: Record<number, string>): string {
  const n = splits.length;
  const names = splits.map((s) => nameById?.[s.CategoryID]).filter((x): x is string => !!x);
  if (names.length !== n || n === 0) return `${n} part${n === 1 ? "" : "s"}`;
  if (n <= 2) return names.join(" + ");
  return `${names[0]} + ${n - 1} more`;
}

/** Build the sheet's draft lines from a transaction's stored split set. */
export function draftFromSplits(splits: TxnSplit[] | undefined): SplitDraftLine[] {
  return (splits ?? []).map((s) => ({
    categoryId: s.CategoryID,
    amountText: filsToAmountText(s.AmountFils),
    note: s.Note ?? "",
  }));
}

/** Map stored split lines back onto the PUT body shape (undo / re-save). */
export function splitsToBody(splits: TxnSplit[]): SplitLineBody[] {
  return splits.map((s) => ({
    category_id: s.CategoryID,
    amount_fils: s.AmountFils,
    note: s.Note ?? "",
  }));
}
