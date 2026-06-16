import { Card } from "../ui/Card";
import { Money } from "../Money";
import type { CategoryDelta } from "../../lib/insights";
import { DeltaBadge } from "./DeltaBadge";

export function TopMovers({ movers, hasPrev }: { movers: CategoryDelta[]; hasPrev: boolean }) {
  return (
    <Card>
      <p className="text-sm font-medium mb-2">Biggest changes</p>
      {!hasPrev ? (
        <p className="text-sm text-muted">No prior month to compare.</p>
      ) : movers.length === 0 ? (
        <p className="text-sm text-muted">No notable changes.</p>
      ) : (
        <ul className="space-y-2">
          {movers.map((m) => (
            <li key={m.category_id} className="flex items-center justify-between gap-3 text-sm">
              <span className="truncate">{m.name}</span>
              <span className="flex items-center gap-2">
                <span className="tnum text-muted"><Money fils={m.delta} /></span>
                <DeltaBadge delta={m.delta} deltaPct={m.deltaPct} isNew={m.isNew} isGone={m.spent === 0 && m.prevSpent > 0} />
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
