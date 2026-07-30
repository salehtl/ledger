import { useEffect, useMemo, useRef, useState } from "react";
import { EmptyState } from "../../components/EmptyState";
import { Card } from "../../components/ui/Card";
import { SectionLabel } from "../../components/ui/SectionLabel";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { AlertTriangle, PiggyBank } from "../../components/ui/PixelIcon";
import { currentPeriod } from "../../lib/insights";
import type { Scope } from "../../lib/scope";
import {
  ageMirrorAgrees,
  categoryTxns,
  cellTxns,
  fifoSpendAges,
  isFlatZero,
  monthTxns,
  monthYear,
  netMonthTxns,
  yoyRows,
  yoySummary,
  type IncomeExpenseRow,
  type ReportTxn,
} from "../../lib/reports";
import {
  useAgeOfMoney,
  useCategories,
  useIncomeExpense,
  useNetWorth,
  useReportsWindowTxns,
  useTrend24,
} from "../../api/hooks";
import { NetWorthChart } from "./NetWorthChart";
import { AgeOfMoneyTile } from "./AgeOfMoneyTile";
import { IncomeExpenseMatrix } from "./IncomeExpenseMatrix";
import { TrendCompare } from "./TrendCompare";
import { ReportDrillSheet } from "./ReportDrillSheet";
import { AgeOfMoneySkeleton, MatrixSkeleton, NetWorthSkeleton, TrendsSkeleton } from "./skeletons";

export type ReportSection = "networth" | "income-expense" | "age" | "trends";

/** What a drill-down is pointed at; resolved to transactions at render time
 *  so a still-loading window fills the open sheet in when it lands. */
type Drill =
  | { kind: "month"; month: string }
  | { kind: "net-month"; month: string }
  | { kind: "cell"; row: IncomeExpenseRow; month: string }
  | { kind: "category"; row: IncomeExpenseRow; fromMonth: string }
  | { kind: "age" };

/**
 * The reports suite: net worth, age of money, income v expense, and the
 * 24-month year-over-year spending compare. Every figure drills to the exact
 * transactions behind it — reports over a 100%-captured local dataset are
 * auditable, not just glanceable.
 *
 * Reports deliberately ignore the app-wide period scope: each section is a
 * trailing window ending today and says so in its own header, so there is
 * never a mismatch between the stepper and a 24-month chart.
 */
export function ReportsScreen({ focus }: { scope?: Scope; focus?: ReportSection }) {
  const [nwWindow, setNwWindow] = useState<"12" | "24">("12");
  const networth = useNetWorth(Number(nwWindow));
  const matrix = useIncomeExpense(12);
  const age = useAgeOfMoney();
  const trend = useTrend24();
  const cats = useCategories();
  const windowTxns = useReportsWindowTxns(24);

  const [drill, setDrill] = useState<Drill | null>(null);

  const sectionRefs = {
    networth: useRef<HTMLElement>(null),
    "income-expense": useRef<HTMLElement>(null),
    age: useRef<HTMLElement>(null),
    trends: useRef<HTMLElement>(null),
  };
  // Entered from an Insights tile: land on that report. Instant, not smooth —
  // this is navigation, not motion for its own sake. Re-anchors as each
  // section's queries settle: even dimension-reserving skeletons can differ
  // slightly from loaded content, so the scroll must survive the swaps.
  const settleKey = [
    networth.isPending, matrix.isPending, age.isPending, trend.isPending, windowTxns.isPending,
  ].join();
  useEffect(() => {
    // Optional call: jsdom has no scrollIntoView.
    if (focus) sectionRefs[focus].current?.scrollIntoView?.({ block: "start" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus, settleKey]);

  const txns: ReportTxn[] = useMemo(() => windowTxns.data ?? [], [windowTxns.data]);
  const kindById = useMemo(
    () => new Map((cats.data ?? []).map((c) => [c.ID, c.Kind])),
    [cats.data],
  );
  const mirror = useMemo(() => fifoSpendAges(txns, kindById), [txns, kindById]);
  // The sparkline/drill render only while the client FIFO mirror agrees with
  // the server figure; a divergent mirror hides rather than lies (the client
  // sees a 24-month window, the server all history).
  const mirrorOk =
    age.data !== undefined && age.data.sample_size > 0 && ageMirrorAgrees(mirror, age.data.sample_size);
  const spendAges = mirrorOk ? mirror.ages : [];
  const yoy = useMemo(() => yoyRows(trend.data ?? [], currentPeriod()), [trend.data]);
  const yoySum = useMemo(() => yoySummary(yoy), [yoy]);

  const drillProps = useMemo(() => {
    if (!drill) return null;
    switch (drill.kind) {
      case "month":
        return {
          title: monthYear(drill.month),
          txns: monthTxns(txns, drill.month),
        };
      case "net-month":
        return {
          title: `Net · ${monthYear(drill.month)}`,
          note: "confirmed income and spending only",
          txns: netMonthTxns(txns, drill.month, kindById),
        };
      case "cell":
        return {
          title: `${drill.row.name} · ${monthYear(drill.month)}`,
          txns: cellTxns(txns, drill.row.category_id, drill.month),
        };
      case "category":
        return {
          title: `${drill.row.name} · last 12 months`,
          txns: categoryTxns(txns, drill.row.category_id, drill.fromMonth),
        };
      case "age": {
        const ids = new Set(spendAges.map((a) => a.id));
        return {
          title: "Behind age of money",
          note: "the last funded spends — each aged from the income that covered it",
          txns: txns.filter((t) => ids.has(t.ID)),
        };
      }
    }
  }, [drill, txns, spendAges, kindById]);

  const matrixFrom = matrix.data?.months[0] ?? "";

  return (
    <div className="space-y-6">
      <section ref={sectionRefs.networth} className="scroll-mt-2 space-y-2">
        <div className="flex min-h-9 items-center justify-between px-1">
          <SectionLabel as="h2">Net worth</SectionLabel>
          <SegmentedControl
            value={nwWindow}
            onChange={setNwWindow}
            options={[{ value: "12", label: "12 mo" }, { value: "24", label: "24 mo" }]}
          />
        </div>
        <Card>
          {networth.isPending ? (
            <NetWorthSkeleton />
          ) : networth.isError ? (
            <EmptyState icon={AlertTriangle} title="Couldn't load net worth" hint="Check your connection and try again." />
          ) : isFlatZero(networth.data.months) ? (
            <EmptyState
              icon={PiggyBank}
              title="No balance check-ins yet"
              hint="Check in an account balance under Accounts and net worth builds from there, month by month."
            />
          ) : (
            <NetWorthChart
              points={networth.data.months}
              onDrillMonth={(m) => setDrill({ kind: "month", month: m })}
            />
          )}
        </Card>
      </section>

      <section ref={sectionRefs.age} className="scroll-mt-2 space-y-2">
        <SectionLabel as="h2" className="px-1">Age of money</SectionLabel>
        {age.isPending ? (
          <AgeOfMoneySkeleton />
        ) : age.isError ? (
          <Card><EmptyState icon={AlertTriangle} title="Couldn't load age of money" hint="Check your connection and try again." /></Card>
        ) : (
          <AgeOfMoneyTile
            age={age.data}
            ages={spendAges}
            onDrill={mirrorOk ? () => setDrill({ kind: "age" }) : undefined}
          />
        )}
      </section>

      <section ref={sectionRefs["income-expense"]} className="scroll-mt-2 space-y-2">
        <div className="flex items-baseline justify-between px-1">
          <SectionLabel as="h2">Income v expense</SectionLabel>
          <span className="font-mono text-[10px] tracking-[0.04em] text-muted">last 12 months</span>
        </div>
        <Card className="!p-0">
          {matrix.isPending ? (
            <div className="py-2"><MatrixSkeleton /></div>
          ) : matrix.isError ? (
            <EmptyState icon={AlertTriangle} title="Couldn't load the matrix" hint="Check your connection and try again." />
          ) : (
            <div className="py-2">
              <IncomeExpenseMatrix
                data={matrix.data}
                onDrillCell={(row, m) => setDrill({ kind: "cell", row, month: m })}
                onDrillRow={(row) => setDrill({ kind: "category", row, fromMonth: matrixFrom })}
                onDrillMonth={(m) => setDrill({ kind: "net-month", month: m })}
              />
            </div>
          )}
        </Card>
      </section>

      <section ref={sectionRefs.trends} className="scroll-mt-2 space-y-2">
        <div className="flex items-baseline justify-between px-1">
          <SectionLabel as="h2">Spending trends</SectionLabel>
          <span className="font-mono text-[10px] tracking-[0.04em] text-muted">year over year</span>
        </div>
        <Card>
          {trend.isPending ? (
            <TrendsSkeleton />
          ) : trend.isError ? (
            <EmptyState icon={AlertTriangle} title="Couldn't load trends" hint="Check your connection and try again." />
          ) : (trend.data?.length ?? 0) === 0 ? (
            <EmptyState title="No spending history yet" hint="Trends appear once confirmed transactions build up." />
          ) : (
            <TrendCompare
              rows={yoy}
              summary={yoySum}
              onDrillMonth={(m) => setDrill({ kind: "month", month: m })}
            />
          )}
        </Card>
      </section>

      {drill && drillProps && (
        <ReportDrillSheet
          title={drillProps.title}
          note={"note" in drillProps ? drillProps.note : undefined}
          txns={drillProps.txns}
          pending={windowTxns.isPending}
          error={windowTxns.isError}
          categories={cats.data ?? []}
          onClose={() => setDrill(null)}
        />
      )}
    </div>
  );
}
