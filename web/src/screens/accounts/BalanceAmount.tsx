import { moneyClass } from "../../lib/money";
import { balanceLabel } from "../../lib/reconcile";

/**
 * A balance figure. Unlike `<Money>` (whose zero is "—", right for activity
 * sums), a balance of exactly zero is a real statement — "0.00" in the muted
 * zero register. Negative balances keep the accounting-parens red register.
 */
export function BalanceAmount({ fils, className = "" }: { fils: number; className?: string }) {
  return <span className={`${moneyClass(fils)} ${className}`}>{balanceLabel(fils)}</span>;
}
