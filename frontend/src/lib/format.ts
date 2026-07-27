import type { Tone } from "../components/ui/Pill";

const STATUS_LABELS: Record<string, string> = {
  needs_review: "Needs review",
  confirmed: "Confirmed",
  transfer: "Transfer",
  ignored: "Ignored",
  archived: "Archived",
};

export function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status.charAt(0).toUpperCase() + status.slice(1);
}

/**
 * Only `needs_review` spends the app's one rationed red (the review badge —
 * see components/README.md). Every other status prints in ink or muted ink;
 * the label carries the meaning colour used to.
 */
export function statusTone(status: string): Tone {
  switch (status) {
    case "needs_review": return "attention";
    case "ignored": return "muted";
    case "archived": return "muted";
    default: return "default";
  }
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Compact posted-at label for list rows: "Jul 10" in the reference year,
 * "Jul 10, 2025" otherwise. Accepts an RFC3339 timestamp or a bare date; the
 * reference date is injectable so the year rule is testable without the clock.
 */
export function shortDate(iso: string, ref: Date = new Date()): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  const [, year, month, day] = m;
  const label = `${MONTHS[Number(month) - 1] ?? month} ${Number(day)}`;
  return Number(year) === ref.getFullYear() ? label : `${label}, ${year}`;
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
