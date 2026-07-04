import type { ButtonHTMLAttributes, MouseEvent, ReactNode } from "react";
import { fire } from "../../lib/haptics";
type Variant = "primary" | "secondary" | "ghost" | "danger";
const VARIANTS: Record<Variant, string> = {
  primary: "bg-accent text-accent-fg hover:opacity-90",
  secondary: "bg-surface-2 text-fg hover:opacity-80",   // Material tonal
  ghost: "bg-transparent text-accent hover:bg-surface-2",
  danger: "bg-bad text-bg hover:opacity-90",
};
export function Button(
  { variant = "secondary", className = "", children, onClick, ...rest }:
  { variant?: Variant; children: ReactNode } & ButtonHTMLAttributes<HTMLButtonElement>,
) {
  const handleClick = (e: MouseEvent<HTMLButtonElement>) => {
    fire("selection");
    onClick?.(e);
  };
  return (
    <button
      className={`min-h-11 px-5 rounded-lg text-sm font-medium inline-flex items-center justify-center gap-2 transition-colors press disabled:opacity-50 ${VARIANTS[variant]} ${className}`}
      onClick={handleClick}
      {...rest}
    >
      {children}
    </button>
  );
}
