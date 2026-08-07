/**
 * Transactions, against a real projection.
 *
 * Same contract as `Home.test.tsx`: every value asserted here exists only in
 * the SQLite projection this test builds, and `fetch` must never be called —
 * a screen that quietly fell back to `GET /api/transactions` would render an
 * empty list against `ledgerd`, not a working one.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { SqlDriver } from "@ledger/client/store/driver";

import { Transactions } from "./Transactions";
import { MotionProvider } from "../app/MotionProvider";
import { projectionWith } from "../test/projectionFixture";
import { sqlTxnSource } from "../v2/sources/transactions";

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async () => new Response("[]"));
  vi.stubGlobal("fetch", fetchMock);
});

function wrap(db: SqlDriver | null, props: { from?: string; to?: string } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MotionProvider>
      <QueryClientProvider client={qc}>
        {db === null ? <Transactions {...props} /> : <Transactions {...props} source={sqlTxnSource(db)} />}
      </QueryClientProvider>
    </MotionProvider>,
  );
}

describe("Transactions on the projection", () => {
  it("lists every live row, newest first, with bigint amounts", async () => {
    const db = await projectionWith();
    wrap(db);

    expect(await screen.findByText("SPINNEYS")).toBeInTheDocument();
    expect(screen.getByText("CARREFOUR")).toBeInTheDocument();
    expect(screen.getByText("−125.00")).toBeInTheDocument();
    expect(screen.getByText("+9,000.00")).toBeInTheDocument();
    expect(screen.getByText("6 transactions")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("totals only the rows that carry a home-currency snapshot, and says how many it left out", async () => {
    const db = await projectionWith();
    wrap(db);
    // 125.00 + 49.99 + 30.00 = 204.99 debits with a snapshot. The USD row has
    // no rate; the unparsed row is not money at all.
    expect(await screen.findByText(/204\.99 spent/)).toBeInTheDocument();
    expect(screen.getByText(/1 unconverted/)).toBeInTheDocument();
  });

  it("narrows to the rows a segment names", async () => {
    const db = await projectionWith();
    wrap(db);
    await screen.findByText("CARREFOUR");

    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    // The review row and the unread message both need review; nothing else does.
    await waitFor(() => expect(screen.getByText("2 transactions")).toBeInTheDocument());
    expect(screen.queryByText("CARREFOUR")).toBeNull();
    expect(screen.getByText("SPINNEYS")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Confirmed" }));
    await waitFor(() => expect(screen.getByText("4 transactions")).toBeInTheDocument());
    expect(screen.queryByText("SPINNEYS")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Unread" }));
    await waitFor(() => expect(screen.getByText("1 transaction")).toBeInTheDocument());
    // An unread message prints an em dash, never a 0.00 purchase.
    expect(screen.queryByText("−0.00")).toBeNull();
  });

  it("searches merchants through the projection, not through a client-side filter over a fetch", async () => {
    const db = await projectionWith();
    wrap(db);
    await screen.findByText("CARREFOUR");

    fireEvent.change(screen.getByPlaceholderText("Search merchant…"), { target: { value: "netfl" } });
    await waitFor(() => expect(screen.getByText("1 transaction")).toBeInTheDocument());
    expect(screen.getByText("NETFLIX")).toBeInTheDocument();
    expect(screen.queryByText("CARREFOUR")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("honours the shell's period, inclusively at both ends of the day", async () => {
    const db = await projectionWith();
    wrap(db, { from: "2026-08-02", to: "2026-08-03" });
    // NETFLIX on the 2nd and SALARY on the 3rd — an upper bound compared
    // against the whole RFC3339 instant would have dropped the 3rd.
    expect(await screen.findByText("2 transactions")).toBeInTheDocument();
    expect(screen.getByText("NETFLIX")).toBeInTheDocument();
    expect(screen.getByText("SALARY")).toBeInTheDocument();
    expect(screen.queryByText("CARREFOUR")).toBeNull();
  });

  it("filters by a chip drawn from what the projection actually holds", async () => {
    const db = await projectionWith();
    wrap(db);
    await screen.findByText("CARREFOUR");

    fireEvent.click(screen.getByRole("button", { name: "Filters" }));
    fireEvent.click(await screen.findByRole("button", { name: "groceries" }));
    await waitFor(() => expect(screen.getByText("1 transaction")).toBeInTheDocument());
    expect(screen.getByText("CARREFOUR")).toBeInTheDocument();

    // The token row can take it back off.
    fireEvent.click(screen.getByRole("button", { name: "Remove groceries filter" }));
    await waitFor(() => expect(screen.getByText("6 transactions")).toBeInTheDocument());
  });

  it("says so when the filters match nothing, rather than showing a blank card", async () => {
    const db = await projectionWith();
    wrap(db);
    await screen.findByText("CARREFOUR");
    fireEvent.change(screen.getByPlaceholderText("Search merchant…"), { target: { value: "nothing here" } });
    expect(await screen.findByText("No transactions")).toBeInTheDocument();
  });

  it("bounds the window and offers the rest rather than reading the whole table", async () => {
    const many = Array.from({ length: 60 }, (_, i) => ({
      id: `m${i}`,
      amount: "100",
      posted_at: `2026-06-${String((i % 28) + 1).padStart(2, "0")}T0${i % 10}:00:00Z`,
      merchant: `MERCHANT ${i}`,
      category: "groceries",
    }));
    const db = await projectionWith(many);
    wrap(db);

    expect(await screen.findByText("50 transactions")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show older" }));
    await waitFor(() => expect(screen.getByText("60 transactions")).toBeInTheDocument());
  });

  it("says the local ledger is closed rather than silently falling back to v1", async () => {
    wrap(null);
    expect(await screen.findByText("Your local ledger isn't open")).toBeInTheDocument();
    await waitFor(() => expect(fetchMock).not.toHaveBeenCalled());
  });
});
