import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Txn } from "../../api/types";
import { LinkRefundSheet } from "./LinkRefundSheet";

function txn(p: Partial<Txn>): Txn {
  return {
    ID: 1, PostedAt: "2026-07-03T10:00:00Z", AmountFils: 5000, AmountAedFils: 5000, Currency: "AED",
    Direction: "credit", MerchantRaw: "Refund", Status: "needs_review", Confidence: 1, Source: "email",
    CategoryID: null, CategoryName: "", Bucket: "", Kind: "", BucketSnapshot: "", RefundOfID: null,
    ...p,
  };
}

const credit = txn({ ID: 7 });
const candidate = txn({
  ID: 9, Direction: "debit", MerchantRaw: "Carrefour", Status: "confirmed",
  CategoryID: 3, CategoryName: "Groceries", Bucket: "need", Kind: "spending",
  PostedAt: "2026-06-20T10:00:00Z",
});

function renderSheet(onLinked = vi.fn(), onClose = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <LinkRefundSheet txn={credit} onLinked={onLinked} onClose={onClose} />
    </QueryClientProvider>,
  );
  return { onLinked, onClose };
}

// Restore the fetch spy after each test. (Restoring in beforeEach would wipe
// the matchMedia mock the global test setup installs in its own beforeEach.)
afterEach(() => {
  vi.restoreAllMocks();
});

describe("LinkRefundSheet", () => {
  it("lists candidates and links on tap", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify([candidate]))) // GET candidates
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }))); // POST link
    const { onLinked } = renderSheet();

    await screen.findByText("Carrefour");
    fireEvent.click(screen.getByRole("button", { name: /Carrefour/ }));

    await waitFor(() => expect(onLinked).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/transactions/7/link-refund",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("shows an empty state when there are no candidates", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("[]"));
    renderSheet();
    expect(await screen.findByText(/No categorized purchases/)).toBeInTheDocument();
    // The empty-state copy and a candidate list are mutually exclusive states;
    // guard against both rendering at once.
    expect(screen.queryByRole("button", { name: /Carrefour/ })).toBeNull();
  });
});
