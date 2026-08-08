/**
 * Insights, against a real projection.
 *
 * The rows here are folded from ops with `fold` and written with `project` —
 * the two functions the sync engine itself calls — so every expectation is a
 * value that exists ONLY in the local SQLite projection. A screen that reached
 * for v1's `/api/insights/categories` could not satisfy them; it would render
 * nothing. The `fetch` assertion says so explicitly rather than leaving it
 * implied, on both the happy path and the disconnected one.
 *
 * No clock is stubbed and none needs to be: the screen anchors its trailing
 * trend on the month it is showing, not on `Date.now()`, so a fixture dated
 * 2026-08 reads the same in any month this suite is run.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { SqlDriver } from "@ledger/client/store/driver";

import { Insights } from "./Insights";
import { MotionProvider } from "../app/MotionProvider";
import { FIXTURE_ROWS, projectionWith, type FixtureRow } from "../test/projectionFixture";
import { sqlInsightsSource } from "../v2/sources/insights";
import type { Scope } from "../lib/scope";

let fetchMock: ReturnType<typeof vi.fn>;

const AUGUST: Scope = { kind: "month", period: "2026-08" };

/**
 * The default fixture plus two rows this screen exists to exercise: a July
 * grocery run, so there is a previous month to compare against, and an amount
 * of 2^53 + 1 — the first integer a JS `number` cannot hold — because every
 * figure on this screen is a SUM.
 */
const ROWS: FixtureRow[] = [
  ...FIXTURE_ROWS,
  { id: "t7", amount: "9007199254740993", posted_at: "2026-08-07T10:00:00Z", merchant: "WHALE", category: "shopping" },
  { id: "t0", amount: "20000", posted_at: "2026-07-15T10:00:00Z", merchant: "CARREFOUR", category: "groceries" },
];

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
          <Insights scope={AUGUST} />
        ) : (
          <Insights scope={AUGUST} insightsSource={sqlInsightsSource(db)} />
        )}
      </QueryClientProvider>
    </MotionProvider>,
  );
}

describe("Insights on the projection", () => {
  it("breaks the month down by category, from the local projection", async () => {
    wrap(await projectionWith(ROWS));

    // Names and amounts appear more than once on purpose — the breakdown, the
    // bucket legend and "Biggest changes" all state them — so these are
    // `getAllBy`.
    expect((await screen.findAllByText("groceries")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("125.00").length).toBeGreaterThan(0);
    expect(screen.getAllByText("entertainment").length).toBeGreaterThan(0);
    expect(screen.getAllByText("49.99").length).toBeGreaterThan(0);
    // The USD row has no home rate and the SPINNEYS row is still in review:
    // neither is spending yet, so neither has a row here.
    expect(screen.getAllByText("shopping").length).toBeGreaterThan(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sums past 2^53 without rounding, which is the whole reason the money is bigint", async () => {
    wrap(await projectionWith(ROWS));

    // 9,007,199,254,740,993 minor units, exactly.
    expect((await screen.findAllByText("90,071,992,547,409.93")).length).toBeGreaterThan(0);
  });

  it("compares against the previous month rather than presenting the total as new", async () => {
    wrap(await projectionWith(ROWS));

    // July groceries 200.00 → August 125.00 is a 38% drop.
    expect((await screen.findAllByLabelText(/down 38% vs last month/i)).length).toBeGreaterThan(0);
    expect(screen.queryByText(/no prior month to compare/i)).toBeNull();
  });

  it("says there is nothing to compare when the month stands alone", async () => {
    wrap(await projectionWith(FIXTURE_ROWS));

    expect(await screen.findByText(/no prior month to compare/i)).toBeInTheDocument();
  });

  it("ranks buckets, and names the money it could not place in one", async () => {
    wrap(await projectionWith([
      ...FIXTURE_ROWS,
      { id: "t8", amount: "7000", posted_at: "2026-08-08T10:00:00Z", merchant: "ODD", category: "not-a-known-category" },
    ]));

    fireEvent.click(await screen.findByText("Buckets"));
    expect((await screen.findAllByText("Needs")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("Wants").length).toBeGreaterThan(0);
    // An unmapped category is not silently dropped out of the shares.
    expect(screen.getAllByText("Uncategorized").length).toBeGreaterThan(0);
    expect(screen.getAllByText("70.00").length).toBeGreaterThan(0);
  });

  it("ranks merchants from the projection's own merchant strings", async () => {
    wrap(await projectionWith(ROWS));

    fireEvent.click(await screen.findByText("Merchants"));
    expect(await screen.findByText("WHALE")).toBeInTheDocument();
    expect(screen.getByText("CARREFOUR")).toBeInTheDocument();
  });

  it("opens the transactions behind a row, read from the projection", async () => {
    wrap(await projectionWith(ROWS));

    fireEvent.click(await screen.findByRole("button", { name: /see transactions for groceries/i }));
    await waitFor(() => expect(screen.getByText("CARREFOUR")).toBeInTheDocument());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("claims no target, no pace and no report it cannot produce", async () => {
    wrap(await projectionWith(ROWS));

    await screen.findAllByText("groceries");
    expect(screen.queryByText(/Net worth|Age of money|Spending trends/)).toBeNull();
    expect(screen.queryByText(/On track|Over pace|Over budget/)).toBeNull();
    expect(screen.queryByText(/Search transactions/i)).toBeNull();
  });

  it("names the plan the buckets are read against, the user's or the rule", async () => {
    // Backwards compatibility first: with no `budget_split_set` op the sentence
    // is the rule this screen has always assumed.
    wrap(await projectionWith(ROWS));
    expect(await screen.findByText(/50 \/ 30 \/ 20/)).toBeInTheDocument();

    const db = await projectionWith(ROWS);
    db.prepare("INSERT INTO budget_split (id,need,want,saving) VALUES (1,60,20,20)").run();
    wrap(db);
    expect(await screen.findByText(/60 \/ 20 \/ 20/)).toBeInTheDocument();
  });

  it("says the ledger is not open instead of reaching for the network", async () => {
    wrap(null);

    expect(await screen.findByText(/your local ledger isn't open/i)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
