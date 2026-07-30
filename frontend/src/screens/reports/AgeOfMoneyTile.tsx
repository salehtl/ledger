import type { AgeOfMoney, SpendAge } from "../../lib/reports";

/**
 * Age of money: how many days income sat in the pool before the last funded
 * spends drained it (FIFO — the server computes the headline, the sparkline
 * mirrors it client-side from the same transactions so the two always agree
 * on definition). One number, one plain-words explainer, one bar per sampled
 * spend; the whole tile drills to the spends behind the figure.
 *
 * The sparkline strip is always reserved (h-8) so the tile never grows when
 * the slower transactions window lands; `ages` arrives empty both while that
 * window loads and when the client mirror diverges from the server figure
 * (ReportsScreen hides a mirror it can't vouch for — see ageMirrorAgrees).
 *
 * Not computable yet (no income/spend history) renders a quiet "—" with the
 * expectation stated — a first-run dashboard of unexplained zeros is worse
 * than an honest "not yet".
 */
export function AgeOfMoneyTile({ age, ages, onDrill }: {
  age: AgeOfMoney | undefined;
  /** Client-side FIFO ages behind the sparkline (lib/reports.fifoSpendAges). */
  ages: SpendAge[];
  onDrill?: () => void;
}) {
  const computable = age !== undefined && age.sample_size > 0;

  if (!computable) {
    return (
      <div className="rounded-[var(--radius)] border border-border bg-surface p-4">
        <span className="tnum text-xl font-semibold tracking-[-0.02em] text-muted">—</span>
        <p className="mt-1 text-sm text-muted">
          Not enough history yet. Once income lands and gets spent, this shows how many days money waits in between.
        </p>
      </div>
    );
  }

  const maxAge = Math.max(...ages.map((a) => a.ageDays), 1);

  return (
    <button
      type="button"
      onClick={onDrill}
      disabled={!onDrill}
      className="w-full rounded-[var(--radius)] border border-border bg-surface p-4 text-left press"
    >
      <div className="flex items-baseline justify-between gap-3">
        <span className="tnum text-xl font-semibold tracking-[-0.02em]">
          {age.age_days} day{age.age_days === 1 ? "" : "s"}
        </span>
        <span className="font-mono text-[10px] tracking-[0.04em] text-muted shrink-0">
          last {age.sample_size} spend{age.sample_size === 1 ? "" : "s"} {onDrill && <span aria-hidden>›</span>}
        </span>
      </div>

      <div className="mt-2 flex h-8 items-end gap-1" aria-hidden data-testid="aom-spark">
        {ages.map((a, i) => (
          <div
            key={a.id}
            className="dither-mask w-full max-w-4 rounded-[var(--radius)]"
            style={{
              height: `${Math.max(Math.round((a.ageDays / maxAge) * 32), 2)}px`,
              background: i === ages.length - 1 ? "var(--color-fg)" : "var(--color-muted)",
            }}
          />
        ))}
      </div>

      <p className="mt-2 text-sm text-muted">
        How many days money sits between arriving and being spent — higher means you're living on older money.
      </p>
    </button>
  );
}
