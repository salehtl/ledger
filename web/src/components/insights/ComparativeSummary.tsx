import { Card } from "../ui/Card";
import { Pressable } from "../ui/Pressable";
import { bucketColor } from "../../lib/insights";
import { formatMinor } from "../../lib/minorMoney";
import { share, LENS_BUCKET_LABEL } from "../../lib/lens";
import type { BucketDelta } from "../../v2/sources/insights";
import { DitherFill } from "../charts/DitherFill";
import { bucketDither, bucketDensity } from "../../lib/ditherColor";

/** Geometry resolution for the split bar; see {@link LensBreakdown}. */
const BAR_UNITS = 10_000;

/**
 * The month's headline: net, savings rate, and how the spending split across
 * the buckets.
 *
 * # No "over budget", by construction
 *
 * v1 took a `pct_used >= 1.0` set from `/api/summary` and rendered those bars
 * solid. There is no target op in the v2 vocabulary
 * (`client/src/replay/state.ts`), so there is nothing to be over and the prop is
 * gone rather than permanently passed empty — a prop nobody can ever set is a
 * claim the screen cannot make.
 *
 * Money is `bigint`; the only `number` here is the aria-hidden bar geometry and
 * the savings *rate*, which is a ratio.
 */
export function ComparativeSummary({ label, note, net, savingsRate, buckets, onSelectBucket }: {
  label: string;
  note: string;
  net: bigint;
  savingsRate: number | null;
  buckets: readonly BucketDelta[];
  onSelectBucket?: (bucket: BucketDelta) => void;
}) {
  const total = buckets.reduce((s, b) => s + b.spent, 0n);
  return (
    <Card>
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-sm font-medium">{label}</p>
        {note && <span className="text-xs text-muted">{note}</span>}
      </div>
      <div className="mt-2 flex items-end justify-between gap-3">
        <div>
          <p className="text-xs text-muted">Net this month</p>
          <p className="text-2xl font-bold tnum">{formatMinor(net)}</p>
        </div>
        <div className="text-right">
          <p className="text-xs text-muted">Saved</p>
          <p className={`text-lg font-semibold tnum ${savingsRate != null && savingsRate < 0 ? "text-bad" : ""}`}>
            {savingsRate != null ? `${Math.round(savingsRate * 100)}%` : "—"}
          </p>
        </div>
      </div>

      {/* Spending split: one bar showing the need/want/saving proportions. */}
      <div className="mt-3">
        <DitherFill
          segments={buckets
            .filter((b) => b.spent > 0n)
            .map((b) => ({
              value: share(b.spent, total) * BAR_UNITS,
              color: bucketDither(b.bucket),
              density: bucketDensity(b.bucket),
            }))}
          max={BAR_UNITS}
          height={12}
        />
      </div>

      {/* Legend doubles as drill-in: tap a bucket to see its transactions.
          Because it's tappable it needs a real target — the row's own text is
          only 20px tall, so the buttons carry vertical padding and the gaps
          shrink to compensate rather than the row growing taller. */}
      <div className="mt-1.5 flex flex-wrap gap-x-4">
        {buckets.map((b) => {
          const name = LENS_BUCKET_LABEL[b.bucket];
          const chip = (
            <>
              <span className="inline-block w-2.5 h-2.5 rounded-[var(--radius)] shrink-0" style={{ background: bucketColor(b.bucket) }} aria-hidden />
              <span className="text-sm">{name}</span>
              <span className="text-xs text-muted tnum">{formatMinor(b.spent)}</span>
            </>
          );
          return onSelectBucket ? (
            <Pressable
              key={b.bucket}
              aria-label={`See ${name} transactions`}
              className="flex min-h-11 items-center gap-1.5"
              onClick={() => onSelectBucket(b)}
            >
              {chip}
            </Pressable>
          ) : (
            <span key={b.bucket} className="flex min-h-11 items-center gap-1.5">{chip}</span>
          );
        })}
      </div>
    </Card>
  );
}
