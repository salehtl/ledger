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

  it("searches by merchant through ?q= and clears back to the full page", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify([candidate])))  // initial page
      .mockResolvedValueOnce(new Response(JSON.stringify([txn({          // search hit
        ID: 11, Direction: "debit", MerchantRaw: "Woodford CPT Airport", Status: "confirmed",
        CategoryID: 3, CategoryName: "Shopping", Kind: "spending", PostedAt: "2026-05-01T10:00:00Z",
      })])))
      .mockResolvedValueOnce(new Response(JSON.stringify([candidate])));  // back to the page
    renderSheet();
    await screen.findByText("Carrefour");

    const box = screen.getByLabelText("Search purchases");
    fireEvent.change(box, { target: { value: "wood" } });
    await screen.findByText("Woodford CPT Airport");
    expect(fetchMock.mock.calls[fetchMock.mock.calls.length - 1]?.[0]).toBe("/api/transactions/7/refund-candidates?q=wood");
    expect(screen.queryByText("Carrefour")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect((box as HTMLInputElement).value).toBe("");
    await screen.findByText("Carrefour");
    vi.useRealTimers();
  });

  it("tells the difference between no purchases at all and no search match", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify([candidate])))
      .mockResolvedValueOnce(new Response("[]"));
    renderSheet();
    await screen.findByText("Carrefour");
    fireEvent.change(screen.getByLabelText("Search purchases"), { target: { value: "zzz" } });
    expect(await screen.findByText(/No purchases match/)).toBeInTheDocument();
    expect(screen.queryByText(/No categorized purchases/)).toBeNull();
    vi.useRealTimers();
  });

  it("shows an empty state when there are no candidates", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("[]"));
    renderSheet();
    expect(await screen.findByText(/No categorized purchases in the year before/)).toBeInTheDocument();
    // The empty-state copy and a candidate list are mutually exclusive states;
    // guard against both rendering at once.
    expect(screen.queryByRole("button", { name: /Carrefour/ })).toBeNull();
  });
});
