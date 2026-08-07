import type { MouseEvent, ReactNode } from "react";
import { fire } from "../../lib/feedback";
import { Pressable, type PressableProps } from "./Pressable";
type Variant = "primary" | "secondary" | "ghost" | "danger";
const VARIANTS: Record<Variant, string> = {
  primary: "bg-accent text-accent-fg hover:opacity-90",
  secondary: "bg-surface-2 text-fg hover:opacity-80",   // Material tonal
  ghost: "bg-transparent text-fg hover:bg-surface-2",
  danger: "bg-accent text-accent-fg hover:opacity-90",
};
export function Button(
  { variant = "secondary", className = "", children, onClick, ...rest }:
  // PressableProps, not ButtonHTMLAttributes: motion's HTMLMotionProps
  // narrows a few DOM event handlers (onAnimationStart et al.) to its own
  // animation-aware signatures, and the native React type is not assignable
  // to those — this is the type Pressable itself actually accepts.
  { variant?: Variant; children: ReactNode } & PressableProps,
) {
  const handleClick = (e: MouseEvent<HTMLButtonElement>) => {
    fire("selection");
    onClick?.(e);
  };
  return (
    <Pressable
      className={`min-h-11 px-5 rounded-[var(--radius)] text-sm font-medium inline-flex items-center justify-center gap-2 transition-colors disabled:opacity-50 ${VARIANTS[variant]} ${className}`}
      onClick={handleClick}
      {...rest}
    >
      {children}
    </Pressable>
  );
}
