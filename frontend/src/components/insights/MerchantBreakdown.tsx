import type { Txn } from "../../api/types";
import { Card } from "../ui/Card";
import { Money } from "../Money";
import { EmptyState } from "../EmptyState";
import { merchantBreakdown } from "../../lib/analysis";

export function MerchantBreakdown({ txns, onSelect }: { txns: Txn[]; onSelect: (merchant: string) => void }) {
  const rows = merchantBreakdown(txns, 8);
  return (
    <Card className="!p-0">
      <p className="text-sm font-medium px-4 pt-4">Top merchants</p>
      {rows.length === 0 ? (
        <EmptyState title="No spending this month" />
      ) : (
        <ul className="divide-y divide-border px-4 pb-2">
          {rows.map((m) => {
            const isOther = m.merchant === "Other";
            const content = (
              <span className="flex items-center justify-between gap-3 w-full">
                <span className="truncate">{m.merchant}</span>
                <span className="flex items-center gap-3 shrink-0">
                  <span className="text-xs text-muted tnum">{Math.round(m.share * 100)}%</span>
                  <span className="tnum font-medium"><Money fils={m.spent} /></span>
                </span>
              </span>
            );
            return (
              <li key={m.merchant} className="py-2.5">
                {isOther ? (
                  <div className="flex text-muted">{content}</div>
                ) : (
                  <button type="button" aria-label={`Drill into ${m.merchant}`} className="w-full text-left" onClick={() => onSelect(m.merchant)}>
                    {content}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
