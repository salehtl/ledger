import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "../components/Toast";
import { CategoryManager } from "./CategoryManager";

const CATS = [
  { ID: 1, Name: "Groceries", Kind: "spending", Bucket: "need", IsActive: true },
  { ID: 2, Name: "Salary", Kind: "income", Bucket: "", IsActive: true },
];

function mockFetch(usage: Record<number, { transactions: number; rules: number }>) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    const usageMatch = u.match(/\/api\/categories\/(\d+)\/usage$/);
    if (usageMatch) {
      const id = Number(usageMatch[1]);
      return new Response(JSON.stringify(usage[id] ?? { transactions: 0, rules: 0 }));
    }
    if (u === "/api/categories" && (!init || init.method === undefined || init.method === "GET")) {
      return new Response(JSON.stringify(CATS));
    }
    // POST/PUT/DELETE
    return new Response(JSON.stringify({ ok: true }));
  });
}

function wrap() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}><ToastProvider><CategoryManager onClose={() => {}} /></ToastProvider></QueryClientProvider>,
  );
}

describe("CategoryManager", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", mockFetch({ 1: { transactions: 3, rules: 0 }, 2: { transactions: 0, rules: 0 } }));
  });

  it("renders categories grouped by kind", async () => {
    wrap();
    expect(await screen.findByDisplayValue("Groceries")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Salary")).toBeInTheDocument();
    // group headings appear once data loads (there are multiple "Spending"/"Income" texts from the kind select
    // options, so we check using getAllByText and verify at least one is a paragraph heading)
    expect(screen.getAllByText("Spending").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Income").length).toBeGreaterThanOrEqual(1);
  });

  it("shows the bucket select on the add form only for spending kind", async () => {
    wrap();
    await screen.findByDisplayValue("Groceries");
    // spending is the default kind -> bucket select present
    expect(screen.getByLabelText(/new category bucket/i)).toBeInTheDocument();
    // switch to income -> bucket select disappears
    fireEvent.change(screen.getByLabelText(/new category kind/i), { target: { value: "income" } });
    expect(screen.queryByLabelText(/new category bucket/i)).not.toBeInTheDocument();
  });

  it("disables delete when the category is in use", async () => {
    wrap();
    // Groceries (id 1) has 3 transactions -> delete disabled
    const btn = await screen.findByRole("button", { name: /groceries in use/i });
    expect(btn).toBeDisabled();
  });

  it("posts a new category", async () => {
    const fetchMock = mockFetch({});
    vi.stubGlobal("fetch", fetchMock);
    wrap();
    await screen.findByDisplayValue("Groceries");
    fireEvent.change(screen.getByLabelText(/new category name/i), { target: { value: "Hobbies" } });
    fireEvent.click(screen.getByRole("button", { name: /^add$/i }));
    await waitFor(() => {
      const call = fetchMock.mock.calls.find((c) => c[0] === "/api/categories" && c[1]?.method === "POST");
      expect(call).toBeTruthy();
      expect(JSON.parse(String(call![1]!.body))).toMatchObject({ name: "Hobbies", kind: "spending", bucket: "need" });
    });
  });
});
