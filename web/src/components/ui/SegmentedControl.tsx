import { fire } from "../../lib/feedback";
import { Pressable } from "./Pressable";

export function SegmentedControl<T extends string>({
  value, onChange, options, fullWidth = false,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string; badge?: number }[];
  /** Stretch to fill the row with equal-width segments (page-level status filter).
   *  Segments never wrap; labels stay on one line. */
  fullWidth?: boolean;
}) {
  return (
    // Tighter chrome when full-width: with six equal segments at 320px the
    // 4px padding and gaps ate enough room to leave each one 43px, a pixel
    // under the minimum. The segments are contiguous and the active fill
    // already separates them, so the gap was doing little work.
    <div
      className={`bg-surface-2 rounded-[var(--radius)] ${
        fullWidth ? "flex w-full gap-0.5 p-0.5" : "inline-flex gap-1 p-1"
      }`}
    >
      {options.map((o) => (
        <Pressable
          key={o.value}
          // Explicit: without it these are submit buttons, and a segmented
          // control inside a form would submit it on every segment tap.
          // (Pressable already defaults to type="button" — this comment is
          // kept here because that is the reason the default matters.)
          aria-pressed={value === o.value}
          onClick={() => { fire("selection"); onChange(o.value); }}
          // min-h-11: this is a page-level control, so it takes the standard
          // 44px target. The 36px allowance is only for dense stacked rows.
          //
          // min-w-11 on the auto-width branch: `px-4` alone sizes a segment to
          // its text, so a single-glyph label lands under the minimum — the
          // +/- sign toggle in BalanceField measured 40x44 and 39x44. Longer
          // labels already clear 44px, so this only ever widens the short ones.
          // The full-width branch keeps `min-w-0` deliberately: its segments
          // divide a fixed row and must be allowed to shrink (see above).
          className={`rounded-[var(--radius)] text-sm font-medium transition-colors inline-flex min-h-11 items-center justify-center gap-1.5 py-2 ${
            fullWidth ? "flex-1 min-w-0 px-2" : "min-w-11 px-4"
          } ${value === o.value ? "bg-surface text-fg" : "text-muted hover:text-fg"}`}
        >
          {/* Truncates rather than pushing the badge out of the control when a
              label is longer than its equal-width segment. */}
          <span className="min-w-0 truncate">{o.label}</span>
          {o.badge != null && o.badge > 0 && (
            <span className="tnum text-[11px] font-semibold rounded-[var(--radius)] bg-accent/15 text-fg px-1.5 min-w-4 shrink-0 text-center">
              {o.badge}
            </span>
          )}
        </Pressable>
      ))}
    </div>
  );
}
