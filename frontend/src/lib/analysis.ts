import type { Txn } from "../api/types";

/** A transaction counts toward spending iff it mirrors SelectCategorySpend:
 *  confirmed, debit, and in a spending-kind category. */
export function isSpending(t: Txn): boolean {
  return t.Status === "confirmed" && t.Direction === "debit" && t.Kind === "spending";
}

export function spendingTxns(txns: Txn[]): Txn[] {
  return txns.filter(isSpending);
}

/** The bucket a spending txn belongs to: the frozen snapshot when freeze_history
 *  is on and present, otherwise the category's live bucket. */
export function effectiveBucket(t: Txn, frozen: boolean): string {
  return frozen && t.BucketSnapshot ? t.BucketSnapshot : t.Bucket;
}

export interface CategoryBreakdownRow {
  categoryId: number | null;
  name: string;
  bucket: string;
  spent: number;
  count: number;
  share: number;
}

export interface BucketBreakdownRow {
  bucket: string;
  spent: number;
  share: number;
  categories: CategoryBreakdownRow[];
}

/** Group spending transactions by effective bucket, then by category.
 *  Shares are fractions of the total spending in the input. */
export function bucketBreakdown(txns: Txn[], frozen: boolean): BucketBreakdownRow[] {
  const spending = spendingTxns(txns);
  const total = spending.reduce((s, t) => s + t.AmountFils, 0);

  const buckets = new Map<string, { spent: number; cats: Map<string, CategoryBreakdownRow> }>();
  for (const t of spending) {
    const bucket = effectiveBucket(t, frozen);
    const b = buckets.get(bucket) ?? { spent: 0, cats: new Map() };
    b.spent += t.AmountFils;
    const key = t.CategoryID === null ? "uncategorized" : String(t.CategoryID);
    const c = b.cats.get(key) ?? { categoryId: t.CategoryID, name: t.CategoryName || "Uncategorized", bucket, spent: 0, count: 0, share: 0 };
    c.spent += t.AmountFils;
    c.count += 1;
    b.cats.set(key, c);
    buckets.set(bucket, b);
  }

  const out: BucketBreakdownRow[] = [];
  for (const [bucket, b] of buckets) {
    const categories = [...b.cats.values()]
      .map((c) => ({ ...c, share: total > 0 ? c.spent / total : 0 }))
      .sort((a, c) => c.spent - a.spent);
    out.push({ bucket, spent: b.spent, share: total > 0 ? b.spent / total : 0, categories });
  }
  return out.sort((a, c) => c.spent - a.spent);
}

export interface MerchantRow {
  merchant: string;
  spent: number;
  count: number;
  share: number;
}

/** Spending grouped by merchant_raw, sorted by spend desc. When topN is given
 *  and there are more merchants, the remainder is folded into an "Other" row. */
export function merchantBreakdown(txns: Txn[], topN?: number): MerchantRow[] {
  const spending = spendingTxns(txns);
  const total = spending.reduce((s, t) => s + t.AmountFils, 0);
  const byMerchant = new Map<string, { spent: number; count: number }>();
  for (const t of spending) {
    const name = t.MerchantRaw || "—";
    const m = byMerchant.get(name) ?? { spent: 0, count: 0 };
    m.spent += t.AmountFils;
    m.count += 1;
    byMerchant.set(name, m);
  }
  const rows = [...byMerchant.entries()]
    .map(([merchant, m]) => ({ merchant, spent: m.spent, count: m.count, share: total > 0 ? m.spent / total : 0 }))
    .sort((a, b) => b.spent - a.spent);

  if (topN === undefined || rows.length <= topN) return rows;
  const head = rows.slice(0, topN);
  const rest = rows.slice(topN);
  const restSpent = rest.reduce((s, r) => s + r.spent, 0);
  const restCount = rest.reduce((s, r) => s + r.count, 0);
  head.push({ merchant: "Other", spent: restSpent, count: restCount, share: total > 0 ? restSpent / total : 0 });
  return head;
}

/** Case-insensitive merchant substring filter. Empty/blank term returns all. */
export function searchTxns(rows: Txn[], term: string): Txn[] {
  const q = term.trim().toLowerCase();
  if (!q) return rows;
  return rows.filter((t) => (t.MerchantRaw || "").toLowerCase().includes(q));
}
