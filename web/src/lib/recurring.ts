// Pure recurrence phrasing, countdown, and grace math for the Recurring
// screen (screens/recurring/). Framework-free per the lib convention; the
// wire types it needs are declared here so screens/api can share them without
// the lib importing from a screen dir.

import { dirhamsToFils } from "./format";
import { formatFils } from "./money";

/** Detector provenance persisted on detected schedules (read-only). */
export interface ProvenanceInfo {
  count: number;
  avg_interval_days: number;
  last_amounts_fils: number[];
  tx_ids: number[];
  price_stepped?: boolean;
}

/** POST/PUT /api/scheduled body. PUT is a full replace server-side, so
 *  fields the form doesn't edit (tolerance_pct, account_id) must still ride
 *  along on edits or the server resets them to defaults. */
export interface SchedulePayload {
  merchant: string;
  label?: string;
  amount_fils: number;
  /** Omitted on create — the server defaults to the detector's ±10%. */
  tolerance_pct?: number;
  interval_days: number;
  next_due: string; // YYYY-MM-DD
  direction?: string;
  category_id?: number | null;
  account_id?: number | null;
}

/** Canonical cadence phrasing for the snap intervals the detector proposes.
 *  Non-canonical day counts fall back to the literal "every N days". */
export function cadenceLabel(intervalDays: number): string {
  switch (intervalDays) {
    case 7: return "every week";
    case 14: return "every 2 weeks";
    case 30: return "every month";
    case 91: return "every 3 months";
    case 365: return "every year";
    default: return `every ${intervalDays} days`;
  }
}

/** Provenance line for a detected proposal: "seen 6× every ~30 days at 39.00".
 *  The interval keeps its mined average (with ~) rather than the snapped
 *  cadence — the evidence line shows what was actually observed. */
export function provenanceLine(p: ProvenanceInfo, amountFils: number): string {
  return `seen ${p.count}× every ~${p.avg_interval_days} days at ${formatFils(amountFils)}`;
}

/** Countdown copy for an upcoming item. Negative due_in_days = overdue. */
export function dueLabel(dueInDays: number): string {
  if (dueInDays < 0) {
    const d = -dueInDays;
    return d === 1 ? "1 day overdue" : `${d} days overdue`;
  }
  if (dueInDays === 0) return "due today";
  if (dueInDays === 1) return "due tomorrow";
  return `due in ${dueInDays} days`;
}

/** Mirror of the server's missed-bill grace: interval/10, clamped 2..7 days
 *  (integer division, matching Go). */
export function graceDays(intervalDays: number): number {
  const g = Math.floor(intervalDays / 10);
  return Math.min(7, Math.max(2, g));
}

/** Whole-day difference from `todayISO` to `dateISO` (both YYYY-MM-DD or
 *  RFC3339; only the date part counts). Positive = future. */
export function daysUntil(dateISO: string, todayISO: string): number {
  const a = Date.parse(dateISO.slice(0, 10) + "T00:00:00Z");
  const b = Date.parse(todayISO.slice(0, 10) + "T00:00:00Z");
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((a - b) / 86_400_000);
}

/** What to call a schedule in the UI: the user's label, else the merchant. */
export function scheduleName(s: { label: string; merchant: string }): string {
  return s.label || s.merchant;
}

/** "last charge 42.00 — expected 39.00" when the last match strayed from the
 *  expected amount; null when there is nothing to explain. */
export function priceChangeLine(s: {
  price_change: boolean;
  last_amount_fils: number | null;
  amount_fils: number;
}): string | null {
  if (!s.price_change || s.last_amount_fils == null) return null;
  if (s.last_amount_fils === s.amount_fils) return null;
  return `last charge ${formatFils(s.last_amount_fils)} — expected ${formatFils(s.amount_fils)}`;
}

/** Partition an upcoming feed (already soonest-first) into overdue vs due. */
export function splitUpcoming<T extends { due_in_days: number }>(items: T[]): { overdue: T[]; due: T[] } {
  return {
    overdue: items.filter((i) => i.due_in_days < 0),
    due: items.filter((i) => i.due_in_days >= 0),
  };
}

/** Sum of expected outgoing fils in an upcoming window (credits don't count
 *  against the wallet). */
export function upcomingDebitTotal(items: { direction: string; amount_fils: number }[]): number {
  let total = 0;
  for (const i of items) if (i.direction !== "credit") total += i.amount_fils;
  return total;
}

/** Active schedules matched within the last `withinDays` days — the "recently
 *  paid" strip, most recent first. */
export function recentlyPaid<T extends { status: string; last_matched_at?: string; last_matched_tx_id: number | null }>(
  schedules: T[],
  todayISO: string,
  withinDays = 10,
): T[] {
  return schedules
    .filter((s) => {
      if (s.status !== "active" || !s.last_matched_at || s.last_matched_tx_id == null) return false;
      const age = -daysUntil(s.last_matched_at, todayISO);
      return age >= 0 && age <= withinDays;
    })
    .sort((a, b) => (a.last_matched_at! < b.last_matched_at! ? 1 : -1));
}

/** Interval choices for the manual schedule form. "custom" opens a day-count
 *  field. */
export const INTERVAL_CHOICES = [
  { value: "7", label: "Weekly" },
  { value: "14", label: "Every 2 weeks" },
  { value: "30", label: "Monthly" },
  { value: "91", label: "Quarterly" },
  { value: "365", label: "Yearly" },
  { value: "custom", label: "Custom…" },
] as const;

/** Which form choice a stored interval maps back onto (edit prefill). */
export function intervalChoice(intervalDays: number): string {
  return ["7", "14", "30", "91", "365"].includes(String(intervalDays)) ? String(intervalDays) : "custom";
}

export interface ScheduleFormInput {
  merchant: string;
  label: string;
  amountAed: string;
  intervalChoice: string; // one of INTERVAL_CHOICES values
  customDays: string;     // used when intervalChoice === "custom"
  nextDue: string;        // YYYY-MM-DD
  direction: string;
  categoryId: number | null;
  /** Round-tripped from the schedule being edited (the form never edits
   *  these, but PUT is a full replace). Leave undefined on create. */
  tolerancePct?: number;
  accountId?: number | null;
}

export type ScheduleBuildResult =
  | { ok: true; payload: SchedulePayload }
  | { ok: false; error: string };

/** Validate the schedule form and project it onto the POST/PUT body.
 *  Money goes through integer fils — never floats past this boundary. */
export function buildSchedulePayload(input: ScheduleFormInput): ScheduleBuildResult {
  const merchant = input.merchant.trim();
  if (!merchant) return { ok: false, error: "Enter a name or merchant." };

  const aed = Number(input.amountAed);
  if (!Number.isFinite(aed) || aed <= 0) {
    return { ok: false, error: "Enter an amount greater than zero." };
  }

  let interval: number;
  if (input.intervalChoice === "custom") {
    interval = Number(input.customDays);
    if (!Number.isInteger(interval) || interval <= 0) {
      return { ok: false, error: "Enter how many days between charges." };
    }
  } else {
    interval = Number(input.intervalChoice);
    if (!Number.isInteger(interval) || interval <= 0) {
      return { ok: false, error: "Choose how often it repeats." };
    }
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.nextDue)) {
    return { ok: false, error: "Choose the next due date." };
  }
  if (input.direction !== "debit" && input.direction !== "credit") {
    return { ok: false, error: "Choose debit or credit." };
  }

  const payload: SchedulePayload = {
    merchant,
    label: input.label.trim(),
    amount_fils: dirhamsToFils(aed),
    interval_days: interval,
    next_due: input.nextDue,
    direction: input.direction,
    category_id: input.categoryId,
  };
  if (input.tolerancePct !== undefined) payload.tolerance_pct = input.tolerancePct;
  if (input.accountId !== undefined) payload.account_id = input.accountId;
  return { ok: true, payload };
}
