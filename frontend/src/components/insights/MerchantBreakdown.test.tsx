import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { Txn } from "../../api/types";
import { MerchantBreakdown } from "./MerchantBreakdown";

function txn(p: Partial<Txn>): Txn {
  return {
    ID: 1, PostedAt: "2026-06-10T12:00:00Z", AmountFils: 1000, Currency: "AED",
    Direction: "debit", MerchantRaw: "Deliveroo", Status: "confirmed", Confidence: 1, Source: "email",
    CategoryID: 10, CategoryName: "Dining", Bucket: "want", Kind: "spending", BucketSnapshot: "",
    ...p,
  };
}

describe("MerchantBreakdown", () => {
  it("lists merchants by spend and fires onSelect on tap", () => {
    const onSelect = vi.fn();
    render(<MerchantBreakdown txns={[
      txn({ ID: 1, MerchantRaw: "Deliveroo", AmountFils: 600 }),
      txn({ ID: 2, MerchantRaw: "Noon", AmountFils: 400 }),
    ]} onSelect={onSelect} />);
    expect(screen.getByText("Deliveroo")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Deliveroo/ }));
    expect(onSelect).toHaveBeenCalledWith("Deliveroo");
  });

  it("shows an empty state when there is no spending", () => {
    render(<MerchantBreakdown txns={[]} onSelect={() => {}} />);
    expect(screen.getByText(/no spending/i)).toBeInTheDocument();
  });

  it("folds merchants beyond top 8 into a non-interactive Other row", () => {
    const onSelect = vi.fn();
    render(<MerchantBreakdown txns={[
      txn({ ID: 1, MerchantRaw: "M1", AmountFils: 9000 }),
      txn({ ID: 2, MerchantRaw: "M2", AmountFils: 8000 }),
      txn({ ID: 3, MerchantRaw: "M3", AmountFils: 7000 }),
      txn({ ID: 4, MerchantRaw: "M4", AmountFils: 6000 }),
      txn({ ID: 5, MerchantRaw: "M5", AmountFils: 5000 }),
      txn({ ID: 6, MerchantRaw: "M6", AmountFils: 4000 }),
      txn({ ID: 7, MerchantRaw: "M7", AmountFils: 3000 }),
      txn({ ID: 8, MerchantRaw: "M8", AmountFils: 2000 }),
      txn({ ID: 9, MerchantRaw: "M9", AmountFils: 1000 }),
    ]} onSelect={onSelect} />);

    expect(screen.getByText("Other")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Other/ })).toBeNull();
    expect(screen.getByRole("button", { name: /M1/ })).toBeInTheDocument();
  });
});
