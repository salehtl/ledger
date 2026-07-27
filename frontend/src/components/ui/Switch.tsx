import type { InputHTMLAttributes } from "react";

/**
 * Toggle switch rendered over a real checkbox, so it keeps native semantics
 * (label association, checked/disabled, change events) for forms and tests.
 */
export function Switch({ className = "", ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <span className={`relative inline-block h-7 w-12 shrink-0 ${className}`}>
      <input
        type="checkbox"
        {...rest}
        className="peer absolute inset-0 z-10 m-0 h-full w-full cursor-pointer appearance-none rounded-[var(--radius)] disabled:cursor-default"
      />
      <span
        aria-hidden
        className="absolute inset-0 rounded-[var(--radius)] border border-border bg-surface-2 transition-colors duration-200 peer-checked:border-accent peer-checked:bg-accent peer-disabled:opacity-40 peer-focus-visible:ring-2 peer-focus-visible:ring-accent/50 peer-focus-visible:ring-offset-1"
      />
      <span
        aria-hidden
        className="absolute left-1 top-1 h-5 w-5 rounded-[var(--radius)] bg-surface transition-transform duration-200 motion-reduce:transition-none peer-checked:translate-x-5 peer-disabled:opacity-60"
      />
    </span>
  );
}
