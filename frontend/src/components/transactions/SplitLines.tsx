// frontend/src/components/transactions/SplitLines.tsx
import { bucketColor } from "../../lib/insights";
import { splitAmountLabel, type SplitCategoryInfo, type TxnSplit } from "../../lib/txSplit";

/**
 * The split-line stack: one calm row per line — category dot + mono label,
 * the user's note beneath, the amount (parent-currency minor units) in the
 * figures column. Pure display; the list row collapses it behind an expander,
 * the detail sheet shows it open. Line amounts always sum to the parent, so
 * no totals row repeats what the parent row already says.
 */
export function SplitLines({ splits, currency, categories, className = "" }: {
  splits: TxnSplit[];
  /** Parent transaction currency — split amounts live in its minor units. */
  currency: string;
  /** Category lookup for names + dot colour; lines fall back to "—" without it. */
  categories?: Record<number, SplitCategoryInfo>;
  className?: string;
}) {
  return (
    <ul className={`divide-y divide-border border border-border rounded-[var(--radius)] ${className}`}>
      {splits.map((s) => {
        const info = categories?.[s.CategoryID];
        const dot = !info
          ? "var(--color-border)"
          : info.kind === "income"
            ? "var(--color-good)"
            : info.bucket
              ? bucketColor(info.bucket)
              : "var(--color-border)";
        return (
          <li key={s.ID} className="flex items-start justify-between gap-3 px-3 py-2">
            <div className="min-w-0 flex-1">
              <p className="flex items-center gap-1.5 font-mono text-xs tracking-[0.04em]">
                <span aria-hidden className="w-2 h-2 rounded-[var(--radius)] shrink-0" style={{ background: dot }} />
                <span className="truncate">{info?.name ?? "—"}</span>
              </p>
              {s.Note ? <p className="mt-0.5 text-xs text-muted break-words">{s.Note}</p> : null}
            </div>
            <span className="tnum text-sm shrink-0">{splitAmountLabel(s.AmountFils, currency)}</span>
          </li>
        );
      })}
    </ul>
  );
}
