import { describe, it, expect } from "vitest";
import type { IngestHealth } from "../api/types";
import { relTime, bannerMessage, dismissKey, ingestStatusLabel, reasonText } from "./ingestHealth";

const NOW = new Date("2026-07-05T12:00:00Z");

function health(overrides: Partial<IngestHealth> = {}): IngestHealth {
  return {
    configured: true, count: 10, last_at: "2026-07-05T10:00:00Z",
    status: "warn", reasons: ["poll_stale"],
    last_poll_success_at: "2026-07-05T11:00:00Z",
    last_poll_attempt_at: "2026-07-05T11:59:00Z",
    consecutive_failures: 0, poll_interval_seconds: 60, silence_days: 3,
    ...overrides,
  };
}

describe("relTime", () => {
  it("formats seconds/minutes/hours/days", () => {
    expect(relTime("2026-07-05T11:59:30Z", NOW)).toBe("just now");
    expect(relTime("2026-07-05T11:55:00Z", NOW)).toBe("5m ago");
    expect(relTime("2026-07-05T09:00:00Z", NOW)).toBe("3h ago");
    expect(relTime("2026-07-01T12:00:00Z", NOW)).toBe("4d ago");
  });
  it("handles missing and invalid values", () => {
    expect(relTime(undefined, NOW)).toBe("never");
    expect(relTime("garbage", NOW)).toBe("never");
  });
});

describe("bannerMessage", () => {
  it("is null when not warning", () => {
    expect(bannerMessage(health({ status: "ok", reasons: [] }), NOW)).toBeNull();
  });
  it("prioritizes polls_failing over the rest", () => {
    const h = health({ reasons: ["poll_stale", "polls_failing"], consecutive_failures: 4 });
    expect(bannerMessage(h, NOW)).toContain("failing");
    expect(bannerMessage(h, NOW)).toContain("4");
  });
  it("describes staleness with the last success time", () => {
    expect(bannerMessage(health(), NOW)).toContain("1h ago");
  });
  it("describes mail silence with the threshold", () => {
    const h = health({ reasons: ["mail_silent"], silence_days: 3 });
    expect(bannerMessage(h, NOW)).toContain("3 days");
  });
});

describe("dismissKey", () => {
  it("is order-independent", () => {
    expect(dismissKey(["b", "a"])).toBe(dismissKey(["a", "b"]));
  });
  it("differs for different reason sets", () => {
    expect(dismissKey(["poll_stale"])).not.toBe(dismissKey(["poll_stale", "mail_silent"]));
  });
});

describe("labels", () => {
  it("maps statuses to human labels", () => {
    expect(ingestStatusLabel("ok")).toBe("Healthy");
    expect(ingestStatusLabel("warn")).toBe("Warning");
    expect(ingestStatusLabel("starting")).toBe("Starting…");
    expect(ingestStatusLabel("off")).toBe("Off");
  });
  it("spells out each reason", () => {
    const h = health({ consecutive_failures: 5, silence_days: 3 });
    expect(reasonText("polls_failing", h)).toContain("5");
    expect(reasonText("poll_stale", h).length).toBeGreaterThan(0);
    expect(reasonText("mail_silent", h)).toContain("3 day");
  });
});
