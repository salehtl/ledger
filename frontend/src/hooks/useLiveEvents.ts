import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";

export const LIVE_INVALIDATE_KEYS = [["summary"], ["transactions"], ["review"], ["insights-categories"], ["insights-trend"]] as const;

export function useLiveEvents() {
  const qc = useQueryClient();
  useEffect(() => {
    const es = new EventSource("/api/events");
    // The backend broadcasts transaction payloads as the default (unnamed) SSE
    // event — only the keepalive is a named "heartbeat" event. So we listen on
    // "message" (the default), NOT on named "tx"/"summary" events, which the
    // backend never emits. Drift alerts carry no view data, so we skip them.
    const onMessage = (e: MessageEvent) => {
      let type = "";
      try { type = (JSON.parse(e.data) as { type?: string })?.type ?? ""; } catch { /* non-JSON / heartbeat */ }
      if (type === "drift_alert") return;
      for (const key of LIVE_INVALIDATE_KEYS) {
        qc.invalidateQueries({ queryKey: [...key] });
      }
    };
    es.addEventListener("message", onMessage);
    es.onerror = () => { /* EventSource auto-reconnects */ };
    return () => es.close();
  }, [qc]);
}
