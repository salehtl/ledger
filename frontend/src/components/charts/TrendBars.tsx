import { BarChart, Bar, XAxis, ResponsiveContainer, Cell } from "recharts";
import type { TrendPoint } from "../../lib/insights";

export function TrendBars({ points, activePeriod }: { points: TrendPoint[]; activePeriod?: string }) {
  return (
    <div className="h-32" role="img" aria-label="Monthly spending trend">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={points} margin={{ top: 8, right: 0, bottom: 0, left: 0 }}>
          <XAxis dataKey="label" tickLine={false} axisLine={false} fontSize={11} stroke="var(--color-muted)" />
          <Bar dataKey="spent" radius={[4, 4, 0, 0]}>
            {points.map((p, i) => (
              <Cell key={i} fill={p.period === activePeriod ? "var(--color-accent)" : "var(--color-border)"} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
