import { describe, expect, it } from "vitest";
import {
  adjustLabel,
  agoLabel,
  balanceLabel,
  booksTotal,
  cashHint,
  checkinAgeDays,
  checkinMeta,
  checkinVerdict,
  composeStated,
  detailMeta,
  discrepancyCauses,
  fxHint,
  groupAccounts,
  hasExplicitSign,
  parseBalanceFils,
  rowMeta,
  signedAmountText,
  sourceLabel,
  sparkRange,
  sparklinePoints,
  verdictTitle,
  type AccountBalanceSummary,
  type BalancePoint,
  type CheckinResult,
} from "./reconcile";

const NOW = new Date("2026-07-29T12:00:00Z");

function acct(over: Partial<AccountBalanceSummary> = {}): AccountBalanceSummary {
  return {
    account_id: 1,
    name: "ENBD Current",
    bank: "Emirates NBD",
    last4: "3921",
    kind: "budget",
    has_checkin: true,
    anchor_fils: 800000,
    anchor_as_of: "2026-07-25T10:00:00Z",
    anchor_source: "checkin",
    activity_since_fils: -55000,
    txn_count: 2,
    computed_fils: 745000,
    ...over,
  };
}

function result(over: Partial<CheckinResult> = {}): CheckinResult {
  return {
    account_id: 1,
    stated_fils: 745000,
    expected_fils: 745000,
    delta_fils: 0,
    since: "2026-07-25T10:00:00Z",
    txn_count: 2,
    unconverted_count: 0,
    first_checkin: false,
    balance_id: 9,
    unparsed: [],
    ...over,
  };
}

function point(over: Partial<BalancePoint> = {}): BalancePoint {
  return {
    id: 1,
    account_id: 1,
    as_of: "2026-07-25T10:00:00Z",
    balance_fils: 800000,
    source: "checkin",
    created_at: "2026-07-25T10:00:00Z",
    ...over,
  };
}

describe("parseBalanceFils", () => {
  it("parses plain, comma and decimal forms into integer fils", () => {
    expect(parseBalanceFils("8250")).toBe(825000);
    expect(parseBalanceFils("8,250")).toBe(825000);
    expect(parseBalanceFils("39.5")).toBe(3950);
    expect(parseBalanceFils("39.55")).toBe(3955);
    expect(parseBalanceFils(" 0.01 ")).toBe(1);
    expect(parseBalanceFils("0")).toBe(0);
  });

  it("accepts negatives: minus, unicode minus, accounting parens", () => {
    expect(parseBalanceFils("-120.40")).toBe(-12040);
    expect(parseBalanceFils("−120.40")).toBe(-12040);
    expect(parseBalanceFils("(1,234.56)")).toBe(-123456);
  });

  it("never returns -0", () => {
    expect(Object.is(parseBalanceFils("-0"), -0)).toBe(false);
    expect(parseBalanceFils("-0")).toBe(0);
  });

  it("rejects junk: letters, >2 decimals, empty, double sign", () => {
    expect(parseBalanceFils("12abc")).toBeNull();
    expect(parseBalanceFils("1.234")).toBeNull();
    expect(parseBalanceFils("")).toBeNull();
    expect(parseBalanceFils("--5")).toBeNull();
    expect(parseBalanceFils("(abc)")).toBeNull();
  });
});

describe("composeStated / hasExplicitSign", () => {
  it("applies the sign toggle when the text has no sign of its own", () => {
    expect(composeStated("500", "pos")).toBe(50000);
    expect(composeStated("500", "neg")).toBe(-50000);
  });

  it("a typed/pasted sign wins over the toggle", () => {
    expect(composeStated("-500", "pos")).toBe(-50000);
    expect(composeStated("(500)", "pos")).toBe(-50000);
    expect(hasExplicitSign("-500")).toBe(true);
    expect(hasExplicitSign("(500)")).toBe(true);
    expect(hasExplicitSign("500")).toBe(false);
  });

  it("propagates parse failure", () => {
    expect(composeStated("nope", "neg")).toBeNull();
  });
});

describe("amount text", () => {
  it("signedAmountText round-trips prefills including negatives", () => {
    expect(signedAmountText(825000)).toBe("8250");
    expect(signedAmountText(3955)).toBe("39.55");
    expect(signedAmountText(-12040)).toBe("-120.40");
    expect(signedAmountText(0)).toBe("0");
  });

  it("balanceLabel prints an explicit 0.00 at zero", () => {
    expect(balanceLabel(0)).toBe("0.00");
    expect(balanceLabel(123456)).toBe("1,234.56");
    expect(balanceLabel(-50000)).toBe("(500.00)");
  });
});

describe("grouping and totals", () => {
  const rows = [
    acct(),
    acct({ account_id: 2, name: "Card", kind: "budget", computed_fils: -20000 }),
    acct({ account_id: 3, name: "Sarwa", kind: "tracking", computed_fils: 5000000 }),
    acct({ account_id: 4, name: "New", has_checkin: false, computed_fils: undefined }),
  ];

  it("groups budget vs tracking in server order", () => {
    const g = groupAccounts(rows);
    expect(g.budget.map((a) => a.account_id)).toEqual([1, 2, 4]);
    expect(g.tracking.map((a) => a.account_id)).toEqual([3]);
  });

  it("booksTotal sums checked-in accounts only and counts the unanchored", () => {
    const t = booksTotal(rows);
    expect(t.total_fils).toBe(745000 - 20000 + 5000000);
    expect(t.counted).toBe(3);
    expect(t.unanchored).toBe(1);
  });
});

describe("freshness labels", () => {
  it("checkinAgeDays is day-granular in UTC", () => {
    expect(checkinAgeDays("2026-07-29T01:00:00Z", NOW)).toBe(0);
    expect(checkinAgeDays("2026-07-28T23:59:00Z", NOW)).toBe(1);
    expect(checkinAgeDays("2026-07-01T10:00:00Z", NOW)).toBe(28);
    expect(checkinAgeDays("2026-08-02T10:00:00Z", NOW)).toBe(0); // future clamps
  });

  it("agoLabel: today / yesterday / Nd ago / date past a month", () => {
    expect(agoLabel("2026-07-29T09:00:00Z", NOW)).toBe("today");
    expect(agoLabel("2026-07-28T09:00:00Z", NOW)).toBe("yesterday");
    expect(agoLabel("2026-07-24T09:00:00Z", NOW)).toBe("5d ago");
    expect(agoLabel("2026-06-02T09:00:00Z", NOW)).toBe("Jun 2");
  });

  it("rowMeta covers budget, tracking, zero-txn and never-checked-in", () => {
    expect(rowMeta(acct(), NOW)).toBe("checked in 4d ago · 2 txns since");
    expect(rowMeta(acct({ txn_count: 0 }), NOW)).toBe("checked in 4d ago");
    expect(rowMeta(acct({ kind: "tracking" }), NOW)).toBe("updated 4d ago");
    expect(rowMeta(acct({ has_checkin: false }), NOW)).toBe("no check-in yet");
  });

  it("detailMeta names the anchor and the window", () => {
    expect(detailMeta(acct(), NOW)).toBe("anchor 8,000.00 · checked in 4d ago · 2 txns since");
    expect(detailMeta(acct({ kind: "tracking" }), NOW)).toBe("updated 4d ago");
    expect(detailMeta(acct({ has_checkin: false }), NOW)).toBe("");
  });
});

describe("check-in verdicts", () => {
  it("classifies first / match / less / more", () => {
    expect(checkinVerdict(result({ first_checkin: true }))).toBe("first");
    expect(checkinVerdict(result())).toBe("match");
    expect(checkinVerdict(result({ delta_fils: -18000 }))).toBe("less");
    expect(checkinVerdict(result({ delta_fils: 5000 }))).toBe("more");
  });

  it("titles are terse and carry the magnitude", () => {
    expect(verdictTitle(result())).toBe("Books match");
    expect(verdictTitle(result({ delta_fils: -18000 }))).toBe("Bank shows 180.00 less");
    expect(verdictTitle(result({ delta_fils: 5000 }))).toBe("Bank shows 50.00 more");
    expect(verdictTitle(result({ first_checkin: true }))).toBe("Starting balance set");
  });

  it("checkinMeta lines up expected · stated · window", () => {
    expect(checkinMeta(result({ stated_fils: 727000, expected_fils: 745000 }), NOW)).toBe(
      "expected 7,450.00 · stated 7,270.00 · 2 txns since Jul 25",
    );
    expect(checkinMeta(result({ since: undefined, txn_count: 0 }), NOW)).toBe(
      "expected 7,450.00 · stated 7,450.00",
    );
  });
});

describe("discrepancy causes", () => {
  const email = { id: 88, received_at: "2026-07-27T09:00:00Z", from_addr: "alerts@bank.ae", subject: "Card alert" };

  it("orders unparsed → fx → cash, and cash is always present", () => {
    const causes = discrepancyCauses(
      result({ delta_fils: -18000, unparsed: [email], unconverted_count: 2 }),
    );
    expect(causes.map((c) => c.kind)).toEqual(["unparsed", "fx", "cash"]);
    expect(discrepancyCauses(result({ delta_fils: -18000 })).map((c) => c.kind)).toEqual(["cash"]);
  });

  it("hints speak plainly with amounts in words", () => {
    expect(cashHint(result({ delta_fils: -18000 }))).toContain("180.00 may have left as cash");
    expect(cashHint(result({ delta_fils: 4200 }))).toContain("42.00 may be a deposit or refund");
    expect(fxHint(1)).toContain("1 foreign transaction awaits an FX rate");
    expect(fxHint(3)).toContain("3 foreign transactions await an FX rate");
  });

  it("adjustLabel prints the absolute delta", () => {
    expect(adjustLabel(-18000)).toBe("Write 180.00 adjustment");
    expect(adjustLabel(4200)).toBe("Write 42.00 adjustment");
  });
});

describe("sparkline", () => {
  const history = [
    point({ id: 4, as_of: "2026-07-25T10:00:00Z", balance_fils: 800000 }),
    point({ id: 3, as_of: "2026-06-30T10:00:00Z", balance_fils: 600000 }),
    point({ id: 2, as_of: "2026-05-31T10:00:00Z", balance_fils: 700000 }),
    point({ id: 1, as_of: "2026-04-30T10:00:00Z", balance_fils: 400000 }),
  ];

  it("reverses newest-first history and normalizes min..max to 0..1", () => {
    const pts = sparklinePoints(history);
    expect(pts.map((p) => p.balance_fils)).toEqual([400000, 700000, 600000, 800000]);
    expect(pts[0].h).toBe(0);
    expect(pts[3].h).toBe(1);
    expect(pts[1].h).toBeCloseTo(0.75);
  });

  it("caps at max, keeping the newest points", () => {
    const pts = sparklinePoints(history, 2);
    expect(pts.map((p) => p.balance_fils)).toEqual([600000, 800000]);
  });

  it("flat or single history sits mid-height; empty stays empty", () => {
    expect(sparklinePoints([point()]).map((p) => p.h)).toEqual([0.5]);
    expect(sparklinePoints([point(), point({ id: 2 })]).map((p) => p.h)).toEqual([0.5, 0.5]);
    expect(sparklinePoints([])).toEqual([]);
  });

  it("sparkRange reports low/high and the window start", () => {
    const r = sparkRange(history)!;
    expect(r.lo_fils).toBe(400000);
    expect(r.hi_fils).toBe(800000);
    expect(r.from).toBe("2026-04-30T10:00:00Z");
    expect(sparkRange([])).toBeNull();
  });
});

describe("sourceLabel", () => {
  it("maps wire sources to display words", () => {
    expect(sourceLabel("checkin")).toBe("check-in");
    expect(sourceLabel("adjustment")).toBe("adjustment");
    expect(sourceLabel("other")).toBe("other");
  });
});
