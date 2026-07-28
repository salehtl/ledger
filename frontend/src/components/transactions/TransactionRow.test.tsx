import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TransactionRow } from "./TransactionRow";
import type { Txn } from "../../api/types";

const mk = (over: Partial<Txn>): Txn => ({
  ID: 1, PostedAt: "2026-06-10", AmountFils: 5000, AmountAedFils: 5000, Currency: "AED", Direction: "debit",
  MerchantRaw: "SPINNEYS", Status: "confirmed", Confidence: 0, Source: "email",
  CategoryID: null, CategoryName: "", Bucket: "", Kind: "", BucketSnapshot: "", ...over,
});

describe("TransactionRow", () => {
  it("opens the row on tap", () => {
    const onOpen = vi.fn();
    render(<TransactionRow txn={mk({})} onOpen={onOpen} />);
    fireEvent.click(screen.getByRole("button", { name: /open spinneys/i }));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("shows category and short date, and 'Uncategorized' when unset", () => {
    const { rerender } = render(<TransactionRow txn={mk({ CategoryName: "Groceries" })} onOpen={() => {}} />);
    expect(screen.getByText(/Groceries · Jun 10/)).toBeInTheDocument();
    rerender(<TransactionRow txn={mk({ CategoryName: "" })} onOpen={() => {}} />);
    expect(screen.getByText(/Uncategorized · Jun 10/)).toBeInTheDocument();
  });

  it("signs the amount by flow direction", () => {
    const { rerender } = render(<TransactionRow txn={mk({ Direction: "debit", AmountFils: 5000 })} onOpen={() => {}} />);
    expect(screen.getByText("−50.00")).toBeInTheDocument();
    rerender(<TransactionRow txn={mk({ Direction: "credit", AmountFils: 5000 })} onOpen={() => {}} />);
    expect(screen.getByText("+50.00")).toBeInTheDocument();
    expect(screen.getByText("+50.00")).toHaveStyle({ color: "var(--color-good)" });
  });

  it("keeps the complete merchant title available when the visual title wraps", () => {
    const merchant = "A VERY LONG MERCHANT DESCRIPTION WITH REFERENCE DETAILS";
    render(<TransactionRow txn={mk({ MerchantRaw: merchant })} onOpen={() => {}} />);
    expect(screen.getByText(merchant)).toHaveAttribute("title", merchant);
    expect(screen.getByText(merchant)).toHaveClass("line-clamp-2", "break-words");
  });

  it("shows the converted AED amount with a native tag for foreign rows", () => {
    render(<TransactionRow txn={mk({ AmountFils: 1009, Currency: "USD", AmountAedFils: 3706, Direction: "debit" })} onOpen={() => {}} />);
    expect(screen.getByText("−37.06")).toBeInTheDocument();
    expect(screen.getByText(/USD 10\.09/)).toBeInTheDocument();
  });

  it("marks unconverted foreign rows", () => {
    render(<TransactionRow txn={mk({ AmountFils: 2412, Currency: "EUR", AmountAedFils: null, Direction: "debit" })} onOpen={() => {}} />);
    expect(screen.getByText(/no AED rate/)).toBeInTheDocument();
  });

  it("tags linked refunds in the meta line", () => {
    render(<TransactionRow txn={mk({ Direction: "credit", CategoryName: "Groceries", RefundOfID: 42 })} onOpen={() => {}} />);
    expect(screen.getByText(/refund/)).toBeInTheDocument();
  });

  describe("project chip", () => {
    const projectsById = { 7: { name: "Kitchen reno", color: "#1373d9" } };

    it("renders a chip when the txn's project is in projectsById", () => {
      render(<TransactionRow txn={mk({ ProjectID: 7 })} projectsById={projectsById} onOpen={() => {}} />);
      expect(screen.getByText("Kitchen reno")).toBeInTheDocument();
    });

    it("shows no chip when projectsById is not passed", () => {
      render(<TransactionRow txn={mk({ ProjectID: 7 })} onOpen={() => {}} />);
      expect(screen.queryByText("Kitchen reno")).not.toBeInTheDocument();
    });

    it("shows no chip when the txn has no project", () => {
      render(<TransactionRow txn={mk({ ProjectID: null })} projectsById={projectsById} onOpen={() => {}} />);
      expect(screen.queryByText("Kitchen reno")).not.toBeInTheDocument();
    });
  });

  it("shows a status pill only when a row needs attention or is archived", () => {
    const { rerender } = render(<TransactionRow txn={mk({ Status: "confirmed" })} onOpen={() => {}} />);
    expect(screen.queryByText(/needs review|archived/i)).not.toBeInTheDocument();
    rerender(<TransactionRow txn={mk({ Status: "needs_review" })} onOpen={() => {}} />);
    expect(screen.getByText(/needs review/i)).toBeInTheDocument();
    rerender(<TransactionRow txn={mk({ Status: "archived" })} onOpen={() => {}} />);
    expect(screen.getByText(/archived/i)).toBeInTheDocument();
  });
});
