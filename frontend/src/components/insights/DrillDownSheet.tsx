import { useState } from "react";
import type { Category, Txn } from "../../api/types";
import { Dialog } from "../ui/Dialog";
import { Money } from "../Money";
import { EmptyState } from "../EmptyState";
import { TransactionRow } from "../transactions/TransactionRow";
import { CategorizeSheet } from "../transactions/CategorizeSheet";
import { useTxnActions } from "../../hooks/useTxnActions";
import { bucketBreakdown, effectiveBucket, isSpending } from "../../lib/analysis";
import { BUCKET_LABEL } from "../../lib/insights";

export type DrillTarget =
  | { type: "bucket"; bucket: string }
  | { type: "category"; categoryId: number | null; name: string }
  | { type: "merchant"; merchant: string };

export function DrillDownSheet({ target, txns, frozen, categories, onClose }: {
  target: DrillTarget;
  txns: Txn[];
  frozen: boolean;
  categories: Category[];
  onClose: () => void;
}) {
  // Within a bucket sheet, the user can narrow to one category (nested drill).
  const [narrowed, setNarrowed] = useState<{ categoryId: number | null; name: string } | null>(null);
  const { setStatus, archiveTxn, restoreTxn, categorize } = useTxnActions();
  const [active, setActive] = useState<Txn | null>(null);

  const spending = txns.filter(isSpending);

  // Resolve the active view (target, or the narrowed category inside a bucket).
  let title: string;
  let rows: Txn[];
  let subRows: { categoryId: number | null; name: string; spent: number; count: number }[] = [];

  if (target.type === "bucket" && !narrowed) {
    title = BUCKET_LABEL[target.bucket] ?? target.bucket;
    const bucket = bucketBreakdown(txns, frozen).find((b) => b.bucket === target.bucket);
    subRows = (bucket?.categories ?? []).map((c) => ({ categoryId: c.categoryId, name: c.name, spent: c.spent, count: c.count }));
    rows = spending.filter((t) => effectiveBucket(t, frozen) === target.bucket);
  } else if (target.type === "bucket" && narrowed) {
    title = narrowed.name;
    rows = spending.filter((t) => effectiveBucket(t, frozen) === target.bucket && t.CategoryID === narrowed.categoryId);
  } else if (target.type === "category") {
    title = target.name;
    rows = spending.filter((t) => t.CategoryID === target.categoryId);
  } else {
    title = (target as { type: "merchant"; merchant: string }).merchant;
    rows = spending.filter((t) => (t.MerchantRaw || "—") === (target as { type: "merchant"; merchant: string }).merchant);
  }

  const total = rows.reduce((s, t) => s + t.AmountFils, 0);

  return (
    <Dialog title={title} onClose={onClose}>
      {target.type === "bucket" && narrowed && (
        <button aria-label="Back" className="text-sm text-accent mb-2" onClick={() => setNarrowed(null)}>← Back</button>
      )}
      <p className="text-sm text-muted mb-3">{rows.length} transaction{rows.length === 1 ? "" : "s"} · <span className="tnum"><Money fils={-total} /></span></p>

      {subRows.length > 0 && (
        <ul className="mb-3 divide-y divide-border">
          {subRows.map((c) => (
            <li key={c.categoryId ?? "uncat"}>
              <button
                aria-label={`Drill into ${c.name}`}
                className="w-full flex items-center justify-between gap-3 py-2 text-left"
                onClick={() => setNarrowed({ categoryId: c.categoryId, name: c.name })}
              >
                <span className="truncate">{c.name}</span>
                <span className="tnum text-muted"><Money fils={c.spent} /></span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {rows.length === 0 ? (
        <EmptyState title="No transactions" />
      ) : (
        <ul className="divide-y divide-border">
          {rows.map((t) => (
            <li key={t.ID}>
              <TransactionRow txn={t} onOpen={setActive} onStatus={setStatus} onArchive={archiveTxn} onRestore={restoreTxn} />
            </li>
          ))}
        </ul>
      )}

      {active && (
        <CategorizeSheet
          txn={active}
          categories={categories}
          onSubmit={async (body) => { if (await categorize(active, body)) setActive(null); }}
          onClose={() => setActive(null)}
        />
      )}
    </Dialog>
  );
}
