import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getJSON } from "../api/client";
import type { CategorySpend, MonthlyTotal, Summary, Txn, Category, BudgetConfig } from "../api/types";
import { Card } from "../components/ui/Card";
import { Skeleton } from "../components/Skeleton";
import { EmptyState } from "../components/EmptyState";
import { DonutChart } from "../components/charts/DonutChart";
import { TrendBars } from "../components/charts/TrendBars";
import { ComparativeSummary } from "../components/insights/ComparativeSummary";
import { TopMovers } from "../components/insights/TopMovers";
import { CategoryComparisonList } from "../components/insights/CategoryComparisonList";
import { MerchantBreakdown } from "../components/insights/MerchantBreakdown";
import { DrillDownSheet, type DrillTarget } from "../components/insights/DrillDownSheet";
import { SearchSheet } from "../components/insights/SearchSheet";
import {
  donutSlices, trendSeries, trailingPeriods, currentPeriod, monthLabel,
  categoryDeltas, withShare, bucketComparison, topMovers, savingsRate,
} from "../lib/insights";
import { addMonth, insightsFocus, DEFAULT_SCOPE, type Scope } from "../lib/scope";
import { monthRange } from "../lib/transactions";
import { AlertTriangle, Search } from "lucide-react";

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

  const { from, to } = monthRange(focusMonth);
  const monthTxns = useQuery({
    queryKey: ["transactions", "insights-month", from, to],
    queryFn: () => getJSON<Txn[]>(`/api/transactions?from=${from}&to=${to}`),
  });
  const cats = useQuery({ queryKey: ["categories"], queryFn: () => getJSON<Category[]>("/api/categories") });
  const budget = useQuery({ queryKey: ["budget"], queryFn: () => getJSON<BudgetConfig>("/api/budget") });

  const [drill, setDrill] = useState<DrillTarget | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);

  const txns = monthTxns.data ?? [];
  const frozen = budget.data?.freeze_history ?? false;

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
      <div className="flex justify-end">
        <button
          aria-label="Search & filter"
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-surface-2 text-sm text-muted"
          onClick={() => setSearchOpen(true)}
        >
          <Search size={16} /> Search & filter
        </button>
      </div>
      <ComparativeSummary label={label} note={focus.note} net={savings.net} savings={savings} buckets={buckets} onSelectBucket={(bucket) => setDrill({ type: "bucket", bucket })} />
      <TopMovers movers={movers} hasPrev={prevData.length > 0} />
      <Card>
        <p className="text-sm font-medium mb-2">Where the money went</p>
        {slices.length === 0 ? <EmptyState title="No spending this month" /> : (
          <DonutChart
            slices={slices}
            centerLabel="Spent"
            centerValue={total}
            onSelect={(name) => {
              const cat = curData.find((c) => c.name === name);
              if (cat) setDrill({ type: "category", categoryId: cat.category_id, name });
            }}
          />
        )}
      </Card>
      <CategoryComparisonList rows={listRows} onSelectCategory={(categoryId, name) => setDrill({ type: "category", categoryId, name })} />
      <MerchantBreakdown txns={txns} onSelect={(merchant) => setDrill({ type: "merchant", merchant })} />
      <Card>
        <p className="text-sm font-medium mb-2">6-month spending trend</p>
        {trend.isError
          ? <p className="text-sm text-muted text-center py-6">Trend unavailable</p>
          : <TrendBars points={points} activePeriod={focusMonth} />}
      </Card>
      {drill && (
        <DrillDownSheet
          key={`${drill.type}:${drill.type === "bucket" ? drill.bucket : drill.type === "category" ? drill.categoryId : drill.merchant}`}
          target={drill} txns={txns} frozen={frozen} categories={cats.data ?? []} onClose={() => setDrill(null)}
        />
      )}
      {searchOpen && (
        <SearchSheet txns={txns} categories={cats.data ?? []} onClose={() => setSearchOpen(false)} />
      )}
    </div>
  );
}
