import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Txn } from "../../api/types";
import { SwipeDeck } from "./SwipeDeck";
import { ToastProvider } from "../Toast";
import { DEFAULT_SWIPE_CONFIG } from "../../lib/swipe";

function txn(p: Partial<Txn> = {}): Txn {
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

afterEach(() => vi.restoreAllMocks());

// The rails render as filled, labelled pills that look exactly like buttons.
// They used to be pointer-events-none decoration, which made swiping the only
// way to triage anything — no keyboard, switch control, or screen-reader path.
describe("SwipeDeck bucket rails", () => {
  it("exposes all four rails as real buttons", () => {
    renderDeck([txn()]);
    for (const dir of ["up", "down", "left", "right"] as const) {
      const label = DEFAULT_SWIPE_CONFIG[dir].label;
      expect(screen.getByRole("button", { name: new RegExp(label, "i") })).toBeInTheDocument();
    }
  });

  it("starts the same sort a swipe would, with no gesture involved", async () => {
    renderDeck([txn({ ID: 7 })]);
    fireEvent.click(screen.getByRole("button", { name: new RegExp(DEFAULT_SWIPE_CONFIG.left.label, "i") }));
    // A left swipe opens the category panel to finish the sort; tapping the
    // rail must reach that same state rather than doing nothing.
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  it("shows no rails once the queue is empty", () => {
    renderDeck([]);
    expect(
      screen.queryByRole("button", { name: new RegExp(DEFAULT_SWIPE_CONFIG.left.label, "i") }),
    ).not.toBeInTheDocument();
  });
});
