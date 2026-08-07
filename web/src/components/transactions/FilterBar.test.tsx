// frontend/src/components/transactions/FilterBar.test.tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { FilterBar } from "./FilterBar";
import { EMPTY_FILTERS } from "../../lib/transactions";
import type { Category, Txn } from "../../api/types";

const cats: Category[] = [
  { ID: 1, Name: "Groceries", Kind: "spending", Bucket: "need", IsActive: true, Color: "teal" },
  { ID: 2, Name: "Dining", Kind: "spending", Bucket: "want", IsActive: true, Color: "orchid" },
  { ID: 3, Name: "Rent", Kind: "spending", Bucket: "need", IsActive: true, Color: "" },
];
const txns: Txn[] = [];

const dot = (name: string) =>
  (screen.getByRole("button", { name }).querySelector("span[aria-hidden]") as HTMLElement | null)?.style.backgroundColor;

describe("FilterBar category chips", () => {
  // The category chips are the busiest category surface in the app. They used
  // to carry bucketColor(c.Bucket), which ties every "need" to the same amber
  // — so Groceries read teal in Plan and Settings and amber here.
  //
  // bucketColor can only ever return --color-need/want/save/transfer/muted, so
  // teal and orchid are unreachable through it: a regression to the bucket
  // source fails this rather than passing by coincidence.
  it("carries each category's own colour", () => {
    render(<FilterBar filters={EMPTY_FILTERS} categories={cats} txns={txns} open onChange={() => {}} />);
    expect(dot("Groceries")).toBe("var(--color-teal)");
    expect(dot("Dining")).toBe("var(--color-orchid)");
  });

  it("falls back to the neutral rather than an empty dot for an unset colour", () => {
    // The interesting distinction is neutral vs *nothing*: an unknown or empty
    // name must never be interpolated into var(--color-), which is valid CSS
    // that resolves to nothing and would make the mark silently disappear.
    render(<FilterBar filters={EMPTY_FILTERS} categories={cats} txns={txns} open onChange={() => {}} />);
    expect(dot("Rent")).toBe("var(--color-slate)");
  });

  it("still colours the bucket chips by bucket", () => {
    // Not everything in this bar is a category. The bucket filter chips above
    // are genuinely about buckets and must keep bucketColor.
    render(<FilterBar filters={EMPTY_FILTERS} categories={cats} txns={txns} open onChange={() => {}} />);
    expect(dot("Needs")).toBe("var(--color-need)");
    expect(dot("Wants")).toBe("var(--color-want)");
  });
});
