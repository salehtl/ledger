// Piece-local data hooks for the Accounts & reconcile flow. Endpoints per
// docs/v3/api-contract.md §4. Check-ins and adjustments invalidate rather
// than cache-write: the server owns the balance math (day-granular windows,
// AED convention), so a refetch is the only honest way to show it.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { del, getJSON, postJSON } from "../../api/client";
import type { AccountBalanceSummary, AccountKind, BalancePoint, CheckinResult } from "../../lib/reconcile";

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

export interface NewAccount {
  name: string;
  bank: string;
  last4: string;
  kind: AccountKind;
}

/** POST /api/accounts (+ PUT kind when tracking) — register an account. */
export function useCreateAccount() {
  const invalidate = useInvalidateAccount();
  return useMutation({
    mutationFn: async (a: NewAccount) => {
      const { id } = await postJSON<{ id: number }>("/api/accounts", {
        name: a.name,
        bank: a.bank,
        last4: a.last4,
      });
      if (a.kind === "tracking") await postJSON(`/api/accounts/${id}`, { kind: "tracking" }, "PUT");
      return id;
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
