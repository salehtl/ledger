import { useQuery } from "@tanstack/react-query";
import { getJSON } from "../api/client";
import type { Health } from "../api/types";

/** Polls /api/health so the banner notices problems while the app is open.
 *  refetchOnWindowFocus (react-query default) covers the reopen case. */
export function useIngestHealth() {
  return useQuery({
    queryKey: ["health"],
    queryFn: () => getJSON<Health>("/api/health"),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
}
