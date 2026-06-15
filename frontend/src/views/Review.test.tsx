// frontend/src/views/Review.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "../components/Toast";
import { Review } from "./Review";
import type { Txn, Category } from "../api/types";

const txns: Txn[] = [
  { ID: 1, PostedAt: "2026-06-10", AmountFils: 5000, Currency: "AED", Direction: "debit", MerchantRaw: "SPINNEYS", Status: "needs_review", Confidence: 0, Source: "email", CategoryID: null, CategoryName: "", Bucket: "" },
];
const cats: Category[] = [{ ID: 1, Name: "Groceries", Kind: "spending", Bucket: "need", IsActive: true }];

const calls: { url: string; body: unknown }[] = [];

beforeEach(() => {
  calls.length = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/review") return new Response(JSON.stringify(txns));
    if (url === "/api/categories") return new Response(JSON.stringify(cats));
    calls.push({ url, body: init?.body ? JSON.parse(init.body as string) : null });
    return new Response("{}");
  }));
});

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><ToastProvider>{ui}</ToastProvider></QueryClientProvider>);
}

describe("Review", () => {
  it("shows error state when /api/review fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url === "/api/review") return new Response("error", { status: 500 });
      if (url === "/api/categories") return new Response(JSON.stringify(cats));
      return new Response("{}");
    }));
    wrap(<Review />);
    expect(await screen.findByText(/couldn't load review/i)).toBeInTheDocument();
  });

  it("renders labeled Transfer and Ignore actions", async () => {
    wrap(<Review />);
    expect(await screen.findByRole("button", { name: /transfer/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /ignore/i })).toBeInTheDocument();
  });

  it("ignores an item and offers Undo", async () => {
    wrap(<Review />);
    fireEvent.click(await screen.findByRole("button", { name: /ignore/i }));
    await waitFor(() => expect(calls.some((c) => c.url === "/api/transactions/1/status")).toBe(true));
    expect(screen.getByText(/ignored/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /undo/i })).toBeInTheDocument();
  });
});
