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
});
