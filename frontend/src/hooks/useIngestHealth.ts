import { useQuery } from "@tanstack/react-query";
import { getJSON } from "../api/client";
import type { Health } from "../api/types";

/** Polls /api/health so the banner notices problems while the app is open.
 *  The app-wide query client disables refetchOnWindowFocus by default (to avoid
 *  refetching everything on every tab switch), so this hook opts back in
 *  explicitly to cover the reopen/refocus case for ingest health specifically. */
export function useIngestHealth() {
  return useQuery({
    queryKey: ["health"],
    queryFn: () => getJSON<Health>("/api/health"),
    refetchInterval: 60_000,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
}
