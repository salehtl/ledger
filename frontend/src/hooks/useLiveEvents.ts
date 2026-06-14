import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";

export const LIVE_INVALIDATE_KEYS = [["summary"], ["transactions"], ["review"]] as const;

export function useLiveEvents() {
  const qc = useQueryClient();
  useEffect(() => {
    const es = new EventSource("/api/events");
    const onEvent = () => {
      for (const key of LIVE_INVALIDATE_KEYS) {
        qc.invalidateQueries({ queryKey: [...key] });
      }
    };
    es.addEventListener("tx", onEvent);
    es.addEventListener("summary", onEvent);
    es.onerror = () => { /* EventSource auto-reconnects */ };
    return () => es.close();
  }, [qc]);
}
