import type { PixelIconType } from "./PixelIcon";
import { fire } from "../../lib/feedback";
import { Pressable } from "./Pressable";

/**
 * The screen's single creation action: a square vermilion plate above the bottom
 * nav, flush to the 16px content margin. Deliberately not elevated — nothing in
 * this design floats. If it needs separating from content beneath it, that is a
 * layout problem, not an elevation problem.
 */
export function Fab({
  icon: Icon,
  label,
  onClick,
  over = "nav",
}: {
  icon: PixelIconType;
  label: string;
  onClick: () => void;
  /** What sits beneath this Fab. Full-screen drill-in panels (Recurring, and
   *  anything else hosted in a SettingsPage) cover the bottom nav, so reserving
   *  its height there leaves the plate hovering in mid-air over a row's amount. */
  over?: "nav" | "edge";
}) {
  return (
    <Pressable
      aria-label={label}
      onClick={() => { fire("selection"); onClick(); }}
      className={`fixed right-4 z-30 flex h-14 w-14 items-center justify-center rounded-[var(--radius)] bg-accent text-accent-fg hover:opacity-90 ${
        over === "nav"
          ? "bottom-[calc(env(safe-area-inset-bottom)+4.5rem)]"
          : "bottom-[max(1rem,env(safe-area-inset-bottom))]"
      }`}
    >
      <Icon size={24} aria-hidden />
    </Pressable>
  );
}
