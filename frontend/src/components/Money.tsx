import { formatFils, moneyClass } from "../lib/money";
export function Money({ fils }: { fils: number }) {
  return <span className={moneyClass(fils)}>{formatFils(fils)}</span>;
}
