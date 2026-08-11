/**
 * The third step of authoring: sync, then tell every screen to re-read.
 *
 * # Why authoring needs a third step at all
 *
 * A screen that authors does three durable things today: it queues ops on the
 * outbox (instant), it invalidates its own queries (instant, but re-reads the
 * OLD projection), and it flushes the outbox to the server (background, never
 * awaited — a deck that stalled on the network would be unusable). What
 * nothing did was fold: the projection every screen reads only moves when a
 * sync pulls the rows the server now holds and rewrites it, and the engine
 * syncs on launch, on `visibilitychange`, on pull-to-refresh — and, until this
 * file, on nothing else. So an edit made on one screen reached the others on
 * the next relaunch or pull, which read as "my changes don't show up".
 *
 * `settleAuthored` closes the loop from behind the flush: once the upload has
 * landed, run one background sync (the `"authored"` trigger — it joins any
 * sync already in flight, so a burst of swipes coalesces), then mark the
 * projection root stale so every mounted screen re-reads what the fold wrote.
 *
 * The invalidation runs even when the sync fails: an offline device still
 * wants its own screens re-reading the authored overlay, and the next
 * successful sync — whatever triggers it — settles the rest.
 */
import { useCallback } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";

import { useV2 } from "./BootGate";
import type { SyncTrigger } from "./engine";
import { invalidateAfterSync } from "./queries";

/** Sync (pull + fold what the server now holds), THEN re-read every projection query. */
export async function settleAuthored(
  run: (trigger: SyncTrigger) => Promise<void>,
  qc: QueryClient,
): Promise<void> {
  try {
    await run("authored");
  } catch {
    // The app-level gate never rejects; a raw coordinator can. Either way the
    // re-read below must still happen — the authored overlay is on this device.
  }
  await invalidateAfterSync(qc);
}

/**
 * `settleAuthored` bound to the runtime this tree renders under.
 *
 * With no v2 runtime (tests, the signed-out shell) it degrades to the
 * invalidation alone — there is no engine to fold, and the overlay is all
 * there is to show.
 */
export function useSettleAuthored(): () => Promise<void> {
  const qc = useQueryClient();
  const v2 = useV2();
  return useCallback(() => {
    if (v2 === null) return invalidateAfterSync(qc);
    return settleAuthored((trigger) => v2.sync.run(trigger), qc);
  }, [v2, qc]);
}
