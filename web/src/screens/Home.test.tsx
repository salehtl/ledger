/**
 * Home, against a real projection.
 *
 * Every expectation below is a value that exists only in the SQLite projection
 * this test builds — so a screen that fell back to v1's `/api/summary` could
 * not satisfy them, it would render nothing. The `fetch` assertion makes that
 * explicit rather than implicit: this screen must not talk to the network at
 * all, because `ledgerd` does not serve the routes v1's Home used.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { SqlDriver } from "@ledger/client/store/driver";

import { Home } from "./Home";
import { MotionProvider } from "../app/MotionProvider";
import { FIXTURE_ROWS, projectionWith } from "../test/projectionFixture";
import { sqlBudgetSource } from "../v2/sources/budget";
import { sqlTxnSource } from "../v2/sources/transactions";

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async () => new Response("[]"));
  vi.stubGlobal("fetch", fetchMock);
});

function wrap(db: SqlDriver | null) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MotionProvider>
      <QueryClientProvider client={qc}>
        {db === null ? (
          <Home />
        ) : (
          <Home budgetSource={sqlBudgetSource(db)} txnSource={sqlTxnSource(db)} />
        )}
      </QueryClientProvider>
    </MotionProvider>,
  );
}

describe("Home on the projection", () => {
  it("totals the buckets from the local projection, in the home currency", async () => {
    const db = await projectionWith();
    wrap(db);

    // 125.00 groceries (need) + 49.99 entertainment (want) = 174.99 spent. The
    // 9,000.00 credit is income context, never spending; the USD row has no
    // rate so it contributes nothing; the review row is not confirmed.
    expect(await screen.findByText("174.99")).toBeInTheDocument();
    expect(screen.getByText("125.00")).toBeInTheDocument();
    expect(screen.getByText("49.99")).toBeInTheDocument();
    expect(screen.getByText("9,000.00")).toBeInTheDocument();
    // No target, no pace, no verdict — none of them has an op behind it.
    expect(screen.queryByText(/On track|Over pace|Over budget/)).toBeNull();
  });

  it("names what it left out instead of absorbing it into a total", async () => {
    const db = await projectionWith();
    wrap(db);

    // The USD row has no rate, and the unread message is not money.
    expect(await screen.findByText(/missing a home-currency rate/)).toBeInTheDocument();
    expect(screen.getByText(/couldn't be read/)).toBeInTheDocument();
  });

  it("lists the most recent transactions with signed amounts from the projection", async () => {
    const db = await projectionWith();
    wrap(db);

    // The five newest, so CARREFOUR (the oldest) is out of the recent list and
    // only in the totals above it.
    expect(await screen.findByText("NETFLIX")).toBeInTheDocument();
    expect(screen.getByText("SPINNEYS")).toBeInTheDocument();
    expect(screen.getByText("+9,000.00")).toBeInTheDocument();
    expect(screen.getByText("−49.99")).toBeInTheDocument();
    // The unparsed row is a message, not a 0.00 purchase.
    expect(screen.queryByText("−0.00")).toBeNull();
  });

  it("keeps money exact past 2^53, which a Number could not", async () => {
    const db = await projectionWith([
      { id: "big", amount: "9007199254740993", posted_at: "2026-08-01T08:00:00Z", merchant: "WHALE", category: "groceries" },
    ]);
    wrap(db);
    // In the hero and again on the Needs row: both are the same exact digits,
    // which is the assertion — a double would have rounded the last one.
    await waitFor(() => expect(screen.getAllByText("90,071,992,547,409.93").length).toBeGreaterThan(1));
  });

  it("never touches the network — there is no v1 endpoint behind this screen", async () => {
    const db = await projectionWith();
    wrap(db);
    await screen.findByText("NETFLIX");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("says the local ledger is closed rather than silently falling back to v1", async () => {
    // No v2 gate above it and no injected source: the one thing this must NOT
    // do is fetch /api/summary and look like it worked.
    wrap(null);
    expect(await screen.findByText("Your local ledger isn't open")).toBeInTheDocument();
    await waitFor(() => expect(fetchMock).not.toHaveBeenCalled());
  });

  it("refuses to present a stale projection as fact", async () => {
    const db = await projectionWith();
    db.prepare("UPDATE projection_meta SET complete = 0 WHERE id = 1").run();
    wrap(db);
    expect(await screen.findByText(/rebuilding after an update/)).toBeInTheDocument();
    // …and the buckets it would have shown are absent, not zeroed and passed off.
    expect(screen.queryByText("125.00")).toBeNull();
  });

  it("shows the empty state when the log holds no transactions", async () => {
    const db = await projectionWith([]);
    wrap(db);
    expect(await screen.findByText("No recent activity")).toBeInTheDocument();
    expect(FIXTURE_ROWS.length).toBeGreaterThan(0); // the default set is not what we used
  });
});
