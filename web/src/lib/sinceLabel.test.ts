import { describe, it, expect } from "vitest";

import { sinceLabel } from "./sinceLabel";

const T = Date.parse("2026-08-07T12:00:00Z");

describe("sinceLabel", () => {
  it("says 'just now' under a minute, rather than '0 minutes ago'", () => {
    expect(sinceLabel(T, T)).toBe("just now");
    expect(sinceLabel(T, T + 59_000)).toBe("just now");
  });

  it("counts minutes, hours and days, singular and plural", () => {
    expect(sinceLabel(T, T + 60_000)).toBe("1 minute ago");
    expect(sinceLabel(T, T + 5 * 60_000)).toBe("5 minutes ago");
    expect(sinceLabel(T, T + 3_600_000)).toBe("1 hour ago");
    expect(sinceLabel(T, T + 5 * 3_600_000)).toBe("5 hours ago");
    expect(sinceLabel(T, T + 86_400_000)).toBe("1 day ago");
    expect(sinceLabel(T, T + 9 * 86_400_000)).toBe("9 days ago");
  });

  it("does not report a negative age when the clock has stepped backwards", () => {
    expect(sinceLabel(T, T - 120_000)).toBe("just now");
  });
});
