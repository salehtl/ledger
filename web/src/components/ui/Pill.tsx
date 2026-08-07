import type { ReactNode } from "react";

/**
 * Small inline status badge. Colour no longer carries status — the label does.
 * Only `attention` spends the spot ink, and red is rationed app-wide, so use it
 * for the one status that should pull the eye (needs review), never for routine
 * states.
 */
export type Tone = "default" | "muted" | "attention";

const TONES: Record<Tone, string> = {
  default: "text-fg border border-border",
  muted: "text-muted border border-border",
  attention: "bg-accent text-accent-fg",
};

export function Pill({ tone = "default", children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center whitespace-nowrap rounded-[var(--radius)] px-2.5 py-1 text-xs font-medium ${TONES[tone]}`}>
      {children}
    </span>
  );
}
