import { describe, it, expect } from "vitest";
import { formatMuUSD, dollarsToMuUSD, muUSDToDollars } from "./aiCost";

describe("aiCost", () => {
  it("formats dollars", () => {
    expect(formatMuUSD(1_900_000)).toBe("$1.90");
    expect(formatMuUSD(190_000_000)).toBe("$190.00");
  });
  it("formats zero and sub-cent", () => {
    expect(formatMuUSD(0)).toBe("$0.00");
    expect(formatMuUSD(1047)).toBe("< $0.01"); // ~$0.001
  });
  it("converts dollars <-> muUSD", () => {
    expect(dollarsToMuUSD(5)).toBe(5_000_000);
    expect(dollarsToMuUSD(0.5)).toBe(500_000);
    expect(muUSDToDollars(2_500_000)).toBe(2.5);
  });
});
