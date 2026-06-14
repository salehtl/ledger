import type { BucketSummary } from "../api/types";
import { Money } from "./Money";

const LABELS: Record<string, string> = { need: "Needs", want: "Wants", saving: "Savings" };

export function barColor(pct: number): string {
  if (pct >= 1.0) return "bar-red";
  if (pct >= 0.8) return "bar-amber";
  return "bar-green";
}

export function BucketBox({ b }: { b: BucketSummary }) {
  const width = Math.min(100, Math.max(0, b.pct_used * 100));
  return (
    <fieldset style={{ marginBottom: 10 }}>
      <legend>{LABELS[b.bucket] ?? b.bucket}</legend>
      <div className="bar" role="progressbar" aria-valuenow={Math.round(width)}>
        <div className={`bar-fill ${barColor(b.pct_used)}`} style={{ width: `${width}%` }} />
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6 }}>
        <span>Spent <Money fils={b.spent} /> / <Money fils={b.target} /></span>
        <span>Left <Money fils={b.remaining} /></span>
      </div>
    </fieldset>
  );
}
