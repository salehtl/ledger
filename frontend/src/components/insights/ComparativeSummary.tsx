import { Card } from "../ui/Card";
import { Money } from "../Money";
import { bucketColor, BUCKET_LABEL } from "../../lib/insights";
import type { BucketComparison, SavingsResult } from "../../lib/insights";
import { DeltaBadge } from "./DeltaBadge";

export function ComparativeSummary({ label, note, net, savings, buckets, onSelectBucket }: {
  label: string; note: string; net: number; savings: SavingsResult; buckets: BucketComparison[];
  onSelectBucket?: (bucket: string) => void;
}) {
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
      <div className="mt-3 space-y-1.5">
        {buckets.map((b) => {
          const inner = (
            <>
              <span className="flex items-center gap-2">
                <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ background: bucketColor(b.bucket) }} aria-hidden />
                {BUCKET_LABEL[b.bucket] ?? b.bucket}
              </span>
              <span className="flex items-center gap-2">
                <span className="tnum text-muted"><Money fils={b.spent} /></span>
                <DeltaBadge delta={b.delta} deltaPct={b.prevSpent > 0 ? b.delta / b.prevSpent : null} isNew={b.prevSpent === 0 && b.spent > 0} />
              </span>
            </>
          );
          return onSelectBucket ? (
            <button key={b.bucket} className="w-full flex items-center justify-between gap-2 text-sm text-left" onClick={() => onSelectBucket(b.bucket)}>
              {inner}
            </button>
          ) : (
            <div key={b.bucket} className="flex items-center justify-between gap-2 text-sm">{inner}</div>
          );
        })}
      </div>
    </Card>
  );
}
