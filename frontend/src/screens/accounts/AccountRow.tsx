import { rowMeta, type AccountBalanceSummary } from "../../lib/reconcile";
import { BalanceAmount } from "./BalanceAmount";

const MASK = "••••";

/**
 * One account line: name + live computed balance (anchor ± activity since),
 * then a mono meta line — bank · last4 on the left, anchor freshness on the
 * right, so every balance answers "as of when?". An account never checked in
 * shows a muted em dash instead of a fake zero. The whole row is the tap
 * target (opens the account detail).
 */
export function AccountRow({ account, onOpen, now }: {
  account: AccountBalanceSummary;
  onOpen: (a: AccountBalanceSummary) => void;
  /** Injectable clock for stories/tests. */
  now?: Date;
}) {
  const a = account;
  return (
    <button
      type="button"
      onClick={() => onOpen(a)}
      // No aria-label override: the visible content (name, balance, freshness)
      // is the accessible name, so assistive tech hears what sighted users see.
      data-kind={a.kind}
      data-checkin={a.has_checkin ? "anchored" : "none"}
      className="w-full text-left px-4 py-3 press"
    >
      <div className="flex items-baseline justify-between gap-3">
        <p className="min-w-0 truncate text-sm font-medium leading-5 tracking-[-0.01em]">{a.name}</p>
        <span className="tnum font-medium leading-5 shrink-0">
          {a.has_checkin ? <BalanceAmount fils={a.computed_fils ?? 0} /> : <span className="text-muted">—</span>}
        </span>
      </div>
      <div className="mt-1 flex items-center justify-between gap-3 font-mono text-[10px] tracking-[0.04em] text-muted">
        <span className="min-w-0 truncate tnum">
          {a.bank ? `${a.bank} · ` : ""}{MASK} {a.last4}
        </span>
        <span className="shrink-0 tnum">{rowMeta(a, now)}</span>
      </div>
    </button>
  );
}
