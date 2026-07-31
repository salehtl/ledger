// frontend/src/components/transactions/SplitSheet.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SplitSheet } from "./SplitSheet";
import type { Category } from "../../api/types";
import type { TxnDepth } from "../../lib/txSplit";

const cats: Category[] = [
  { ID: 1, Name: "Groceries", Kind: "spending", Bucket: "need", IsActive: true, Color: "" },
  { ID: 2, Name: "Dining", Kind: "spending", Bucket: "want", IsActive: true, Color: "" },
  { ID: 3, Name: "Fitness", Kind: "spending", Bucket: "want", IsActive: true, Color: "" },
  { ID: 4, Name: "Salary", Kind: "income", Bucket: "", IsActive: true, Color: "" },
  { ID: 5, Name: "Transfers", Kind: "excluded", Bucket: "", IsActive: true, Color: "" },
  { ID: 6, Name: "Old", Kind: "spending", Bucket: "want", IsActive: false, Color: "" },
];

const txn = (over: Partial<TxnDepth> = {}): TxnDepth => ({
  ID: 9, PostedAt: "2026-07-10", AmountFils: 10000, AmountAedFils: 10000, Currency: "AED",
  Direction: "debit", MerchantRaw: "CARREFOUR", Status: "confirmed", Confidence: 0, Source: "email",
  CategoryID: 1, CategoryName: "Groceries", Bucket: "need", Kind: "spending", BucketSnapshot: "",
  ...over,
});

const amountInput = (name: string) => screen.getByLabelText(`Amount for ${name}`) as HTMLInputElement;

describe("SplitSheet", () => {
  it("offers only categories the server would accept for a debit", () => {
    render(<SplitSheet txn={txn()} categories={cats} onSubmit={() => {}} onClose={() => {}} />);
    expect(screen.getByRole("button", { name: "Groceries" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Salary" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Transfers" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Old" })).not.toBeInTheDocument();
  });

  it("adds income categories for credit parents", () => {
    render(<SplitSheet txn={txn({ Direction: "credit" })} categories={cats} onSubmit={() => {}} onClose={() => {}} />);
    expect(screen.getByRole("button", { name: "Salary" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Transfers" })).not.toBeInTheDocument();
  });

  it("paints the picker dot and the chosen line with the category's own colour", () => {
    // Two sites in one sheet: the picker chip and the per-line header. Both
    // used to read bucketColor(c.Bucket) — which can only return
    // --color-need/want/save/transfer/muted, so teal is unreachable through it
    // and a regression cannot pass this by coincidence.
    const colored = cats.map((c) => (c.ID === 1 ? { ...c, Color: "teal" } : c));
    render(<SplitSheet txn={txn()} categories={colored} onSubmit={() => {}} onClose={() => {}} />);
    const picker = screen.getByRole("button", { name: "Groceries" });
    expect((picker.querySelector("span[aria-hidden]") as HTMLElement).style.backgroundColor).toBe("var(--color-teal)");
    fireEvent.click(picker);
    // Selecting inverts the chip to the accent, so read the line header, which
    // is the second site and keeps the hue.
    const line = screen.getByLabelText("Amount for Groceries").closest("div.border") as HTMLElement;
    expect((line.querySelector("span[aria-hidden]") as HTMLElement).style.backgroundColor).toBe("var(--color-teal)");
  });

  it("prefills the first line with the whole amount and the next with the rest", () => {
    render(<SplitSheet txn={txn()} categories={cats} onSubmit={() => {}} onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Groceries" }));
    expect(amountInput("Groceries").value).toBe("100");
    fireEvent.change(amountInput("Groceries"), { target: { value: "60" } });
    expect(screen.getByText("40.00 left to place")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Dining" }));
    expect(amountInput("Dining").value).toBe("40");
    expect(screen.getByText("Adds up exactly")).toBeInTheDocument();
  });

  it("submits the validated wire body", () => {
    const onSubmit = vi.fn();
    render(<SplitSheet txn={txn()} categories={cats} onSubmit={onSubmit} onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Groceries" }));
    fireEvent.change(amountInput("Groceries"), { target: { value: "60" } });
    fireEvent.click(screen.getByRole("button", { name: "Dining" }));
    fireEvent.change(screen.getByLabelText("Note for Dining"), { target: { value: "team lunch" } });
    fireEvent.click(screen.getByRole("button", { name: "Save split" }));
    expect(onSubmit).toHaveBeenCalledWith([
      { category_id: 1, amount_fils: 6000, note: "" },
      { category_id: 2, amount_fils: 4000, note: "team lunch" },
    ]);
  });

  it("flags an overshoot in words and blocks saving", () => {
    const onSubmit = vi.fn();
    render(<SplitSheet txn={txn()} categories={cats} onSubmit={onSubmit} onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Groceries" }));
    fireEvent.change(amountInput("Groceries"), { target: { value: "120" } });
    expect(screen.getByText("20.00 over the total")).toBeInTheDocument();
    const save = screen.getByRole("button", { name: "Save split" });
    expect(save).toBeDisabled();
    fireEvent.click(save);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("splits evenly with the last line absorbing the rounding", () => {
    render(<SplitSheet txn={txn()} categories={cats} onSubmit={() => {}} onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Groceries" }));
    fireEvent.click(screen.getByRole("button", { name: "Dining" }));
    fireEvent.click(screen.getByRole("button", { name: "Fitness" }));
    fireEvent.click(screen.getByRole("button", { name: "Split evenly" }));
    expect(amountInput("Groceries").value).toBe("33.33");
    expect(amountInput("Dining").value).toBe("33.33");
    expect(amountInput("Fitness").value).toBe("33.34");
    expect(screen.getByText("Adds up exactly")).toBeInTheDocument();
  });

  it("puts the remainder on the last line on request", () => {
    render(<SplitSheet txn={txn()} categories={cats} onSubmit={() => {}} onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Groceries" }));
    fireEvent.change(amountInput("Groceries"), { target: { value: "60" } });
    fireEvent.click(screen.getByRole("button", { name: "Dining" }));
    fireEvent.change(amountInput("Dining"), { target: { value: "10" } });
    fireEvent.click(screen.getByRole("button", { name: "Add the rest to Dining" }));
    expect(amountInput("Dining").value).toBe("40");
    expect(screen.getByText("Adds up exactly")).toBeInTheDocument();
  });

  it("balances an overshooting last line on request", () => {
    render(<SplitSheet txn={txn()} categories={cats} onSubmit={() => {}} onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Groceries" }));
    fireEvent.change(amountInput("Groceries"), { target: { value: "120" } });
    fireEvent.click(screen.getByRole("button", { name: "Balance on Groceries" }));
    expect(amountInput("Groceries").value).toBe("100");
    expect(screen.getByText("Adds up exactly")).toBeInTheDocument();
  });

  it("keeps Save disabled with no lines on an unsplit transaction", () => {
    render(<SplitSheet txn={txn()} categories={cats} onSubmit={() => {}} onClose={() => {}} />);
    expect(screen.getByRole("button", { name: "Save split" })).toBeDisabled();
  });

  it("prefills existing lines and un-splits with a stated consequence", () => {
    const onSubmit = vi.fn();
    const split = txn({
      CategoryID: null, CategoryName: "", Bucket: "",
      Splits: [
        { ID: 1, TransactionID: 9, CategoryID: 1, AmountFils: 6000, Note: "mine" },
        { ID: 2, TransactionID: 9, CategoryID: 2, AmountFils: 4000 },
      ],
    });
    render(<SplitSheet txn={split} categories={cats} onSubmit={onSubmit} onClose={() => {}} />);
    expect(amountInput("Groceries").value).toBe("60");
    expect(screen.getByLabelText("Note for Groceries")).toHaveValue("mine");
    fireEvent.click(screen.getByRole("button", { name: "Remove Groceries" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove Dining" }));
    expect(screen.getByTestId("unsplit-note")).toHaveTextContent(/review queue/i);
    fireEvent.click(screen.getByRole("button", { name: "Remove split" }));
    expect(onSubmit).toHaveBeenCalledWith([]);
  });

  it("tags foreign parents' amounts with their currency", () => {
    render(
      <SplitSheet
        txn={txn({ Currency: "USD", AmountFils: 1009, AmountAedFils: 3706 })}
        categories={cats}
        onSubmit={() => {}}
        onClose={() => {}}
      />,
    );
    // Header tag and the helper line both speak the parent's own currency.
    expect(screen.getAllByText(/USD 10\.09/).length).toBeGreaterThan(0);
  });

  it("filters the picker by search", () => {
    render(<SplitSheet txn={txn()} categories={cats} onSubmit={() => {}} onClose={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText(/search categories/i), { target: { value: "din" } });
    expect(screen.getByRole("button", { name: "Dining" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Groceries" })).not.toBeInTheDocument();
  });
});
