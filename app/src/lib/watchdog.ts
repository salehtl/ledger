const DAY_MS = 86_400_000;
export const WATCHDOG_SYNC_STALE_MS = 2 * DAY_MS;
export const WATCHDOG_LIMITATION = "Checked when you open Ledger; iOS may not run this watchdog in the background.";

export interface WatchdogInput {
  readonly arrivals: readonly number[];
  readonly quarantinedArrivals?: readonly number[];
  readonly quarantineActionNeeded: number;
  readonly lastSuccessfulSyncAt: number | null;
  readonly now: number;
}

export interface WatchdogResult {
  readonly mail: "insufficient_history" | "normal" | "silent";
  readonly sync: "never" | "fresh" | "stale";
  readonly actionNeeded: boolean;
  readonly baselineIntervalMs: number | null;
  readonly silenceThresholdMs: number | null;
  readonly alerts: readonly ("mail_silent" | "quarantine" | "sync_stale")[];
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const hi = sorted[middle]!;
  return sorted.length % 2 ? hi : (sorted[middle - 1]! + hi) / 2;
}

export function evaluateWatchdog(input: WatchdogInput): WatchdogResult {
  const arrivals = [...input.arrivals, ...(input.quarantinedArrivals ?? [])]
    .filter((at) => Number.isFinite(at) && at <= input.now)
    .sort((a, b) => a - b);
  const intervals = arrivals.slice(1).map((at, index) => at - arrivals[index]!).filter((n) => n > 0);
  const baseline = intervals.length >= 3 ? median(intervals) : null;
  const threshold = baseline === null ? null : Math.max(3 * DAY_MS, 3 * baseline);
  const last = arrivals.at(-1);
  const mail = threshold === null || last === undefined
    ? "insufficient_history"
    : input.now - last > threshold ? "silent" : "normal";
  const sync = input.lastSuccessfulSyncAt === null
    ? "never"
    : input.now - input.lastSuccessfulSyncAt > WATCHDOG_SYNC_STALE_MS ? "stale" : "fresh";
  const alerts: ("mail_silent" | "quarantine" | "sync_stale")[] = [];
  if (mail === "silent") alerts.push("mail_silent");
  if (input.quarantineActionNeeded > 0) alerts.push("quarantine");
  if (sync === "stale") alerts.push("sync_stale");
  return {
    mail,
    sync,
    actionNeeded: alerts.length > 0,
    baselineIntervalMs: baseline,
    silenceThresholdMs: threshold,
    alerts,
  };
}
