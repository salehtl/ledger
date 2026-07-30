import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PocketStrip } from "./PocketStrip";

let envelopes: object;
let upcoming: object;
let networth: object;

beforeEach(() => {
  envelopes = { month: "2026-07", income_fils: 500000, assigned_fils: 380000, overspend_debt_fils: 0, ready_to_assign_fils: 120000, envelopes: [] };
  upcoming = { days: 14, items: [
    { id: 1, merchant: "NETFLIX", label: "Netflix", amount_fils: 3900, next_due: "2026-08-01", direction: "debit", category_id: null, due_in_days: 2 },
    { id: 2, merchant: "DEWA", amount_fils: 40000, next_due: "2026-08-05", direction: "debit", category_id: null, due_in_days: 6 },
  ] };
  networth = { months: [
    { month: "2026-06", budget_fils: 100000, tracking_fils: 500000, networth_fils: 600000 },
    { month: "2026-07", budget_fils: 150000, tracking_fils: 500000, networth_fils: 650000 },
  ] };
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.startsWith("/api/envelopes")) return new Response(JSON.stringify(envelopes));
    if (url.startsWith("/api/upcoming")) return new Response(JSON.stringify(upcoming));
    if (url.startsWith("/api/reports/networth")) return new Response(JSON.stringify(networth));
    return new Response("{}", { status: 404 });
  }));
});

function wrap(props: Partial<Parameters<typeof PocketStrip>[0]> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <PocketStrip month="2026-07" {...props} />
    </QueryClientProvider>,
  );
}

describe("PocketStrip", () => {
  it("shows RTA, the soonest bill, and the net-worth delta", async () => {
    wrap();
    expect(await screen.findByText("1,200.00")).toBeInTheDocument(); // RTA
    expect(screen.getByText("Netflix due in 2d")).toBeInTheDocument(); // soonest of the two
    expect(screen.getByText("6,500.00")).toBeInTheDocument(); // latest net worth
    expect(screen.getByText(/\+500\.00 this month/)).toBeInTheDocument();
  });

  it("routes each row to its surface", async () => {
    const onOpenPlan = vi.fn(); const onOpenRecurring = vi.fn(); const onOpenReports = vi.fn();
    wrap({ onOpenPlan, onOpenRecurring, onOpenReports });
    fireEvent.click(await screen.findByRole("button", { name: "Open Plan" }));
    fireEvent.click(screen.getByRole("button", { name: "Open Recurring" }));
    fireEvent.click(screen.getByRole("button", { name: "Open Reports" }));
    expect(onOpenPlan).toHaveBeenCalled();
    expect(onOpenRecurring).toHaveBeenCalled();
    expect(onOpenReports).toHaveBeenCalled();
  });

  it("states absences instead of rendering blank", async () => {
    upcoming = { days: 14, items: [] };
    networth = { months: [
      { month: "2026-06", budget_fils: 0, tracking_fils: 0, networth_fils: 0 },
      { month: "2026-07", budget_fils: 0, tracking_fils: 0, networth_fils: 0 },
    ] };
    wrap();
    expect(await screen.findByText("none due in 14d")).toBeInTheDocument();
    expect(screen.getByText("check in to track")).toBeInTheDocument();
  });

  it("surfaces a missed bill ahead of a due one", async () => {
    upcoming = { days: 14, items: [
      { id: 1, merchant: "NETFLIX", amount_fils: 3900, next_due: "2026-08-01", direction: "debit", category_id: null, due_in_days: 2 },
      { id: 2, merchant: "DEWA", amount_fils: 40000, next_due: "2026-07-27", direction: "debit", category_id: null, due_in_days: -3, missed: true },
    ] };
    wrap();
    // Name and amount are separate spans so only the name may be elided —
    // truncating them together used to eat the amount, the fact that matters.
    expect(await screen.findByText("DEWA 3d overdue")).toBeInTheDocument();
    expect(screen.getByText("400.00")).toBeInTheDocument();
  });
});
