import { useQuery } from "@tanstack/react-query";
import { getJSON } from "../api/client";
import type { CategorySpend, MonthlyTotal, Summary } from "../api/types";
import { Card } from "../components/ui/Card";
import { Skeleton } from "../components/Skeleton";
import { EmptyState } from "../components/EmptyState";
import { DonutChart } from "../components/charts/DonutChart";
import { TrendBars } from "../components/charts/TrendBars";
import { ComparativeSummary } from "../components/insights/ComparativeSummary";
import { TopMovers } from "../components/insights/TopMovers";
import { CategoryComparisonList } from "../components/insights/CategoryComparisonList";
import {
  donutSlices, trendSeries, trailingPeriods, currentPeriod, monthLabel,
  categoryDeltas, withShare, bucketComparison, topMovers, savingsRate,
} from "../lib/insights";
import { addMonth, insightsFocus, DEFAULT_SCOPE, type Scope } from "../lib/scope";
import { AlertTriangle } from "lucide-react";

export function Insights({ scope = DEFAULT_SCOPE }: { scope?: Scope }) {
  const focus = insightsFocus(scope);
  const focusMonth = focus.period;
  const prevMonth = addMonth(focusMonth, -1);
  // The 6-month trend is always the trailing 6 real months (matches the static endpoint).
  const periods = trailingPeriods(currentPeriod(), 6);

  const cur = useQuery({ queryKey: ["insights-categories", focusMonth], queryFn: () => getJSON<CategorySpend[]>(`/api/insights/categories?period=${focusMonth}`) });
  const prev = useQuery({ queryKey: ["insights-categories", prevMonth], queryFn: () => getJSON<CategorySpend[]>(`/api/insights/categories?period=${prevMonth}`) });
  const summary = useQuery({ queryKey: ["summary", focusMonth], queryFn: () => getJSON<Summary>(`/api/summary?period=${focusMonth}`) });
  const trend = useQuery({ queryKey: ["insights-trend"], queryFn: () => getJSON<MonthlyTotal[]>("/api/insights/trend?months=6") });

  if (cur.isLoading || prev.isLoading || summary.isLoading) return <Skeleton rows={8} />;
  if (cur.isError) return <EmptyState icon={AlertTriangle} title="Couldn't load insights" hint="Check your connection and try again." />;

  const curData = cur.data ?? [];
  const prevData = prev.data ?? [];
  const total = curData.reduce((s, c) => s + c.spent, 0);
  const deltas = categoryDeltas(curData, prevData);
  const listRows = withShare([...deltas].sort((a, b) => b.spent - a.spent), total);
  const movers = topMovers(deltas, 3);
  const buckets = bucketComparison(curData, prevData);
  const income = summary.data?.income ?? 0;
  const savings = savingsRate(income, total);
  const slices = donutSlices(curData);
  const points = trendSeries(trend.data ?? [], periods);
  const label = `${monthLabel(focusMonth)} ${focusMonth.slice(0, 4)}`;

  return (
    <div className="space-y-4">
      <ComparativeSummary label={label} note={focus.note} net={savings.net} savings={savings} buckets={buckets} />
      <TopMovers movers={movers} hasPrev={prevData.length > 0} />
      <Card>
        <p className="text-sm font-medium mb-2">Where the money went</p>
        {slices.length === 0 ? <EmptyState title="No spending this month" /> : <DonutChart slices={slices} centerLabel="Spent" centerValue={total} />}
      </Card>
      <CategoryComparisonList rows={listRows} />
      <Card>
        <p className="text-sm font-medium mb-2">6-month spending trend</p>
        {trend.isError
          ? <p className="text-sm text-muted text-center py-6">Trend unavailable</p>
          : <TrendBars points={points} activePeriod={focusMonth} />}
      </Card>
    </div>
  );
}
