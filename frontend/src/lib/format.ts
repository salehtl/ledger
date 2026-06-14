const STATUS_LABELS: Record<string, string> = {
  needs_review: "Needs review",
  confirmed: "Confirmed",
  transfer: "Transfer",
  ignored: "Ignored",
};

export function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status.charAt(0).toUpperCase() + status.slice(1);
}

export type Tone = "good" | "warn" | "muted" | "neutral";

export function statusTone(status: string): Tone {
  switch (status) {
    case "confirmed": return "good";
    case "needs_review": return "warn";
    case "ignored": return "muted";
    default: return "neutral";
  }
}

/** AED has 2 minor units. Inputs are in dirhams; storage is in fils. */
export function dirhamsToFils(dirhams: number): number {
  return Math.round(dirhams * 100);
}
export function filsToDirhams(fils: number): number {
  return fils / 100;
}

/** Budget splits are stored as fractions (0.5) but shown as whole percents (50). */
export function fractionToPercent(fraction: number): number {
  return Math.round(fraction * 100);
}
export function percentToFraction(percent: number): number {
  return percent / 100;
}
