// frontend/src/components/transactions/TransactionDetailSheet.test.tsx
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TransactionDetailSheet } from "./TransactionDetailSheet";
import type { Category } from "../../api/types";
import type { TxnDepth } from "../../lib/txSplit";

const cats: Category[] = [
  { ID: 1, Name: "Groceries", Kind: "spending", Bucket: "need", IsActive: true },
  { ID: 2, Name: "Dining", Kind: "spending", Bucket: "want", IsActive: true },
];

const txn = (over: Partial<TxnDepth> = {}): TxnDepth => ({
  ID: 9, PostedAt: "2026-07-10", AmountFils: 10000, AmountAedFils: 10000, Currency: "AED",
  Direction: "debit", MerchantRaw: "CARREFOUR", Status: "confirmed", Confidence: 0, Source: "email",
  CategoryID: 1, CategoryName: "Groceries", Bucket: "need", Kind: "spending", BucketSnapshot: "",
  ...over,
});

const splitTxn = (over: Partial<TxnDepth> = {}): TxnDepth =>
  txn({
    CategoryID: null, CategoryName: "", Bucket: "",
    Splits: [
      { ID: 1, TransactionID: 9, CategoryID: 1, AmountFils: 6000, Note: "mine" },
      { ID: 2, TransactionID: 9, CategoryID: 2, AmountFils: 4000 },
    ],
    ...over,
  });

const noop = {
  onClose: () => {}, onCategorize: () => {}, onTransfer: () => {}, onStatus: () => {},
  onArchive: () => {}, onRestore: () => {}, onLinkRefund: () => {}, onUnlinkRefund: () => {},
};

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.includes("/api/categories")) return new Response(JSON.stringify(cats));
    return new Response("{}");
  }));
});

afterEach(() => vi.unstubAllGlobals());

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe("TransactionDetailSheet depth entry points", () => {
  it("offers split, rename and source email for a confirmed email txn", () => {
    const onSplit = vi.fn(), onRename = vi.fn(), onViewEmail = vi.fn();
    wrap(<TransactionDetailSheet txn={txn()} {...noop} onSplit={onSplit} onRename={onRename} onViewEmail={onViewEmail} />);
    fireEvent.click(screen.getByRole("button", { name: /split across categories/i }));
    fireEvent.click(screen.getByRole("button", { name: /rename merchant/i }));
    fireEvent.click(screen.getByRole("button", { name: /source email/i }));
    expect(onSplit).toHaveBeenCalled();
    expect(onRename).toHaveBeenCalled();
    expect(onViewEmail).toHaveBeenCalled();
  });

  it("hides the new entry points when the callbacks are absent (legacy call sites)", () => {
    wrap(<TransactionDetailSheet txn={txn()} {...noop} />);
    expect(screen.queryByRole("button", { name: /split across/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /rename/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /source email/i })).not.toBeInTheDocument();
  });

  it("offers no split entry for needs_review or manual-source-specific gating", () => {
    wrap(<TransactionDetailSheet txn={txn({ Status: "needs_review" })} {...noop} onSplit={() => {}} onViewEmail={() => {}} />);
    expect(screen.queryByRole("button", { name: /split across/i })).not.toBeInTheDocument();
  });

  it("hides the email door for manual entries", () => {
    wrap(<TransactionDetailSheet txn={txn({ Source: "manual" })} {...noop} onViewEmail={() => {}} onRename={() => {}} />);
    expect(screen.queryByRole("button", { name: /source email/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /rename merchant/i })).toBeInTheDocument();
  });

  it("always carries the note field", () => {
    wrap(<TransactionDetailSheet txn={txn({ Note: "team lunch" })} {...noop} />);
    expect(screen.getByLabelText(/note/i)).toHaveValue("team lunch");
  });

  it("prints the clean name with the raw merchant kept visible", () => {
    wrap(<TransactionDetailSheet txn={txn({ DisplayName: "Carrefour" })} {...noop} />);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("Carrefour")).toBeInTheDocument();
    expect(screen.getByText("CARREFOUR")).toBeInTheDocument();
  });
});

describe("TransactionDetailSheet split parents", () => {
  it("shows the line stack with resolved names and swaps the primary to Edit split", async () => {
    const onSplit = vi.fn();
    wrap(<TransactionDetailSheet txn={splitTxn()} {...noop} onSplit={onSplit} />);
    expect(screen.getByText("Split across 2 categories")).toBeInTheDocument();
    expect(await screen.findByText("Groceries")).toBeInTheDocument();
    expect(screen.getByText("Dining")).toBeInTheDocument();
    expect(screen.getByText("mine")).toBeInTheDocument();
    expect(screen.getByText("60.00")).toBeInTheDocument();
    expect(screen.getByText("40.00")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /edit split/i }));
    expect(onSplit).toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /categorize/i })).not.toBeInTheDocument();
  });

  it("closes the doors the server refuses while split (categorize, transfer, refund link)", () => {
    wrap(
      <TransactionDetailSheet
        txn={splitTxn({ Direction: "credit", Status: "needs_review" })}
        {...noop}
        onSplit={() => {}}
      />,
    );
    expect(screen.queryByRole("button", { name: /^categorize$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /transfer/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /link the purchase/i })).not.toBeInTheDocument();
  });

  it("keeps provenance visible for split parents: source, email door, refund pill", () => {
    const onViewEmail = vi.fn();
    wrap(
      <TransactionDetailSheet
        txn={splitTxn({ Direction: "credit", RefundOfID: 42 })}
        {...noop}
        onSplit={() => {}}
        onViewEmail={onViewEmail}
      />,
    );
    expect(screen.getByText("Email")).toBeInTheDocument();
    expect(screen.getByText("refund")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /source email/i }));
    expect(onViewEmail).toHaveBeenCalled();
    // unlink stays available — provenance machinery is never severed by a split
    expect(screen.getByRole("button", { name: /unlink refund/i })).toBeInTheDocument();
  });
});
