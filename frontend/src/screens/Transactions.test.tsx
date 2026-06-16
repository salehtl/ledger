// frontend/src/screens/Transactions.test.tsx
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "../components/Toast";
import { Transactions } from "./Transactions";
import type { Txn, Category } from "../api/types";

const all: Txn[] = [
  { ID: 1, PostedAt: "2026-06-10", AmountFils: 5000, Currency: "AED", Direction: "debit", MerchantRaw: "SPINNEYS", Status: "needs_review", Confidence: 0, Source: "email", CategoryID: null, CategoryName: "", Bucket: "" },
  { ID: 2, PostedAt: "2026-06-09", AmountFils: 2500, Currency: "AED", Direction: "debit", MerchantRaw: "NETFLIX", Status: "confirmed", Confidence: 0, Source: "email", CategoryID: 2, CategoryName: "Subscriptions", Bucket: "want" },
];
const cats: Category[] = [{ ID: 1, Name: "Groceries", Kind: "spending", Bucket: "need", IsActive: true }];

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.includes("/api/categories")) return new Response(JSON.stringify(cats));
    if (url.includes("/api/transactions")) {
      const sp = new URL("http://x" + url.replace(/^[^/]*/, "")).searchParams;
      const status = sp.get("status");
      const from = sp.get("from");
      const to = sp.get("to");
      let rows = status ? all.filter((t) => t.Status === status) : all;
      if (from) rows = rows.filter((t) => t.PostedAt >= from);
      if (to) rows = rows.filter((t) => t.PostedAt <= to);
      return new Response(JSON.stringify(rows));
    }
    return new Response("[]");
  }));
});

function wrap() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><ToastProvider><Transactions /></ToastProvider></QueryClientProvider>);
}

describe("Transactions", () => {
  it("renders rows with a result count", async () => {
    wrap();
    expect(await screen.findByText("SPINNEYS")).toBeInTheDocument();
    expect(screen.getByText("NETFLIX")).toBeInTheDocument();
    expect(screen.getByText(/2 transactions/i)).toBeInTheDocument();
  });

  it("filters to needs-review via the segmented control", async () => {
    wrap();
    await screen.findByText("NETFLIX");
    fireEvent.click(screen.getByRole("button", { name: /needs review/i }));
    expect(await screen.findByText("SPINNEYS")).toBeInTheDocument();
    expect(screen.queryByText("NETFLIX")).not.toBeInTheDocument();
  });

  it("client-filters by search text", async () => {
    wrap();
    await screen.findByText("NETFLIX");
    fireEvent.change(screen.getByPlaceholderText(/search merchant/i), { target: { value: "spin" } });
    expect(screen.getByText("SPINNEYS")).toBeInTheDocument();
    expect(screen.queryByText("NETFLIX")).not.toBeInTheDocument();
  });

  it("scopes the list to a selected month", async () => {
    wrap();
    await screen.findByText("SPINNEYS");
    // sample rows are June 2026; selecting May yields none
    fireEvent.change(screen.getByLabelText(/^month$/i), { target: { value: "2026-05" } });
    expect(await screen.findByText(/no transactions/i)).toBeInTheDocument();
    expect(screen.queryByText("SPINNEYS")).not.toBeInTheDocument();
  });

  it("clears the month scope with All time", async () => {
    wrap();
    await screen.findByText("SPINNEYS");
    fireEvent.change(screen.getByLabelText(/^month$/i), { target: { value: "2026-05" } });
    await screen.findByText(/no transactions/i);
    fireEvent.click(screen.getByRole("button", { name: /all time/i }));
    expect(await screen.findByText("SPINNEYS")).toBeInTheDocument();
    expect(screen.getByText("NETFLIX")).toBeInTheDocument();
  });
});
