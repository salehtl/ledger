// frontend/src/api/hooks.ts
//
// The shared react-query hooks and canonical query keys for the whole app,
// consolidated from the v3 piece-local api layers (scope §7). One rule above
// all: QUERY KEYS ARE CONTRACT. lib/liveInvalidation + hooks/useLiveEvents.ts
// invalidate by these exact key prefixes on every SSE event, so a renamed key
// silently goes dead to live updates — change keys only together with
// LIVE_INVALIDATE_KEYS in hooks/useLiveEvents.ts.
//
// Layering: plain fetch helpers and one-shot calls live in ./client; wire
// types in ./types; pure display/math helpers stay in lib/. Query/mutation
// functions here call getJSON/postJSON/del from ./client directly, which also
// lets tests stub the whole network by spying on those three helpers.
import { keepPreviousData, useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { del, getJSON, postJSON, renameMerchant } from "./client";
import type {
  AssignmentSet,
  AutoAssignResult,
  Category,
  MonthlyTotal,
  MoveBody,
  NewAccount,
  Schedule,
  ScheduleAction,
  TargetBody,
  Txn,
  UpcomingResponse,
} from "./types";
import type { EnvelopeSummary } from "../lib/envelope";
import type { SchedulePayload } from "../lib/recurring";
import type { AgeOfMoney, IncomeExpenseResponse, NetWorthResponse, ReportTxn } from "../lib/reports";
import type { AccountBalanceSummary, AccountKind, BalancePoint, CheckinResult } from "../lib/reconcile";
import type { ManualTxnPayload } from "../lib/transactions";
import type { SplitLineBody, TxnDepth } from "../lib/txSplit";
import type { DepthRule } from "../components/transactions/merchantRename";
import { addMonth } from "../lib/scope";
import { currentPeriod } from "../lib/insights";
import { monthRange } from "../lib/transactions";

// ---- shared inventories ----------------------------------------------------

/** The app-wide category inventory (one cache key across every screen). */
export function useCategories(enabled = true) {
  return useQuery({
    queryKey: ["categories"],
    queryFn: () => getJSON<Category[]>("/api/categories"),
    enabled,
  });
}

// ---- envelopes & targets (plan) --------------------------------------------
// Endpoints per docs/v3/api-contract.md §1–3. Every envelope mutation returns
// the fresh summary, which is written straight into the query cache — the
// screen's numbers move the moment the server answers, no follow-up fetch.

export const envelopesKey = (month: string) => ["envelopes", month] as const;

export function useEnvelopes(month: string) {
  return useQuery({
    queryKey: envelopesKey(month),
    queryFn: () => getJSON<EnvelopeSummary>(`/api/envelopes?month=${month}`),
  });
}

/** Write a fresh summary into its month's cache and mark every *other* cached
 *  month stale — assignments and moves ripple through carryover chains. */
export function writeSummary(qc: QueryClient, summary: EnvelopeSummary) {
  qc.setQueryData(envelopesKey(summary.month), summary);
  qc.invalidateQueries({ queryKey: ["envelopes"], predicate: (q) => q.queryKey[1] !== summary.month });
}

function useWriteSummary() {
  const qc = useQueryClient();
  return (summary: EnvelopeSummary) => writeSummary(qc, summary);
}

/** POST /api/envelopes/assign — absolute batch set. */
export function useAssignEnvelopes(month: string) {
  const write = useWriteSummary();
  return useMutation({
    mutationFn: (assignments: AssignmentSet[]) =>
      postJSON<EnvelopeSummary>("/api/envelopes/assign", { month, assignments }),
    onSuccess: write,
  });
}

/** POST /api/envelopes/move — atomic two-leg move. */
export function useMoveMoney(month: string) {
  const write = useWriteSummary();
  return useMutation({
    mutationFn: (body: MoveBody) => postJSON<EnvelopeSummary>("/api/envelopes/move", { month, ...body }),
    onSuccess: write,
  });
}

/** POST /api/envelopes/auto-assign — targets first, then 50/30/20 pro-rata. */
export function useAutoAssign(month: string) {
  const write = useWriteSummary();
  return useMutation({
    mutationFn: () => postJSON<AutoAssignResult>("/api/envelopes/auto-assign", { month }),
    onSuccess: (res) => write(res.summary),
  });
}

/** PUT /api/targets/{categoryId} — create or overwrite. A target changes the
 *  needed-this-month ask for every cached month, so invalidate the prefix. */
export function usePutTarget(_month: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ categoryId, body }: { categoryId: number; body: TargetBody }) =>
      postJSON(`/api/targets/${categoryId}`, body, "PUT"),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["envelopes"] }),
  });
}

/** DELETE /api/targets/{categoryId} — idempotent; prefix-invalidates like PUT. */
export function useDeleteTarget(_month: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (categoryId: number) => del(`/api/targets/${categoryId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["envelopes"] }),
  });
}

// ---- recurring schedules ---------------------------------------------------
// Confirm/dismiss/pause and edits invalidate both the inventory and the
// upcoming feed — every transition moves a bill between the two.

export function useSchedules() {
  return useQuery({ queryKey: ["scheduled"], queryFn: () => getJSON<Schedule[]>("/api/scheduled") });
}

/** GET /api/upcoming — shared by Plan (claims), Home (next-bill hint), and
 *  Recurring (the feed). Switching the 7/14/30d window is a daily-path filter
 *  change (P18): keep the previous window's rows on screen while the new one
 *  loads instead of letting the fresh key's isPending re-trigger the
 *  full-screen skeleton. (With a fixed `days` the placeholder never engages.) */
export function useUpcoming(days = 14) {
  return useQuery({
    queryKey: ["upcoming", days],
    queryFn: () => getJSON<UpcomingResponse>(`/api/upcoming?days=${days}`),
    placeholderData: keepPreviousData,
  });
}

/** Full transaction list, indexed by id — resolves provenance tx_ids and
 *  last_matched_tx_id links without a per-id endpoint. Single-user volumes
 *  keep this cheap, but the register is only fetched when the evidence sheet
 *  actually opens; the ["transactions", ...] key keeps it inside the app-wide
 *  ["transactions"] invalidations. */
export function useTxnIndex(enabled: boolean) {
  return useQuery({
    queryKey: ["transactions", "index"],
    queryFn: () => getJSON<Txn[]>("/api/transactions"),
    enabled,
    select: (rows: Txn[]) => {
      const byId = new Map<number, Txn>();
      for (const t of rows) byId.set(t.ID, t);
      return byId;
    },
  });
}

function useInvalidateRecurring() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ["scheduled"] });
    qc.invalidateQueries({ queryKey: ["upcoming"] });
  };
}

export function useScheduleAction() {
  const invalidate = useInvalidateRecurring();
  return useMutation({
    mutationFn: ({ id, action }: { id: number; action: ScheduleAction }) =>
      postJSON<Schedule>(`/api/scheduled/${id}/${action}`, {}),
    onSuccess: invalidate,
  });
}

export function useCreateSchedule() {
  const invalidate = useInvalidateRecurring();
  return useMutation({
    mutationFn: (payload: SchedulePayload) => postJSON<Schedule>("/api/scheduled", payload),
    onSuccess: invalidate,
  });
}

export function useUpdateSchedule() {
  const invalidate = useInvalidateRecurring();
  return useMutation({
    mutationFn: ({ id, payload }: { id: number; payload: SchedulePayload }) =>
      postJSON<Schedule>(`/api/scheduled/${id}`, payload, "PUT"),
    onSuccess: invalidate,
  });
}

export function useDeleteSchedule() {
  const invalidate = useInvalidateRecurring();
  return useMutation({
    mutationFn: (id: number) => del(`/api/scheduled/${id}`),
    onSuccess: invalidate,
  });
}

// ---- reports ---------------------------------------------------------------
// Endpoints per docs/v3/api-contract.md §5 plus the existing trend and
// transactions endpoints. Keys reuse the app-wide families where they exist
// (["transactions", …]) so SSE-driven invalidation keeps reports as live as
// every other surface.

export function useNetWorth(months = 12) {
  return useQuery({
    queryKey: ["report-networth", months],
    queryFn: () => getJSON<NetWorthResponse>(`/api/reports/networth?months=${months}`),
  });
}

export function useIncomeExpense(months = 12) {
  return useQuery({
    queryKey: ["report-income-expense", months],
    queryFn: () => getJSON<IncomeExpenseResponse>(`/api/reports/income-expense?months=${months}`),
  });
}

export function useAgeOfMoney() {
  return useQuery({
    queryKey: ["report-age-of-money"],
    queryFn: () => getJSON<AgeOfMoney>("/api/reports/age-of-money"),
  });
}

/** The existing trend endpoint driven to its full 24-month window. */
export function useTrend24() {
  return useQuery({
    queryKey: ["insights-trend", 24],
    queryFn: () => getJSON<MonthlyTotal[]>("/api/insights/trend?months=24"),
  });
}

/**
 * One transactions fetch covering the whole reports window (trailing
 * `months`, ending this month). Every drill-down and the age-of-money
 * sparkline filter this client-side, so tapping around the reports costs no
 * further requests. `enabled` gates it off until a surface actually needs it.
 */
export function useReportsWindowTxns(months = 24, enabled = true) {
  const to = currentPeriod();
  const from = addMonth(to, -(months - 1));
  const { to: toDay } = monthRange(to);
  return useQuery({
    queryKey: ["transactions", "reports-window", from, to],
    queryFn: () => getJSON<ReportTxn[]>(`/api/transactions?from=${from}-01&to=${toDay}`),
    enabled,
  });
}

// ---- accounts & reconcile --------------------------------------------------
// Endpoints per docs/v3/api-contract.md §4. Check-ins and adjustments
// invalidate rather than cache-write: the server owns the balance math
// (day-granular windows, AED convention), so a refetch is the only honest way
// to show it.

export const accountBalancesKey = ["accounts-balances"] as const;
export const balanceHistoryKey = (id: number) => ["account-balance-history", id] as const;

/** GET /api/accounts/balances — the whole accounts screen in one call. */
export function useAccountBalances() {
  return useQuery({
    queryKey: accountBalancesKey,
    queryFn: () => getJSON<AccountBalanceSummary[]>("/api/accounts/balances"),
  });
}

/** GET /api/accounts/{id}/balances — balance history, newest first. */
export function useBalanceHistory(accountId: number, limit = 16) {
  return useQuery({
    queryKey: [...balanceHistoryKey(accountId), limit],
    queryFn: () => getJSON<BalancePoint[]>(`/api/accounts/${accountId}/balances?limit=${limit}`),
  });
}

function useInvalidateAccount() {
  const qc = useQueryClient();
  return (accountId?: number) => {
    qc.invalidateQueries({ queryKey: accountBalancesKey });
    qc.invalidateQueries({ queryKey: ["accounts"] });
    if (accountId != null) qc.invalidateQueries({ queryKey: balanceHistoryKey(accountId) });
  };
}

/** POST /api/accounts/{id}/checkin — the 30-second reconcile. */
export function useCheckin(accountId: number) {
  const invalidate = useInvalidateAccount();
  return useMutation({
    mutationFn: (body: { stated_fils: number; note?: string }) =>
      postJSON<CheckinResult>(`/api/accounts/${accountId}/checkin`, { note: "", ...body }),
    onSuccess: () => invalidate(accountId),
  });
}

/** POST /api/accounts/{id}/adjust — write the delta off as a transaction. */
export function useAdjust(accountId: number) {
  const invalidate = useInvalidateAccount();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { delta_fils: number; note?: string }) =>
      postJSON<{ ok: boolean; transaction_id: number }>(`/api/accounts/${accountId}/adjust`, {
        note: "",
        ...body,
      }),
    onSuccess: () => {
      invalidate(accountId);
      // The adjustment is a real transaction — money surfaces must move too.
      qc.invalidateQueries({ queryKey: ["transactions"] });
      qc.invalidateQueries({ queryKey: ["summary"] });
    },
  });
}

/** POST /api/transactions — manual entry attributed to an account (the
 *  discrepancy card's third route; api-contract §4 `account_id`). */
export function useAddAccountTxn(accountId: number) {
  const invalidate = useInvalidateAccount();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: ManualTxnPayload & { account_id?: number }) =>
      postJSON("/api/transactions", payload),
    onSuccess: () => {
      invalidate(accountId);
      // A real transaction — money surfaces must move too.
      qc.invalidateQueries({ queryKey: ["transactions"] });
      qc.invalidateQueries({ queryKey: ["summary"] });
    },
  });
}

/** POST /api/accounts/{id}/balances — plain balance point (tracking update). */
export function usePostBalance(accountId: number) {
  const invalidate = useInvalidateAccount();
  return useMutation({
    mutationFn: (body: { balance_fils: number; note?: string }) =>
      postJSON<{ ok: boolean; id: number }>(`/api/accounts/${accountId}/balances`, {
        note: "",
        ...body,
      }),
    onSuccess: () => invalidate(accountId),
  });
}

/** PUT /api/accounts/{id} — flip budget ↔ tracking. */
export function useSetKind(accountId: number) {
  const invalidate = useInvalidateAccount();
  return useMutation({
    mutationFn: (kind: AccountKind) => postJSON(`/api/accounts/${accountId}`, { kind }, "PUT"),
    onSuccess: () => invalidate(accountId),
  });
}

/** POST /api/accounts (+ PUT kind when tracking) — register an account.
 *  The two-step is not atomic: if the kind PUT fails the account still
 *  exists, so resolve with the id and `kindApplied: false` — the caller can
 *  then say so instead of claiming nothing was added. */
export function useCreateAccount() {
  const invalidate = useInvalidateAccount();
  return useMutation({
    mutationFn: async (a: NewAccount): Promise<{ id: number; kindApplied: boolean }> => {
      const { id } = await postJSON<{ id: number }>("/api/accounts", {
        name: a.name,
        bank: a.bank,
        last4: a.last4,
      });
      if (a.kind !== "tracking") return { id, kindApplied: true };
      try {
        await postJSON(`/api/accounts/${id}`, { kind: "tracking" }, "PUT");
        return { id, kindApplied: true };
      } catch {
        return { id, kindApplied: false };
      }
    },
    onSuccess: () => invalidate(),
  });
}

/** DELETE /api/accounts/{id} — refused (409 "in use") once check-ins exist. */
export function useDeleteAccount() {
  const invalidate = useInvalidateAccount();
  return useMutation({
    mutationFn: (accountId: number) => del(`/api/accounts/${accountId}`),
    onSuccess: () => invalidate(),
  });
}

// ---- transaction depth: splits, notes, merchant clean-names ----------------
// Endpoints per docs/v3/api-contract.md §6.

/** Split lines move money between categories, so everything derived from
 *  category activity refetches — same set useTxnActions invalidates, plus
 *  envelopes (split lines feed envelope activity per the contract). */
function invalidateMoneyViews(qc: QueryClient) {
  for (const key of ["transactions", "summary", "review", "insights-categories", "insights-trend", "envelopes"]) {
    qc.invalidateQueries({ queryKey: [key] });
  }
}

/** PUT /api/transactions/{id}/splits — replace-set; [] un-splits. */
export function useSaveSplits() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ txnId, splits }: { txnId: number; splits: SplitLineBody[] }) =>
      postJSON(`/api/transactions/${txnId}/splits`, { splits }, "PUT"),
    onSuccess: () => invalidateMoneyViews(qc),
  });
}

/** PUT /api/transactions/{id}/note — user memo; "" clears. */
export function useSaveNote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ txnId, note }: { txnId: number; note: string }) =>
      postJSON(`/api/transactions/${txnId}/note`, { note }, "PUT"),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["transactions"] });
      qc.invalidateQueries({ queryKey: ["summary"] });
    },
  });
}

/** GET /api/rules — for resolving the rename target. Fetched lazily so the
 *  list screen never pays for it until a rename sheet opens. */
export function useRules(enabled: boolean) {
  return useQuery({
    queryKey: ["rules"],
    queryFn: () => getJSON<DepthRule[]>("/api/rules"),
    enabled,
  });
}

/** Mutation wrapper for renameMerchant (see ./client) with cache invalidation. */
export function useRenameMerchant() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ txn, rules, name }: { txn: TxnDepth; rules: DepthRule[]; name: string }) =>
      renameMerchant(txn, rules, name),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["transactions"] });
      qc.invalidateQueries({ queryKey: ["summary"] });
      qc.invalidateQueries({ queryKey: ["rules"] });
    },
  });
}
