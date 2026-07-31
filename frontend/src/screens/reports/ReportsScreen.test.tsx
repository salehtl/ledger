import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ReportsScreen } from "./ReportsScreen";
import { ToastProvider } from "../../components/Toast";
import * as client from "../../api/client";
import type { Category } from "../../api/types";
import type { NetWorthPoint, ReportTxn } from "../../lib/reports";

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>{ui}</ToastProvider>
    </QueryClientProvider>,
  );
}

function nwSeries(months: number, flat = false): NetWorthPoint[] {
  return Array.from({ length: months }, (_, i) => {
    const d = new Date(Date.UTC(2026, 6 - (months - 1) + i, 1));
    const month = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    const budget = flat ? 0 : 5_000_000 + i * 250_000;
    return { month, budget_fils: budget, tracking_fils: 0, networth_fils: budget };
  });
}

function txn(over: Partial<ReportTxn>): ReportTxn {
  return {
    ID: 1, PostedAt: "2026-07-05T10:00:00Z", AmountFils: 17435, AmountAedFils: 17435,
    Currency: "AED", Direction: "debit", MerchantRaw: "CARREFOUR", Status: "confirmed",
    Confidence: 1, Source: "email", CategoryID: 5, CategoryName: "Groceries",
    Bucket: "need", Kind: "spending", BucketSnapshot: "need",
    ...over,
  };
}

const categories: Category[] = [
  { ID: 2, Name: "Salary", Kind: "income", Bucket: "saving", IsActive: true, Color: "" },
  { ID: 5, Name: "Groceries", Kind: "spending", Bucket: "need", IsActive: true, Color: "" },
  { ID: 9, Name: "Transfers", Kind: "transfer", Bucket: "need", IsActive: true, Color: "" },
];

function mockGets(over: {
  networth?: NetWorthPoint[];
  age?: { age_days: number; sample_size: number };
  txns?: ReportTxn[];
  failNetworth?: boolean;
  failTxns?: boolean;
} = {}) {
  vi.spyOn(client, "getJSON").mockImplementation(async (url: string) => {
    if (url.startsWith("/api/reports/networth")) {
      if (over.failNetworth) throw new Error("boom");
      return { months: over.networth ?? nwSeries(12) } as never;
    }
    if (url.startsWith("/api/reports/income-expense")) {
      return {
        months: ["2026-06", "2026-07"],
        rows: [
          { category_id: 2, name: "Salary", kind: "income", by_month_fils: [2650000, 2650000], total_fils: 5300000, avg_fils: 2650000 },
          { category_id: 5, name: "Groceries", kind: "spending", by_month_fils: [18990, 17435], total_fils: 36425, avg_fils: 18212 },
        ],
        net_by_month_fils: [2631010, 2632565],
      } as never;
    }
    if (url.startsWith("/api/reports/age-of-money")) {
      return (over.age ?? { age_days: 24, sample_size: 10 }) as never;
    }
    if (url.startsWith("/api/insights/trend")) {
      return [
        { period: "2026-06", spent: 18990, income: 2650000 },
        { period: "2026-07", spent: 17435, income: 2650000 },
      ] as never;
    }
    if (url.startsWith("/api/transactions")) {
      if (over.failTxns) throw new Error("boom");
      return (over.txns ?? [txn({})]) as never;
    }
    if (url.startsWith("/api/categories")) return categories as never;
    throw new Error(`unexpected GET ${url}`);
  });
}

describe("ReportsScreen", () => {
  it("renders all four report sections from the wire", async () => {
    mockGets();
    wrap(<ReportsScreen />);
    expect(await screen.findByText("Net worth")).toBeInTheDocument();
    expect(await screen.findByText("as of Jul ’26")).toBeInTheDocument();
    expect(screen.getByText("Age of money")).toBeInTheDocument();
    expect(await screen.findByText("24 days")).toBeInTheDocument();
    expect(screen.getByText("Income v expense")).toBeInTheDocument();
    expect(screen.getByText("Salary")).toBeInTheDocument();
    expect(screen.getByText("Spending trends")).toBeInTheDocument();
    expect(screen.getByText("spent, last 12 months")).toBeInTheDocument();
  });

  it("a never-checked-in ledger explains how net worth starts", async () => {
    mockGets({ networth: nwSeries(12, true) });
    wrap(<ReportsScreen />);
    expect(await screen.findByText("No balance check-ins yet")).toBeInTheDocument();
    expect(screen.getByText(/Check in an account balance/)).toBeInTheDocument();
  });

  it("a matrix cell drills to the exact transactions behind it", async () => {
    mockGets();
    wrap(<ReportsScreen />);
    fireEvent.click(await screen.findByRole("button", { name: "Groceries, Jul ’26: 174.35" }));
    expect(await screen.findByText("Groceries · Jul ’26")).toBeInTheDocument();
    expect(await screen.findByText("CARREFOUR")).toBeInTheDocument();
    expect(screen.getByText(/1 transaction/)).toBeInTheDocument();
  });

  it("age of money not computable renders the dash state, untappable", async () => {
    mockGets({ age: { age_days: 0, sample_size: 0 }, txns: [] });
    wrap(<ReportsScreen />);
    expect(await screen.findByText(/Not enough history yet/)).toBeInTheDocument();
  });

  it("a failed section reports its own error without taking the rest down", async () => {
    mockGets({ failNetworth: true });
    wrap(<ReportsScreen />);
    expect(await screen.findByText("Couldn't load net worth")).toBeInTheDocument();
    expect(await screen.findByText("24 days")).toBeInTheDocument();
    expect(screen.getByText("Salary")).toBeInTheDocument();
  });

  it("a failed transactions window shows an error in the drill, never a false empty", async () => {
    mockGets({ failTxns: true });
    wrap(<ReportsScreen />);
    fireEvent.click(await screen.findByRole("button", { name: "Groceries, Jul ’26: 174.35" }));
    expect(await screen.findByText("Couldn't load transactions")).toBeInTheDocument();
    expect(screen.queryByText("No transactions")).not.toBeInTheDocument();
  });

  it("an income drill's net reads money-in positive, not accounting-negative", async () => {
    mockGets({
      txns: [txn({
        ID: 7, Direction: "credit", Kind: "income", CategoryID: 2, CategoryName: "Salary",
        Bucket: "saving", BucketSnapshot: "saving", MerchantRaw: "EMPLOYER",
        AmountFils: 2650000, AmountAedFils: 2650000,
      })],
    });
    wrap(<ReportsScreen />);
    fireEvent.click(await screen.findByRole("button", { name: "Salary, Jul ’26: 26,500.00" }));
    const sheet = await screen.findByRole("dialog");
    expect(await within(sheet).findByText(/1 transaction/)).toBeInTheDocument();
    expect(within(sheet).getByText("26,500.00")).toBeInTheDocument();
    expect(within(sheet).queryByText("(26,500.00)")).not.toBeInTheDocument();
  });

  it("the net row drill shows only confirmed income and spending", async () => {
    mockGets({
      txns: [
        txn({ ID: 1 }),
        txn({ ID: 2, MerchantRaw: "PENDING SHOP", Status: "needs_review" }),
        txn({ ID: 3, MerchantRaw: "TRANSFER OUT", Kind: "transfer", CategoryID: 9, CategoryName: "Transfers" }),
      ],
    });
    wrap(<ReportsScreen />);
    fireEvent.click(await screen.findByRole("button", { name: /Net for Jul ’26/ }));
    expect(await screen.findByText("Net · Jul ’26")).toBeInTheDocument();
    expect(screen.getByText("confirmed income and spending only")).toBeInTheDocument();
    expect(await screen.findByText("CARREFOUR")).toBeInTheDocument();
    expect(screen.queryByText("PENDING SHOP")).not.toBeInTheDocument();
    expect(screen.queryByText("TRANSFER OUT")).not.toBeInTheDocument();
  });

  it("the net-worth month drill titles with the shared short month-year", async () => {
    mockGets();
    wrap(<ReportsScreen />);
    fireEvent.click(await screen.findByRole("button", { name: /Transactions in Jul ’26/ }));
    expect(await screen.findByRole("heading", { name: "Jul ’26" })).toBeInTheDocument();
  });

  it("hides the age sparkline and drill when the client mirror can't match the server sample", async () => {
    // Default window: one confirmed spend, no income — the mirror has an
    // unfunded spend while the server claims a 10-spend sample. Divergent.
    mockGets();
    wrap(<ReportsScreen />);
    const days = await screen.findByText("24 days");
    expect(screen.getByTestId("aom-spark").childElementCount).toBe(0);
    expect(days.closest("button")).toBeDisabled();
  });

  it("shows the sparkline and drill when the mirror agrees with the server", async () => {
    mockGets({
      age: { age_days: 3, sample_size: 2 },
      txns: [
        txn({ ID: 1, PostedAt: "2026-07-01T08:00:00Z", Direction: "credit", Kind: "income",
          CategoryID: 2, CategoryName: "Salary", MerchantRaw: "EMPLOYER",
          AmountFils: 100000, AmountAedFils: 100000 }),
        txn({ ID: 2, PostedAt: "2026-07-03T08:00:00Z" }),
        txn({ ID: 3, PostedAt: "2026-07-05T08:00:00Z" }),
      ],
    });
    wrap(<ReportsScreen />);
    const days = await screen.findByText("3 days");
    expect(screen.getByTestId("aom-spark").childElementCount).toBe(2);
    fireEvent.click(days.closest("button")!);
    expect(await screen.findByText("Behind age of money")).toBeInTheDocument();
  });
});
