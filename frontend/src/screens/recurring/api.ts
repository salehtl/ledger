// Piece-local data layer for the Recurring screen (v3 convention: hooks live
// beside the screen; only the shared fetch helpers come from api/client).
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { del, getJSON, postJSON } from "../../api/client";
import type { Category, Txn } from "../../api/types";
import type { ProvenanceInfo, SchedulePayload } from "../../lib/recurring";

/** Wire shape of GET /api/scheduled items (snake_case per the v3 contract). */
export interface Schedule {
  id: number;
  merchant: string;
  label: string;
  amount_fils: number;
  tolerance_pct: number;
  interval_days: number;
  next_due: string; // YYYY-MM-DD
  direction: string;
  category_id: number | null;
  account_id: number | null;
  source: "manual" | "detected";
  status: "proposed" | "active" | "paused" | "dismissed";
  last_matched_tx_id: number | null;
  last_matched_at?: string;
  last_amount_fils: number | null;
  missed: boolean;
  price_change: boolean;
  provenance?: ProvenanceInfo;
  created_at: string;
  updated_at: string;
}

export interface UpcomingItem extends Schedule {
  due_in_days: number;
}

export interface UpcomingResponse {
  days: number;
  items: UpcomingItem[];
}

export type ScheduleAction = "confirm" | "dismiss" | "pause";

// ---- fetchers (exported for test spying) ----------------------------------

export function getScheduled(): Promise<Schedule[]> {
  return getJSON<Schedule[]>("/api/scheduled");
}

export function getUpcoming(days: number): Promise<UpcomingResponse> {
  return getJSON<UpcomingResponse>(`/api/upcoming?days=${days}`);
}

export function getCategories(): Promise<Category[]> {
  return getJSON<Category[]>("/api/categories");
}

export function getAllTxns(): Promise<Txn[]> {
  return getJSON<Txn[]>("/api/transactions");
}

export function actOnSchedule(id: number, action: ScheduleAction): Promise<Schedule> {
  return postJSON<Schedule>(`/api/scheduled/${id}/${action}`, {});
}

export function createSchedule(payload: SchedulePayload): Promise<Schedule> {
  return postJSON<Schedule>("/api/scheduled", payload);
}

export function updateSchedule(id: number, payload: SchedulePayload): Promise<Schedule> {
  return postJSON<Schedule>(`/api/scheduled/${id}`, payload, "PUT");
}

export function deleteSchedule(id: number): Promise<void> {
  return del(`/api/scheduled/${id}`);
}

// ---- hooks ----------------------------------------------------------------

export function useSchedules() {
  return useQuery({ queryKey: ["scheduled"], queryFn: getScheduled });
}

export function useUpcoming(days: number) {
  return useQuery({ queryKey: ["upcoming", days], queryFn: () => getUpcoming(days) });
}

/** Same key + shape the rest of the app uses for the category inventory. */
export function useCategories() {
  return useQuery({ queryKey: ["categories"], queryFn: getCategories });
}

/** Full transaction list, indexed by id — resolves provenance tx_ids and
 *  last_matched_tx_id links without a per-id endpoint. Single-user volumes
 *  keep this cheap; it shares the fetch across both consumers via the key. */
export function useTxnIndex() {
  return useQuery({
    queryKey: ["recurring", "txn-index"],
    queryFn: getAllTxns,
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
    mutationFn: ({ id, action }: { id: number; action: ScheduleAction }) => actOnSchedule(id, action),
    onSuccess: invalidate,
  });
}

export function useCreateSchedule() {
  const invalidate = useInvalidateRecurring();
  return useMutation({
    mutationFn: (payload: SchedulePayload) => createSchedule(payload),
    onSuccess: invalidate,
  });
}

export function useUpdateSchedule() {
  const invalidate = useInvalidateRecurring();
  return useMutation({
    mutationFn: ({ id, payload }: { id: number; payload: SchedulePayload }) => updateSchedule(id, payload),
    onSuccess: invalidate,
  });
}

export function useDeleteSchedule() {
  const invalidate = useInvalidateRecurring();
  return useMutation({
    mutationFn: (id: number) => deleteSchedule(id),
    onSuccess: invalidate,
  });
}
