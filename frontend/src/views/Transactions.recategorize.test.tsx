import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "../components/Toast";
import { Transactions } from "./Transactions";
import type { Txn, Category } from "../api/types";

const txns: Txn[] = [
  { ID: 7, PostedAt: "2026-06-09", AmountFils: 2500, Currency: "AED", Direction: "debit", MerchantRaw: "NOON", Status: "needs_review", Confidence: 0, Source: "email", CategoryID: null, CategoryName: "", Bucket: "" },
];
const cats: Category[] = [{ ID: 1, Name: "Shopping", Kind: "spending", Bucket: "want", IsActive: true }];

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.startsWith("/api/transactions")) return new Response(JSON.stringify(txns));
    if (url === "/api/categories") return new Response(JSON.stringify(cats));
    return new Response("{}");
  }));
});

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><ToastProvider>{ui}</ToastProvider></QueryClientProvider>);
}

describe("Transactions", () => {
  it("shows a human status pill and a count", async () => {
    wrap(<Transactions />);
    expect(await screen.findByText("Needs review", { selector: ".pill" })).toBeInTheDocument();
    expect(screen.getByText(/1 transaction/i)).toBeInTheDocument();
  });

  it("opens the categorize dialog when a row is tapped", async () => {
    wrap(<Transactions />);
    fireEvent.click(await screen.findByText("NOON"));
    expect(await screen.findByRole("button", { name: /ok/i })).toBeInTheDocument();
  });
});
