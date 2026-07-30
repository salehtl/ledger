// frontend/src/screens/Transactions.test.tsx
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "../components/Toast";
import { Transactions } from "./Transactions";
import type { Category } from "../api/types";
import type { TxnDepth } from "../lib/txSplit";

const all: TxnDepth[] = [
  { ID: 1, PostedAt: "2026-06-10", AmountFils: 5000, AmountAedFils: 5000, Currency: "AED", Direction: "debit", MerchantRaw: "SPINNEYS", Status: "needs_review", Confidence: 0, Source: "email", CategoryID: null, CategoryName: "", Bucket: "", Kind: "", BucketSnapshot: "", ProjectID: 7 },
  { ID: 2, PostedAt: "2026-06-09", AmountFils: 2500, AmountAedFils: 2500, Currency: "AED", Direction: "debit", MerchantRaw: "NETFLIX", Status: "confirmed", Confidence: 0, Source: "email", CategoryID: 2, CategoryName: "Subscriptions", Bucket: "want", Kind: "spending", BucketSnapshot: "" },
  {
    ID: 3, PostedAt: "2026-06-08", AmountFils: 9000, AmountAedFils: 9000, Currency: "AED", Direction: "debit", MerchantRaw: "CARREFOUR CITY", Status: "confirmed", Confidence: 0, Source: "email", CategoryID: null, CategoryName: "", Bucket: "", Kind: "", BucketSnapshot: "",
    Splits: [
      { ID: 11, TransactionID: 3, CategoryID: 1, AmountFils: 6000, Note: "mine" },
      { ID: 12, TransactionID: 3, CategoryID: 2, AmountFils: 3000 },
    ],
  },
];
const cats: Category[] = [
  { ID: 1, Name: "Groceries", Kind: "spending", Bucket: "need", IsActive: true },
  { ID: 2, Name: "Subscriptions", Kind: "spending", Bucket: "want", IsActive: true },
];
const rules = [
  { ID: 4, MatchType: "contains", Pattern: "netflix", CategoryID: 2, Priority: 100, Source: "ai_confirmed", IsActive: true },
];
const projects = [
  { id: 7, name: "Kitchen reno", budget_fils: null, color: "#1373d9", starts_on: "", ends_on: "", status: "active", count_in_monthly: false, completed_at: "", net_spent_fils: 0, pending_fils: 0, txn_count: 1 },
];

let calls: { url: string; method?: string }[];

beforeEach(() => {
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method });
    if (init?.method === "POST" || init?.method === "PUT") return new Response("{}");
    if (url.includes("/api/rules")) return new Response(JSON.stringify(rules));
    if (url.includes("/api/categories")) return new Response(JSON.stringify(cats));
    if (/\/api\/transactions\/\d+\/email$/.test(url)) {
      return new Response(JSON.stringify({ error: "source email unavailable" }), { status: 404 });
    }
    if (url.includes("/api/transactions/export")) return new Response("id,merchant\n1,SPINNEYS\n");
    if (url.includes("/api/projects")) return new Response(JSON.stringify(projects));
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

afterEach(() => {
  vi.unstubAllGlobals();
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
    expect(screen.getByText(/3 transactions/i)).toBeInTheDocument();
  });

  it("filters to review via the segmented control", async () => {
    wrap();
    await screen.findByText("NETFLIX");
    fireEvent.click(screen.getByRole("button", { name: /review/i }));
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

  it("filters by bucket with an inline chip", async () => {
    wrap();
    await screen.findByText("NETFLIX");
    fireEvent.click(screen.getByRole("button", { name: /filters/i }));
    fireEvent.click(screen.getByRole("button", { name: "Wants" }));
    expect(screen.getByText("NETFLIX")).toBeInTheDocument();
    expect(screen.queryByText("SPINNEYS")).not.toBeInTheDocument();
  });

  it("ANDs a bucket chip with a type chip", async () => {
    wrap();
    await screen.findByText("NETFLIX");
    fireEvent.click(screen.getByRole("button", { name: /filters/i }));
    fireEvent.click(screen.getByRole("button", { name: "Wants" }));
    fireEvent.click(screen.getByRole("button", { name: "Income" })); // credit — both rows are debit
    expect(screen.queryByText("NETFLIX")).not.toBeInTheDocument();
    expect(await screen.findByText(/no transactions/i)).toBeInTheDocument();
  });

  it("Clear all restores every row", async () => {
    wrap();
    await screen.findByText("NETFLIX");
    fireEvent.click(screen.getByRole("button", { name: /filters/i }));
    fireEvent.click(screen.getByRole("button", { name: "Wants" }));
    expect(screen.queryByText("SPINNEYS")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /clear all/i }));
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

  it("archives a row from its detail sheet", async () => {
    wrap();
    await screen.findByText("SPINNEYS");
    fireEvent.click(screen.getByRole("button", { name: /open spinneys/i }));
    fireEvent.click(await screen.findByRole("button", { name: /^archive$/i }));
    await screen.findByText(/archived/i); // toast
    expect(calls.some((c) => c.method === "POST" && /\/api\/transactions\/\d+\/archive$/.test(c.url))).toBe(true);
  });

  it("shows a project chip on a row assigned to an active project", async () => {
    wrap();
    await screen.findByText("SPINNEYS");
    expect(await screen.findByText("Kitchen reno")).toBeInTheDocument();
  });

  it("renders a split parent with its lines' categories and an expandable stack", async () => {
    wrap();
    await screen.findByText("CARREFOUR CITY");
    expect(screen.getByText(/Split · Groceries \+ Subscriptions/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /show 2 parts/i }));
    expect(screen.getByText("60.00")).toBeInTheDocument();
    expect(screen.getByText("30.00")).toBeInTheDocument();
    expect(screen.getByText("mine")).toBeInTheDocument();
  });

  it("edits a split from the detail sheet and un-splits with an empty set", async () => {
    wrap();
    await screen.findByText("CARREFOUR CITY");
    fireEvent.click(screen.getByRole("button", { name: /open carrefour city/i }));
    fireEvent.click(await screen.findByRole("button", { name: /edit split/i }));
    // The sheet opens prefilled from the stored lines; removing both un-splits.
    fireEvent.click(await screen.findByRole("button", { name: /remove groceries/i }));
    fireEvent.click(screen.getByRole("button", { name: /remove subscriptions/i }));
    fireEvent.click(screen.getByRole("button", { name: /remove split/i }));
    await screen.findByText(/removed split/i); // toast with undo
    expect(calls.some((c) => c.method === "PUT" && c.url === "/api/transactions/3/splits")).toBe(true);
  });

  it("splits a confirmed transaction from its detail sheet", async () => {
    wrap();
    await screen.findByText("NETFLIX");
    fireEvent.click(screen.getByRole("button", { name: /open netflix/i }));
    fireEvent.click(await screen.findByRole("button", { name: /split across categories/i }));
    fireEvent.click(await screen.findByRole("button", { name: "Groceries" }));
    fireEvent.change(screen.getByLabelText("Amount for Groceries"), { target: { value: "10" } });
    fireEvent.click(screen.getByRole("button", { name: "Subscriptions" }));
    fireEvent.click(screen.getByRole("button", { name: /save split/i }));
    await screen.findByText(/split netflix across 2 categories/i); // toast
    expect(calls.some((c) => c.method === "PUT" && c.url === "/api/transactions/2/splits")).toBe(true);
  });

  it("renames a merchant through the rules write-back", async () => {
    wrap();
    await screen.findByText("NETFLIX");
    fireEvent.click(screen.getByRole("button", { name: /open netflix/i }));
    fireEvent.click(await screen.findByRole("button", { name: /rename merchant/i }));
    fireEvent.change(await screen.findByLabelText(/shown as/i), { target: { value: "Netflix" } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await screen.findByText(/shown as “netflix” from now on/i); // toast
    expect(calls.some((c) => c.method === "PUT" && c.url === "/api/rules/4/display-name")).toBe(true);
  });

  it("opens the source email preview from the detail sheet", async () => {
    wrap();
    await screen.findByText("NETFLIX");
    fireEvent.click(screen.getByRole("button", { name: /open netflix/i }));
    fireEvent.click(await screen.findByRole("button", { name: /source email/i }));
    expect(await screen.findByText(/no source email is available/i)).toBeInTheDocument();
  });

  it("exports via the platform share sheet with the current server-side filters", async () => {
    const share = vi.fn(() => Promise.resolve());
    (navigator as unknown as { canShare: () => boolean }).canShare = () => true;
    (navigator as unknown as { share: typeof share }).share = share;
    wrap({ from: "2026-06-01", to: "2026-06-32" });
    await screen.findByText("NETFLIX");
    fireEvent.click(screen.getByRole("button", { name: /confirmed/i }));
    fireEvent.change(screen.getByPlaceholderText(/search merchant/i), { target: { value: "net" } });
    fireEvent.click(screen.getByRole("button", { name: /export csv/i }));
    await waitFor(() => expect(share).toHaveBeenCalled());
    expect(calls.some((c) => c.url ===
      "/api/transactions/export?status=confirmed&from=2026-06-01&to=2026-06-32&q=net")).toBe(true);
  });
});
