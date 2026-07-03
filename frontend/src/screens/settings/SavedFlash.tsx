import { useCallback, useRef, useState } from "react";
import { Check } from "lucide-react";

/**
 * Autosave feedback. Call `flash()` after a change commits successfully; the
 * "Saved" cue shows for a beat, then fades. Repeated saves re-arm the timer.
 */
export function useSavedFlash(): { saved: boolean; flash: () => void } {
  const [saved, setSaved] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const flash = useCallback(() => {
    setSaved(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setSaved(false), 1600);
  }, []);
  return { saved, flash };
}

/** Quiet inline "Saved ✓" that a page shows when a field autosaves. */
export function SavedFlash({ saved }: { saved: boolean }) {
  return (
    <span
      role="status"
      aria-live="polite"
      className={`inline-flex items-center gap-1 text-xs font-medium text-good transition-opacity duration-300 motion-reduce:transition-none ${saved ? "opacity-100" : "opacity-0"}`}
    >
      {saved && (
        <>
          <Check size={13} aria-hidden /> Saved
        </>
      )}
    </span>
  );
}
