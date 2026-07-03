// Pure formatters for the Settings hub's live value previews. Kept framework-free
// and unit-tested so each row can show its current state at a glance without the
// hub having to render the drill-in page.
import type { AppSettings, BudgetConfig, RatesResponse } from "../api/types";
import { fractionToPercent } from "./format";
import type { SwipeConfig } from "./swipe";

/** "50/30/20" — the need/want/saving split as whole percents. */
export function budgetSplitLabel(cfg: BudgetConfig): string {
  return [cfg.need_pct, cfg.want_pct, cfg.saving_pct].map(fractionToPercent).join("/");
}

/** "Off" | "On" | "On · AI" — whether new transactions are categorized, and how. */
export function categorizationSummary(s: AppSettings): string {
  if (!s.auto_categorize) return "Off";
  return s.ai_enabled ? "On · AI" : "On";
}

/**
 * "AED · USD +1" — configured currency codes, remainder collapsed. Missing rates
 * (transactions in a currency with no rate) are surfaced because they silently
 * drop out of budgets until fixed.
 */
export function currenciesLabel(r: RatesResponse): string {
  const codes = r.rates.map((x) => x.currency);
  const segments: string[] = [];
  if (codes.length > 0) {
    let s = codes.slice(0, 2).join(" · ");
    if (codes.length > 2) s += ` +${codes.length - 2}`;
    segments.push(s);
  }
  if (r.missing.length > 0) segments.push(`${r.missing.length} missing`);
  return segments.length > 0 ? segments.join(" · ") : "None";
}

/** "← Want · → Need" — the two horizontal swipe actions, the ones users hit most. */
export function swipeSummary(cfg: SwipeConfig): string {
  return `← ${cfg.left.label} · → ${cfg.right.label}`;
}
