import { describe, expect, test } from "bun:test";

import { canonicalTime } from "@ledger/client/wire/op.ts";

import {
  dayKey,
  dayLabel,
  isDayDraft,
  longDate,
  parseErrorCopy,
  provenanceLabel,
  shortDate,
  tierLabel,
  timeOfDay,
  withDay,
} from "./format.ts";

const TODAY = "2026-08-02T09:00:00.000Z";

describe("shortDate", () => {
  test("drops the year inside the reference year and keeps it outside", () => {
    expect(shortDate("2026-07-10T12:00:00.000Z", TODAY)).toBe("Jul 10");
    expect(shortDate("2025-07-10T12:00:00.000Z", TODAY)).toBe("Jul 10, 2025");
    expect(shortDate("2027-01-01T00:00:00.000Z", TODAY)).toBe("Jan 1, 2027");
  });

  test("the day is the UTC day of the instant, not a slice of the string", () => {
    // 2026-06-05T22:00-04:00 is the SIXTH in UTC. Slicing the string reads the
    // fifth and disagrees with `fingerprint`, which is what decides duplicates.
    expect(shortDate("2026-06-05T22:00:00-04:00", TODAY)).toBe("Jun 6");
    expect(dayKey("2026-06-05T22:00:00-04:00")).toBe("2026-06-06");
  });

  test("an unreadable timestamp is shown, not swallowed", () => {
    expect(shortDate("not a date", TODAY)).toBe("not a date");
    expect(dayKey("not a date")).toBe("");
  });
});

describe("dayLabel", () => {
  test("names today and yesterday, and dates everything else", () => {
    expect(dayLabel("2026-08-02T23:59:59.000Z", TODAY)).toBe("Today");
    expect(dayLabel("2026-08-01T00:00:00.000Z", TODAY)).toBe("Yesterday");
    expect(dayLabel("2026-07-31T00:00:00.000Z", TODAY)).toBe("Jul 31");
    expect(dayLabel("2025-12-31T00:00:00.000Z", TODAY)).toBe("Dec 31, 2025");
  });

  test("crosses a month and a year boundary correctly", () => {
    expect(dayLabel("2025-12-31T00:00:00.000Z", "2026-01-01T00:00:00.000Z")).toBe("Yesterday");
    expect(dayLabel("2026-02-28T00:00:00.000Z", "2026-03-01T00:00:00.000Z")).toBe("Yesterday");
    // 2028 is a leap year: the day before March 1 is February 29.
    expect(dayLabel("2028-02-29T00:00:00.000Z", "2028-03-01T00:00:00.000Z")).toBe("Yesterday");
  });
});

describe("longDate and timeOfDay", () => {
  test("spell the month and pad the clock", () => {
    expect(longDate("2026-07-10T04:05:00.000Z")).toBe("10 July 2026");
    expect(timeOfDay("2026-07-10T04:05:00.000Z")).toBe("04:05");
    expect(timeOfDay("2026-07-10T23:59:00.000Z")).toBe("23:59");
    expect(timeOfDay("nope")).toBe("");
  });
});

describe("withDay", () => {
  test("replaces the calendar day and keeps the time of day", () => {
    const out = withDay("2026-07-10T04:05:06.007Z", "2026-08-01");
    expect(out).toBe("2026-08-01T04:05:06.007Z");
    // And it is still a timestamp both executors accept.
    expect(canonicalTime(out)).toBe(out);
  });

  test("refuses a day that is not a real day, rather than rolling it over", () => {
    // Date.parse would read 2026-02-30 as March 2. An edit that silently moved
    // a transaction to a different month is exactly the class of silent wrong
    // answer parseInstantMs exists to refuse.
    expect(() => withDay("2026-07-10T04:05:06.007Z", "2026-02-30")).toThrow();
    expect(() => withDay("2026-07-10T04:05:06.007Z", "2026-13-01")).toThrow();
    expect(() => withDay("2026-07-10T04:05:06.007Z", "not-a-day")).toThrow();
  });

  test("refuses a base that is not already canonical", () => {
    expect(() => withDay("2026-07-10T04:05:06+04:00", "2026-08-01")).toThrow();
  });

  test("isDayDraft accepts only a complete day", () => {
    expect(isDayDraft("2026-08-01")).toBe(true);
    expect(isDayDraft("2026-08-1")).toBe(false);
    expect(isDayDraft("2026-08")).toBe(false);
    expect(isDayDraft("2026-02-30")).toBe(false);
    expect(isDayDraft("")).toBe(false);
  });
});

describe("provenance and tier copy", () => {
  test("provenance says who wrote the row, which is the §3.3 requirement", () => {
    expect(provenanceLabel("ingest")).toBe("From your inbox");
    expect(provenanceLabel("user")).toBe("Entered on a device");
  });

  test("tier names the extractor, and never claims one for an unparsed row", () => {
    expect(tierLabel("template", false)).toBe("Bank template");
    expect(tierLabel("heuristic", false)).toBe("Read by pattern");
    expect(tierLabel("none", false)).toBe("Entered by hand");
    expect(tierLabel("none", true)).toBe("Nothing could be read");
  });

  test("a parse-error token becomes a sentence, and an unknown one still prints", () => {
    expect(parseErrorCopy(null)).toBe("");
    expect(parseErrorCopy("no_amount")).toBe("No amount");
    expect(parseErrorCopy("some_future_reason")).toBe("Some future reason");
  });
});
