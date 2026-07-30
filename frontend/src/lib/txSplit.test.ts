// frontend/src/lib/txSplit.test.ts
import { describe, it, expect } from "vitest";
import type { Category } from "../api/types";
import {
  absorbRemainder,
  categoryInfoById,
  categoryNamesById,
  displayMerchant,
  draftAmounts,
  draftFromSplits,
  eligibleSplitCategories,
  evenAmounts,
  filsToAmountText,
  isSplitTxn,
  parseAmountToFils,
  splitAmountLabel,
  splitLabel,
  splitRemainder,
  splitsToBody,
  validateSplitDraft,
  type TxnDepth,
  type TxnSplit,
} from "./txSplit";

const cats: Category[] = [
  { ID: 1, Name: "Groceries", Kind: "spending", Bucket: "need", IsActive: true },
  { ID: 2, Name: "Dining", Kind: "spending", Bucket: "want", IsActive: true },
  { ID: 3, Name: "Salary", Kind: "income", Bucket: "", IsActive: true },
  { ID: 4, Name: "Transfers", Kind: "excluded", Bucket: "", IsActive: true },
  { ID: 5, Name: "Old", Kind: "spending", Bucket: "want", IsActive: false },
];

const txn = (over: Partial<TxnDepth> = {}): TxnDepth => ({
  ID: 9, PostedAt: "2026-07-10", AmountFils: 10000, AmountAedFils: 10000, Currency: "AED",
  Direction: "debit", MerchantRaw: "CARREFOUR", Status: "confirmed", Confidence: 0, Source: "email",
  CategoryID: 1, CategoryName: "Groceries", Bucket: "need", Kind: "spending", BucketSnapshot: "",
  ...over,
});

const split = (over: Partial<TxnSplit> = {}): TxnSplit => ({
  ID: 1, TransactionID: 9, CategoryID: 1, AmountFils: 6000, Note: "", ...over,
});

describe("parseAmountToFils", () => {
  it("parses whole and fractional amounts into integer fils", () => {
    expect(parseAmountToFils("150")).toBe(15000);
    expect(parseAmountToFils("39.50")).toBe(3950);
    expect(parseAmountToFils("39.5")).toBe(3950);
    expect(parseAmountToFils("0.01")).toBe(1);
    expect(parseAmountToFils("1,250.75")).toBe(125075);
    expect(parseAmountToFils(" 12 ")).toBe(1200);
  });

  it("rejects anything that is not a plain amount", () => {
    expect(parseAmountToFils("")).toBeNull();
    expect(parseAmountToFils("-5")).toBeNull();
    expect(parseAmountToFils("1.234")).toBeNull();
    expect(parseAmountToFils("abc")).toBeNull();
    expect(parseAmountToFils("1.2.3")).toBeNull();
  });

  it("round-trips filsToAmountText", () => {
    expect(parseAmountToFils(filsToAmountText(15000))).toBe(15000);
    expect(parseAmountToFils(filsToAmountText(3955))).toBe(3955);
    expect(filsToAmountText(15000)).toBe("150");
    expect(filsToAmountText(3950)).toBe("39.50");
    expect(filsToAmountText(305)).toBe("3.05");
  });
});

describe("splitAmountLabel", () => {
  it("prints AED bare and foreign with a currency tag", () => {
    expect(splitAmountLabel(6000, "AED")).toBe("60.00");
    expect(splitAmountLabel(6000, "")).toBe("60.00");
    expect(splitAmountLabel(1009, "USD")).toBe("USD 10.09");
  });
});

describe("eligibleSplitCategories", () => {
  it("debit parents may only use active spending categories", () => {
    expect(eligibleSplitCategories(cats, "debit").map((c) => c.ID)).toEqual([1, 2]);
  });

  it("credit parents add income; excluded and inactive never qualify", () => {
    expect(eligibleSplitCategories(cats, "credit").map((c) => c.ID)).toEqual([1, 2, 3]);
  });
});

describe("remainder math", () => {
  it("computes the live remainder, treating unparsed lines as zero", () => {
    expect(splitRemainder(10000, [6000, null])).toBe(4000);
    expect(splitRemainder(10000, [6000, 4000])).toBe(0);
    expect(splitRemainder(10000, [6000, 5000])).toBe(-1000);
    expect(splitRemainder(10000, [])).toBe(10000);
  });

  it("absorbRemainder balances one line against the others", () => {
    expect(absorbRemainder(10000, [6000, 1000], 1)).toBe(4000);
    expect(absorbRemainder(10000, [6000, null], 1)).toBe(4000);
    expect(absorbRemainder(10000, [10000, 500], 1)).toBeNull(); // would need ≤ 0
  });

  it("evenAmounts puts the rounding on the last line, integer-exact", () => {
    expect(evenAmounts(10000, 3)).toEqual([3333, 3333, 3334]);
    expect(evenAmounts(10000, 2)).toEqual([5000, 5000]);
    expect(evenAmounts(5, 3)).toEqual([1, 1, 3]);
    expect(evenAmounts(10000, 0)).toEqual([]);
    const parts = evenAmounts(99999, 7);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(99999);
  });
});

describe("validateSplitDraft", () => {
  const parent = { amountFils: 10000, direction: "debit" };

  it("accepts a complete, exactly-summing draft and shapes the wire body", () => {
    const res = validateSplitDraft(parent, [
      { categoryId: 1, amountText: "60", note: " mine " },
      { categoryId: 2, amountText: "40", note: "" },
    ], cats);
    expect(res).toEqual({
      ok: true,
      unsplit: false,
      body: [
        { category_id: 1, amount_fils: 6000, note: "mine" },
        { category_id: 2, amount_fils: 4000, note: "" },
      ],
    });
  });

  it("an empty draft is a valid un-split", () => {
    expect(validateSplitDraft(parent, [], cats)).toEqual({ ok: true, body: [], unsplit: true });
  });

  it("rejects sums that miss the parent amount", () => {
    const res = validateSplitDraft(parent, [
      { categoryId: 1, amountText: "60", note: "" },
      { categoryId: 2, amountText: "39.99", note: "" },
    ], cats);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/add up/i);
  });

  it("rejects missing and zero amounts", () => {
    expect(validateSplitDraft(parent, [{ categoryId: 1, amountText: "", note: "" }], cats).ok).toBe(false);
    expect(validateSplitDraft(parent, [{ categoryId: 1, amountText: "0", note: "" }], cats).ok).toBe(false);
  });

  it("rejects ineligible categories per the parent's direction", () => {
    // income on a debit parent
    expect(validateSplitDraft(parent, [{ categoryId: 3, amountText: "100", note: "" }], cats).ok).toBe(false);
    // excluded on any parent
    expect(validateSplitDraft({ amountFils: 10000, direction: "credit" },
      [{ categoryId: 4, amountText: "100", note: "" }], cats).ok).toBe(false);
    // inactive
    expect(validateSplitDraft(parent, [{ categoryId: 5, amountText: "100", note: "" }], cats).ok).toBe(false);
    // income on a credit parent is fine
    expect(validateSplitDraft({ amountFils: 10000, direction: "credit" },
      [{ categoryId: 3, amountText: "100", note: "" }], cats).ok).toBe(true);
  });
});

describe("display shaping", () => {
  const names = categoryNamesById(cats);

  it("splitLabel names one or two lines, then counts", () => {
    expect(splitLabel([split()], names)).toBe("Groceries");
    expect(splitLabel([split(), split({ ID: 2, CategoryID: 2 })], names)).toBe("Groceries + Dining");
    expect(splitLabel(
      [split(), split({ ID: 2, CategoryID: 2 }), split({ ID: 3, CategoryID: 3 })], names,
    )).toBe("Groceries + 2 more");
  });

  it("falls back to a part count when names are unknown", () => {
    expect(splitLabel([split({ CategoryID: 99 })], names)).toBe("1 part");
    expect(splitLabel([split(), split({ ID: 2, CategoryID: 99 })], names)).toBe("2 parts");
    expect(splitLabel([split(), split({ ID: 2, CategoryID: 2 })])).toBe("2 parts");
  });

  it("categoryInfoById carries name, bucket and kind for the dot", () => {
    expect(categoryInfoById(cats)[2]).toEqual({ name: "Dining", bucket: "want", kind: "spending" });
    expect(categoryInfoById(cats)[3]).toEqual({ name: "Salary", bucket: "", kind: "income" });
  });

  it("isSplitTxn and displayMerchant read the decorated fields", () => {
    expect(isSplitTxn(txn())).toBe(false);
    expect(isSplitTxn(txn({ Splits: [split()] }))).toBe(true);
    expect(displayMerchant(txn())).toBe("CARREFOUR");
    expect(displayMerchant(txn({ DisplayName: "Carrefour" }))).toBe("Carrefour");
  });

  it("draftFromSplits and splitsToBody round-trip the stored set", () => {
    const stored = [split({ AmountFils: 6000, Note: "mine" }), split({ ID: 2, CategoryID: 2, AmountFils: 4000 })];
    expect(draftFromSplits(stored)).toEqual([
      { categoryId: 1, amountText: "60", note: "mine" },
      { categoryId: 2, amountText: "40", note: "" },
    ]);
    expect(splitsToBody(stored)).toEqual([
      { category_id: 1, amount_fils: 6000, note: "mine" },
      { category_id: 2, amount_fils: 4000, note: "" },
    ]);
    expect(draftFromSplits(undefined)).toEqual([]);
    expect(draftAmounts(draftFromSplits(stored))).toEqual([6000, 4000]);
  });
});
