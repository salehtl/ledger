import { Card } from "../ui/Card";
import type { CategoryDelta } from "../../v2/sources/insights";
import { formatMinor } from "../../lib/minorMoney";
import { DeltaBadge } from "./DeltaBadge";

/**
 * The categories that moved most since last month.
 *
 * `movers` arrives already ranked by the caller; money is `bigint` minor units
 * because each figure is the difference of two SUMs over the projection.
 */
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
            <li key={m.key} className="flex items-center justify-between gap-3 text-sm">
              <span className="truncate">{m.name}</span>
              <span className="flex items-center gap-2">
                <span className="tnum text-muted">{formatMinor(m.delta < 0n ? -m.delta : m.delta)}</span>
                <DeltaBadge delta={m.delta} deltaPct={m.deltaPct} isNew={m.isNew} isGone={m.isGone} />
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
