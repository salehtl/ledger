/**
 * The drill-in, against a real projection.
 *
 * The assertions that matter are the ones about the *total*: this sheet prints
 * a figure in the same units, directly under the breakdown row it was opened
 * from, and a first cut of it could contradict that row two different ways. So
 * the merchant case and the split case are here, and both compare against the
 * breakdown's own number rather than against a literal.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ensureProjection, PROJECTION_VERSION } from "@ledger/client/replay/projection";
import type { SqlDriver } from "@ledger/client/store/driver";

import { MotionProvider } from "../../app/MotionProvider";
import { openBrowserDriver } from "../../v2/db/driver";
import { sqlInsightsSource, type DrillTarget } from "../../v2/sources/insights";
import { ProjectionDrillSheet } from "./ProjectionDrillSheet";

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async () => new Response("[]"));
  vi.stubGlobal("fetch", fetchMock);
});

type AddOpts = { home?: string; merchant?: string; category?: string | null };

async function setup() {
  const db: SqlDriver = await openBrowserDriver(`drill-${crypto.randomUUID()}`);
  ensureProjection(db);
  db.prepare(
    `INSERT INTO projection_meta (id,version,cursor_hot,cursor_cold,home_currency,complete) VALUES (1,${PROJECTION_VERSION},'0','0','AED',1)`,
  ).run();
  const add = (id: string, o: AddOpts = {}) =>
    db
      .prepare(
        `INSERT INTO txn (id,ingest_id,amount_minor,currency,direction,posted_at,merchant_raw,last4,category,needs_review,provenance,amount_home_minor,unparsed,tier,parse_error,superseded_by,possible_duplicate_of,version)
         VALUES (?,?,?, 'AED','debit','2026-08-02T00:00:00.000Z',?,'',?,0,'ingest',?,0,'template',NULL,NULL,NULL,1)`,
      )
      .run(id, id.padEnd(64, "a"), o.home ?? "100", o.merchant ?? "M", o.category ?? null, o.home ?? "100");
  return { db, add };
}

function wrap(db: SqlDriver | null, target: DrillTarget) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MotionProvider>
      <QueryClientProvider client={qc}>
        <ProjectionDrillSheet
          target={target}
          period="2026-08"
          currency="AED"
          source={db === null ? null : sqlInsightsSource(db)}
          // This fixture defines no categories, so the rows fall back to the
          // built-in table — said explicitly, because the prop is required
          // precisely so that an empty set is a decision rather than a default.
          categoryDefs={[]}
          onClose={() => {}}
        />
      </QueryClientProvider>
    </MotionProvider>,
  );
}

describe("ProjectionDrillSheet", () => {
  it("totals the exact merchant, not everything the name is a prefix of", async () => {
    const { db, add } = await setup();
    add("a", { home: "100", merchant: "CARREFOUR", category: "groceries" });
    add("b", { home: "900", merchant: "CARREFOUR MARKET", category: "groceries" });

    wrap(db, { type: "merchant", merchant: "CARREFOUR", name: "CARREFOUR" });

    // 1.00 — the row that was tapped. A LIKE would print 10.00 here.
    expect(await screen.findByText("AED 1.00")).toBeInTheDocument();
    expect(screen.getByText("1 transaction")).toBeInTheDocument();
    expect(screen.queryByText("CARREFOUR MARKET")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("counts only the part of a split that belongs here, and says the rows do not add up to it", async () => {
    const { db, add } = await setup();
    add("s", { home: "100", merchant: "SPLIT", category: "ignored" });
    const put = db.prepare("INSERT INTO txn_split (txn_id,idx,category,amount_minor,amount_home_minor) VALUES (?,?,?,?,?)");
    put.run("s", 0, "groceries", "1", "33");
    put.run("s", 1, "dining", "1", "67");

    wrap(db, { type: "category", category: "groceries", name: "groceries" });

    expect(await screen.findByText("AED 0.33")).toBeInTheDocument();
    expect(screen.getByText(/counts only the parts in this group/i)).toBeInTheDocument();
  });

  it("says the list is capped while still totalling the whole month", async () => {
    const { db, add } = await setup();
    for (let i = 0; i < 3; i++) add(`r${i}`, { home: "100", category: "groceries" });

    wrap(db, { type: "category", category: "groceries", name: "groceries" });

    expect(await screen.findByText("AED 3.00")).toBeInTheDocument();
    // DRILL_LIMIT is 100, so nothing is capped here; the plain count shows.
    expect(screen.getByText("3 transactions")).toBeInTheDocument();
    expect(screen.queryByText(/showing the/i)).toBeNull();
  });

  it("shows an empty state rather than a zero total when nothing matches", async () => {
    const { db, add } = await setup();
    add("g", { home: "100", category: "groceries" });

    wrap(db, { type: "category", category: "dining", name: "dining" });

    expect(await screen.findByText(/nothing here this month/i)).toBeInTheDocument();
    expect(screen.queryByText("AED 0.00")).toBeNull();
  });

  it("says the ledger is not open instead of reaching for the network", async () => {
    wrap(null, { type: "category", category: "dining", name: "dining" });

    expect(await screen.findByText(/your local ledger isn't open/i)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
