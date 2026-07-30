import { fire } from "../../lib/feedback";

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
    <div className={`p-1 bg-surface-2 rounded-[var(--radius)] gap-1 ${fullWidth ? "flex w-full" : "inline-flex"}`}>
      {options.map((o) => (
        <button
          key={o.value}
          // Explicit: without it these are submit buttons, and a segmented
          // control inside a form would submit it on every segment tap.
          type="button"
          aria-pressed={value === o.value}
          onClick={() => { fire("selection"); onChange(o.value); }}
          // min-h-11: this is a page-level control, so it takes the standard
          // 44px target. The 36px allowance is only for dense stacked rows.
          className={`rounded-[var(--radius)] text-sm font-medium transition-colors press inline-flex min-h-11 items-center justify-center gap-1.5 py-2 ${
            fullWidth ? "flex-1 min-w-0 px-2" : "px-4"
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
        </button>
      ))}
    </div>
  );
}
