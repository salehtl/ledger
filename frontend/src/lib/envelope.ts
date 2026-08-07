// Pure display/decision math for the Plan screen's envelopes.
// Wire shapes follow docs/v3/api-contract.md §1–3 (snake_case v3 endpoints).
// All money is int64 AED fils; ratios appear only as geometry for bars.
import { formatFils } from "./money";
import { derivePaceStatus, monthLabel, type PaceStatus } from "./insights";

// ---------------------------------------------------------------- wire types

export type TargetType = "set_aside" | "refill" | "save_by_date";
export type Cadence = "weekly" | "monthly" | "yearly";

export interface EnvelopeTargetInfo {
  type: TargetType;
  amount_fils: number;
  cadence: Cadence;
  /** Only on save_by_date targets. */
  due_date?: string;
  months_left?: number;
  /** This month's full ask. */
  needed_fils: number;
  /** max(0, needed − assigned). */
  still_needed_fils: number;
  funded: boolean;
  /** The month this version was set from — may be earlier than the month
   *  requested, which is inheritance carrying the target forward, not a bug. */
  effective_month?: string;
}

export interface Envelope {
  category_id: number;
  category_name: string;
  bucket: string;
  carryover_fils: number;
  assigned_fils: number;
  activity_fils: number;
  available_fils: number;
  overspent: boolean;
  overspend_debt_fils: number;
  target?: EnvelopeTargetInfo;
}

export interface EnvelopeSummary {
  month: string;
  income_fils: number;
  assigned_fils: number;
  overspend_debt_fils: number;
  ready_to_assign_fils: number;
  envelopes: Envelope[];
}

/** Subset of the schedule object GET /api/upcoming decorates with due_in_days. */
export interface UpcomingItem {
  id: number;
  merchant: string;
  label?: string;
  amount_fils: number;
  next_due: string;
  direction: string;
  category_id: number | null;
  missed?: boolean;
  price_change?: boolean;
  due_in_days: number;
}

export interface UpcomingResponse {
  days: number;
  items: UpcomingItem[];
}

export interface Allocation {
  category_id: number;
  amount_fils: number;
}

// ------------------------------------------------------------------ grouping

const BUCKET_ORDER = ["need", "want", "saving"];

export interface EnvelopeGroup {
  bucket: string;
  envelopes: Envelope[];
  /** Sum of available across the group's *enveloped* rows (jar rows excluded —
   *  their negative "available" is just uncovered jar spend, not envelope debt). */
  available_fils: number;
}

/** Group envelopes under the need/want/saving buckets, in that order; unknown
 *  buckets (defensive) append after. Empty buckets are dropped. */
export function groupByBucket(envelopes: Envelope[]): EnvelopeGroup[] {
  const byBucket = new Map<string, Envelope[]>();
  for (const e of envelopes) {
    const list = byBucket.get(e.bucket);
    if (list) list.push(e);
    else byBucket.set(e.bucket, [e]);
  }
  const order = [...BUCKET_ORDER, ...[...byBucket.keys()].filter((b) => !BUCKET_ORDER.includes(b))];
  return order
    .filter((b) => byBucket.has(b))
    .map((bucket) => {
      const list = byBucket.get(bucket)!;
      return {
        bucket,
        envelopes: list,
        available_fils: list.reduce((s, e) => s + (isEnveloped(e) ? e.available_fils : 0), 0),
      };
    });
}

// ------------------------------------------------------------- envelope math

/**
 * Envelope depth is opt-in per category, and it starts when money actually
 * goes in: a category with nothing funded (no assignment, no carryover, no
 * overspend debt) rides the 50/30/20 jar math — plain spend, no bar, never an
 * overspend flag. Its negative wire `available` is an artifact of 0 − activity,
 * not a decision the user took, and a target alone is an *intent*, not money:
 * a target-only row stays a jar row (showing its ask) until it gets funded,
 * so the pre-assignment screen reads as asks, not a wall of red.
 */
export function isEnveloped(e: Envelope): boolean {
  return e.carryover_fils + e.assigned_fils !== 0 || e.overspend_debt_fils > 0;
}

/** Displayed overspend: the wire flag gated to enveloped rows (see isEnveloped). */
export function isOverspent(e: Envelope): boolean {
  return isEnveloped(e) && e.available_fils < 0;
}

export interface EnvelopeBar {
  /** Fraction of the funded amount spent (geometry for ProgressBar). */
  pct: number;
  status: PaceStatus;
}

/**
 * Bar geometry for an enveloped row: spend against funded (carryover +
 * assigned), same treatment as Home's jars — dotted fill, pace marker, the
 * three-stop ink ramp. Jar rows get no bar (null): nothing to measure against.
 *
 * Red means money is actually missing: only `available < 0` reads overbudget.
 * An envelope spent to *exactly* zero did what it was funded to do (a savings
 * transfer hitting its target, a bill paid in full) — that's a full ink bar,
 * not an alarm.
 */
export function envelopeBar(e: Envelope, pace?: number): EnvelopeBar | null {
  if (!isEnveloped(e)) return null;
  const funded = e.carryover_fils + e.assigned_fils;
  const pct = funded > 0 ? e.activity_fils / funded : e.activity_fils > 0 ? 1 : 0;
  const status: PaceStatus =
    e.available_fils < 0 ? "overbudget" : pct >= 1 ? "under" : derivePaceStatus(pct, pace);
  return { pct, status };
}

/** Available after re-assigning `assignedFils` (absolute), before saving. */
export function assignPreview(e: Envelope, assignedFils: number): number {
  return e.carryover_fils + assignedFils - e.activity_fils;
}

/**
 * Fraction of `month` elapsed (the ProgressBar pace marker), or undefined when
 * `month` is not the calendar month `today` sits in — a finished month has no
 * "today" and a future month hasn't started.
 */
export function monthProgress(month: string, today: Date = new Date()): number | undefined {
  const current = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}`;
  if (month !== current) return undefined;
  const daysInMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
  return today.getDate() / daysInMonth;
}

/** "Jul 2026" for a "YYYY-MM" month. */
export function monthTitle(month: string): string {
  return `${monthLabel(month)} ${month.slice(0, 4)}`;
}

// ------------------------------------------------------------ target display

const CADENCE_SHORT: Record<Cadence, string> = { weekly: "/wk", monthly: "/mo", yearly: "/yr" };

/** "Dec 2026" from a "YYYY-MM-DD" due date; "" when absent. */
export function dueDateLabel(dueDate?: string): string {
  if (!dueDate) return "";
  return `${monthLabel(dueDate.slice(0, 7))} ${dueDate.slice(0, 4)}`;
}

/** Terse target descriptor for a row meta line. */
export function targetLabel(t: EnvelopeTargetInfo): string {
  const amt = formatFils(t.amount_fils);
  if (t.type === "set_aside") return `set aside ${amt}${CADENCE_SHORT[t.cadence]}`;
  if (t.type === "refill") return `refill to ${amt}${CADENCE_SHORT[t.cadence]}`;
  return `save ${amt} by ${dueDateLabel(t.due_date)}`;
}

/** Needed-this-month verdict: "funded" or "needs X more". */
export function neededLabel(t: EnvelopeTargetInfo): string {
  if (t.funded) return "funded";
  return `needs ${formatFils(t.still_needed_fils)} more`;
}

// ---------------------------------------------------------- upcoming claims

export interface CategoryClaim {
  total_fils: number;
  count: number;
  /** The soonest-due item — what the hint names. */
  soonest: UpcomingItem;
}

/** Sum upcoming *debit* bills per category — the money already spoken for. */
export function claimsByCategory(items: UpcomingItem[]): Map<number, CategoryClaim> {
  const claims = new Map<number, CategoryClaim>();
  for (const it of items) {
    if (it.category_id == null || it.direction === "credit") continue;
    const cur = claims.get(it.category_id);
    if (!cur) {
      claims.set(it.category_id, { total_fils: it.amount_fils, count: 1, soonest: it });
    } else {
      cur.total_fils += it.amount_fils;
      cur.count += 1;
      if (it.due_in_days < cur.soonest.due_in_days) cur.soonest = it;
    }
  }
  return claims;
}

/** "due today" / "due tomorrow" / "due in 5d" / "3d overdue". */
export function dueLabel(days: number): string {
  if (days < 0) return `${-days}d overdue`;
  if (days === 0) return "due today";
  if (days === 1) return "due tomorrow";
  return `due in ${days}d`;
}

/** The single most pressing upcoming bill: missed bills first, then soonest due. */
export function nextUpcoming(items: UpcomingItem[]): UpcomingItem | null {
  if (items.length === 0) return null;
  return [...items].sort(
    (a, b) => Number(b.missed ?? false) - Number(a.missed ?? false) || a.due_in_days - b.due_in_days,
  )[0];
}

/** "NETFLIX due in 2d" — the pocket-strip line for the most pressing bill. */
export function nextUpcomingLabel(item: UpcomingItem): string {
  return `${item.label || item.merchant} ${dueLabel(item.due_in_days)}`;
}

/** One-line claim hint for a row: "Netflix due in 2d · 39.00". */
export function claimText(c: CategoryClaim): string {
  const name = c.soonest.label || c.soonest.merchant;
  if (c.count === 1) return `${name} ${dueLabel(c.soonest.due_in_days)} · ${formatFils(c.total_fils)}`;
  return `${c.count} bills · ${formatFils(c.total_fils)} · next ${dueLabel(c.soonest.due_in_days)}`;
}

/** How much of the claim the envelope cannot cover yet (0 when covered). */
export function claimShort(c: CategoryClaim, availableFils: number): number {
  return Math.max(0, c.total_fils - Math.max(0, availableFils));
}

// ------------------------------------------------------------- move money

/** Envelopes money can be taken from: positive available, destination excluded,
 *  most available first (name tie-break for determinism). */
export function moveSources(envelopes: Envelope[], toId: number): Envelope[] {
  return envelopes
    .filter((e) => e.category_id !== toId && e.available_fils > 0)
    .sort((a, b) => b.available_fils - a.available_fils || a.category_name.localeCompare(b.category_name));
}

/** What the destination is short: uncovered overspend first, else its target's
 *  remaining ask, else its uncovered upcoming-bill claim. */
export function shortfallFils(e: Envelope, claim?: CategoryClaim): number {
  if (e.available_fils < 0) return -e.available_fils;
  if (e.target && !e.target.funded) return e.target.still_needed_fils;
  if (claim) return claimShort(claim, e.available_fils);
  return 0;
}

/** Prefill for the move amount: cover the destination's shortfall, capped at
 *  what the source actually has. 0 = leave the input empty. */
export function moveSuggestionFils(from: Envelope, to: Envelope, claim?: CategoryClaim): number {
  return Math.min(Math.max(0, from.available_fils), shortfallFils(to, claim));
}

export interface MovePreview {
  from_after_fils: number;
  to_after_fils: number;
}

/** Post-move available on both legs (assignment shifts, activity doesn't). */
export function movePreview(from: Envelope, to: Envelope, amountFils: number): MovePreview {
  return {
    from_after_fils: from.available_fils - amountFils,
    to_after_fils: to.available_fils + amountFils,
  };
}

// ------------------------------------------------------------- auto-assign

export function allocationsTotal(allocations: Allocation[]): number {
  return allocations.reduce((s, a) => s + a.amount_fils, 0);
}

/** Toast copy after auto-assign. */
// Figure-free on purpose: toasts set their body in Sans, and §1.3 keeps money
// out of Sans — the assigned numbers land in the rows on screen anyway.
export function autoAssignMessage(allocations: Allocation[]): string {
  if (allocations.length === 0) return "Nothing to assign";
  const n = allocations.length;
  return `Assigned ${n} envelope${n === 1 ? "" : "s"}`;
}

/** The absolute assignment set that reverses an auto-assign: for each touched
 *  category, its post-assign figure minus the delta that was applied. */
export function undoAssignments(
  allocations: Allocation[],
  after: EnvelopeSummary,
): { category_id: number; assigned_fils: number }[] {
  const assignedNow = new Map(after.envelopes.map((e) => [e.category_id, e.assigned_fils]));
  return allocations.map((a) => ({
    category_id: a.category_id,
    assigned_fils: Math.max(0, (assignedNow.get(a.category_id) ?? 0) - a.amount_fils),
  }));
}

// -------------------------------------------------------------- RTA banner

/** Amount text with an explicit 0.00 at zero, for figures woven into running
 *  labels ("spent 0.00 of 500.00") where formatFils's "—" would read as a
 *  missing value rather than a real zero. */
export function filsLabel(fils: number): string {
  return fils === 0 ? "0.00" : formatFils(fils);
}

/** RTA prints an explicit 0.00 at zero — for this one number, zero is the goal
 *  state, not an absence (formatFils's "—" would read as missing data). */
export function rtaDisplay(rtaFils: number): string {
  return filsLabel(rtaFils);
}

/** One calm line under the RTA figure. */
export function rtaMessage(s: EnvelopeSummary): string {
  if (s.ready_to_assign_fils < 0) {
    return `Assigned ${formatFils(-s.ready_to_assign_fils)} more than you have — move money back to zero.`;
  }
  if (s.income_fils === 0 && s.assigned_fils === 0) {
    return "Set your monthly income in Settings to start assigning.";
  }
  if (s.ready_to_assign_fils === 0) return "Every dirham assigned.";
  return "Auto-assign funds targets first, then follows your 50/30/20 split.";
}

// ------------------------------------------------------------ amount input

/**
 * Parse a typed dirham amount into integer fils without float arithmetic:
 * "1,250" → 125000, "39.5" → 3950, "39.55" → 3955. Null on anything else
 * (letters, negatives, >2 decimals, empty).
 */
export function parseAmountFils(text: string): number | null {
  const t = text.trim().replace(/,/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  const [whole, frac = ""] = t.split(".");
  const cents = (frac + "00").slice(0, 2);
  return Number(whole) * 100 + Number(cents);
}

/** Prefill text for an amount input: "150" / "39.50" (never negative). */
export function filsToAmountText(fils: number): string {
  const v = Math.max(0, fils);
  const whole = Math.trunc(v / 100);
  const cents = v % 100;
  return cents === 0 ? String(whole) : `${whole}.${String(cents).padStart(2, "0")}`;
}
