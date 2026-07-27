import type { InputHTMLAttributes, SelectHTMLAttributes } from "react";
import type { PixelIconType } from "./PixelIcon";

// text-base (16px) is load-bearing: iOS Safari zooms the viewport onto any
// focused control whose font-size is below 16px. Never swap it for text-sm.
// `inset` (bg-surface-2) is for fields inside a Dialog, whose panel is
// already bg-surface; the default bg-surface is for fields on the page (bg-bg).
const BASE = "w-full min-h-11 py-2 pr-3 rounded-md border border-border text-base";
const bg = (inset: boolean) => (inset ? "bg-surface-2" : "bg-surface");

export function Input({ inset = false, icon: Icon, className = "", ...rest }:
  { inset?: boolean; icon?: PixelIconType; className?: string } & InputHTMLAttributes<HTMLInputElement>) {
  const control = (
    <input className={`${BASE} ${Icon ? "pl-9" : "pl-3"} ${bg(inset)} ${className}`} {...rest} />
  );
  if (!Icon) return control;
  return (
    <div className="relative">
      <Icon size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted pointer-events-none" aria-hidden />
      {control}
    </div>
  );
}

export function Select({ inset = false, className = "", children, ...rest }:
  { inset?: boolean; className?: string } & SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={`${BASE} pl-3 ${bg(inset)} ${className}`} {...rest}>
      {children}
    </select>
  );
}
