import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Txn } from "../../api/types";
import { SwipeDeck } from "./SwipeDeck";
import { ToastProvider } from "../Toast";

function txn(p: Partial<Txn>): Txn {
  return {
    ID: 1, PostedAt: "2026-07-03T10:00:00Z", AmountFils: 5000, AmountAedFils: 5000, Currency: "AED",
    Direction: "debit", MerchantRaw: "Carrefour", Status: "needs_review", Confidence: 1, Source: "email",
    CategoryID: null, CategoryName: "", Bucket: "", Kind: "", BucketSnapshot: "", RefundOfID: null,
    ...p,
  };
}

function renderDeck(transactions: Txn[]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <SwipeDeck transactions={transactions} categories={[]} />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SwipeDeck refund action", () => {
  it("shows the refund button for a credit card and opens the link sheet", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("[]"));
    renderDeck([txn({ ID: 7, Direction: "credit", MerchantRaw: "Refund inbound" })]);
    const btn = screen.getByRole("button", { name: /this is a refund/i });
    fireEvent.click(btn);
    expect(await screen.findByText("Link refund")).toBeInTheDocument();
  });

  it("hides the refund button for debit cards", () => {
    renderDeck([txn({ ID: 8, Direction: "debit" })]);
    expect(screen.queryByRole("button", { name: /this is a refund/i })).not.toBeInTheDocument();
  });
});
