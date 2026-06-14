import { describe, it, expect } from "vitest";
import { buildTxnQuery } from "./Transactions";

describe("buildTxnQuery", () => {
  it("omits empty filters", () => {
    expect(buildTxnQuery({ status: "", from: "", to: "" })).toBe("/api/transactions");
  });
  it("encodes provided filters", () => {
    expect(buildTxnQuery({ status: "confirmed", from: "2026-06-01", to: "2026-06-30" }))
      .toBe("/api/transactions?status=confirmed&from=2026-06-01&to=2026-06-30");
  });
});
