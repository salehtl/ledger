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
    <div className={`p-1 bg-surface-2 rounded-md gap-1 ${fullWidth ? "flex w-full" : "inline-flex"}`}>
      {options.map((o) => (
        <button
          key={o.value}
          aria-pressed={value === o.value}
          onClick={() => { fire("selection"); onChange(o.value); }}
          className={`rounded text-sm font-medium transition-colors press inline-flex items-center justify-center gap-1.5 whitespace-nowrap py-2 ${
            fullWidth ? "flex-1 min-w-0 px-2" : "px-4"
          } ${value === o.value ? "bg-surface text-fg shadow-1" : "text-muted hover:text-fg"}`}
        >
          {o.label}
          {o.badge != null && o.badge > 0 && (
            <span className="tnum text-[11px] font-semibold rounded-full bg-accent/15 text-accent px-1.5 min-w-4 text-center">
              {o.badge}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}
