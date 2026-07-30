import { useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { getJSON } from "../api/client";
import type { CategorySpend, MonthlyTotal, Summary, Txn, Category, BudgetConfig } from "../api/types";
import { Money } from "../components/Money";
import { SettingsPage } from "./settings/SettingsPage";
import { ReportsScreen, type ReportSection } from "./reports/ReportsScreen";
import { useAgeOfMoney, useNetWorth, useTrend24 } from "../api/hooks";
import { deltaSummary, pctLabel, yoyRows, yoySummary } from "../lib/reports";
import { Card } from "../components/ui/Card";
import { SectionLabel } from "../components/ui/SectionLabel";
import { Pressable } from "../components/ui/Pressable";
import { Skeleton } from "../components/Skeleton";
import { EmptyState } from "../components/EmptyState";
import { SegmentedControl } from "../components/ui/SegmentedControl";
import { FlowBars } from "../components/charts/FlowBars";
import { ComparativeSummary } from "../components/insights/ComparativeSummary";
import { TopMovers } from "../components/insights/TopMovers";
import { LensBreakdown } from "../components/insights/LensBreakdown";
import { DrillDownSheet, type DrillTarget } from "../components/insights/DrillDownSheet";
import { SearchSheet } from "../components/insights/SearchSheet";
import {
  trendSeries, trailingPeriods, currentPeriod, monthLabel,
  categoryDeltas, withShare, bucketComparison, topMovers, savingsRate, overBudgetBuckets,
} from "../lib/insights";
import { type Lens, type BreakdownRow, bucketRows, categoryRows, merchantRows } from "../lib/lens";
import { addMonth, insightsFocus, DEFAULT_SCOPE, type Scope } from "../lib/scope";
import { monthRange } from "../lib/transactions";
import { AlertTriangle, Search } from "../components/ui/PixelIcon";

const LENS_OPTIONS: { value: Lens; label: string }[] = [
  { value: "buckets", label: "Buckets" },
  { value: "categories", label: "Categories" },
  { value: "merchants", label: "Merchants" },
];

export function Insights({ scope = DEFAULT_SCOPE }: { scope?: Scope }) {
  const focus = insightsFocus(scope);
  const focusMonth = focus.period;
  const prevMonth = addMonth(focusMonth, -1);
  // The 6-month trend is always the trailing 6 real months (matches the static
  // endpoint). Memoized for identity, not cost: it feeds the `points` memo.
  const periods = useMemo(() => trailingPeriods(currentPeriod(), 6), []);

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

  const [lens, setLens] = useState<Lens>("categories");
  const [drill, setDrill] = useState<DrillTarget | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  // The Reports suite opens as a full-screen drill-in over Insights; a tile
  // names the report it lands on. The queries behind the tile stats double as
  // a prefetch, so the drill-in opens already-warm.
  const [reportsFocus, setReportsFocus] = useState<ReportSection | null>(null);
  const networth = useNetWorth(12);
  const ageOfMoney = useAgeOfMoney();
  const trend24 = useTrend24();

  const txns = monthTxns.data ?? [];
  const frozen = budget.data?.freeze_history ?? false;

  const curData = cur.data ?? [];
  const prevData = prev.data ?? [];
  const total = curData.reduce((s, c) => s + c.spent, 0);
  // Buckets at or over target for the focus month — same `summary` query the
  // hero net/income figures already use, just not previously threaded down to
  // the bucket bars. Feeds `bucketRows`/`ComparativeSummary` so their bars go
  // solid at the same `pct >= 1.0` point Home's `ProgressBar`s turn red.
  const overBudget = useMemo(() => overBudgetBuckets(summary.data?.buckets ?? []), [summary.data]);

  const rows = useMemo<BreakdownRow[]>(() => {
    if (lens === "buckets") return bucketRows(bucketComparison(curData, prevData), total, overBudget);
    if (lens === "merchants") return merchantRows(txns, total);
    const deltas = categoryDeltas(curData, prevData);
    return categoryRows(withShare([...deltas].sort((a, b) => b.spent - a.spent), total));
  }, [lens, curData, prevData, txns, total, overBudget]);

  // Memoized (and hoisted above the early returns, so it stays a hook): this is
  // FlowBars' `data`, and dither-kit restarts the 900ms entrance wave whenever
  // `data` changes *identity*. Unmemoized, every SSE-driven query invalidation
  // anywhere on this screen replayed the chart's entrance.
  const points = useMemo(() => trendSeries(trend.data ?? [], periods), [trend.data, periods]);

  // isPending, not isLoading: queries are pending-but-not-fetching during
  // persisted-cache restore, and isLoading is false in that window.
  if (cur.isPending || prev.isPending || summary.isPending) return <Skeleton rows={8} />;
  if (cur.isError) return <EmptyState icon={AlertTriangle} title="Couldn't load insights" hint="Check your connection and try again." />;

  const deltas = categoryDeltas(curData, prevData);
  const movers = topMovers(deltas, 3);
  const buckets = bucketComparison(curData, prevData);
  const income = summary.data?.income ?? 0;
  const savings = savingsRate(income, total);
  const label = `${monthLabel(focusMonth)} ${focusMonth.slice(0, 4)}`;

  // Tile stats — each a single glanceable figure; the report itself is one tap in.
  const nwDelta = deltaSummary((networth.data?.months ?? []).map((m) => m.networth_fils));
  const yoy = yoySummary(yoyRows(trend24.data ?? [], currentPeriod()));
  const aom = ageOfMoney.data;

  const onDrill = (row: BreakdownRow) => {
    if (lens === "buckets") setDrill({ type: "bucket", bucket: row.key });
    else if (lens === "merchants") setDrill({ type: "merchant", merchant: row.name });
    else setDrill({ type: "category", categoryId: row.categoryId ?? null, name: row.name });
  };

  return (
    <div className="space-y-4">
      {/* Reports is hosted here rather than in AppShell's overlay stack, so it
          has to take the screen underneath out of the tab order itself —
          otherwise Tab from its back arrow walks back into Insights. */}
      <div className="contents" inert={reportsFocus !== null}>
      <Pressable
        className="w-full min-h-11 flex items-center gap-2 px-3 rounded-[var(--radius)] border border-border bg-surface text-base text-muted"
        onClick={() => setSearchOpen(true)}
      >
        <Search size={16} aria-hidden /> Search transactions…
      </Pressable>

      <ComparativeSummary label={label} note={focus.note} net={savings.net} savings={savings} buckets={buckets} overBudgetBuckets={overBudget} onSelectBucket={(bucket) => setDrill({ type: "bucket", bucket })} />

      <div>
        <SectionLabel className="mb-1.5">Analyze by</SectionLabel>
        <div className="mb-2 overflow-x-auto -mx-1 px-1">
          <SegmentedControl value={lens} onChange={setLens} options={LENS_OPTIONS} />
        </div>
        <LensBreakdown rows={rows} onDrill={onDrill} />
      </div>

      <TopMovers movers={movers} hasPrev={prevData.length > 0} />

      <Card>
        <p className="text-sm font-medium mb-2">Money in vs out</p>
        {trend.isError
          ? <p className="text-sm text-muted text-center py-6">Trend unavailable</p>
          : <FlowBars points={points} activePeriod={focusMonth} />}
      </Card>

      <div>
        <SectionLabel className="mb-1.5">Reports</SectionLabel>
        <div className="grid grid-cols-2 gap-2">
          <ReportTile
            label="Net worth"
            pending={networth.isPending}
            stat={<Money fils={nwDelta.latest} />}
            meta={nwDelta.pct === null ? "from balance check-ins" : `${pctLabel(nwDelta.pct)} vs last month`}
            onOpen={() => setReportsFocus("networth")}
          />
          <ReportTile
            label="Income v expense"
            stat={<Money fils={savings.net} />}
            meta="net this month · by category"
            onOpen={() => setReportsFocus("income-expense")}
          />
          <ReportTile
            label="Age of money"
            pending={ageOfMoney.isPending}
            stat={aom !== undefined && aom.sample_size > 0 ? `${aom.age_days} days` : "—"}
            meta={aom !== undefined && aom.sample_size > 0 ? `last ${aom.sample_size} spends` : "needs more history"}
            onOpen={() => setReportsFocus("age")}
          />
          <ReportTile
            label="Spending trends"
            pending={trend24.isPending}
            stat={yoy.comparableMonths > 0 ? pctLabel(yoy.pct) : "—"}
            meta={yoy.comparableMonths > 0 ? "spend vs a year ago" : "builds with history"}
            onOpen={() => setReportsFocus("trends")}
          />
        </div>
      </div>

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
      {reportsFocus !== null && (
        <SettingsPage title="Reports" onClose={() => setReportsFocus(null)}>
          <ReportsScreen focus={reportsFocus} />
        </SettingsPage>
      )}
    </div>
  );
}

/** One reports entry tile: eyebrow label, a single glanceable figure, and a
 *  one-line qualifier. Navigation with a stat, not a data surface — the full
 *  report (with its own loading/empty/error states) is the tap away. While
 *  the backing query loads, the stat slot shows a skeleton line, never the
 *  same "—" the loaded not-computable state uses. */
function ReportTile({ label, stat, meta, pending = false, onOpen }: {
  label: string;
  stat: ReactNode;
  meta: string;
  /** True while the query behind the stat is still loading. */
  pending?: boolean;
  onOpen: () => void;
}) {
  return (
    <Pressable
      onClick={onOpen}
      className="min-h-11 rounded-[var(--radius)] border border-border bg-surface p-3 text-left"
    >
      <span className="flex items-center justify-between font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-muted">
        {label} <span aria-hidden>›</span>
      </span>
      {pending ? (
        <span aria-busy="true" aria-label="Loading" className="mt-1 flex h-6 items-center">
          <span className="block h-4 w-16 animate-pulse rounded-[var(--radius)] bg-surface-2" />
        </span>
      ) : (
        <span className="mt-1 block tnum text-base font-semibold">{stat}</span>
      )}
      <span className="mt-0.5 block font-mono text-[10px] tracking-[0.04em] text-muted">
        {pending ? "loading…" : meta}
      </span>
    </Pressable>
  );
}
