import { useEffect, useState } from "react";
import { TriangleAlert, X } from "./ui/PixelIcon";
import { useIngestHealth } from "../hooks/useIngestHealth";
import { bannerMessage, dismissKey } from "../lib/ingestHealth";
import { IconButton } from "./ui/IconButton";

const STORAGE_KEY = "ingest-banner-dismissed";

/** App-wide warning strip, visible only when ingest looks broken. Dismissal
 *  sticks (sessionStorage) until the reason set changes or health recovers. */
export function IngestHealthBanner({ onView }: { onView: () => void }) {
  const { data } = useIngestHealth();
  const [dismissed, setDismissed] = useState<string | null>(
    () => sessionStorage.getItem(STORAGE_KEY),
  );
  const ih = data?.ingest;

  // Recovery clears the dismissal so the next (identical) warning shows again.
  useEffect(() => {
    if (ih && ih.status === "ok" && dismissed !== null) {
      sessionStorage.removeItem(STORAGE_KEY);
      setDismissed(null);
    }
  }, [ih, dismissed]);

  if (!ih || ih.status !== "warn") return null;
  const key = dismissKey(ih.reasons);
  if (dismissed === key) return null;
  const msg = bannerMessage(ih, new Date());
  if (!msg) return null;

  const dismiss = () => {
    sessionStorage.setItem(STORAGE_KEY, key);
    setDismissed(key);
  };

  return (
    <div role="alert" className="shrink-0 bg-warn/15 text-warn text-sm flex items-center gap-2 pl-3 pr-1">
      <TriangleAlert size={14} aria-hidden className="shrink-0" />
      <button aria-label="Ingest details" onClick={onView} className="flex-1 text-left py-1 truncate">
        {msg}
      </button>
      <IconButton label="Dismiss" size="sm" onClick={dismiss} className="shrink-0">
        <X size={14} aria-hidden />
      </IconButton>
    </div>
  );
}
