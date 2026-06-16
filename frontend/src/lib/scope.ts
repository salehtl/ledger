import { currentPeriod, monthLabel } from "./insights";
import { monthRange } from "./transactions";

/** The app-wide time scope. Periods are "YYYY-MM". */
export type Scope =
  | { kind: "month"; period: string }
  | { kind: "range"; from: string; to: string } // both "YYYY-MM", from <= to
  | { kind: "all" };

export const DEFAULT_SCOPE: Scope = { kind: "month", period: currentPeriod() };

/** Add `delta` months to a "YYYY-MM" period (UTC-safe, wraps years). */
export function addMonth(period: string, delta: number): string {
  const [y, m] = period.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Order two periods ascending. */
export function normalizeRange(a: string, b: string): { from: string; to: string } {
  return a <= b ? { from: a, to: b } : { from: b, to: a };
}

/**
 * Inclusive query bounds for the transactions list. month/range reuse the
 * day-"32" upper bound (see monthRange) so timestamped posted_at on the last
 * day still matches; "all" returns no bounds.
 */
export function scopeBounds(scope: Scope): { from?: string; to?: string } {
  if (scope.kind === "all") return {};
  if (scope.kind === "month") return monthRange(scope.period);
  return { from: `${scope.from}-01`, to: `${scope.to}-32` };
}

/** The single month the monthly views (Home, Insights) should show. */
export function scopeAnchor(scope: Scope): string {
  if (scope.kind === "month") return scope.period;
  if (scope.kind === "range") return scope.to;
  return currentPeriod();
}

export interface InsightsFocus { period: string; note: string; }

/** The single month Insights evaluates, plus a qualifier when the scope spans more than one month. */
export function insightsFocus(scope: Scope): InsightsFocus {
  if (scope.kind === "month") return { period: scope.period, note: "" };
  if (scope.kind === "range") return { period: scope.to, note: "latest in range" };
  return { period: currentPeriod(), note: "current month" };
}

/** Human label: "Jun 2026" · "Mar–Jun 2026" · "Dec 2025 – Feb 2026" · "All time". */
export function scopeLabel(scope: Scope): string {
  if (scope.kind === "all") return "All time";
  if (scope.kind === "month") return `${monthLabel(scope.period)} ${scope.period.slice(0, 4)}`;
  const fy = scope.from.slice(0, 4), ty = scope.to.slice(0, 4);
  return fy === ty
    ? `${monthLabel(scope.from)}–${monthLabel(scope.to)} ${ty}`
    : `${monthLabel(scope.from)} ${fy} – ${monthLabel(scope.to)} ${ty}`;
}
