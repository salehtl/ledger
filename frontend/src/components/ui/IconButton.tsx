// frontend/src/components/ui/IconButton.tsx
import type { ButtonHTMLAttributes, MouseEvent, ReactNode } from "react";
import { fire } from "../../lib/feedback";

type Size = "md" | "sm";
type Tone = "muted" | "accent" | "danger";

const SIZES: Record<Size, string> = {
  md: "min-w-11 min-h-11", // 44px — the default touch target (Apple HIG)
  sm: "w-9 h-9",           // 36px — ONLY inside dense stacked rows (CategoryManager)
};
const TONES: Record<Tone, string> = {
  muted: "text-muted hover:bg-surface-2",
  accent: "text-accent hover:bg-surface-2",
  danger: "text-muted hover:text-bad active:text-bad",
};

/** Icon-only button. `label` is required — it is the accessible name.
 *  `size="sm"` (36px) is for dense stacked rows only (e.g. CategoryManager). */
export function IconButton(
  { label, size = "md", tone = "muted", className = "", children, onClick, ...rest }:
  { label: string; size?: Size; tone?: Tone; className?: string; children: ReactNode }
    & ButtonHTMLAttributes<HTMLButtonElement>,
) {
  const handleClick = (e: MouseEvent<HTMLButtonElement>) => {
    fire("selection");
    onClick?.(e);
  };
  return (
    <button
      type="button"
      aria-label={label}
      className={`inline-flex items-center justify-center rounded-lg transition-colors press disabled:opacity-30 disabled:cursor-not-allowed ${SIZES[size]} ${TONES[tone]} ${className}`}
      onClick={handleClick}
      {...rest}
    >
      {children}
    </button>
  );
}
