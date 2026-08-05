import { describe, expect, test } from "bun:test";
import { evaluateWatchdog, WATCHDOG_SYNC_STALE_MS } from "./watchdog.ts";

const day = 86_400_000;

describe("watchdog", () => {
  test("detects silence against the user's daily baseline", () => {
    const now = 10 * day;
    const result = evaluateWatchdog({ arrivals: [0, day, 2 * day, 3 * day], quarantineActionNeeded: 0, lastSuccessfulSyncAt: now, now });
    expect(result.baselineIntervalMs).toBe(day);
    expect(result.mail).toBe("silent");
    expect(result.alerts).toContain("mail_silent");
  });

  test("does not flag a sparse-but-normal weekly user", () => {
    const result = evaluateWatchdog({ arrivals: [0, 7 * day, 14 * day, 21 * day], quarantineActionNeeded: 0, lastSuccessfulSyncAt: 30 * day, now: 30 * day });
    expect(result.silenceThresholdMs).toBe(21 * day);
    expect(result.mail).toBe("normal");
  });

  test("a quarantined arrival proves mail is arriving and remains action-needed", () => {
    const result = evaluateWatchdog({ arrivals: [0, day, 2 * day], quarantinedArrivals: [3 * day], quarantineActionNeeded: 1, lastSuccessfulSyncAt: 4 * day, now: 4 * day });
    expect(result.mail).toBe("normal");
    expect(result.alerts).toContain("quarantine");
    expect(result.actionNeeded).toBe(true);
  });

  test("reports stale and never-synced health separately", () => {
    const stale = evaluateWatchdog({ arrivals: [], quarantineActionNeeded: 0, lastSuccessfulSyncAt: 0, now: WATCHDOG_SYNC_STALE_MS + 1 });
    expect(stale.sync).toBe("stale");
    expect(stale.alerts).toContain("sync_stale");
    expect(evaluateWatchdog({ arrivals: [], quarantineActionNeeded: 0, lastSuccessfulSyncAt: null, now: 0 }).sync).toBe("never");
  });
});
