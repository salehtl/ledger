// frontend/src/screens/Transactions.test.tsx
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "../components/Toast";
import { Transactions } from "./Transactions";
import type { Txn, Category } from "../api/types";

const all: Txn[] = [
  { ID: 1, PostedAt: "2026-06-10", AmountFils: 5000, Currency: "AED", Direction: "debit", MerchantRaw: "SPINNEYS", Status: "needs_review", Confidence: 0, Source: "email", CategoryID: null, CategoryName: "", Bucket: "", Kind: "", BucketSnapshot: "" },
  { ID: 2, PostedAt: "2026-06-09", AmountFils: 2500, Currency: "AED", Direction: "debit", MerchantRaw: "NETFLIX", Status: "confirmed", Confidence: 0, Source: "email", CategoryID: 2, CategoryName: "Subscriptions", Bucket: "want", Kind: "spending", BucketSnapshot: "" },
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

function wrap(props: { from?: string; to?: string } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><ToastProvider><Transactions {...props} /></ToastProvider></QueryClientProvider>);
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

  it("filters by bucket via the chip picker", async () => {
    wrap();
    await screen.findByText("NETFLIX");
    fireEvent.click(screen.getByRole("button", { name: /^bucket/i }));
    fireEvent.click(screen.getByLabelText("Wants"));
    fireEvent.click(screen.getByRole("button", { name: /done/i }));
    expect(screen.getByText("NETFLIX")).toBeInTheDocument();
    expect(screen.queryByText("SPINNEYS")).not.toBeInTheDocument();
  });

  it("ANDs a bucket chip with a direction chip", async () => {
    wrap();
    await screen.findByText("NETFLIX");
    fireEvent.click(screen.getByRole("button", { name: /^bucket/i }));
    fireEvent.click(screen.getByLabelText("Wants"));
    fireEvent.click(screen.getByRole("button", { name: /done/i }));
    fireEvent.click(screen.getByRole("button", { name: /^direction/i }));
    fireEvent.click(screen.getByLabelText("Income")); // credit — NETFLIX is debit
    fireEvent.click(screen.getByRole("button", { name: /done/i }));
    expect(screen.queryByText("NETFLIX")).not.toBeInTheDocument();
    expect(await screen.findByText(/no transactions/i)).toBeInTheDocument();
  });

  it("Clear restores all rows", async () => {
    wrap();
    await screen.findByText("NETFLIX");
    fireEvent.click(screen.getByRole("button", { name: /^bucket/i }));
    fireEvent.click(screen.getByLabelText("Wants"));
    fireEvent.click(screen.getByRole("button", { name: /done/i }));
    expect(screen.queryByText("SPINNEYS")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^clear$/i }));
    expect(await screen.findByText("SPINNEYS")).toBeInTheDocument();
  });

  it("scopes to the from/to bounds it is given", async () => {
    wrap({ from: "2026-05-01", to: "2026-05-32" }); // May → no June rows
    expect(await screen.findByText(/no transactions/i)).toBeInTheDocument();
    expect(screen.queryByText("SPINNEYS")).not.toBeInTheDocument();
  });

  it("opens the Add transaction sheet", async () => {
    wrap();
    await screen.findByText("NETFLIX");
    fireEvent.click(screen.getByRole("button", { name: /add transaction/i }));
    expect(await screen.findByRole("button", { name: /^add$/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/merchant/i)).toBeInTheDocument();
  });

  it("archives a row via its Archive action", async () => {
    wrap();
    await screen.findByText("SPINNEYS");
    const calls: string[] = [];
    const realFetch = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    realFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") { calls.push(url); return new Response("{}"); }
      if (url.includes("/api/categories")) return new Response(JSON.stringify(cats));
      return new Response(JSON.stringify(all));
    });
    fireEvent.click(screen.getAllByRole("button", { name: /^archive$/i })[0]);
    await screen.findByText(/archived/i); // toast
    expect(calls.some((u) => /\/api\/transactions\/\d+\/archive$/.test(u))).toBe(true);
  });
});
