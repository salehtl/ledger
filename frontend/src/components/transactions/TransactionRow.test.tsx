// frontend/src/components/transactions/TransactionRow.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TransactionRow } from "./TransactionRow";
import type { Txn } from "../../api/types";

const review: Txn = { ID: 1, PostedAt: "2026-06-10", AmountFils: 5000, Currency: "AED", Direction: "debit", MerchantRaw: "SPINNEYS", Status: "needs_review", Confidence: 0, Source: "email", CategoryID: null, CategoryName: "", Bucket: "" };
const confirmed: Txn = { ...review, ID: 2, Status: "confirmed", CategoryID: 1, CategoryName: "Groceries", Bucket: "need" };

describe("TransactionRow", () => {
  it("shows merchant, human status, and category", () => {
    render(<TransactionRow txn={confirmed} onOpen={() => {}} onStatus={() => {}} />);
    expect(screen.getByText("SPINNEYS")).toBeInTheDocument();
    expect(screen.getByText("Confirmed")).toBeInTheDocument();
    expect(screen.getByText(/Groceries/)).toBeInTheDocument();
  });

  it("offers Transfer/Ignore only for needs_review and opens on tap", () => {
    const onOpen = vi.fn();
    const onStatus = vi.fn();
    render(<TransactionRow txn={review} onOpen={onOpen} onStatus={onStatus} />);
    fireEvent.click(screen.getByRole("button", { name: /ignore/i }));
    expect(onStatus).toHaveBeenCalledWith(review, "ignored");
    fireEvent.click(screen.getByRole("button", { name: /categorize/i }));
    expect(onOpen).toHaveBeenCalledWith(review);
  });
});
