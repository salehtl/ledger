import { Card } from "../ui/Card";
import { Money } from "../Money";
import { bucketColor, BUCKET_LABEL } from "../../lib/insights";
import type { BucketComparison, SavingsResult } from "../../lib/insights";
import { DitherFill } from "../charts/DitherFill";
import { bucketDither, bucketDensity } from "../../lib/ditherColor";

export function ComparativeSummary({ label, note, net, savings, buckets, overBudgetBuckets = new Set(), onSelectBucket }: {
  label: string; note: string; net: number; savings: SavingsResult; buckets: BucketComparison[];
  /** Bucket names at or over target for the period shown (see `overBudgetBuckets` in `lib/insights.ts`) — those bars render solid instead of their usual density. */
  overBudgetBuckets?: Set<string>;
  onSelectBucket?: (bucket: string) => void;
}) {
  const total = buckets.reduce((s, b) => s + b.spent, 0);
  return (
    <Card>
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-sm font-medium">{label}</p>
        {note && <span className="text-xs text-muted">{note}</span>}
      </div>
      <div className="mt-2 flex items-end justify-between gap-3">
        <div>
          <p className="text-xs text-muted">Net this month</p>
          <p className="text-2xl font-bold tnum"><Money fils={net} /></p>
        </div>
        <div className="text-right">
          <p className="text-xs text-muted">Saved</p>
          <p className={`text-lg font-semibold tnum ${savings.rate != null && savings.rate < 0 ? "text-bad" : ""}`}>{savings.rate != null ? `${Math.round(savings.rate * 100)}%` : "—"}</p>
        </div>
      </div>

      {/* Spending split: one bar showing the need/want/saving proportions. */}
      <div className="mt-3">
        <DitherFill
          segments={buckets.filter((b) => b.spent > 0).map((b) => ({ value: b.spent, color: bucketDither(b.bucket), density: bucketDensity(b.bucket, overBudgetBuckets.has(b.bucket)) }))}
          max={total}
          height={12}
        />
      </div>

      {/* Legend doubles as drill-in: tap a bucket to see its transactions. */}
      <div className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1.5">
        {buckets.map((b) => {
          const chip = (
            <>
              <span className="inline-block w-2.5 h-2.5 rounded-[var(--radius)] shrink-0" style={{ background: bucketColor(b.bucket) }} aria-hidden />
              <span className="text-sm">{BUCKET_LABEL[b.bucket] ?? b.bucket}</span>
              <span className="text-xs text-muted tnum"><Money fils={b.spent} /></span>
            </>
          );
          return onSelectBucket ? (
            <button key={b.bucket} aria-label={`See ${BUCKET_LABEL[b.bucket] ?? b.bucket} transactions`} className="flex items-center gap-1.5" onClick={() => onSelectBucket(b.bucket)}>
              {chip}
            </button>
          ) : (
            <span key={b.bucket} className="flex items-center gap-1.5">{chip}</span>
          );
        })}
      </div>
    </Card>
  );
}
