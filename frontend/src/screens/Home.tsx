import { useQuery } from "@tanstack/react-query";
import { getJSON } from "../api/client";
import type { Summary, MonthlyTotal } from "../api/types";
import { Money } from "../components/Money";
import { Card } from "../components/ui/Card";
import { ProgressBar } from "../components/ui/ProgressBar";
import { Skeleton } from "../components/Skeleton";
import { EmptyState } from "../components/EmptyState";
import { TrendBars } from "../components/charts/TrendBars";
import {
  totalSpent, totalBudget, totalProjection, paceStatus, paceTone,
  trendSeries, trailingPeriods, bucketColor, currentPeriod, monthLabel,
} from "../lib/insights";
import { type Scope, DEFAULT_SCOPE, scopeAnchor, scopeLabel } from "../lib/scope";
import { formatFils, flowAmount } from "../lib/money";
import { AlertTriangle, Check, TrendingUp } from "lucide-react";
import { useFirstReveal } from "../hooks/useFirstReveal";

const BUCKET_LABEL: Record<string, string> = { need: "Needs", want: "Wants", saving: "Savings" };
const VERDICT: Record<string, string> = { under: "On track", over: "Over pace", overbudget: "Over budget" };
const TONE_TEXT = { good: "text-good", warn: "text-warn", bad: "text-bad" } as const;
// Hero status badge: solid tone fill + text-bg (legible on any tone in both themes).
const HERO_BADGE_BG = { good: "bg-good", warn: "bg-warn", bad: "bg-bad" } as const;
const VERDICT_ICON = { under: Check, over: TrendingUp, overbudget: AlertTriangle } as const;

/** "1,180 left" or "320 over" for a remaining amount (positive = under budget). */
function remainingLabel(remaining: number): string {
  return remaining >= 0 ? `${formatFils(remaining)} left` : `${formatFils(-remaining)} over`;
}

/** Query string for /api/summary: a single month, a from..to span, or all time. */
function summaryParams(scope: Scope): string {
  const p = new URLSearchParams();
  if (scope.kind === "month") p.set("period", scope.period);
  else if (scope.kind === "range") { p.set("from", scope.from); p.set("to", scope.to); }
  else p.set("all", "1");
  return p.toString();
}

export function Home({ scope = DEFAULT_SCOPE }: { scope?: Scope }) {
  // The 6-month trend is always the trailing 6 real months (it matches the
  // static /api/insights/trend), independent of the selected scope.
  const periods = trailingPeriods(currentPeriod(), 6);

  // Summary aggregates over the whole scope: a single month, a from..to span, or
  // all time. Pace/projection/recent below stay scoped to the live current month.
  const params = summaryParams(scope);
  const summary = useQuery({ queryKey: ["summary", params], queryFn: () => getJSON<Summary>(`/api/summary?${params}`) });
  const trend = useQuery({ queryKey: ["insights-trend"], queryFn: () => getJSON<MonthlyTotal[]>("/api/insights/trend?months=6") });

  const isCurrent = scope.kind === "month" && scope.period === currentPeriod();
  const anchor = scopeAnchor(scope); // the month the trend chart highlights
  const heroLabel = isCurrent
    ? "Spent this month"
    : scope.kind === "month"
      ? `Spent in ${monthLabel(scope.period)} ${scope.period.slice(0, 4)}`
      : scope.kind === "all"
        ? "Spent all time"
        : `Spent · ${scopeLabel(scope)}`;

  // Hook must be before early returns (React rules); gates on first populated recent list paint.
  const firstReveal = useFirstReveal(!summary.isLoading && (summary.data?.recent.length ?? 0) > 0);

  if (summary.isLoading) return <Skeleton rows={8} />;
  if (summary.isError) return <EmptyState icon={AlertTriangle} title="Couldn't load your spending" hint="Check your connection and try again." />;

  const s = summary.data!;
  const spent = totalSpent(s.buckets);
  const budget = totalBudget(s.buckets);
  const projection = totalProjection(s.buckets);
  const pct = budget > 0 ? spent / budget : 0;
  // Only the in-progress month has a "today" pace marker; finished months are done.
  const pace = isCurrent ? s.month_progress : undefined;
  const heroStatus = paceStatus(spent, budget, projection);
  const heroTone = paceTone(heroStatus);
  const HeroIcon = VERDICT_ICON[heroStatus];
  const points = trendSeries(trend.data ?? [], periods);

  return (
    <div className="space-y-4">
      {/* hero: spent vs budget, with today's pace + projection — the one bold,
          branded surface; everything below stays quiet on neutral cards. */}
      <div className="rounded-[var(--radius-card)] bg-hero text-hero-fg shadow-1 p-5">
        <p className="text-sm opacity-80">{heroLabel}</p>
        <p className="mt-1 text-[2.75rem] leading-none font-semibold tracking-tight tnum"><Money fils={spent} /></p>
        <p className="text-sm opacity-80 mt-2">of <span className="tnum"><Money fils={budget} /></span> budget</p>
        <div className="mt-4"><ProgressBar pct={pct} pace={pace} tone={heroTone} onAccent label="Total budget used" /></div>
        <div className="flex items-center justify-between mt-2 text-sm">
          <span className="tnum opacity-80">{remainingLabel(budget - spent)}</span>
          {isCurrent && (
            <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-semibold text-bg ${HERO_BADGE_BG[heroTone]}`}>
              <HeroIcon size={13} aria-hidden />
              {VERDICT[heroStatus]}
            </span>
          )}
        </div>
        {isCurrent && (
          <p className="text-xs opacity-70 mt-1">
            Projected <span className="tnum"><Money fils={projection} /></span> · {Math.round(s.month_progress * 100)}% of month gone
          </p>
        )}
      </div>

      {/* budget pace: each bucket against today's pace */}
      <Card>
        <p className="text-sm font-medium mb-3">Budget pace</p>
        <div className="space-y-4">
          {s.buckets.map((b) => {
            const status = paceStatus(b.spent, b.target, b.projection);
            const tone = paceTone(status);
            const name = BUCKET_LABEL[b.bucket] ?? b.bucket;
            return (
              <div key={b.bucket}>
                <div className="flex items-center justify-between text-sm mb-1.5">
                  <span className="flex items-center gap-2 font-medium">
                    <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ background: bucketColor(b.bucket) }} />
                    {name}
                  </span>
                  <span className="tnum text-muted"><Money fils={b.spent} /> / <Money fils={b.target} /></span>
                </div>
                <ProgressBar pct={b.pct_used} pace={pace} tone={tone} label={`${name} budget used`} />
                <div className="flex items-center justify-between mt-1.5 text-xs">
                  <span className="tnum text-muted">{remainingLabel(b.remaining)}</span>
                  {isCurrent && <span className={`font-medium ${TONE_TEXT[tone]}`}>{VERDICT[status]}</span>}
                </div>
              </div>
            );
          })}
        </div>
      </Card>

      {/* 6-month trend */}
      <Card>
        <p className="text-sm font-medium mb-2">6-month trend</p>
        {trend.isError
          ? <p className="text-sm text-muted text-center py-6">Trend unavailable</p>
          : <TrendBars points={points} activePeriod={anchor} />}
      </Card>

      {/* recent stream — only meaningful for the current month */}
      {isCurrent && (
        <Card>
          <p className="text-sm font-medium mb-2">Recent</p>
          {s.recent.length === 0 ? (
            <EmptyState title="No recent activity" hint="New transactions will appear here." />
          ) : (
            <ul className="divide-y divide-border">
              {s.recent.map((t) => {
                const amount = flowAmount(t.Direction, t.AmountFils);
                return (
                  <li key={t.ID} className={`py-2 flex items-center justify-between gap-3${firstReveal ? " stagger-item" : ""}`}>
                    <div className="min-w-0">
                      <p className="truncate font-medium">{t.MerchantRaw || "—"}</p>
                      <p className="text-xs text-muted">{t.PostedAt.slice(0, 10)}{t.CategoryName ? ` · ${t.CategoryName}` : ""}</p>
                    </div>
                    <span
                      className="tnum"
                      style={amount.flow === "in" ? { color: "var(--color-good)" } : undefined}
                      title={amount.flow === "in" ? "Money in" : "Money out"}
                    >
                      {amount.text}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      )}
    </div>
  );
}
