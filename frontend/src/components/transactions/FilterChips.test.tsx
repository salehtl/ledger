import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { FilterChips } from "./FilterChips";
import { EMPTY_FILTERS, type TxnFilters } from "../../lib/transactions";
import type { Category, Txn } from "../../api/types";

const cats: Category[] = [
  { ID: 1, Name: "Groceries", Kind: "spending", Bucket: "need", IsActive: true },
  { ID: 2, Name: "Dining", Kind: "spending", Bucket: "want", IsActive: true },
];
const txns: Txn[] = [
  { ID: 1, PostedAt: "2026-06-10", AmountFils: 1000, Currency: "AED", Direction: "debit", MerchantRaw: "X", Status: "confirmed", Confidence: 0, Source: "email", CategoryID: 1, CategoryName: "Groceries", Bucket: "need", Kind: "spending", BucketSnapshot: "" },
  { ID: 2, PostedAt: "2026-06-09", AmountFils: 2000, Currency: "AED", Direction: "credit", MerchantRaw: "Y", Status: "confirmed", Confidence: 0, Source: "ai", CategoryID: 2, CategoryName: "Dining", Bucket: "want", Kind: "spending", BucketSnapshot: "" },
];

function setup(filters: TxnFilters = EMPTY_FILTERS) {
  const onChange = vi.fn();
  render(<FilterChips filters={filters} categories={cats} txns={txns} onChange={onChange} />);
  return { onChange };
}

describe("FilterChips", () => {
  it("renders a chip per dimension", () => {
    setup();
    expect(screen.getByRole("button", { name: /bucket/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /category/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /direction/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /source/i })).toBeInTheDocument();
  });

  it("opens a picker and toggling a value calls onChange", () => {
    const { onChange } = setup();
    fireEvent.click(screen.getByRole("button", { name: /bucket/i }));
    fireEvent.click(screen.getByLabelText("Needs"));
    expect(onChange).toHaveBeenCalledWith({ ...EMPTY_FILTERS, buckets: ["need"] });
  });

  it("derives source options from the loaded rows", () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: /source/i }));
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
    expect(screen.getByLabelText("AI")).toBeInTheDocument();
  });

  it("maps category checkbox to its numeric id", () => {
    const { onChange } = setup();
    fireEvent.click(screen.getByRole("button", { name: /category/i }));
    fireEvent.click(screen.getByLabelText("Dining"));
    expect(onChange).toHaveBeenCalledWith({ ...EMPTY_FILTERS, categoryIds: [2] });
  });

  it("shows a count on an active chip and a Clear-all that resets", () => {
    const { onChange } = setup({ ...EMPTY_FILTERS, buckets: ["need", "want"] });
    expect(screen.getByRole("button", { name: /bucket · 2/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /clear/i }));
    expect(onChange).toHaveBeenCalledWith(EMPTY_FILTERS);
  });
});
