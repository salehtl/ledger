import { Card } from "../ui/Card";
import { Money } from "../Money";
import { Pill, type Tone } from "../ui/Pill";
import { EmptyState } from "../EmptyState";
import { BUCKET_LABEL, type CategoryDelta } from "../../lib/insights";
import { DeltaBadge } from "./DeltaBadge";

const BUCKET_TONE: Record<string, Tone> = { need: "neutral", want: "warn", saving: "good" };

export function CategoryComparisonList({ rows, onSelectCategory }: {
  rows: (CategoryDelta & { pct: number })[];
  onSelectCategory?: (categoryId: number, name: string) => void;
}) {
  return (
    <Card className="!p-0">
      <p className="text-sm font-medium px-4 pt-4">By category</p>
      {rows.length === 0 ? (
        <EmptyState title="Nothing to break down yet" />
      ) : (
        <ul className="divide-y divide-border px-4 pb-2">
          {rows.map((c) => {
            const inner = (
              <>
                <span className="flex items-center gap-2 min-w-0">
                  <span className="truncate">{c.name}</span>
                  <Pill tone={BUCKET_TONE[c.bucket] ?? "muted"}>{BUCKET_LABEL[c.bucket] ?? c.bucket}</Pill>
                </span>
                <span className="flex items-center gap-3">
                  <span className="text-xs text-muted tnum">{Math.round(c.pct * 100)}%</span>
                  <span className="tnum font-medium"><Money fils={c.spent} /></span>
                  <DeltaBadge delta={c.delta} deltaPct={c.deltaPct} isNew={c.isNew} isGone={c.spent === 0 && c.prevSpent > 0} />
                </span>
              </>
            );
            return (
              <li key={c.category_id} className="py-2.5">
                {onSelectCategory ? (
                  <button className="w-full flex items-center justify-between gap-3 text-left" onClick={() => onSelectCategory(c.category_id, c.name)}>
                    {inner}
                  </button>
                ) : (
                  <div className="flex items-center justify-between gap-3">{inner}</div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
