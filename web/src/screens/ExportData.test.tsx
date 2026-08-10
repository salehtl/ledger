/**
 * Downloading the ledger, over the real projection.
 *
 * The rows come from `projectionFixture`, which folds real ops and projects
 * them the way the sync engine does — so a screen that reached for anything
 * other than the local projection would find nothing here. `fetch` throws
 * throughout: the whole claim is that no server assembles this file.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import type { SqlDriver } from "@ledger/client/store/driver";

import { MotionProvider } from "../app/MotionProvider";
import { projectionWith } from "../test/projectionFixture";
import { parseCSV } from "@ledger/client/importer/csv";
import { sqlTxnSource } from "../v2/sources/transactions";
import { ExportData, readAllTxns } from "./ExportData";

let saved: { name: string; text: string } | null = null;

function mount(db: SqlDriver) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MotionProvider>
      <QueryClientProvider client={qc}>
        <ExportData
          source={sqlTxnSource(db)}
          now={() => new Date("2026-08-09T22:00:00Z")}
          saveAs={(name, text) => {
            saved = { name, text };
          }}
        />
      </QueryClientProvider>
    </MotionProvider>,
  );
}

beforeEach(() => {
  saved = null;
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("exporting must never reach the network");
    }),
  );
});

describe("downloading", () => {
  it("writes a dated CSV of the transactions this device holds", async () => {
    const db = await projectionWith();
    mount(db);
    await userEvent.click(screen.getByTestId("export-download"));

    expect(saved).not.toBeNull();
    expect(saved!.name).toBe("ledger-2026-08-09.csv");
    const { headers, rows } = parseCSV(saved!.text);
    expect(headers).toEqual(["Date", "Description", "Amount", "Currency", "Direction", "Category"]);
    expect(rows.map((r) => r["Description"])).toContain("CARREFOUR");
    expect(rows.find((r) => r["Description"] === "CARREFOUR")).toMatchObject({
      Date: "2026-08-01",
      Amount: "-125.00",
      Currency: "AED",
      Direction: "Spending",
      Category: "groceries",
    });
    expect(rows.find((r) => r["Description"] === "SALARY")).toMatchObject({ Amount: "9000.00", Direction: "Income" });
  });

  it("leaves out the message no tier could read, rather than exporting a 0.00 line", async () => {
    const db = await projectionWith();
    mount(db);
    await userEvent.click(screen.getByTestId("export-download"));
    const { rows } = parseCSV(saved!.text);
    // The fixture's `t6` is unparsed: no amount, no currency, no merchant.
    expect(rows.every((r) => r["Amount"] !== "0.00")).toBe(true);
    expect(rows.every((r) => r["Description"] !== "")).toBe(true);
  });

  it("says what it holds, and says a device that has not synced may hold less", async () => {
    const db = await projectionWith();
    mount(db);
    // No V2 runtime in this test, so `lastCompletedAt` is unknown — which the
    // screen must report as "may not be your whole ledger", never as complete.
    expect(screen.getByTestId("export-scope")).toHaveTextContent("has not finished a sync");
    expect(screen.getByTestId("export-count")).toHaveTextContent("5 transactions on this device.");
  });

  it("reports how many rows were saved", async () => {
    const db = await projectionWith();
    mount(db);
    await userEvent.click(screen.getByTestId("export-download"));
    expect(await screen.findByTestId("export-done")).toHaveTextContent("5 transactions saved.");
  });
});

describe("reading the projection", () => {
  it("walks every page rather than one window", async () => {
    const rows = Array.from({ length: 1200 }, (_, i) => ({
      id: `p${i}`,
      amount: `${i + 1}00`,
      posted_at: `2026-0${(i % 8) + 1}-0${(i % 9) + 1}T10:00:00Z`,
      merchant: `SHOP ${i}`,
      category: "groceries",
    }));
    const db = await projectionWith(rows);
    // 1,200 rows is more than one 500-row page, which is the whole point: an
    // export that stopped at the first page would silently be a third of a
    // ledger.
    expect(readAllTxns(sqlTxnSource(db))).toHaveLength(1200);
  });
});
