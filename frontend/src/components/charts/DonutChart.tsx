import { PieChart, Pie, Cell, ResponsiveContainer } from "recharts";
import type { DonutSlice } from "../../lib/insights";
import { formatFils } from "../../lib/money";

export function DonutChart({ slices, centerLabel, centerValue }: {
  slices: DonutSlice[]; centerLabel: string; centerValue: number;
}) {
  const share = (value: number) => (centerValue > 0 ? Math.round((value / centerValue) * 100) : 0);
  return (
    <div>
      <div className="relative h-44" role="img" aria-label={`Spending by category, total ${formatFils(centerValue)}`}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie data={slices} dataKey="value" nameKey="name" innerRadius="68%" outerRadius="100%"
                 stroke="var(--color-surface)" strokeWidth={2} paddingAngle={1.5}>
              {slices.map((s, i) => <Cell key={i} fill={s.color} />)}
            </Pie>
          </PieChart>
        </ResponsiveContainer>
        <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
          <span className="text-xs text-muted">{centerLabel}</span>
          <span className="text-lg font-semibold tnum">{formatFils(centerValue)}</span>
        </div>
      </div>
      <ul className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5">
        {slices.map((s, i) => (
          <li key={i} className="flex items-center gap-2 min-w-0 text-sm">
            <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: s.color }} aria-hidden />
            <span className="truncate">{s.name}</span>
            <span className="ml-auto tnum text-muted shrink-0">{share(s.value)}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
