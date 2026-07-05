// frontend/src/components/transactions/CategorizeSheet.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { CategorizeSheet } from "./CategorizeSheet";
import type { Category, Txn } from "../../api/types";

const cats: Category[] = [
  { ID: 1, Name: "Groceries", Kind: "spending", Bucket: "need", IsActive: true },
  { ID: 2, Name: "Dining", Kind: "spending", Bucket: "want", IsActive: true },
];
const txn: Txn = { ID: 9, PostedAt: "2026-06-10", AmountFils: 5000, AmountAedFils: 5000, Currency: "AED", Direction: "debit", MerchantRaw: "CARREFOUR", Status: "needs_review", Confidence: 0, Source: "email", CategoryID: null, CategoryName: "", Bucket: "", Kind: "", BucketSnapshot: "" };

describe("CategorizeSheet", () => {
  it("submits the chosen category + make_rule", () => {
    const onSubmit = vi.fn();
    render(<CategorizeSheet txn={txn} categories={cats} onSubmit={onSubmit} onClose={() => {}} />);
    fireEvent.click(screen.getByLabelText("Dining"));
    fireEvent.click(screen.getByLabelText(/make a rule/i));
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    expect(onSubmit).toHaveBeenCalledWith({ category_id: 2, make_rule: true });
  });

  it("filters by search", () => {
    render(<CategorizeSheet txn={txn} categories={cats} onSubmit={() => {}} onClose={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText(/search/i), { target: { value: "din" } });
    expect(screen.getByLabelText("Dining")).toBeInTheDocument();
    expect(screen.queryByLabelText("Groceries")).not.toBeInTheDocument();
  });

  it("marks an unconverted foreign row with the native tag and a no-rate note", () => {
    const foreign: Txn = { ...txn, AmountFils: 1009, Currency: "USD", AmountAedFils: null };
    render(<CategorizeSheet txn={foreign} categories={cats} onSubmit={() => {}} onClose={() => {}} />);
    expect(screen.getByText(/USD 10\.09/)).toBeInTheDocument();
    expect(screen.getByText(/no AED rate/)).toBeInTheDocument();
  });
});

describe("CategorizeSheet refund actions", () => {
  it("offers the refund link for unlinked credits", () => {
    const onLinkRefund = vi.fn();
    render(
      <CategorizeSheet
        txn={{ ...txn, Direction: "credit", RefundOfID: null }}
        categories={cats}
        onSubmit={() => {}}
        onClose={() => {}}
        onLinkRefund={onLinkRefund}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /refund/i }));
    expect(onLinkRefund).toHaveBeenCalled();
  });

  it("offers unlink for linked credits", () => {
    const onUnlinkRefund = vi.fn();
    render(
      <CategorizeSheet
        txn={{ ...txn, Direction: "credit", RefundOfID: 42 }}
        categories={cats}
        onSubmit={() => {}}
        onClose={() => {}}
        onUnlinkRefund={onUnlinkRefund}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /unlink refund/i }));
    expect(onUnlinkRefund).toHaveBeenCalled();
  });

  it("hides refund actions for debits", () => {
    render(
      <CategorizeSheet
        txn={{ ...txn, Direction: "debit" }}
        categories={cats}
        onSubmit={() => {}}
        onClose={() => {}}
        onLinkRefund={() => {}}
      />,
    );
    expect(screen.queryByRole("button", { name: /refund/i })).not.toBeInTheDocument();
  });
});
