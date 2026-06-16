import { useQuery } from "@tanstack/react-query";
import { getJSON } from "../api/client";
import type { CategorySpend, MonthlyTotal } from "../api/types";
import { Card } from "../components/ui/Card";
import { Money } from "../components/Money";
import { Pill, type Tone } from "../components/ui/Pill";
import { Skeleton } from "../components/Skeleton";
import { EmptyState } from "../components/EmptyState";
import { DonutChart } from "../components/charts/DonutChart";
import { TrendBars } from "../components/charts/TrendBars";
import { donutSlices, trendSeries, trailingPeriods, currentPeriod } from "../lib/insights";
import { AlertTriangle } from "lucide-react";

const BUCKET_TONE: Record<string, Tone> = { need: "neutral", want: "warn", saving: "good" };

export function Insights({ period = currentPeriod() }: { period?: string }) {
  // The 6-month trend is always the trailing 6 real months (it matches the
  // static /api/insights/trend), independent of the selected scope.
  const periods = trailingPeriods(currentPeriod(), 6);
  const cats = useQuery({ queryKey: ["insights-categories", period], queryFn: () => getJSON<CategorySpend[]>(`/api/insights/categories?period=${period}`) });
  const trend = useQuery({ queryKey: ["insights-trend"], queryFn: () => getJSON<MonthlyTotal[]>("/api/insights/trend?months=6") });

  if (cats.isLoading) return <Skeleton rows={8} />;
  if (cats.isError) return <EmptyState icon={AlertTriangle} title="Couldn't load insights" hint="Check your connection and try again." />;

  const data = cats.data ?? [];
  const total = data.reduce((s, c) => s + c.spent, 0);
  const slices = donutSlices(data);
  const points = trendSeries(trend.data ?? [], periods);

  return (
    <div className="space-y-4">
      <Card>
        <p className="text-sm font-medium mb-2">Where the money went</p>
        {slices.length === 0 ? <EmptyState title="No spending this month" /> : <DonutChart slices={slices} centerLabel="Spent" centerValue={total} />}
      </Card>

      <Card>
        <p className="text-sm font-medium mb-2">6-month spending trend</p>
        {trend.isError
          ? <p className="text-sm text-muted text-center py-6">Trend unavailable</p>
          : <TrendBars points={points} activePeriod={period} />}
      </Card>

      <Card className="!p-0">
        <p className="text-sm font-medium px-4 pt-4">By category</p>
        {data.length === 0 ? (
          <EmptyState title="Nothing to break down yet" />
        ) : (
          <ul className="divide-y divide-border px-4 pb-2">
            {data.map((c) => (
              <li key={c.category_id} className="py-2.5 flex items-center justify-between gap-3">
                <span className="flex items-center gap-2 min-w-0">
                  <span className="truncate">{c.name}</span>
                  <Pill tone={BUCKET_TONE[c.bucket] ?? "muted"}>{c.bucket}</Pill>
                </span>
                <span className="tnum font-medium"><Money fils={c.spent} /></span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
