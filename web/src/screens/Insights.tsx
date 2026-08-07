import { useMemo, useState } from "react";

import { Card } from "../components/ui/Card";
import { SectionLabel } from "../components/ui/SectionLabel";
import { Skeleton } from "../components/Skeleton";
import { EmptyState } from "../components/EmptyState";
import { SegmentedControl } from "../components/ui/SegmentedControl";
import { FlowBars } from "../components/charts/FlowBars";
import { ComparativeSummary } from "../components/insights/ComparativeSummary";
import { TopMovers } from "../components/insights/TopMovers";
import { LensBreakdown } from "../components/insights/LensBreakdown";
import { ProjectionDrillSheet } from "../components/insights/ProjectionDrillSheet";
import { AlertTriangle } from "../components/ui/PixelIcon";
import { monthLabel, trailingPeriods } from "../lib/insights";
import {
  bucketRows,
  categoryRows,
  merchantRows,
  LENS_BUCKET_LABEL,
  type BreakdownRow,
  type DrillTarget,
  type Lens,
} from "../lib/lens";
import { insightsFocus, DEFAULT_SCOPE, type Scope } from "../lib/scope";
import type { CategoryDelta, InsightsSource } from "../v2/sources/insights";
import { useInsightsSnapshot, useInsightsSource } from "../v2/queries";

/**
 * Insights, on the local projection.
 *
 * # What this screen lost when it came off v1's HTTP API, and why
 *
 * Everything below reads `v2/sources/insights.ts`, which reads the SQLite
 * projection the sync engine writes. Four things went, and were **removed
 * rather than stubbed** — the rule Task 8 set for Home, for the same reason: a
 * "coming soon" placeholder is a promise this codebase cannot keep from here.
 *
 *   - **The Reports suite and its four tiles** (net worth, income v expense,
 *     age of money, spending trends). Net worth needs account balances and
 *     there is no account op; the other three read `/api/reports/*` and
 *     `/api/insights/trend`, which `ledgerd` does not serve.
 *     `client/src/replay/state.ts` holds `txns`, `rules`, `homeCurrency`,
 *     `rates`, `forks` and `anomalies` — nothing that authors a balance, a
 *     check-in or a plan.
 *   - **The over-budget markers.** They came from `/api/summary`'s `pct_used`,
 *     which needs a target, and no op authors one. Every bar is therefore a
 *     magnitude next to its siblings, and nothing here claims a bucket is over.
 *   - **The search entry.** v1 opened a `SearchSheet` over `/api/transactions`.
 *     The projection-backed search lives on the Transactions tab, which owns
 *     the filter strip; a second one here would be a second implementation of
 *     "what matches" and the two would eventually disagree.
 *   - **The freeze-history behaviour** in the drill-in, which read
 *     `/api/budget`'s `freeze_history`. There is no settings op. The drill-in
 *     that survived is read-only, which makes the question moot.
 *
 * # What did NOT go, and why the figures are trustworthy
 *
 * The month's split, the deltas, the movers and the in-vs-out flow are all
 * sums of `txn_ingested`/`txn_categorized`/`txn_split` — data the log has had
 * since Phase 1. They are `bigint` from the SQL cast to the rendered string.
 */
const LENS_OPTIONS: { value: Lens; label: string }[] = [
  { value: "buckets", label: "Buckets" },
  { value: "categories", label: "Categories" },
  { value: "merchants", label: "Merchants" },
];

/** How many movers the "Biggest changes" card lists. */
const MOVERS = 3;
/** How many months the flow chart plots. */
const TREND_MONTHS = 6;

export interface InsightsProps {
  scope?: Scope;
  /** Test seam: a source over a projection this test built. */
  insightsSource?: InsightsSource;
}

export function Insights({ scope = DEFAULT_SCOPE, insightsSource }: InsightsProps) {
  const focus = insightsFocus(scope);
  const period = focus.period;
  // The trend trails the month being *looked at*, not the wall clock. v1
  // hardcoded the trailing six real months to match a static endpoint that no
  // longer exists; anchoring on the focus month instead means stepping back to
  // June shows the six months up to June, and the chart's highlighted column is
  // always the one the rest of the screen is describing. It also keeps `Date`
  // out of this screen entirely.
  //
  // Memoized for identity, not cost: it is part of the query key and the
  // chart's `data`, and dither-kit restarts its 900ms entrance wave whenever
  // `data` changes identity.
  const trendPeriods = useMemo(() => trailingPeriods(period, TREND_MONTHS), [period]);

  const source = useInsightsSource(insightsSource);
  const snapshot = useInsightsSnapshot(source, period, trendPeriods);

  const [lens, setLens] = useState<Lens>("categories");
  const [drill, setDrill] = useState<DrillTarget | null>(null);

  const s = snapshot.data;
  const rows = useMemo<BreakdownRow[]>(() => {
    if (s === undefined || !s.usable) return [];
    if (lens === "buckets") return bucketRows(s.buckets, s.spent);
    if (lens === "merchants") return merchantRows(s.merchants, s.spent);
    return categoryRows(s.categories, s.spent);
  }, [lens, s]);

  // The movers are ranked here rather than in the source: it is a presentation
  // cut of rows the source already returned, and ranking it twice (once for the
  // breakdown, once for this card) is how the two come to disagree about which
  // change was biggest.
  const movers = useMemo<CategoryDelta[]>(() => {
    if (s === undefined) return [];
    const abs = (v: bigint) => (v < 0n ? -v : v);
    return [...s.categories]
      .filter((c) => c.delta !== 0n)
      // Tie-break on the key so the order is stable across refetches.
      .sort((a, b) => (abs(b.delta) === abs(a.delta) ? (a.key < b.key ? -1 : 1) : abs(b.delta) > abs(a.delta) ? 1 : -1))
      .slice(0, MOVERS);
  }, [s]);

  // No v2 runtime and no injected source. This is NOT a v1 fallback: there is
  // no correct one — the projection is the data, and reaching for `/api/*` here
  // would read a different database over a protocol `ledgerd` does not serve,
  // while looking entirely fine.
  if (source === null) {
    return (
      <EmptyState
        icon={AlertTriangle}
        title="Your local ledger isn't open"
        hint="This screen reads the copy of your ledger on this device. Reopen the app to reconnect."
      />
    );
  }
  if (snapshot.isPending) return <Skeleton rows={8} />;
  if (snapshot.isError || s === undefined) {
    return <EmptyState icon={AlertTriangle} title="Couldn't read your ledger" hint="Reopen the app to try again." />;
  }

  // Every money field is a safe zero while the projection is incomplete, so
  // there is no headline to print — printing one would tell a user they spent
  // nothing. Same rule Home follows.
  if (!s.usable) {
    return (
      <Card>
        <p className="text-sm">
          Your insights are rebuilding after an update. Nothing was lost — they will be back once the local sync
          finishes.
        </p>
      </Card>
    );
  }

  const label = `${monthLabel(period)} ${period.slice(0, 4)}`;
  // v2 is explicitly multi-currency and the snapshot carries the code the
  // totals were converted into, so the screen names it rather than leaving a
  // bare `125.00` for the reader to guess at.
  const currency = s.homeCurrency ?? "";

  return (
    <div className="space-y-4">
      <ComparativeSummary
        label={label}
        note={focus.note}
        net={s.net}
        currency={currency}
        savingsRate={s.savingsRate}
        buckets={s.buckets.filter((b) => b.spent > 0n || b.prevSpent > 0n)}
        onSelectBucket={(b) => setDrill({ type: "bucket", bucket: b.bucket, name: LENS_BUCKET_LABEL[b.bucket] })}
      />

      <div>
        <SectionLabel className="mb-1.5">Analyze by</SectionLabel>
        <div className="mb-2 overflow-x-auto -mx-1 px-1">
          <SegmentedControl value={lens} onChange={setLens} options={LENS_OPTIONS} />
        </div>
        <LensBreakdown rows={rows} onDrill={(row) => setDrill(row.drill)} />
      </div>

      <TopMovers movers={movers} hasPrev={s.hasPrevious} />

      <Card>
        <p className="text-sm font-medium mb-2">Money in vs out</p>
        <FlowBars points={s.trend} activePeriod={period} />
      </Card>

      {drill && (
        <ProjectionDrillSheet
          key={drill.type === "bucket" ? drill.bucket : drill.type === "category" ? String(drill.category) : drill.merchant}
          target={drill}
          period={period}
          currency={currency}
          source={source}
          onClose={() => setDrill(null)}
        />
      )}
    </div>
  );
}
