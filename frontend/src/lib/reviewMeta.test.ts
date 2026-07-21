import { describe, it, expect } from "vitest";
import { accountLabel, reviewReason } from "./reviewMeta";
import type { Txn } from "../api/types";

function txn(p: Partial<Txn>): Txn {
  return {
    ID: 1, PostedAt: "2026-07-03T10:00:00Z", AmountFils: 5000, AmountAedFils: 5000, Currency: "AED",
    Direction: "debit", MerchantRaw: "Carrefour", Status: "needs_review", Confidence: 0.97, Source: "email",
    CategoryID: null, CategoryName: "", Bucket: "", Kind: "", BucketSnapshot: "", RefundOfID: null,
    ...p,
  };
}

describe("accountLabel", () => {
  it("prefers the registered account name", () => {
    expect(accountLabel(txn({ Last4: "4821", AccountName: "Main current" }))).toBe("Main current");
  });

  it("falls back to masked last4 when unregistered", () => {
    expect(accountLabel(txn({ Last4: "4821" }))).toBe("···4821");
  });

  it("returns null when the email carried no account digits", () => {
    expect(accountLabel(txn({}))).toBeNull();
    expect(accountLabel(txn({ Last4: "" }))).toBeNull();
  });
});

describe("reviewReason", () => {
  it("labels imported rows", () => {
    expect(reviewReason(txn({ Source: "import" }))).toBe("Imported from a file");
  });

  it("labels manual rows", () => {
    expect(reviewReason(txn({ Source: "manual" }))).toBe("Added manually");
  });

  it("labels confident email parses as a new merchant", () => {
    expect(reviewReason(txn({ Source: "email", Confidence: 0.97 }))).toBe("New merchant");
  });

  it("flags loosely-extracted email parses for a double-check", () => {
    expect(reviewReason(txn({ Source: "email", Confidence: 0.4 })))
      .toBe("Auto-read from the email — double-check");
  });
});
