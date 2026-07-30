// Piece-local data hooks for the Reports suite (v3). Endpoints per
// docs/v3/api-contract.md §5 plus the existing trend/transactions endpoints.
// Query keys reuse the app-wide families where they exist (["transactions",…])
// so SSE-driven invalidation keeps reports as live as every other surface.
import { useQuery } from "@tanstack/react-query";
import { getJSON } from "../../api/client";
import type { Category, MonthlyTotal } from "../../api/types";
import type {
  AgeOfMoney,
  IncomeExpenseResponse,
  NetWorthResponse,
  ReportTxn,
} from "../../lib/reports";
import { addMonth } from "../../lib/scope";
import { currentPeriod } from "../../lib/insights";
import { monthRange } from "../../lib/transactions";

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

export function useCategories() {
  return useQuery({
    queryKey: ["categories"],
    queryFn: () => getJSON<Category[]>("/api/categories"),
  });
}
