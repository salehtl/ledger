import { PieChart, Pie, Cell, ResponsiveContainer } from "recharts";
import type { DonutSlice } from "../../lib/insights";
import { formatFils } from "../../lib/money";

export function DonutChart({ slices, centerLabel, centerValue }: {
  slices: DonutSlice[]; centerLabel: string; centerValue: number;
}) {
  return (
    <div className="relative h-44">
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie data={slices} dataKey="value" nameKey="name" innerRadius="68%" outerRadius="100%"
               stroke="none" paddingAngle={1}>
            {slices.map((s, i) => <Cell key={i} fill={s.color} />)}
          </Pie>
        </PieChart>
      </ResponsiveContainer>
      <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
        <span className="text-xs text-muted">{centerLabel}</span>
        <span className="text-lg font-semibold tnum">{formatFils(centerValue)}</span>
      </div>
    </div>
  );
}
