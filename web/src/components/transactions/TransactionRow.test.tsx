import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TransactionRow } from "./TransactionRow";
import type { Txn } from "../../api/types";
import type { TxnDepth } from "../../lib/txSplit";

const mk = (over: Partial<TxnDepth>): Txn => ({
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

  describe("split parents", () => {
    const splitCategories = {
      1: { name: "Groceries", bucket: "need", kind: "spending" },
      2: { name: "Dining", bucket: "want", kind: "spending" },
    };
    const splitTxn = () => mk({
      CategoryID: null, CategoryName: "",
      Splits: [
        { ID: 1, TransactionID: 1, CategoryID: 1, AmountFils: 3000, Note: "mine" },
        { ID: 2, TransactionID: 1, CategoryID: 2, AmountFils: 2000 },
      ],
    });

    it("shows the lines' categories in the meta and expands the stack on demand", () => {
      render(<TransactionRow txn={splitTxn()} onOpen={() => {}} splitCategories={splitCategories} />);
      expect(screen.getByText(/Split · Groceries \+ Dining · Jun 10/)).toBeInTheDocument();
      expect(screen.queryByText("30.00")).not.toBeInTheDocument();
      const expander = screen.getByRole("button", { name: /show 2 parts/i });
      expect(expander).toHaveAttribute("aria-expanded", "false");
      fireEvent.click(expander);
      expect(screen.getByText("30.00")).toBeInTheDocument();
      expect(screen.getByText("20.00")).toBeInTheDocument();
      expect(screen.getByText("Groceries")).toBeInTheDocument();
      expect(screen.getByText("mine")).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: /hide parts/i }));
      expect(screen.queryByText("30.00")).not.toBeInTheDocument();
    });

    it("degrades to a part count without the category lookup", () => {
      render(<TransactionRow txn={splitTxn()} onOpen={() => {}} />);
      expect(screen.getByText(/Split · 2 parts · Jun 10/)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /show 2 parts/i })).toBeInTheDocument();
    });

    it("keeps the row tap opening the detail sheet, separate from the expander", () => {
      const onOpen = vi.fn();
      render(<TransactionRow txn={splitTxn()} onOpen={onOpen} splitCategories={splitCategories} />);
      fireEvent.click(screen.getByRole("button", { name: /show 2 parts/i }));
      expect(onOpen).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: /open spinneys/i }));
      expect(onOpen).toHaveBeenCalledTimes(1);
    });
  });

  it("prints the merchant clean name when the payload resolves one", () => {
    render(<TransactionRow txn={mk({ DisplayName: "Spinneys" })} onOpen={() => {}} />);
    expect(screen.getByText("Spinneys")).toBeInTheDocument();
    expect(screen.queryByText("SPINNEYS")).not.toBeInTheDocument();
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
