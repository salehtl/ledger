import type { ReactNode } from "react";
export type Tone = "good" | "warn" | "bad" | "muted" | "neutral";
const TONES: Record<Tone, string> = {
  good: "text-good bg-good/10",
  warn: "text-warn bg-warn/10",
  bad: "text-bad bg-bad/10",
  muted: "text-muted bg-muted/10",
  neutral: "text-accent bg-accent/10",
};
export function Pill({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium whitespace-nowrap ${TONES[tone]}`}>
      {children}
    </span>
  );
}
