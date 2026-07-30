import { useState } from "react";
import type { Category, Txn } from "../../api/types";
import { Dialog } from "../../components/ui/Dialog";
import { Money } from "../../components/Money";
import { EmptyState } from "../../components/EmptyState";
import { AlertTriangle } from "../../components/ui/PixelIcon";
import { Skeleton } from "../../components/Skeleton";
import { TransactionRow } from "../../components/transactions/TransactionRow";
import { CategorizeSheet } from "../../components/transactions/CategorizeSheet";
import { useTxnActions } from "../../hooks/useTxnActions";
import { aedFils } from "../../lib/money";
import type { ReportTxn } from "../../lib/reports";

/**
 * The reports drill-down: the transactions behind one report figure, in the
 * same Dialog-list idiom as the Insights drill-down (rebuilt piece-local —
 * the shared sheet's bucket/merchant targeting doesn't fit report cells).
 * Rows stay fully actionable: tapping one opens the categorize sheet, so an
 * audit that surfaces a miscategorized line can fix it on the spot.
 */
export function ReportDrillSheet({ title, note, txns, pending, error = false, categories, onClose }: {
  title: string;
  /** Optional qualifier under the count line, e.g. "spending only". */
  note?: string;
  txns: ReportTxn[];
  /** True while the backing transactions query is still fetching. */
  pending: boolean;
  /** True when the backing transactions query failed — the sheet must say so
   *  rather than claim "No transactions" under a figure that exists. */
  error?: boolean;
  categories: Category[];
  onClose: () => void;
}) {
  const { categorize } = useTxnActions();
  const [active, setActive] = useState<Txn | null>(null);

  // Money-in positive: a Salary drill reads +26,500, matching the report
  // figures this sheet audits (net rows are income − expense).
  const net = txns.reduce((s, t) => {
    const v = aedFils(t);
    if (v === null) return s;
    return t.Direction === "credit" ? s + v : s - v;
  }, 0);

  return (
    <Dialog title={title} onClose={onClose}>
      {pending ? (
        <Skeleton rows={5} />
      ) : error ? (
        <EmptyState icon={AlertTriangle} title="Couldn't load transactions" hint="Check your connection and try again." />
      ) : (
        <>
          <p className="text-sm text-muted mb-3">
            {txns.length} transaction{txns.length === 1 ? "" : "s"} · <span className="tnum"><Money fils={net} /></span>
            {note ? <span className="block font-mono text-[10px] tracking-[0.04em] mt-0.5">{note}</span> : null}
          </p>
          {txns.length === 0 ? (
            <EmptyState title="No transactions" hint="Nothing recorded behind this figure." />
          ) : (
            <ul className="divide-y divide-border">
              {txns.map((t) => (
                <li key={t.ID}>
                  <TransactionRow txn={t} onOpen={setActive} />
                </li>
              ))}
            </ul>
          )}
        </>
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
