// Pure decision/display math for the Accounts & reconcile flow (v3 piece 5).
// Wire shapes follow docs/v3/api-contract.md §4 (snake_case v3 endpoints).
// All money is int64 AED fils; fractions appear only as bar geometry.
import { formatFils } from "./money";
import { shortDate } from "./format";

// ---------------------------------------------------------------- wire types

export type AccountKind = "budget" | "tracking";

/** One item of GET /api/accounts/balances — the accounts screen in one call. */
export interface AccountBalanceSummary {
  account_id: number;
  name: string;
  bank: string;
  last4: string;
  kind: AccountKind;
  has_checkin: boolean;
  /** The rest are zero/omitted until the first check-in. */
  anchor_fils?: number;
  anchor_as_of?: string;
  anchor_source?: string; // "checkin" | "adjustment"
  activity_since_fils?: number;
  txn_count?: number;
  /** anchor + signed activity since — the live balance. */
  computed_fils?: number;
}

/** One row of GET /api/accounts/{id}/balances (newest first). */
export interface BalancePoint {
  id: number;
  account_id: number;
  as_of: string;
  balance_fils: number;
  source: string; // "checkin" | "adjustment"
  note?: string;
  created_at: string;
}

/** One retained email that produced no transaction — a discrepancy candidate. */
export interface UnparsedEmail {
  id: number;
  received_at: string;
  from_addr: string;
  subject: string;
  parse_error?: string;
}

/** POST /api/accounts/{id}/checkin response — the reconcile report. */
export interface CheckinResult {
  account_id: number;
  stated_fils: number;
  expected_fils: number;
  delta_fils: number;
  since?: string;
  txn_count: number;
  unconverted_count: number;
  first_checkin: boolean;
  balance_id: number;
  unparsed: UnparsedEmail[];
}

// ------------------------------------------------------------- amount input

/**
 * Parse a typed balance into integer fils without float arithmetic.
 * "8,250" → 825000, "39.5" → 3950, "-120.40" → -12040, "(120.40)" → -12040
 * (bank apps print credit-card debt either way). Null on anything else
 * (letters, >2 decimals, empty). The unicode minus "−" is accepted.
 */
export function parseBalanceFils(text: string): number | null {
  let t = text.trim().replace(/,/g, "").replace(/−/g, "-");
  let neg = false;
  const paren = /^\((.+)\)$/.exec(t);
  if (paren) {
    neg = true;
    t = paren[1].trim();
  }
  if (t.startsWith("-")) {
    neg = !neg ? true : neg;
    t = t.slice(1).trim();
  }
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  const [whole, frac = ""] = t.split(".");
  const cents = (frac + "00").slice(0, 2);
  const fils = Number(whole) * 100 + Number(cents);
  if (fils === 0) return 0; // never -0
  return neg ? -fils : fils;
}

export type Sign = "pos" | "neg";

/** True when the text itself carries a negative marker ("-", "−", parens). */
export function hasExplicitSign(text: string): boolean {
  const t = text.trim();
  return t.startsWith("-") || t.startsWith("−") || /^\(.+\)$/.test(t);
}

/**
 * The stated balance from the amount text plus the sign toggle. A sign typed
 * (or pasted) in the text wins over the toggle — pasting "-1,234.56" must
 * never be silently flipped positive.
 */
export function composeStated(text: string, sign: Sign): number | null {
  const parsed = parseBalanceFils(text);
  if (parsed === null) return null;
  if (hasExplicitSign(text)) return parsed;
  return sign === "neg" ? -Math.abs(parsed) : parsed;
}

/** Prefill text for a balance input: "8250" / "39.50" / "-120.40". */
export function signedAmountText(fils: number): string {
  const abs = Math.abs(fils);
  const whole = Math.trunc(abs / 100);
  const cents = abs % 100;
  const body = cents === 0 ? String(whole) : `${whole}.${String(cents).padStart(2, "0")}`;
  return fils < 0 ? `-${body}` : body;
}

/** Balance text with an explicit 0.00 at zero — a zero balance is a real
 *  figure, not a missing value (formatFils's "—" would read as unknown). */
export function balanceLabel(fils: number): string {
  return fils === 0 ? "0.00" : formatFils(fils);
}

// ------------------------------------------------------------------ grouping

export interface AccountGroups {
  budget: AccountBalanceSummary[];
  tracking: AccountBalanceSummary[];
}

/** Split into budget vs tracking, keeping server order inside each group. */
export function groupAccounts(rows: AccountBalanceSummary[]): AccountGroups {
  return {
    budget: rows.filter((a) => a.kind !== "tracking"),
    tracking: rows.filter((a) => a.kind === "tracking"),
  };
}

export interface BooksTotal {
  /** Sum of computed balances across every checked-in account (both kinds). */
  total_fils: number;
  /** Accounts contributing to the total. */
  counted: number;
  /** Accounts still awaiting their first check-in. */
  unanchored: number;
}

export function booksTotal(rows: AccountBalanceSummary[]): BooksTotal {
  let total = 0;
  let counted = 0;
  for (const a of rows) {
    if (!a.has_checkin) continue;
    total += a.computed_fils ?? 0;
    counted += 1;
  }
  return { total_fils: total, counted, unanchored: rows.length - counted };
}

// ----------------------------------------------------------------- freshness

/** Whole days between an instant's calendar day and now's (UTC), for "as of
 *  when?" labels. Same-day = 0; negative (future) clamps to 0. */
export function checkinAgeDays(iso: string, now: Date = new Date()): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return 0;
  const then = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.max(0, Math.round((today - then) / 86400000));
}

/** "today" / "yesterday" / "12d ago" / "Jun 2" (past ~a month, the date). */
export function agoLabel(iso: string, now: Date = new Date()): string {
  const d = checkinAgeDays(iso, now);
  if (d === 0) return "today";
  if (d === 1) return "yesterday";
  if (d <= 30) return `${d}d ago`;
  return shortDate(iso, now);
}

function txnPhrase(n: number): string {
  if (n === 0) return "no txns";
  return `${n} txn${n === 1 ? "" : "s"}`;
}

/** The row's right-hand meta: how fresh this balance's anchor is. */
export function rowMeta(a: AccountBalanceSummary, now: Date = new Date()): string {
  if (!a.has_checkin || !a.anchor_as_of) return "no check-in yet";
  const ago = agoLabel(a.anchor_as_of, now);
  if (a.kind === "tracking") return `updated ${ago}`;
  const n = a.txn_count ?? 0;
  return n > 0 ? `checked in ${ago} · ${txnPhrase(n)} since` : `checked in ${ago}`;
}

/** The detail screen's balance meta line. */
export function detailMeta(a: AccountBalanceSummary, now: Date = new Date()): string {
  if (!a.has_checkin || !a.anchor_as_of) return "";
  const when = agoLabel(a.anchor_as_of, now);
  if (a.kind === "tracking") return `updated ${when}`;
  return `anchor ${balanceLabel(a.anchor_fils ?? 0)} · checked in ${when} · ${txnPhrase(a.txn_count ?? 0)} since`;
}

// ----------------------------------------------------------- check-in result

export type CheckinVerdict = "first" | "match" | "less" | "more";

export function checkinVerdict(r: CheckinResult): CheckinVerdict {
  if (r.first_checkin) return "first";
  if (r.delta_fils === 0) return "match";
  return r.delta_fils < 0 ? "less" : "more";
}

/** Terse verdict title for the check-in result. */
export function verdictTitle(r: CheckinResult): string {
  switch (checkinVerdict(r)) {
    case "first":
      return "Starting balance set";
    case "match":
      return "Books match";
    case "less":
      return `Bank shows ${formatFils(-r.delta_fils)} less`;
    case "more":
      return `Bank shows ${formatFils(r.delta_fils)} more`;
  }
}

/** "expected 8,000.00 · stated 7,820.00 · 4 txns since Jul 1" */
export function checkinMeta(r: CheckinResult, now: Date = new Date()): string {
  const parts = [`expected ${balanceLabel(r.expected_fils)}`, `stated ${balanceLabel(r.stated_fils)}`];
  if (r.since) parts.push(`${txnPhrase(r.txn_count)} since ${shortDate(r.since, now)}`);
  return parts.join(" · ");
}

// ------------------------------------------------------- discrepancy causes

export type DiscrepancyCause =
  | { kind: "unparsed"; emails: UnparsedEmail[] }
  | { kind: "fx"; count: number }
  | { kind: "cash" };

/**
 * Candidate causes for a non-zero delta, most concrete first: retained emails
 * that produced no transaction, foreign rows awaiting an FX rate, then the
 * cash/ATM gap (always present — banks never email cash leaving a wallet).
 */
export function discrepancyCauses(r: CheckinResult): DiscrepancyCause[] {
  const out: DiscrepancyCause[] = [];
  if (r.unparsed.length > 0) out.push({ kind: "unparsed", emails: r.unparsed });
  if (r.unconverted_count > 0) out.push({ kind: "fx", count: r.unconverted_count });
  out.push({ kind: "cash" });
  return out;
}

export function fxHint(count: number): string {
  return `${count} foreign transaction${count === 1 ? "" : "s"} await an FX rate — they add nothing to the expected balance until a rate is set in Settings.`;
}

export function cashHint(r: CheckinResult): string {
  if (r.delta_fils < 0) {
    return `${formatFils(-r.delta_fils)} may have left as cash or ATM spending — banks don't email those.`;
  }
  return `${formatFils(r.delta_fils)} may be a deposit or refund that never emailed.`;
}

/** The one-tap action label: "Write 180.00 adjustment". */
export function adjustLabel(deltaFils: number): string {
  return `Write ${formatFils(Math.abs(deltaFils))} adjustment`;
}

// ------------------------------------------------------------- sparkline

export interface SparkPoint {
  as_of: string;
  balance_fils: number;
  /** 0..1 height fraction (geometry only, never money math). */
  h: number;
}

/**
 * Bars for the balance-history sparkline: newest-first wire history becomes
 * oldest→newest bars, heights normalized to the window's min..max range.
 * A flat history (or a single point) sits mid-height.
 */
export function sparklinePoints(history: BalancePoint[], max = 16): SparkPoint[] {
  const pts = history.slice(0, max).reverse();
  if (pts.length === 0) return [];
  let lo = pts[0].balance_fils;
  let hi = pts[0].balance_fils;
  for (const p of pts) {
    if (p.balance_fils < lo) lo = p.balance_fils;
    if (p.balance_fils > hi) hi = p.balance_fils;
  }
  const span = hi - lo;
  return pts.map((p) => ({
    as_of: p.as_of,
    balance_fils: p.balance_fils,
    h: span === 0 ? 0.5 : (p.balance_fils - lo) / span,
  }));
}

export interface SparkRange {
  lo_fils: number;
  hi_fils: number;
  /** Oldest as_of inside the window — "since Jun 2". */
  from: string;
}

/** Low/high/oldest caption for the sparkline — the visible text beside the
 *  aria-hidden bars, so colour/texture is never the sole carrier. */
export function sparkRange(history: BalancePoint[], max = 16): SparkRange | null {
  const pts = sparklinePoints(history, max);
  if (pts.length === 0) return null;
  let lo = pts[0].balance_fils;
  let hi = pts[0].balance_fils;
  for (const p of pts) {
    if (p.balance_fils < lo) lo = p.balance_fils;
    if (p.balance_fils > hi) hi = p.balance_fils;
  }
  return { lo_fils: lo, hi_fils: hi, from: pts[0].as_of };
}

/** "check-in" | "adjustment" for a balance point's source. */
export function sourceLabel(source: string): string {
  if (source === "checkin") return "check-in";
  if (source === "adjustment") return "adjustment";
  return source;
}
