import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getJSON } from "../api/client";
import type { Summary, CategorySpend, MonthlyTotal } from "../api/types";
import { Money } from "../components/Money";
import { Card } from "../components/ui/Card";
import { ProgressBar } from "../components/ui/ProgressBar";
import { Skeleton } from "../components/Skeleton";
import { EmptyState } from "../components/EmptyState";
import { DonutChart } from "../components/charts/DonutChart";
import { TrendBars } from "../components/charts/TrendBars";
import {
  totalSpent, totalBudget, donutSlices, trendSeries, trailingPeriods, monthLabel, bucketColor,
} from "../lib/insights";
import { AlertTriangle } from "lucide-react";

const BUCKET_LABEL: Record<string, string> = { need: "Needs", want: "Wants", saving: "Savings" };

function currentPeriod(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export function Home() {
  const [period, setPeriod] = useState(currentPeriod());
  const periods = trailingPeriods(period, 6);

  const summary = useQuery({ queryKey: ["summary", period], queryFn: () => getJSON<Summary>(`/api/summary?period=${period}`) });
  const catSpend = useQuery({ queryKey: ["insights-categories", period], queryFn: () => getJSON<CategorySpend[]>(`/api/insights/categories?period=${period}`) });
  const trend = useQuery({ queryKey: ["insights-trend"], queryFn: () => getJSON<MonthlyTotal[]>("/api/insights/trend?months=6") });

  if (summary.isLoading) return <Skeleton rows={8} />;
  if (summary.isError) return <EmptyState icon={AlertTriangle} title="Couldn't load your spending" hint="Check your connection and try again." />;

  const s = summary.data!;
  const spent = totalSpent(s.buckets);
  const budget = totalBudget(s.buckets);
  const pct = budget > 0 ? spent / budget : 0;
  const slices = donutSlices(catSpend.data ?? []);
  const points = trendSeries(trend.data ?? [], periods);

  return (
    <div className="space-y-4">
      {/* period selector */}
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">{monthLabel(period)} {period.slice(0, 4)}</h1>
        <select
          aria-label="Period"
          value={period}
          onChange={(e) => setPeriod(e.target.value)}
          className="bg-surface border border-border rounded-lg px-2 py-1 text-sm"
        >
          {periods.slice().reverse().map((p) => (
            <option key={p} value={p}>{monthLabel(p)} {p.slice(0, 4)}</option>
          ))}
        </select>
      </div>

      {/* hero: spent vs budget */}
      <Card>
        <p className="text-sm text-muted">Spent this month</p>
        <p className="text-3xl font-bold tnum"><Money fils={spent} /></p>
        <p className="text-sm text-muted mt-1">spent of <span className="tnum"><Money fils={budget} /></span> budget</p>
        <div className="mt-3"><ProgressBar pct={pct} /></div>
      </Card>

      {/* donut by category + trend */}
      <div className="grid grid-cols-1 gap-4">
        <Card>
          <p className="text-sm font-medium mb-2">By category</p>
          {slices.length === 0
            ? <EmptyState title="No spending yet" />
            : <DonutChart slices={slices} centerLabel="Spent" centerValue={spent} />}
        </Card>
        <Card>
          <p className="text-sm font-medium mb-2">6-month trend</p>
          <TrendBars points={points} activePeriod={period} />
        </Card>
      </div>

      {/* bucket bars */}
      <Card>
        <p className="text-sm font-medium mb-3">Budget buckets</p>
        <div className="space-y-3">
          {s.buckets.map((b) => (
            <div key={b.bucket}>
              <div className="flex items-center justify-between text-sm mb-1">
                <span className="flex items-center gap-2">
                  <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ background: bucketColor(b.bucket) }} />
                  {BUCKET_LABEL[b.bucket] ?? b.bucket}
                </span>
                <span className="tnum text-muted"><Money fils={b.spent} /> / <Money fils={b.target} /></span>
              </div>
              <ProgressBar pct={b.pct_used} />
            </div>
          ))}
        </div>
      </Card>

      {/* recent stream */}
      <Card>
        <p className="text-sm font-medium mb-2">Recent</p>
        {s.recent.length === 0 ? (
          <EmptyState title="No recent activity" hint="New transactions will appear here." />
        ) : (
          <ul className="divide-y divide-border">
            {s.recent.map((t) => (
              <li key={t.ID} className="py-2 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate font-medium">{t.MerchantRaw || "—"}</p>
                  <p className="text-xs text-muted">{t.PostedAt.slice(0, 10)}{t.CategoryName ? ` · ${t.CategoryName}` : ""}</p>
                </div>
                <span className="tnum"><Money fils={t.Direction === "credit" ? t.AmountFils : -t.AmountFils} /></span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
