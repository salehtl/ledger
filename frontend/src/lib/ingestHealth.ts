import type { IngestHealth } from "../api/types";

/** Compact relative time for health facts: "just now", "5m ago", "3h ago", "4d ago". */
export function relTime(iso: string | undefined, now: Date): string {
  if (!iso) return "never";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "never";
  const s = Math.max(0, Math.floor((now.getTime() - t) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

const dayWord = (n: number) => `${n} day${n === 1 ? "" : "s"}`;

/** One-line banner copy for a warn status; null when there is nothing to show.
 *  Hard failures (polls) outrank the soft mail-silence signal. */
export function bannerMessage(h: IngestHealth, now: Date): string | null {
  if (h.status !== "warn" || h.reasons.length === 0) return null;
  if (h.reasons.includes("polls_failing")) {
    return `Email checks failing (${h.consecutive_failures} in a row) — last success ${relTime(h.last_poll_success_at, now)}`;
  }
  if (h.reasons.includes("poll_stale")) {
    return `Email checks may be stuck — last success ${relTime(h.last_poll_success_at, now)}`;
  }
  return `No bank email in over ${dayWord(h.silence_days)} — check the forwarding rule`;
}

/** Plain-language explanation of one reason key, for the status page. */
export function reasonText(reason: string, h: IngestHealth): string {
  switch (reason) {
    case "polls_failing":
      return `Mailbox checks are failing (${h.consecutive_failures} in a row).`;
    case "poll_stale":
      return "No recent successful mailbox check — the worker may be stuck.";
    case "mail_silent":
      return `No bank email in over ${dayWord(h.silence_days)} — check the auto-forward rule.`;
    default:
      return reason;
  }
}

/** Stable key for "dismissed until the situation changes" banner state. */
export function dismissKey(reasons: string[]): string {
  return [...reasons].sort().join(",");
}

export function ingestStatusLabel(status: IngestHealth["status"]): string {
  switch (status) {
    case "ok": return "Healthy";
    case "warn": return "Warning";
    case "starting": return "Starting…";
    case "off": return "Off";
  }
}
