import { m } from "motion/react";
import { Card } from "../components/ui/Card";
import { ProgressBar } from "../components/ui/ProgressBar";
import { Skeleton } from "../components/Skeleton";
import { EmptyState } from "../components/EmptyState";
import { RollingNumber } from "../components/RollingNumber";
import { AlertTriangle, ListOrdered } from "../components/ui/PixelIcon";
import { useFirstReveal } from "../hooks/useFirstReveal";
import { DUR, EASE_OUT } from "../lib/motion";
import { formatMinor } from "../lib/minorMoney";
import { bucketColor } from "../lib/insights";
import type { BudgetBucket, BudgetSource } from "../v2/sources/budget";
import { EMPTY_FILTERS, txnAmountLabel, txnCategoryLabel, type TxnSource } from "../v2/sources/transactions";
import { useBudgetSnapshot, useBudgetSource, useTxnList, useTxnSource } from "../v2/queries";

/**
 * Home, on the local projection.
 *
 * # What this screen lost when it came off v1's HTTP API, and why
 *
 * Every widget below reads `web/src/v2/sources/*`, which read the SQLite
 * projection the sync engine writes. Four of v1's widgets had no projection
 * data behind them and were REMOVED rather than stubbed — a placeholder that
 * says "coming soon" is a promise this codebase cannot keep from here:
 *
 *   - **the pace/verdict hero and the per-bucket target bars.** They read
 *     `target`, `projection` and `month_progress` from `/api/summary`. There is
 *     no target in the v2 vocabulary: `client/src/replay/state.ts` holds
 *     `txns`, `rules`, `homeCurrency`, `rates`, `forks` and `anomalies`, and no
 *     op can author an envelope, a monthly plan or a run rate. 50/30/20 is
 *     printed as what it is — the rule — beside what actually happened.
 *   - **the pocket strip** (ready-to-assign, next bill, net worth), which read
 *     v1's plan, recurring and accounts endpoints. Same reason: no ops.
 *   - **the projects glance**, from `/api/projects`.
 *   - **the 6-month trend**, from `/api/insights/trend`.
 *
 * # The scope selector does not reach this screen
 *
 * `sqlBudgetSource` sums the whole log; the projection carries no per-period
 * plan to scope it against, so the hero says "so far" rather than naming a
 * month it is not actually bounded by. The Transactions screen DOES honour the
 * scope (its filters gained `from`/`to`), which is why the prop is still
 * accepted here and deliberately unused.
 */
export interface HomeProps {
  /** Accepted for the shell's benefit and unused — see the header. */
  scope?: unknown;
  onOpenProject?: (id: number) => void;
  onOpenProjects?: () => void;
  onOpenPlan?: () => void;
  onOpenRecurring?: () => void;
  onOpenReports?: () => void;
  /** Test seam: a source over a projection this test built. */
  budgetSource?: BudgetSource;
  /** Test seam: see {@link budgetSource}. */
  txnSource?: TxnSource;
}

const BUCKET_LABEL: Record<BudgetBucket, string> = { need: "Needs", want: "Wants", saving: "Savings & debt" };
/** The rule, not a target: 50/30/20 is what the buckets MEAN, not a budget the log holds. */
const BUCKET_SHARE: Record<BudgetBucket, number> = { need: 50, want: 30, saving: 20 };
const BUCKETS: BudgetBucket[] = ["need", "want", "saving"];
const RECENT_LIMIT = 5;

export function Home({ budgetSource, txnSource }: HomeProps) {
  const budget = useBudgetSource(budgetSource);
  const txns = useTxnSource(txnSource);
  const snapshot = useBudgetSnapshot(budget);
  const recent = useTxnList(txns, EMPTY_FILTERS, RECENT_LIMIT);
  const rows = recent.data?.rows ?? [];
  const firstReveal = useFirstReveal(rows.length > 0);

  // No v2 runtime and no injected source. This is NOT a v1 fallback: there is
  // no correct one — the projection is the data, and reaching for `/api/*`
  // here would read a different database over a protocol `ledgerd` does not
  // serve, while looking entirely fine.
  if (budget === null || txns === null) {
    return (
      <EmptyState
        icon={AlertTriangle}
        title="Your local ledger isn't open"
        hint="This screen reads the copy of your ledger on this device. Reopen the app to reconnect."
      />
    );
  }
  if (snapshot.isPending) return <Skeleton rows={8} />;
  if (snapshot.isError) {
    return <EmptyState icon={AlertTriangle} title="Couldn't read your ledger" hint="Reopen the app to try again." />;
  }

  const s = snapshot.data;
  const currency = s.homeCurrency ?? "";
  const spent = s.buckets.need + s.buckets.want + s.buckets.saving + s.unassigned;
  // Shares, not budget usage: there is no budget to be a fraction of. The bar
  // is a magnitude next to its siblings and its accessible name says so.
  //
  // The `Number` here is a RATIO, never an amount: the division happens in
  // `bigint` at four decimal places and only the bounded result (0..10000)
  // crosses into a float, so no money value is ever held in a double.
  const share = (v: bigint): number => (spent === 0n ? 0 : Number((v * 10_000n) / spent) / 10_000);

  return (
    <div className="space-y-4">
      {/* hero: what has actually gone out, in the home currency — the one bold,
          branded surface; everything below stays quiet on neutral cards. */}
      <div className="rounded-[var(--radius)] bg-hero text-hero-fg p-5">
        <p className="text-sm opacity-80">Spent so far{currency ? ` · ${currency}` : ""}</p>
        <p className="mt-1 text-[2.75rem] leading-none font-semibold tracking-[-0.02em] tnum">
          <RollingNumber value={formatMinor(spent)} />
        </p>
        <p className="text-sm opacity-80 mt-2">
          against <span className="tnum">{formatMinor(s.income)}</span> in
        </p>
      </div>

      {!s.usable ? (
        <Card>
          <p className="text-sm">
            Your budget is rebuilding after an update. Nothing was lost — it will be back once the local sync finishes.
          </p>
        </Card>
      ) : (
        <>
          {s.warming && (
            <Card>
              <p className="text-sm">
                Your budget is warming up. After 14 days or 10 confirmed transactions this settles into a steadier view.
              </p>
            </Card>
          )}

          {/* 50/30/20 — the rule beside the money, with each bucket's share of
              what was spent. No target: nothing in the log holds one. */}
          <Card>
            <p className="text-sm font-medium mb-3">50 / 30 / 20</p>
            <div className="space-y-4">
              {BUCKETS.map((bucket) => (
                <div key={bucket}>
                  <div className="flex items-center justify-between text-sm mb-1.5">
                    <span className="flex items-center gap-2 font-medium">
                      <span
                        className="inline-block w-2.5 h-2.5 rounded-[var(--radius)]"
                        style={{ background: bucketColor(bucket) }}
                      />
                      {BUCKET_LABEL[bucket]}
                    </span>
                    <span className="tnum text-muted">{formatMinor(s.buckets[bucket])}</span>
                  </div>
                  <ProgressBar pct={share(s.buckets[bucket])} label={`${BUCKET_LABEL[bucket]} share of spending`} />
                  <div className="flex items-center justify-between mt-1.5 text-xs">
                    <span className="text-muted">{BUCKET_SHARE[bucket]}% of the rule</span>
                    <span className="tnum text-muted">{Math.round(share(s.buckets[bucket]) * 100)}% of spending</span>
                  </div>
                </div>
              ))}
            </div>
            {s.unassigned !== 0n && (
              <p className="text-xs text-warn mt-3 pt-3 border-t border-border">
                <span className="tnum">{formatMinor(s.unassigned)}</span> is uncategorized and sits outside the three
                buckets. Categorize it before treating these as complete.
              </p>
            )}
          </Card>

          {/* What the numbers deliberately leave out. §3.7's null rate is a
              waiting state, not a zero, so it is named rather than absorbed. */}
          {(s.excluded.missingHomeRate > 0 || s.excluded.unresolvedDuplicates > 0 || s.excluded.unparsed > 0) && (
            <Card>
              <p className="text-sm font-medium mb-2">Not counted yet</p>
              <ul className="space-y-1 text-xs text-muted">
                {s.excluded.missingHomeRate > 0 && (
                  <li className="text-warn">
                    {s.excluded.missingHomeRate} transaction{s.excluded.missingHomeRate === 1 ? " is" : "s are"} missing
                    a home-currency rate.
                  </li>
                )}
                {s.excluded.unresolvedDuplicates > 0 && (
                  <li className="text-warn">
                    {s.excluded.unresolvedDuplicates} possible duplicate
                    {s.excluded.unresolvedDuplicates === 1 ? " needs" : "s need"} review.
                  </li>
                )}
                {s.excluded.unparsed > 0 && (
                  <li>
                    {s.excluded.unparsed} message{s.excluded.unparsed === 1 ? " couldn't" : "s couldn't"} be read.
                  </li>
                )}
              </ul>
            </Card>
          )}
        </>
      )}

      {/* recent stream */}
      <Card>
        <p className="text-sm font-medium mb-2">Recent</p>
        {rows.length === 0 ? (
          <EmptyState icon={ListOrdered} title="No recent activity" hint="New transactions will appear here." />
        ) : (
          <ul className="divide-y divide-border">
            {rows.map((t, i) => {
              const amount = txnAmountLabel(t);
              return (
                <m.li
                  key={t.id}
                  // `initial={false}` — not a hidden state — is what keeps the
                  // cascade one-shot. On a refetch Framer adopts `animate` as
                  // the starting value and plays nothing, so the list cannot
                  // re-deal itself every time the query revalidates.
                  //
                  // TRANSFORM ONLY — no `opacity: 0` here, deliberately, and do
                  // not add one. `LazyMotion` loads its feature bundle in an
                  // effect, and until that promise settles `m.*` renders
                  // straight from `initial` with no animation running. An
                  // `opacity: 0` resting state therefore means these rows paint
                  // *invisible* until a separate chunk has been fetched and
                  // executed. A `y` offset degrades to "8px low for a moment"
                  // instead of "gone".
                  initial={firstReveal ? { y: 8 } : false}
                  animate={{ y: 0 }}
                  // The cap reproduces the retired `:nth-child(n+7)` rule.
                  transition={{ duration: DUR.sheet, ease: EASE_OUT, delay: Math.min(i * 0.04, 0.24) }}
                  className="py-2 flex items-center justify-between gap-3"
                >
                  <div className="min-w-0">
                    <p className="truncate font-medium">{t.merchant_raw || "—"}</p>
                    <p className="text-xs text-muted">
                      {t.posted_at.slice(0, 10)} · {txnCategoryLabel(t)}
                      {t.currency !== "" && t.currency !== currency ? ` · ${t.currency}` : ""}
                      {!t.unparsed && t.amount_home_minor === null ? ` · no ${currency || "home"} rate` : ""}
                    </p>
                  </div>
                  <span
                    className={`tnum ${amount.unreadable ? "text-muted" : ""}`}
                    style={amount.flow === "in" ? { color: "var(--color-good)" } : undefined}
                    title={amount.flow === "in" ? "Money in" : amount.flow === "out" ? "Money out" : "Nothing could be read"}
                  >
                    {amount.text}
                  </span>
                </m.li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}
