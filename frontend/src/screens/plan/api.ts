// Piece-local data hooks for the Plan screen (v3 envelopes). Endpoints per
// docs/v3/api-contract.md §1–3. Every envelope mutation returns the fresh
// summary, which is written straight into the query cache — the screen's
// numbers move the moment the server answers, no follow-up fetch.
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { del, getJSON, postJSON } from "../../api/client";
import type {
  Allocation,
  Cadence,
  EnvelopeSummary,
  TargetType,
  UpcomingResponse,
} from "../../lib/envelope";

export const envelopesKey = (month: string) => ["envelopes", month] as const;

export function useEnvelopes(month: string) {
  return useQuery({
    queryKey: envelopesKey(month),
    queryFn: () => getJSON<EnvelopeSummary>(`/api/envelopes?month=${month}`),
  });
}

export function useUpcoming(days = 14) {
  return useQuery({
    queryKey: ["upcoming", days],
    queryFn: () => getJSON<UpcomingResponse>(`/api/upcoming?days=${days}`),
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

export interface AssignmentSet {
  category_id: number;
  assigned_fils: number;
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

export interface MoveBody {
  from_category_id: number;
  to_category_id: number;
  amount_fils: number;
}

/** POST /api/envelopes/move — atomic two-leg move. */
export function useMoveMoney(month: string) {
  const write = useWriteSummary();
  return useMutation({
    mutationFn: (body: MoveBody) => postJSON<EnvelopeSummary>("/api/envelopes/move", { month, ...body }),
    onSuccess: write,
  });
}

export interface AutoAssignResult {
  allocations: Allocation[];
  summary: EnvelopeSummary;
}

/** POST /api/envelopes/auto-assign — targets first, then 50/30/20 pro-rata. */
export function useAutoAssign(month: string) {
  const write = useWriteSummary();
  return useMutation({
    mutationFn: () => postJSON<AutoAssignResult>("/api/envelopes/auto-assign", { month }),
    onSuccess: (res) => write(res.summary),
  });
}

export interface TargetBody {
  target_type: TargetType;
  amount_fils: number;
  cadence: Cadence;
  due_date?: string;
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

// Plain calls for undo actions that live in toast closures and outlive their
// sheet: a mutation hook's callbacks are dropped once its component unmounts,
// which would leave even a *successful* undo unwritten to the cache.
export function moveMoneyOnce(month: string, body: MoveBody): Promise<EnvelopeSummary> {
  return postJSON<EnvelopeSummary>("/api/envelopes/move", { month, ...body });
}

export function assignEnvelopesOnce(month: string, assignments: AssignmentSet[]): Promise<EnvelopeSummary> {
  return postJSON<EnvelopeSummary>("/api/envelopes/assign", { month, assignments });
}

export function putTargetOnce(categoryId: number, body: TargetBody): Promise<unknown> {
  return postJSON(`/api/targets/${categoryId}`, body, "PUT");
}
