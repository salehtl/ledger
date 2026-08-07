import { describe, expect, it } from "vitest";
import {
  allocationsTotal,
  assignPreview,
  autoAssignMessage,
  claimShort,
  claimText,
  claimsByCategory,
  dueDateLabel,
  dueLabel,
  envelopeBar,
  filsToAmountText,
  groupByBucket,
  isEnveloped,
  isOverspent,
  monthProgress,
  monthTitle,
  movePreview,
  moveSources,
  moveSuggestionFils,
  neededLabel,
  nextUpcoming,
  nextUpcomingLabel,
  parseAmountFils,
  rtaDisplay,
  rtaMessage,
  shortfallFils,
  targetLabel,
  undoAssignments,
  type Envelope,
  type EnvelopeSummary,
  type EnvelopeTargetInfo,
  type UpcomingItem,
} from "./envelope";

function env(over: Partial<Envelope> = {}): Envelope {
  return {
    category_id: 1,
    category_name: "Groceries",
    bucket: "need",
    carryover_fils: 0,
    assigned_fils: 100000,
    activity_fils: 40000,
    available_fils: 60000,
    overspent: false,
    overspend_debt_fils: 0,
    ...over,
  };
}

function target(over: Partial<EnvelopeTargetInfo> = {}): EnvelopeTargetInfo {
  return {
    type: "set_aside",
    amount_fils: 50000,
    cadence: "monthly",
    needed_fils: 50000,
    still_needed_fils: 0,
    funded: true,
    ...over,
  };
}

describe("groupByBucket", () => {
  it("groups in need → want → saving order and drops empty buckets", () => {
    const groups = groupByBucket([
      env({ category_id: 3, bucket: "saving" }),
      env({ category_id: 1, bucket: "need" }),
      env({ category_id: 2, bucket: "want" }),
    ]);
    expect(groups.map((g) => g.bucket)).toEqual(["need", "want", "saving"]);
  });

  it("sums available across enveloped rows only — jar rows don't poison the total", () => {
    const groups = groupByBucket([
      env({ category_id: 1, available_fils: 60000 }),
      // jar row: never funded, wire available is 0 − activity
      env({ category_id: 2, assigned_fils: 0, activity_fils: 12000, available_fils: -12000 }),
    ]);
    expect(groups[0].available_fils).toBe(60000);
  });

  it("appends unknown buckets after the canonical three", () => {
    const groups = groupByBucket([
      env({ category_id: 1, bucket: "mystery" }),
      env({ category_id: 2, bucket: "need" }),
    ]);
    expect(groups.map((g) => g.bucket)).toEqual(["need", "mystery"]);
  });
});

describe("isEnveloped / isOverspent", () => {
  it("assignment, carryover, or overspend debt makes a row enveloped", () => {
    expect(isEnveloped(env())).toBe(true);
    expect(isEnveloped(env({ assigned_fils: 0, carryover_fils: 5000, available_fils: 5000 }))).toBe(true);
    expect(isEnveloped(env({ assigned_fils: 0, overspend_debt_fils: 100, available_fils: 0 }))).toBe(true);
  });

  it("a target alone is an intent, not money — still a jar row until funded", () => {
    expect(isEnveloped(env({ assigned_fils: 0, available_fils: 0, target: target() }))).toBe(false);
  });

  it("a never-funded category rides jar math — not enveloped, never overspent", () => {
    const jar = env({ assigned_fils: 0, activity_fils: 12000, available_fils: -12000, overspent: true });
    expect(isEnveloped(jar)).toBe(false);
    expect(isOverspent(jar)).toBe(false);
  });

  it("an enveloped row with negative available is overspent", () => {
    expect(isOverspent(env({ available_fils: -5000, overspent: true }))).toBe(true);
    expect(isOverspent(env())).toBe(false);
  });
});

describe("envelopeBar", () => {
  it("is null for jar rows", () => {
    expect(envelopeBar(env({ assigned_fils: 0, activity_fils: 500, available_fils: -500 }))).toBeNull();
  });

  it("measures spend against carryover + assigned", () => {
    const bar = envelopeBar(env({ carryover_fils: 20000, assigned_fils: 80000, activity_fils: 50000, available_fils: 50000 }));
    expect(bar!.pct).toBeCloseTo(0.5);
    expect(bar!.status).toBe("under");
  });

  it("negative available is always overbudget, whatever the pace", () => {
    const bar = envelopeBar(env({ activity_fils: 120000, available_fils: -20000, overspent: true }), 0.1);
    expect(bar!.status).toBe("overbudget");
  });

  it("spent to exactly zero is a full quiet bar, never an alarm", () => {
    const bar = envelopeBar(env({ assigned_fils: 400000, activity_fils: 400000, available_fils: 0 }), 0.5);
    expect(bar!.pct).toBe(1);
    expect(bar!.status).toBe("under");
  });

  it("past the pace marker reads over", () => {
    const bar = envelopeBar(env({ activity_fils: 80000, available_fils: 20000 }), 0.5);
    expect(bar!.status).toBe("over");
  });

  it("a target-only unfunded envelope gets no bar — the ask shows, not a red wall", () => {
    expect(envelopeBar(env({ assigned_fils: 0, activity_fils: 3000, available_fils: -3000, target: target() }))).toBeNull();
  });
});

describe("assignPreview", () => {
  it("recomputes available from an absolute assignment", () => {
    expect(assignPreview(env({ carryover_fils: 10000, activity_fils: 40000 }), 50000)).toBe(20000);
  });
});

describe("monthProgress", () => {
  it("fraction of the current month elapsed", () => {
    expect(monthProgress("2026-07", new Date(2026, 6, 31))).toBeCloseTo(1);
    expect(monthProgress("2026-02", new Date(2026, 1, 7))).toBeCloseTo(0.25);
  });
  it("undefined for finished or future months", () => {
    expect(monthProgress("2026-06", new Date(2026, 6, 15))).toBeUndefined();
    expect(monthProgress("2026-08", new Date(2026, 6, 15))).toBeUndefined();
  });
});

describe("labels", () => {
  it("monthTitle", () => {
    expect(monthTitle("2026-07")).toBe("Jul 2026");
  });

  it("targetLabel per type", () => {
    expect(targetLabel(target())).toBe("set aside 500.00/mo");
    expect(targetLabel(target({ type: "refill", cadence: "weekly" }))).toBe("refill to 500.00/wk");
    expect(targetLabel(target({ type: "save_by_date", amount_fils: 120000, due_date: "2026-12-01" })))
      .toBe("save 1,200.00 by Dec 2026");
  });

  it("dueDateLabel handles absence", () => {
    expect(dueDateLabel(undefined)).toBe("");
    expect(dueDateLabel("2027-01-15")).toBe("Jan 2027");
  });

  it("neededLabel: funded vs still needed", () => {
    expect(neededLabel(target())).toBe("funded");
    expect(neededLabel(target({ funded: false, still_needed_fils: 15000 }))).toBe("needs 150.00 more");
  });

  it("dueLabel bands", () => {
    expect(dueLabel(-3)).toBe("3d overdue");
    expect(dueLabel(0)).toBe("due today");
    expect(dueLabel(1)).toBe("due tomorrow");
    expect(dueLabel(5)).toBe("due in 5d");
  });
});

function bill(over: Partial<UpcomingItem> = {}): UpcomingItem {
  return {
    id: 1, merchant: "netflix.com", label: "Netflix", amount_fils: 3900,
    next_due: "2026-08-01", direction: "debit", category_id: 9, due_in_days: 2,
    ...over,
  };
}

describe("claims", () => {
  it("sums debit bills per category, tracking the soonest", () => {
    const claims = claimsByCategory([
      bill({ id: 1, due_in_days: 5 }),
      bill({ id: 2, merchant: "du.ae", label: "du", amount_fils: 20000, due_in_days: 2 }),
      bill({ id: 3, category_id: 4, amount_fils: 1000 }),
      bill({ id: 4, direction: "credit", amount_fils: 999999 }),  // not a claim
      bill({ id: 5, category_id: null }),                          // uncategorized: no envelope to claim
    ]);
    const c = claims.get(9)!;
    expect(c.total_fils).toBe(23900);
    expect(c.count).toBe(2);
    expect(c.soonest.label).toBe("du");
    expect(claims.get(4)!.total_fils).toBe(1000);
  });

  it("claimText: single vs multiple", () => {
    const one = claimsByCategory([bill()]).get(9)!;
    expect(claimText(one)).toBe("Netflix due in 2d · 39.00");
    const two = claimsByCategory([bill({ id: 1 }), bill({ id: 2, due_in_days: 6 })]).get(9)!;
    expect(claimText(two)).toBe("2 bills · 78.00 · next due in 2d");
  });

  it("falls back to the merchant when a schedule has no label", () => {
    const c = claimsByCategory([bill({ label: undefined })]).get(9)!;
    expect(claimText(c)).toContain("netflix.com");
  });

  it("claimShort: uncovered part of the claim, never negative", () => {
    const c = claimsByCategory([bill()]).get(9)!;
    expect(claimShort(c, 2000)).toBe(1900);
    expect(claimShort(c, 10000)).toBe(0);
    expect(claimShort(c, -5000)).toBe(3900); // negative available covers nothing
  });
});

describe("move money", () => {
  const groceries = env({ category_id: 1, category_name: "Groceries", available_fils: 60000 });
  const dining = env({ category_id: 2, category_name: "Dining out", available_fils: 30000 });
  const rent = env({ category_id: 3, category_name: "Rent", available_fils: 0 });
  const fuel = env({ category_id: 4, category_name: "Fuel", available_fils: -2000, overspent: true });

  it("sources: positive available only, destination excluded, most first", () => {
    const src = moveSources([rent, dining, groceries, fuel], 1);
    expect(src.map((e) => e.category_name)).toEqual(["Dining out"]);
    const src2 = moveSources([rent, dining, groceries, fuel], 3);
    expect(src2.map((e) => e.category_name)).toEqual(["Groceries", "Dining out"]);
  });

  it("shortfall: overspend first, then target ask, then bill claim", () => {
    expect(shortfallFils(fuel)).toBe(2000);
    expect(shortfallFils(env({ target: target({ funded: false, still_needed_fils: 12000 }) }))).toBe(12000);
    const claim = claimsByCategory([bill({ amount_fils: 90000 })]).get(9)!;
    expect(shortfallFils(env({ available_fils: 10000 }), claim)).toBe(80000);
    expect(shortfallFils(env())).toBe(0);
  });

  it("suggestion is the shortfall capped at what the source has", () => {
    expect(moveSuggestionFils(dining, fuel)).toBe(2000);
    expect(moveSuggestionFils(env({ available_fils: 500 }), fuel)).toBe(500);
    expect(moveSuggestionFils(dining, groceries)).toBe(0);
  });

  it("preview shifts available on both legs", () => {
    expect(movePreview(groceries, fuel, 2000)).toEqual({ from_after_fils: 58000, to_after_fils: 0 });
  });
});

describe("auto-assign", () => {
  const allocs = [
    { category_id: 1, amount_fils: 50000 },
    { category_id: 2, amount_fils: 25000 },
  ];

  it("totals and message", () => {
    expect(allocationsTotal(allocs)).toBe(75000);
    expect(autoAssignMessage(allocs)).toBe("Assigned 2 envelopes");
    expect(autoAssignMessage([{ category_id: 1, amount_fils: 100 }])).toBe("Assigned 1 envelope");
    expect(autoAssignMessage([])).toBe("Nothing to assign");
  });

  it("undoAssignments rolls each touched category back by its delta", () => {
    const after: EnvelopeSummary = {
      month: "2026-07", income_fils: 0, assigned_fils: 0, overspend_debt_fils: 0, ready_to_assign_fils: 0,
      envelopes: [
        env({ category_id: 1, assigned_fils: 150000 }),
        env({ category_id: 2, assigned_fils: 25000 }),
      ],
    };
    expect(undoAssignments(allocs, after)).toEqual([
      { category_id: 1, assigned_fils: 100000 },
      { category_id: 2, assigned_fils: 0 },
    ]);
  });
});

describe("RTA banner", () => {
  const s = (over: Partial<EnvelopeSummary>): EnvelopeSummary => ({
    month: "2026-07", income_fils: 2650000, assigned_fils: 0, overspend_debt_fils: 0,
    ready_to_assign_fils: 2650000, envelopes: [], ...over,
  });

  it("rtaDisplay prints an explicit zero", () => {
    expect(rtaDisplay(0)).toBe("0.00");
    expect(rtaDisplay(2650000)).toBe("26,500.00");
    expect(rtaDisplay(-20000)).toBe("(200.00)");
  });

  it("message per state", () => {
    expect(rtaMessage(s({}))).toContain("Auto-assign funds targets first");
    expect(rtaMessage(s({ ready_to_assign_fils: 0, assigned_fils: 2650000 }))).toBe("Every dirham assigned.");
    expect(rtaMessage(s({ ready_to_assign_fils: -20000 }))).toBe("Assigned 200.00 more than you have — move money back to zero.");
    expect(rtaMessage(s({ income_fils: 0, assigned_fils: 0, ready_to_assign_fils: 0 })))
      .toBe("Set your monthly income in Settings to start assigning.");
  });
});

describe("amount input", () => {
  it("parses dirham text to integer fils", () => {
    expect(parseAmountFils("150")).toBe(15000);
    expect(parseAmountFils("1,250.5")).toBe(125050);
    expect(parseAmountFils("39.55")).toBe(3955);
    expect(parseAmountFils(" 0 ")).toBe(0);
  });

  it("rejects junk", () => {
    expect(parseAmountFils("")).toBeNull();
    expect(parseAmountFils("-5")).toBeNull();
    expect(parseAmountFils("1.234")).toBeNull();
    expect(parseAmountFils("12abc")).toBeNull();
    expect(parseAmountFils(".")).toBeNull();
  });

  it("filsToAmountText round-trips cleanly", () => {
    expect(filsToAmountText(15000)).toBe("150");
    expect(filsToAmountText(3955)).toBe("39.55");
    expect(filsToAmountText(305)).toBe("3.05");
    expect(filsToAmountText(-100)).toBe("0");
  });
});

describe("nextUpcoming", () => {
  const item = (over: Partial<UpcomingItem>): UpcomingItem => ({
    id: 1, merchant: "NETFLIX", amount_fils: 3900, next_due: "2026-08-01",
    direction: "debit", category_id: null, due_in_days: 2, ...over,
  });

  it("is null with nothing upcoming", () => {
    expect(nextUpcoming([])).toBeNull();
  });
  it("prefers the soonest due", () => {
    expect(nextUpcoming([item({ id: 1, due_in_days: 5 }), item({ id: 2, due_in_days: 1 })])?.id).toBe(2);
  });
  it("puts a missed bill ahead of a sooner-due one", () => {
    expect(
      nextUpcoming([item({ id: 1, due_in_days: 0 }), item({ id: 2, missed: true, due_in_days: -3 })])?.id,
    ).toBe(2);
  });
  it("labels missed and future bills through dueLabel", () => {
    expect(nextUpcomingLabel(item({ due_in_days: -3 }))).toBe("NETFLIX 3d overdue");
    expect(nextUpcomingLabel(item({ label: "Netflix", due_in_days: 2 }))).toBe("Netflix due in 2d");
  });
});
