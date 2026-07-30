import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { createInvalidationScheduler } from "../lib/liveInvalidation";

// Prefix keys: invalidateQueries matches ["envelopes"] against ["envelopes", month].
// The v3 events (budget_threshold, upcoming_bill, missed_bill, schedule_detected)
// ride the same default SSE channel as transaction broadcasts, so one key list
// serves every event; only refetches of *active* queries actually fire.
export const LIVE_INVALIDATE_KEYS = [
  ["summary"], ["transactions"], ["review"], ["insights-categories"], ["insights-trend"], ["categorize-status"],
  ["envelopes"], ["upcoming"], ["scheduled"],
  ["accounts"], ["accounts-balances"], ["account-balance-history"],
  ["report-networth"], ["report-income-expense"], ["report-age-of-money"],
] as const;

export function useLiveEvents() {
  const qc = useQueryClient();
  useEffect(() => {
    const es = new EventSource("/api/events");
    // Bulk operations emit one SSE message per transaction; invalidating all
    // keys per message refetches every active query N times on the phone.
    // Coalesce bursts: flush once shortly after the burst ends, with a
    // max-wait so a long import still repaints every couple of seconds.
    const scheduler = createInvalidationScheduler(() => {
      for (const key of LIVE_INVALIDATE_KEYS) {
        qc.invalidateQueries({ queryKey: [...key] });
      }
    });
    // The backend broadcasts transaction payloads as the default (unnamed) SSE
    // event — only the keepalive is a named "heartbeat" event. So we listen on
    // "message" (the default), NOT on named "tx"/"summary" events, which the
    // backend never emits. Drift alerts carry no view data, so we skip them.
    const onMessage = (e: MessageEvent) => {
      let type = "";
      try { type = (JSON.parse(e.data) as { type?: string })?.type ?? ""; } catch { /* non-JSON / heartbeat */ }
      if (type === "drift_alert") return;
      scheduler.schedule();
    };
    es.addEventListener("message", onMessage);
    es.onerror = () => { /* EventSource auto-reconnects */ };
    return () => {
      scheduler.cancel();
      es.close();
    };
  }, [qc]);
}
