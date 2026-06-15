// frontend/src/components/CategorizeDialog.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { CategorizeDialog } from "./CategorizeDialog";
import type { Category, Txn } from "../api/types";

const cats: Category[] = [
  { ID: 1, Name: "Groceries", Kind: "spending", Bucket: "need", IsActive: true },
  { ID: 2, Name: "Dining", Kind: "spending", Bucket: "want", IsActive: true },
];
const txn: Txn = { ID: 9, PostedAt: "2026-06-10", AmountFils: 5000, Currency: "AED", Direction: "debit", MerchantRaw: "CARREFOUR", Status: "needs_review", Confidence: 0, Source: "email", CategoryID: null, CategoryName: "", Bucket: "" };

describe("CategorizeDialog", () => {
  it("submits the chosen category + make_rule flag", () => {
    const onSubmit = vi.fn();
    render(<CategorizeDialog txn={txn} categories={cats} onSubmit={onSubmit} onClose={() => {}} />);
    fireEvent.click(screen.getByLabelText("Dining"));
    fireEvent.click(screen.getByLabelText(/save as rule/i));
    fireEvent.click(screen.getByRole("button", { name: /ok/i }));
    expect(onSubmit).toHaveBeenCalledWith({ category_id: 2, make_rule: true });
  });

  it("disables OK until a category is chosen", () => {
    render(<CategorizeDialog txn={txn} categories={cats} onSubmit={() => {}} onClose={() => {}} />);
    expect(screen.getByRole("button", { name: /ok/i })).toBeDisabled();
  });

  it("filters categories by the search box", () => {
    render(<CategorizeDialog txn={txn} categories={cats} onSubmit={() => {}} onClose={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText(/search/i), { target: { value: "din" } });
    expect(screen.getByLabelText("Dining")).toBeInTheDocument();
    expect(screen.queryByLabelText("Groceries")).not.toBeInTheDocument();
  });
});
