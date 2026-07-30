import { describe, expect, it } from "vitest";
import {
  buildSchedulePayload,
  cadenceLabel,
  daysUntil,
  dueLabel,
  graceDays,
  intervalChoice,
  priceChangeLine,
  provenanceLine,
  recentlyPaid,
  scheduleName,
  splitUpcoming,
  upcomingDebitTotal,
  type ScheduleFormInput,
} from "./recurring";

describe("cadenceLabel", () => {
  it("names the canonical cadences", () => {
    expect(cadenceLabel(7)).toBe("every week");
    expect(cadenceLabel(14)).toBe("every 2 weeks");
    expect(cadenceLabel(30)).toBe("every month");
    expect(cadenceLabel(91)).toBe("every 3 months");
    expect(cadenceLabel(365)).toBe("every year");
  });
  it("falls back to literal days", () => {
    expect(cadenceLabel(45)).toBe("every 45 days");
  });
});

describe("provenanceLine", () => {
  it("phrases the mined evidence", () => {
    const p = { count: 6, avg_interval_days: 30, last_amounts_fils: [3900], tx_ids: [1] };
    expect(provenanceLine(p, 3900)).toBe("seen 6× every ~30 days at 39.00");
  });
  it("keeps thousands separators from the fils formatter", () => {
    const p = { count: 3, avg_interval_days: 30, last_amounts_fils: [], tx_ids: [] };
    expect(provenanceLine(p, 650000)).toBe("seen 3× every ~30 days at 6,500.00");
  });
});

describe("dueLabel", () => {
  it("counts down", () => {
    expect(dueLabel(0)).toBe("due today");
    expect(dueLabel(1)).toBe("due tomorrow");
    expect(dueLabel(5)).toBe("due in 5 days");
  });
  it("counts overdue up, with singular/plural", () => {
    expect(dueLabel(-1)).toBe("1 day overdue");
    expect(dueLabel(-4)).toBe("4 days overdue");
  });
});

describe("graceDays", () => {
  it("mirrors the server: interval/10 clamped 2..7 with integer division", () => {
    expect(graceDays(7)).toBe(2);    // 0 -> clamp up
    expect(graceDays(30)).toBe(3);
    expect(graceDays(49)).toBe(4);   // floor(4.9)
    expect(graceDays(91)).toBe(7);   // 9 -> clamp down
    expect(graceDays(365)).toBe(7);
  });
});

describe("daysUntil", () => {
  it("handles future, past, and same day", () => {
    expect(daysUntil("2026-08-01", "2026-07-29")).toBe(3);
    expect(daysUntil("2026-07-25", "2026-07-29")).toBe(-4);
    expect(daysUntil("2026-07-29", "2026-07-29")).toBe(0);
  });
  it("accepts RFC3339 instants by truncating to the date", () => {
    expect(daysUntil("2026-08-01T09:12:00Z", "2026-07-29")).toBe(3);
  });
  it("crosses month boundaries without drift", () => {
    expect(daysUntil("2026-08-02", "2026-06-30")).toBe(33);
  });
  it("degrades to 0 on garbage", () => {
    expect(daysUntil("not-a-date", "2026-07-29")).toBe(0);
  });
});

describe("scheduleName", () => {
  it("prefers the label, falls back to merchant", () => {
    expect(scheduleName({ label: "Netflix", merchant: "netflix.com" })).toBe("Netflix");
    expect(scheduleName({ label: "", merchant: "netflix.com" })).toBe("netflix.com");
  });
});

describe("priceChangeLine", () => {
  it("explains the drift", () => {
    expect(priceChangeLine({ price_change: true, last_amount_fils: 4200, amount_fils: 3900 }))
      .toBe("last charge 42.00 — expected 39.00");
  });
  it("stays quiet when not flagged, unmatched, or equal", () => {
    expect(priceChangeLine({ price_change: false, last_amount_fils: 4200, amount_fils: 3900 })).toBeNull();
    expect(priceChangeLine({ price_change: true, last_amount_fils: null, amount_fils: 3900 })).toBeNull();
    expect(priceChangeLine({ price_change: true, last_amount_fils: 3900, amount_fils: 3900 })).toBeNull();
  });
});

describe("splitUpcoming", () => {
  it("partitions overdue from due, preserving order", () => {
    const items = [{ due_in_days: -3 }, { due_in_days: -1 }, { due_in_days: 0 }, { due_in_days: 4 }];
    const { overdue, due } = splitUpcoming(items);
    expect(overdue.map((i) => i.due_in_days)).toEqual([-3, -1]);
    expect(due.map((i) => i.due_in_days)).toEqual([0, 4]);
  });
});

describe("upcomingDebitTotal", () => {
  it("sums debits only", () => {
    expect(upcomingDebitTotal([
      { direction: "debit", amount_fils: 3900 },
      { direction: "credit", amount_fils: 2_650_000 },
      { direction: "debit", amount_fils: 2399 },
    ])).toBe(6299);
  });
});

describe("recentlyPaid", () => {
  const base = { status: "active", last_matched_tx_id: 9 };
  it("keeps active schedules matched within the window, most recent first", () => {
    const rows = [
      { ...base, id: 1, last_matched_at: "2026-07-25T07:00:00Z" },
      { ...base, id: 2, last_matched_at: "2026-07-28T07:00:00Z" },
      { ...base, id: 3, last_matched_at: "2026-07-01T07:00:00Z" }, // too old
      { ...base, id: 4, status: "paused", last_matched_at: "2026-07-28T07:00:00Z" },
      { ...base, id: 5, last_matched_at: undefined },
    ];
    expect(recentlyPaid(rows, "2026-07-29").map((r: { id: number }) => r.id)).toEqual([2, 1]);
  });
  it("ignores future-dated matches", () => {
    const rows = [{ ...base, id: 1, last_matched_at: "2026-08-02T07:00:00Z" }];
    expect(recentlyPaid(rows, "2026-07-29")).toEqual([]);
  });
});

describe("intervalChoice", () => {
  it("maps canonical intervals to their choice and everything else to custom", () => {
    expect(intervalChoice(30)).toBe("30");
    expect(intervalChoice(365)).toBe("365");
    expect(intervalChoice(45)).toBe("custom");
  });
});

describe("buildSchedulePayload", () => {
  const good: ScheduleFormInput = {
    merchant: "Gym Co",
    label: "Gym membership",
    amountAed: "250",
    intervalChoice: "30",
    customDays: "",
    nextDue: "2026-08-05",
    direction: "debit",
    categoryId: 5,
  };

  it("projects a valid form onto the wire body in integer fils", () => {
    const res = buildSchedulePayload(good);
    expect(res).toEqual({
      ok: true,
      payload: {
        merchant: "Gym Co",
        label: "Gym membership",
        amount_fils: 25000,
        interval_days: 30,
        next_due: "2026-08-05",
        direction: "debit",
        category_id: 5,
      },
    });
  });

  it("rounds fractional dirhams to fils", () => {
    const res = buildSchedulePayload({ ...good, amountAed: "39.999" });
    expect(res.ok && res.payload.amount_fils).toBe(4000);
  });

  it("uses the custom day count when chosen", () => {
    const res = buildSchedulePayload({ ...good, intervalChoice: "custom", customDays: "45" });
    expect(res.ok && res.payload.interval_days).toBe(45);
  });

  it("rejects a blank merchant", () => {
    expect(buildSchedulePayload({ ...good, merchant: "  " }))
      .toEqual({ ok: false, error: "Enter a name or merchant." });
  });

  it("rejects a non-positive or garbage amount", () => {
    expect(buildSchedulePayload({ ...good, amountAed: "0" }).ok).toBe(false);
    expect(buildSchedulePayload({ ...good, amountAed: "abc" }).ok).toBe(false);
  });

  it("rejects a bad custom interval", () => {
    expect(buildSchedulePayload({ ...good, intervalChoice: "custom", customDays: "0" }).ok).toBe(false);
    expect(buildSchedulePayload({ ...good, intervalChoice: "custom", customDays: "2.5" }).ok).toBe(false);
  });

  it("rejects a malformed date and a bad direction", () => {
    expect(buildSchedulePayload({ ...good, nextDue: "05-08-2026" }).ok).toBe(false);
    expect(buildSchedulePayload({ ...good, direction: "sideways" }).ok).toBe(false);
  });

  it("passes a null category through (uncategorized is allowed)", () => {
    const res = buildSchedulePayload({ ...good, categoryId: null });
    expect(res.ok && res.payload.category_id).toBeNull();
  });
});
