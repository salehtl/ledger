import { useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Dialog } from "./Dialog";
import { Button } from "./Button";
import { type Scope, addMonth, normalizeRange } from "../../lib/scope";
import { currentPeriod, monthLabel } from "../../lib/insights";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function PeriodSheet({ scope, onApply, onClose }: {
  scope: Scope;
  onApply: (s: Scope) => void;
  onClose: () => void;
}) {
  const seed = scope.kind === "month" ? scope.period : scope.kind === "range" ? scope.to : currentPeriod();
  const [year, setYear] = useState(Number(seed.slice(0, 4)));
  const [from, setFrom] = useState<string | null>(
    scope.kind === "month" ? scope.period : scope.kind === "range" ? scope.from : null,
  );
  const [to, setTo] = useState<string | null>(
    scope.kind === "month" ? scope.period : scope.kind === "range" ? scope.to : null,
  );

  // First tap starts a single selection; the next tap closes a range; a tap
  // after a complete range starts over.
  const pick = (period: string) => {
    if (from === null || to !== null) {
      setFrom(period);
      setTo(null);
    } else {
      const r = normalizeRange(from, period);
      setFrom(r.from);
      setTo(r.to);
    }
  };

  const inSel = (period: string) => (from && to ? period >= from && period <= to : period === from);

  const show = () => {
    if (from && to) onApply(from === to ? { kind: "month", period: from } : { kind: "range", from, to });
    else if (from) onApply({ kind: "month", period: from });
  };

  const hint =
    from && to && from !== to
      ? `${monthLabel(from)}–${monthLabel(to)} selected`
      : from
        ? "Tap a second month for a range"
        : "Pick a month";

  return (
    <Dialog title="Choose period" onClose={onClose}>
      <div className="flex flex-wrap gap-2 mb-4">
        <Button variant="secondary" onClick={() => onApply({ kind: "month", period: currentPeriod() })}>This month</Button>
        <Button variant="secondary" onClick={() => onApply({ kind: "range", from: addMonth(currentPeriod(), -2), to: currentPeriod() })}>Last 3 months</Button>
        <Button variant="secondary" onClick={() => onApply({ kind: "range", from: `${currentPeriod().slice(0, 4)}-01`, to: currentPeriod() })}>Year to date</Button>
        <Button variant="secondary" onClick={() => onApply({ kind: "all" })}>All time</Button>
      </div>

      <div className="flex items-center justify-between mb-3">
        <button aria-label="Previous year" className="p-2 rounded-md text-muted hover:bg-bg" onClick={() => setYear((y) => y - 1)}><ChevronLeft size={18} /></button>
        <span className="text-sm font-semibold tnum">{year}</span>
        <button aria-label="Next year" className="p-2 rounded-md text-muted hover:bg-bg" onClick={() => setYear((y) => y + 1)}><ChevronRight size={18} /></button>
      </div>

      <div className="grid grid-cols-3 gap-2 mb-4">
        {MONTHS.map((m, i) => {
          const period = `${year}-${String(i + 1).padStart(2, "0")}`;
          const selected = inSel(period);
          const isCurrent = period === currentPeriod();
          return (
            <button
              key={m}
              onClick={() => pick(period)}
              aria-pressed={selected}
              className={`min-h-11 rounded-lg text-sm font-medium transition-colors ${
                selected ? "bg-accent text-accent-fg" : isCurrent ? "bg-surface-2 text-fg ring-1 ring-accent/40" : "bg-surface-2 text-fg hover:bg-border/60"
              }`}
            >
              {m}
            </button>
          );
        })}
      </div>

      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-muted">{hint}</p>
        <Button variant="primary" disabled={!from} onClick={show}>Show</Button>
      </div>
    </Dialog>
  );
}
