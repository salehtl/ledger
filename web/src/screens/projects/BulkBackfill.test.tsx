import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BulkBackfill } from "./BulkBackfill";
import * as client from "../../api/client";
import { ToastProvider } from "../../components/Toast";
import type { Category, ProjectDetail, Txn } from "../../api/types";

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>{ui}</ToastProvider>
    </QueryClientProvider>,
  );
}

function makeTxn(overrides: Partial<Txn> = {}): Txn {
  return {
    ID: 1, PostedAt: "2026-06-01T10:00:00Z", AmountFils: 10000, AmountAedFils: 10000, Currency: "AED",
    Direction: "debit", MerchantRaw: "Ikea", Status: "confirmed", Confidence: 1, Source: "email",
    CategoryID: 1, CategoryName: "Home", Bucket: "want", Kind: "normal", BucketSnapshot: "want",
    ProjectID: null,
    ...overrides,
  };
}

const TXNS: Txn[] = [
  makeTxn({ ID: 1, MerchantRaw: "Ikea", CategoryID: 1, CategoryName: "Home" }),
  makeTxn({ ID: 2, MerchantRaw: "Carrefour", CategoryID: 2, CategoryName: "Groceries" }),
  // Already assigned to project 1 — must be excluded from the backfill candidates.
  makeTxn({ ID: 3, MerchantRaw: "Ikea Online", CategoryID: 1, CategoryName: "Home", ProjectID: 1 }),
];

const CATEGORIES: Category[] = [
  { ID: 1, Name: "Home", Kind: "expense", Bucket: "want", IsActive: true, Color: "" },
  { ID: 2, Name: "Groceries", Kind: "expense", Bucket: "need", IsActive: true, Color: "" },
];

function makeProjectDetail(overrides: Partial<ProjectDetail> = {}): ProjectDetail {
  return {
    id: 1, name: "Kitchen reno", budget_fils: null, color: "#1373d9", starts_on: "", ends_on: "",
    status: "active", count_in_monthly: false, completed_at: "", net_spent_fils: 0, pending_fils: 0,
    txn_count: 0, by_category: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.spyOn(client, "getProject").mockResolvedValue(makeProjectDetail());
  vi.spyOn(client, "getJSON").mockImplementation(async (url: string) => {
    if (url.startsWith("/api/transactions")) return TXNS as unknown as Txn[];
    if (url === "/api/categories") return CATEGORIES as unknown as Category[];
    return [] as unknown as Txn[];
  });
  vi.spyOn(client, "bulkAssignProject").mockResolvedValue(undefined);
});

describe("BulkBackfill", () => {
  it("excludes transactions already assigned to this project", async () => {
    wrap(<BulkBackfill id={1} onClose={() => {}} onDone={() => {}} />);
    expect(await screen.findByText("Ikea")).toBeInTheDocument();
    expect(screen.getByText("Carrefour")).toBeInTheDocument();
    expect(screen.queryByText("Ikea Online")).not.toBeInTheDocument();
    expect(screen.getByText(/2 matching transactions/i)).toBeInTheDocument();
  });

  it("narrows the list and count by merchant text", async () => {
    wrap(<BulkBackfill id={1} onClose={() => {}} onDone={() => {}} />);
    await screen.findByText("Ikea");
    fireEvent.change(screen.getByLabelText(/merchant contains/i), { target: { value: "ikea" } });
    await waitFor(() => expect(screen.queryByText("Carrefour")).not.toBeInTheDocument());
    expect(screen.getByText("Ikea")).toBeInTheDocument();
    expect(screen.getByText(/1 matching transaction$/i)).toBeInTheDocument();
  });

  it("narrows the list by category", async () => {
    wrap(<BulkBackfill id={1} onClose={() => {}} onDone={() => {}} />);
    await screen.findByText("Ikea");
    fireEvent.change(screen.getByLabelText(/^category$/i), { target: { value: "2" } });
    await waitFor(() => expect(screen.queryByText("Ikea")).not.toBeInTheDocument());
    expect(screen.getByText("Carrefour")).toBeInTheDocument();
  });

  it("calls bulkAssignProject with the matching ids and hands back to the caller", async () => {
    const onDone = vi.fn();
    wrap(<BulkBackfill id={1} onClose={() => {}} onDone={onDone} />);
    await screen.findByText("Ikea");
    // A date bound is enough to count as narrowed; without any filter the
    // action stays disabled (see the guard test below).
    fireEvent.change(screen.getByLabelText(/^from$/i), { target: { value: "2026-01-01" } });
    fireEvent.click(await screen.findByRole("button", { name: /assign 2/i }));
    await waitFor(() => expect(client.bulkAssignProject).toHaveBeenCalledWith(1, [1, 2]));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
  });

  // Backfilling is a bulk write with no undo. Opened unfiltered, "matching" is
  // every unassigned transaction in the account, and the button used to be
  // armed to sweep the lot into the project on the first tap.
  it("will not assign until the list has been narrowed", async () => {
    wrap(<BulkBackfill id={1} onClose={() => {}} onDone={() => {}} />);
    await screen.findByText("Ikea");
    const action = screen.getByRole("button", { name: /narrow by date, merchant or category/i });
    expect(action).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/merchant contains/i), { target: { value: "ikea" } });
    expect(await screen.findByRole("button", { name: /assign 1/i })).toBeEnabled();
  });

  it("opens the CategorizeSheet when a candidate row is tapped", async () => {
    wrap(<BulkBackfill id={1} onClose={() => {}} onDone={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: /open ikea/i }));
    expect(await screen.findByText("Categorize")).toBeInTheDocument();
  });

  it("disables the assign button when nothing matches", async () => {
    wrap(<BulkBackfill id={1} onClose={() => {}} onDone={() => {}} />);
    await screen.findByText("Ikea");
    fireEvent.change(screen.getByLabelText(/merchant contains/i), { target: { value: "nonexistent-merchant" } });
    await waitFor(() => expect(screen.getByText(/0 matching transactions/i)).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /assign 0/i })).toBeDisabled();
  });
});
