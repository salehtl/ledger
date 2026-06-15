import type { ButtonHTMLAttributes, ReactNode } from "react";
type Variant = "primary" | "secondary" | "ghost" | "danger";
const VARIANTS: Record<Variant, string> = {
  primary: "bg-accent text-accent-fg hover:opacity-90",
  secondary: "bg-surface border border-border text-fg hover:bg-bg",
  ghost: "bg-transparent text-fg hover:bg-bg",
  danger: "bg-bad text-white hover:opacity-90",
};
export function Button(
  { variant = "secondary", className = "", children, ...rest }:
  { variant?: Variant; children: ReactNode } & ButtonHTMLAttributes<HTMLButtonElement>,
) {
  return (
    <button
      className={`min-h-11 px-4 rounded-xl text-sm font-medium inline-flex items-center justify-center gap-2 disabled:opacity-50 ${VARIANTS[variant]} ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}
