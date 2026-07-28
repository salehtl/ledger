import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "../components/Toast";
import { CategoryManager } from "./CategoryManager";

const CATS = [
  { ID: 1, Name: "Groceries", Kind: "spending", Bucket: "need", IsActive: true },
  { ID: 2, Name: "Salary", Kind: "income", Bucket: "", IsActive: true },
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

/** Expand a category's row into its inline editor. */
async function expand(name: string) {
  fireEvent.click(await screen.findByRole("button", { name: new RegExp(`edit ${name}`, "i") }));
}

describe("CategoryManager", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", mockFetch({ 1: { transactions: 3, rules: 1 }, 2: { transactions: 0, rules: 0 } }));
  });

  it("renders categories grouped by kind as calm text rows, not inputs", async () => {
    wrap();
    expect(await screen.findByText("Groceries")).toBeInTheDocument();
    expect(screen.getByText("Salary")).toBeInTheDocument();
    // Collapsed rows carry no form fields
    expect(screen.queryByLabelText("Rename Groceries")).not.toBeInTheDocument();
    expect(screen.getAllByText("Spending").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Income").length).toBeGreaterThanOrEqual(1);
  });

  it("overlay has a solid theme background, not a broken CSS-var class (regression)", async () => {
    const { container } = wrap();
    await screen.findByText("Groceries");
    const overlay = container.firstChild as HTMLElement;
    expect(overlay.className).toContain("fixed");
    expect(overlay.className).toContain("bg-bg");
    expect(overlay.className).not.toMatch(/bg-\[--/);
  });

  it("shows compact usage on collapsed rows, and stays quiet for unused ones", async () => {
    wrap();
    expect(await screen.findByText(/3 txns · 1 rule/i)).toBeInTheDocument();
    expect(screen.queryByText(/unused/i)).not.toBeInTheDocument();
  });

  it("expanding a row reveals the editor; rename saves via the Save button", async () => {
    const fetchMock = mockFetch({ 1: { transactions: 3, rules: 1 }, 2: { transactions: 0, rules: 0 } });
    vi.stubGlobal("fetch", fetchMock);
    wrap();
    await expand("Groceries");
    const input = screen.getByLabelText("Rename Groceries");
    fireEvent.change(input, { target: { value: "Food & Groceries" } });
    fireEvent.click(screen.getByRole("button", { name: /save name/i }));
    await waitFor(() => {
      const call = fetchMock.mock.calls.find((c) => c[0] === "/api/categories/1" && c[1]?.method === "PUT");
      expect(call).toBeTruthy();
      expect(JSON.parse(String(call![1]!.body))).toMatchObject({ name: "Food & Groceries" });
    });
  });

  it("bucket dot-chips in the expanded row move the category", async () => {
    const fetchMock = mockFetch({ 1: { transactions: 3, rules: 1 }, 2: { transactions: 0, rules: 0 } });
    vi.stubGlobal("fetch", fetchMock);
    wrap();
    await expand("Groceries");
    fireEvent.click(screen.getByRole("button", { name: "Wants" }));
    await waitFor(() => {
      const call = fetchMock.mock.calls.find((c) => c[0] === "/api/categories/1" && c[1]?.method === "PUT");
      expect(call).toBeTruthy();
      expect(JSON.parse(String(call![1]!.body))).toMatchObject({ bucket: "want" });
    });
  });

  it("delete is disabled with an explanation while the category is in use", async () => {
    wrap();
    await expand("Groceries");
    const btn = screen.getByRole("button", { name: /groceries in use/i });
    expect(btn).toBeDisabled();
    expect(screen.getByText(/reassign/i)).toBeInTheDocument();
  });

  it("delete fires for an unused category", async () => {
    const fetchMock = mockFetch({ 1: { transactions: 3, rules: 1 }, 2: { transactions: 0, rules: 0 } });
    vi.stubGlobal("fetch", fetchMock);
    wrap();
    await expand("Salary");
    const btn = screen.getByRole("button", { name: "Delete Salary" });
    expect(btn).not.toBeDisabled();
    fireEvent.click(btn);
    await waitFor(() => {
      const call = fetchMock.mock.calls.find((c) => c[0] === "/api/categories/2" && c[1]?.method === "DELETE");
      expect(call).toBeTruthy();
    });
  });

  it("add form picks kind with a segmented control and bucket with dot-chips", async () => {
    const fetchMock = mockFetch({});
    vi.stubGlobal("fetch", fetchMock);
    wrap();
    await screen.findByText("Groceries");
    fireEvent.click(screen.getByRole("button", { name: /^new$/i }));
    const form = screen.getByTestId("new-category-form");
    // Spending default -> bucket chips present; pick Wants
    fireEvent.click(within(form).getByRole("button", { name: "Wants" }));
    fireEvent.change(screen.getByLabelText(/new category name/i), { target: { value: "Hobbies" } });
    fireEvent.click(screen.getByRole("button", { name: /create category/i }));
    await waitFor(() => {
      const call = fetchMock.mock.calls.find((c) => c[0] === "/api/categories" && c[1]?.method === "POST");
      expect(call).toBeTruthy();
      expect(JSON.parse(String(call![1]!.body))).toMatchObject({ name: "Hobbies", kind: "spending", bucket: "want" });
    });
  });

  it("switching the new-category kind to income hides the bucket chips", async () => {
    wrap();
    await screen.findByText("Groceries");
    fireEvent.click(screen.getByRole("button", { name: /^new$/i }));
    const form = screen.getByTestId("new-category-form");
    expect(within(form).getByRole("button", { name: "Needs" })).toBeInTheDocument();
    fireEvent.click(within(form).getByRole("button", { name: "Income" }));
    expect(within(form).queryByRole("button", { name: "Needs" })).not.toBeInTheDocument();
  });

  it("filters categories by name", async () => {
    wrap();
    await screen.findByText("Groceries");
    fireEvent.change(screen.getByRole("searchbox", { name: /search categories/i }), { target: { value: "salary" } });
    expect(screen.getByText("Salary")).toBeInTheDocument();
    expect(screen.queryByText("Groceries")).not.toBeInTheDocument();
  });

  it("rename with duplicate name shows friendly toast", async () => {
    const fetchMock = mockFetch(
      { 1: { transactions: 3, rules: 1 }, 2: { transactions: 0, rules: 0 } },
      (url, init) => {
        if (url === "/api/categories/1" && init?.method === "PUT") {
          return new Response(JSON.stringify({ error: "name exists" }), { status: 409 });
        }
        return null;
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    wrap();
    await expand("Groceries");
    const input = screen.getByLabelText("Rename Groceries");
    fireEvent.change(input, { target: { value: "Salary" } });
    fireEvent.click(screen.getByRole("button", { name: /save name/i }));
    await waitFor(() => {
      expect(screen.getByText("A category with that name already exists.")).toBeInTheDocument();
    });
  });
});
