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

/** "Default" | "90%" — this device's text-size override. */
export function fontScaleLabel(scale: number): string {
  return scale === 100 ? "Default" : `${scale}%`;
}

/** "← Want · → Need" — the two horizontal swipe actions, the ones users hit most. */
export function swipeSummary(cfg: SwipeConfig): string {
  return `← ${cfg.left.label} · → ${cfg.right.label}`;
}

/** "3 active · 1 found" — confirmed schedules plus detector proposals awaiting triage. */
export function scheduledSummary(rows?: { status: string }[]): string | undefined {
  if (!rows) return undefined;
  const active = rows.filter((r) => r.status === "active").length;
  const proposed = rows.filter((r) => r.status === "proposed").length;
  const parts: string[] = [];
  if (active > 0) parts.push(`${active} active`);
  if (proposed > 0) parts.push(`${proposed} found`);
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

/** "Off" | "Thresholds" | "Bills 3d" | "Thresholds · bills 3d" — the two push gates. */
export function notifySummary(n: { notify_thresholds: boolean; notify_upcoming_days: number }): string {
  const parts: string[] = [];
  if (n.notify_thresholds) parts.push("Thresholds");
  if (n.notify_upcoming_days > 0) parts.push(`bills ${n.notify_upcoming_days}d`);
  if (parts.length === 0) return "Off";
  const s = parts.join(" · ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}
