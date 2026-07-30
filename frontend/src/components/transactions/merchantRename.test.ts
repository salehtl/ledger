// frontend/src/components/transactions/merchantRename.test.ts
import { describe, it, expect } from "vitest";
import type { Txn } from "../../api/types";
import type { TxnDepth } from "../../lib/txSplit";
import {
  affectedCount,
  largestSplitCategory,
  matchingRule,
  renameTarget,
  ruleMatchesMerchant,
  type DepthRule,
} from "./merchantRename";

const rule = (over: Partial<DepthRule> = {}): DepthRule => ({
  ID: 1, MatchType: "contains", Pattern: "talabat", CategoryID: 7, Priority: 100,
  Source: "ai_confirmed", IsActive: true, ...over,
});

const txn = (over: Partial<TxnDepth> = {}): TxnDepth => ({
  ID: 9, PostedAt: "2026-07-10", AmountFils: 10000, AmountAedFils: 10000, Currency: "AED",
  Direction: "debit", MerchantRaw: "TALABAT.COM DUBAI", Status: "confirmed", Confidence: 0,
  Source: "email", CategoryID: 7, CategoryName: "Dining", Bucket: "want", Kind: "spending",
  BucketSnapshot: "", ...over,
});

describe("ruleMatchesMerchant", () => {
  it("matches contains and exact case-insensitively, never regex", () => {
    expect(ruleMatchesMerchant(rule(), "TALABAT.COM DUBAI")).toBe(true);
    expect(ruleMatchesMerchant(rule({ MatchType: "exact", Pattern: "talabat.com dubai" }), "TALABAT.COM DUBAI")).toBe(true);
    expect(ruleMatchesMerchant(rule({ MatchType: "exact", Pattern: "talabat" }), "TALABAT.COM DUBAI")).toBe(false);
    expect(ruleMatchesMerchant(rule({ MatchType: "regex", Pattern: "tala.*" }), "TALABAT.COM DUBAI")).toBe(false);
    expect(ruleMatchesMerchant(rule({ Pattern: "" }), "TALABAT.COM DUBAI")).toBe(false);
    expect(ruleMatchesMerchant(rule(), "")).toBe(false);
  });
});

describe("matchingRule", () => {
  it("picks the first match by priority asc then id asc, active only", () => {
    const rules = [
      rule({ ID: 5, Priority: 100 }),
      rule({ ID: 2, Priority: 100 }),
      rule({ ID: 9, Priority: 50 }),
      rule({ ID: 1, Priority: 10, IsActive: false }),
      rule({ ID: 3, Priority: 1, Pattern: "spinneys" }),
    ];
    expect(matchingRule(rules, "TALABAT.COM DUBAI")?.ID).toBe(9);
    expect(matchingRule([rule({ ID: 5 }), rule({ ID: 2 })], "TALABAT.COM DUBAI")?.ID).toBe(2);
    expect(matchingRule(rules, "no such merchant")).toBeNull();
  });
});

describe("largestSplitCategory", () => {
  it("returns the biggest line's category, first on ties, null when empty", () => {
    expect(largestSplitCategory([
      { ID: 1, TransactionID: 9, CategoryID: 1, AmountFils: 4000 },
      { ID: 2, TransactionID: 9, CategoryID: 2, AmountFils: 6000 },
    ])).toBe(2);
    expect(largestSplitCategory([
      { ID: 1, TransactionID: 9, CategoryID: 1, AmountFils: 5000 },
      { ID: 2, TransactionID: 9, CategoryID: 2, AmountFils: 5000 },
    ])).toBe(1);
    expect(largestSplitCategory([])).toBeNull();
    expect(largestSplitCategory(undefined)).toBeNull();
  });
});

describe("renameTarget", () => {
  it("prefers the existing matching rule", () => {
    const t = renameTarget([rule({ ID: 4 })], txn());
    expect(t).toEqual({ kind: "rule", rule: expect.objectContaining({ ID: 4 }) });
  });

  it("falls back to creating a rule with the transaction's category", () => {
    expect(renameTarget([], txn())).toEqual({ kind: "create", categoryId: 7 });
  });

  it("uses the largest split line's category for split parents", () => {
    const t = txn({
      CategoryID: null,
      Splits: [
        { ID: 1, TransactionID: 9, CategoryID: 1, AmountFils: 4000 },
        { ID: 2, TransactionID: 9, CategoryID: 2, AmountFils: 6000 },
      ],
    });
    expect(renameTarget([], t)).toEqual({ kind: "create", categoryId: 2 });
  });

  it("blocks when there is no rule and no category anywhere", () => {
    expect(renameTarget([], txn({ CategoryID: null }))).toEqual({ kind: "blocked", reason: "uncategorized" });
  });

  it("blocks an empty merchant string outright — no rule can match or seed it", () => {
    expect(renameTarget([], txn({ MerchantRaw: "" }))).toEqual({ kind: "blocked", reason: "no-merchant" });
    expect(renameTarget([], txn({ MerchantRaw: "   " }))).toEqual({ kind: "blocked", reason: "no-merchant" });
  });
});

describe("affectedCount", () => {
  const list: Txn[] = [
    txn({ ID: 1 }),
    txn({ ID: 2, MerchantRaw: "TALABAT.COM ABU DHABI" }),
    txn({ ID: 3, MerchantRaw: "SPINNEYS" }),
  ];

  it("counts matches of the existing rule", () => {
    expect(affectedCount(list, { kind: "rule", rule: rule() }, "TALABAT.COM DUBAI")).toBe(2);
  });

  it("counts matches of the would-be contains rule on the create path", () => {
    expect(affectedCount(list, { kind: "create", categoryId: 7 }, "TALABAT.COM DUBAI")).toBe(1);
    expect(affectedCount(list, { kind: "create", categoryId: 7 }, "SPINNEYS")).toBe(1);
  });
});
