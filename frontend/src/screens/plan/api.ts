// Piece-local data hooks for the Plan screen (v3 envelopes). Endpoints per
// docs/v3/api-contract.md §1–3. Every envelope mutation returns the fresh
// summary, which is written straight into the query cache — the screen's
// numbers move the moment the server answers, no follow-up fetch.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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

function useWriteSummary() {
  const qc = useQueryClient();
  return (summary: EnvelopeSummary) => qc.setQueryData(envelopesKey(summary.month), summary);
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

/** PUT /api/targets/{categoryId} — create or overwrite; envelope summary refetches. */
export function usePutTarget(month: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ categoryId, body }: { categoryId: number; body: TargetBody }) =>
      postJSON(`/api/targets/${categoryId}`, body, "PUT"),
    onSuccess: () => qc.invalidateQueries({ queryKey: envelopesKey(month) }),
  });
}

/** DELETE /api/targets/{categoryId} — idempotent. */
export function useDeleteTarget(month: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (categoryId: number) => del(`/api/targets/${categoryId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: envelopesKey(month) }),
  });
}
