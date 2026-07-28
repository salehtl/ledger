import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "../components/Toast";
import { CategoryManager } from "./CategoryManager";

const CATS = [
  { ID: 1, Name: "Groceries", Kind: "spending", Bucket: "need", IsActive: true },
  { ID: 2, Name: "Salary", Kind: "income", Bucket: "", IsActive: true },
  { ID: 3, Name: "Dining", Kind: "spending", Bucket: "want", IsActive: true },
];

function mockFetch(usage: Record<number, { transactions: number; rules: number }>, overrides?: (url: string, init?: RequestInit) => Response | null) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);

    // Allow caller to intercept specific requests
    if (overrides) {
      const result = overrides(u, init);
      if (result !== null) return result;
    }

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

const USAGE = { 1: { transactions: 3, rules: 1 }, 2: { transactions: 0, rules: 0 }, 3: { transactions: 0, rules: 0 } };

describe("CategoryManager", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", mockFetch(USAGE));
  });

  it("renders one section per bucket plus income and excluded", async () => {
    wrap();
    expect(await screen.findByText("Groceries")).toBeInTheDocument();
    const needs = screen.getByTestId("section-need");
    expect(within(needs).getByText("Needs")).toBeInTheDocument();
    expect(within(needs).getByText("Groceries")).toBeInTheDocument();
    expect(within(screen.getByTestId("section-want")).getByText("Dining")).toBeInTheDocument();
    expect(within(screen.getByTestId("section-income")).getByText("Salary")).toBeInTheDocument();
    // Rows are calm text, not form fields
    expect(screen.queryByLabelText("Rename Groceries")).not.toBeInTheDocument();
  });

  it("overlay has a solid theme background, not a broken CSS-var class (regression)", async () => {
    const { container } = wrap();
    await screen.findByText("Groceries");
    const overlay = container.firstChild as HTMLElement;
    expect(overlay.className).toContain("fixed");
    expect(overlay.className).toContain("bg-bg");
    expect(overlay.className).not.toMatch(/bg-\[--/);
  });

  it("shows compact usage on in-use rows and stays quiet on unused ones", async () => {
    wrap();
    expect(await screen.findByText(/3 txns · 1 rule/i)).toBeInTheDocument();
    expect(screen.queryByText(/unused/i)).not.toBeInTheDocument();
  });

  it("tapping a name edits it in place; Enter saves", async () => {
    const fetchMock = mockFetch(USAGE);
    vi.stubGlobal("fetch", fetchMock);
    wrap();
    fireEvent.click(await screen.findByRole("button", { name: /edit groceries/i }));
    const input = screen.getByLabelText("Rename Groceries");
    fireEvent.change(input, { target: { value: "Food & Groceries" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => {
      const call = fetchMock.mock.calls.find((c) => c[0] === "/api/categories/1" && c[1]?.method === "PUT");
      expect(call).toBeTruthy();
      expect(JSON.parse(String(call![1]!.body))).toMatchObject({ name: "Food & Groceries", bucket: "need" });
    });
  });

  it("Escape cancels an in-place edit without saving", async () => {
    const fetchMock = mockFetch(USAGE);
    vi.stubGlobal("fetch", fetchMock);
    wrap();
    fireEvent.click(await screen.findByRole("button", { name: /edit groceries/i }));
    const input = screen.getByLabelText("Rename Groceries");
    fireEvent.change(input, { target: { value: "Oops" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByLabelText("Rename Groceries")).not.toBeInTheDocument();
    expect(screen.getByText("Groceries")).toBeInTheDocument();
    expect(fetchMock.mock.calls.some((c) => c[1]?.method === "PUT")).toBe(false);
  });

  it("while editing, bucket dots move the category in one tap", async () => {
    const fetchMock = mockFetch(USAGE);
    vi.stubGlobal("fetch", fetchMock);
    wrap();
    fireEvent.click(await screen.findByRole("button", { name: /edit groceries/i }));
    fireEvent.click(screen.getByRole("button", { name: /move to wants/i }));
    await waitFor(() => {
      const call = fetchMock.mock.calls.find((c) => c[0] === "/api/categories/1" && c[1]?.method === "PUT");
      expect(call).toBeTruthy();
      expect(JSON.parse(String(call![1]!.body))).toMatchObject({ bucket: "want" });
    });
  });

  it("delete is always visible: disabled with the reason while in use, live otherwise", async () => {
    const fetchMock = mockFetch(USAGE);
    vi.stubGlobal("fetch", fetchMock);
    wrap();
    const guarded = await screen.findByRole("button", { name: /groceries in use/i });
    expect(guarded).toBeDisabled();
    const live = await screen.findByRole("button", { name: "Delete Salary" });
    expect(live).not.toBeDisabled();
    fireEvent.click(live);
    await waitFor(() => {
      expect(fetchMock.mock.calls.some((c) => c[0] === "/api/categories/2" && c[1]?.method === "DELETE")).toBe(true);
    });
  });

  it("section-header + adds a new category in place with kind and bucket inferred", async () => {
    const fetchMock = mockFetch(USAGE);
    vi.stubGlobal("fetch", fetchMock);
    wrap();
    await screen.findByText("Groceries");
    fireEvent.click(screen.getByRole("button", { name: /add to wants/i }));
    const input = screen.getByLabelText("New category in Wants");
    fireEvent.change(input, { target: { value: "Hobbies" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => {
      const call = fetchMock.mock.calls.find((c) => c[0] === "/api/categories" && c[1]?.method === "POST");
      expect(call).toBeTruthy();
      expect(JSON.parse(String(call![1]!.body))).toMatchObject({ name: "Hobbies", kind: "spending", bucket: "want" });
    });
  });

  it("adding under Income infers the income kind with no bucket", async () => {
    const fetchMock = mockFetch(USAGE);
    vi.stubGlobal("fetch", fetchMock);
    wrap();
    await screen.findByText("Groceries");
    fireEvent.click(screen.getByRole("button", { name: /add to income/i }));
    const input = screen.getByLabelText("New category in Income");
    fireEvent.change(input, { target: { value: "Dividends" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => {
      const call = fetchMock.mock.calls.find((c) => c[0] === "/api/categories" && c[1]?.method === "POST");
      expect(call).toBeTruthy();
      expect(JSON.parse(String(call![1]!.body))).toMatchObject({ name: "Dividends", kind: "income", bucket: "" });
    });
  });

  it("Escape abandons an inline add without posting", async () => {
    const fetchMock = mockFetch(USAGE);
    vi.stubGlobal("fetch", fetchMock);
    wrap();
    await screen.findByText("Groceries");
    fireEvent.click(screen.getByRole("button", { name: /add to needs/i }));
    const input = screen.getByLabelText("New category in Needs");
    fireEvent.change(input, { target: { value: "Nope" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByLabelText("New category in Needs")).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.some((c) => c[1]?.method === "POST")).toBe(false);
  });

  it("filters categories by name", async () => {
    wrap();
    await screen.findByText("Groceries");
    fireEvent.change(screen.getByRole("searchbox", { name: /search categories/i }), { target: { value: "salary" } });
    expect(screen.getByText("Salary")).toBeInTheDocument();
    expect(screen.queryByText("Groceries")).not.toBeInTheDocument();
  });

  it("rename with duplicate name shows friendly toast", async () => {
    const fetchMock = mockFetch(USAGE, (url, init) => {
      if (url === "/api/categories/1" && init?.method === "PUT") {
        return new Response(JSON.stringify({ error: "name exists" }), { status: 409 });
      }
      return null;
    });
    vi.stubGlobal("fetch", fetchMock);
    wrap();
    fireEvent.click(await screen.findByRole("button", { name: /edit groceries/i }));
    const input = screen.getByLabelText("Rename Groceries");
    fireEvent.change(input, { target: { value: "Salary" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => {
      expect(screen.getByText("A category with that name already exists.")).toBeInTheDocument();
    });
  });
});
