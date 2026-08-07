import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, within, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PersistQueryClientProvider, type Persister } from "@tanstack/react-query-persist-client";
import { ToastProvider } from "../../components/Toast";
import { PlanScreen } from "./PlanScreen";
import type { Envelope, EnvelopeSummary, UpcomingResponse } from "../../lib/envelope";
import type { Scope } from "../../lib/scope";

const JULY: Scope = { kind: "month", period: "2026-07" };

function env(over: Partial<Envelope>): Envelope {
  return {
    category_id: 0,
    category_name: "",
    bucket: "need",
    carryover_fils: 0,
    assigned_fils: 0,
    activity_fils: 0,
    available_fils: 0,
    overspent: false,
    overspend_debt_fils: 0,
    ...over,
  };
}

function makeSummary(): EnvelopeSummary {
  return {
    month: "2026-07",
    income_fils: 2650000,
    assigned_fils: 2400000,
    overspend_debt_fils: 0,
    ready_to_assign_fils: 250000,
    envelopes: [
      env({
        category_id: 4, category_name: "Rent", bucket: "need",
        assigned_fils: 1200000, activity_fils: 1200000, available_fils: 0,
        target: { type: "refill", amount_fils: 1200000, cadence: "monthly", needed_fils: 1200000, still_needed_fils: 0, funded: true },
      }),
      env({
        category_id: 5, category_name: "Groceries", bucket: "need",
        assigned_fils: 120000, activity_fils: 47500, available_fils: 72500,
        target: { type: "set_aside", amount_fils: 160000, cadence: "monthly", needed_fils: 160000, still_needed_fils: 40000, funded: false },
      }),
      env({
        category_id: 6, category_name: "Subscriptions", bucket: "want",
        assigned_fils: 2000, activity_fils: 0, available_fils: 2000,
      }),
      env({
        category_id: 7, category_name: "Dining out", bucket: "want",
        assigned_fils: 60000, activity_fils: 84200, available_fils: -24200, overspent: true,
      }),
      // jar row: never funded, no target — wire says overspent, UI must not shout
      env({
        category_id: 8, category_name: "Fitness", bucket: "want",
        activity_fils: 12000, available_fils: -12000, overspent: true,
      }),
      env({
        category_id: 9, category_name: "Japan trip", bucket: "saving",
        assigned_fils: 100000, activity_fils: 0, available_fils: 100000,
        target: {
          type: "save_by_date", amount_fils: 1500000, cadence: "monthly", due_date: "2026-12-01",
          months_left: 5, needed_fils: 270000, still_needed_fils: 170000, funded: false,
        },
      }),
    ],
  };
}

const upcoming: UpcomingResponse = {
  days: 14,
  items: [
    {
      id: 3, merchant: "netflix.com", label: "Netflix", amount_fils: 3900, next_due: "2026-08-01",
      direction: "debit", category_id: 6, due_in_days: 2,
    },
  ],
};

let summary: EnvelopeSummary;
let calls: { url: string; method: string; body: unknown }[];

beforeEach(() => {
  // PlanScreen.tsx's monthProgress(month) defaults to `new Date()` — the pace
  // marker and upcoming-bill claim hints only render when `month` is the real
  // wall-clock's current month (see the comment above `claims` in
  // PlanScreen.tsx). Every fixture here is fixed to "2026-07" (JULY), so
  // without pinning the clock this suite silently depended on being run
  // during July 2026 — the "claim hint" assertion below would start failing
  // the moment the real date crossed into August. shouldAdvanceTime keeps
  // setTimeout-based polling (RTL's findBy/waitFor) working normally.
  vi.useFakeTimers({ now: new Date("2026-07-15T12:00:00Z"), shouldAdvanceTime: true });
  summary = makeSummary();
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });
    if (url.startsWith("/api/envelopes/assign")) {
      // echo an updated summary so cache-write is observable
      summary = { ...summary, assigned_fils: 2500000, ready_to_assign_fils: 150000 };
      return new Response(JSON.stringify(summary));
    }
    if (url.startsWith("/api/envelopes/move")) {
      return new Response(JSON.stringify(summary));
    }
    if (url.startsWith("/api/envelopes/auto-assign")) {
      const after = { ...summary, assigned_fils: 2650000, ready_to_assign_fils: 0 };
      return new Response(JSON.stringify({ allocations: [{ category_id: 8, amount_fils: 250000 }], summary: after }));
    }
    if (url.startsWith("/api/envelopes")) return new Response(JSON.stringify(summary));
    if (url.startsWith("/api/upcoming")) return new Response(JSON.stringify(upcoming));
    if (url.startsWith("/api/targets/")) return new Response(JSON.stringify({}));
    return new Response("[]");
  }));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
});

function wrap(scope: Scope = JULY) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <PlanScreen scope={scope} />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe("PlanScreen", () => {
  it("shows the skeleton while the persisted cache is restoring (isPending, not isLoading)", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const neverRestores: Persister = {
      persistClient: () => {},
      restoreClient: () => new Promise(() => {}),
      removeClient: () => {},
    };
    render(
      <PersistQueryClientProvider client={qc} persistOptions={{ persister: neverRestores }}>
        <ToastProvider><PlanScreen scope={JULY} /></ToastProvider>
      </PersistQueryClientProvider>,
    );
    expect(screen.getByLabelText("Loading")).toBeInTheDocument();
  });

  it("shows the error empty-state when the summary fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "db error" }), { status: 500 })));
    wrap();
    expect(await screen.findByText("Couldn't load your plan")).toBeInTheDocument();
  });

  it("shows a distinct empty state when there are no envelopes at all", async () => {
    summary = { ...makeSummary(), envelopes: [] };
    wrap();
    expect(await screen.findByText("No envelopes yet")).toBeInTheDocument();
    expect(screen.getByText(/Add spending categories in Settings/)).toBeInTheDocument();
  });

  it("renders RTA, bucket groups in need → want → saving order, and per-group available", async () => {
    wrap();
    expect(await screen.findByText("2,500.00")).toBeInTheDocument(); // RollingNumber sr-only
    const headers = screen.getAllByRole("heading").map((h) => h.textContent);
    expect(headers.filter((h) => /Needs|Wants|Savings/.test(h ?? ""))).toEqual(["Needs", "Wants", "Savings"]);
    // want group's available excludes the jar row's pseudo-negative: 2000 − 24200 = −22200
    expect(screen.getByText(/\(222\.00\)/)).toBeInTheDocument();
  });

  it("overspent envelope flags; jar row stays quiet and un-barred", async () => {
    wrap();
    const dining = (await screen.findByRole("button", { name: "Open Dining out" }));
    expect(within(dining).getByText("Overspent")).toBeInTheDocument();
    expect(within(dining).getByRole("progressbar")).toBeInTheDocument();
    const fitness = screen.getByRole("button", { name: "Open Fitness" });
    expect(within(fitness).queryByText("Overspent")).toBeNull();
    expect(within(fitness).queryByRole("progressbar")).toBeNull();
    expect(within(fitness).getByText(/no envelope yet/)).toBeInTheDocument();
  });

  it("shows target progress and the upcoming-bill claim hint with its shortfall", async () => {
    wrap();
    const groceries = await screen.findByRole("button", { name: "Open Groceries" });
    expect(within(groceries).getByText("set aside 1,600.00/mo")).toBeInTheDocument();
    expect(within(groceries).getByText(/needs 400\.00 more/)).toBeInTheDocument();
    const subs = screen.getByRole("button", { name: "Open Subscriptions" });
    expect(within(subs).getByText(/Netflix due in 2d · 39\.00 — short 19\.00/)).toBeInTheDocument();
  });

  it("renders the RTA figure red only when negative", async () => {
    summary = { ...makeSummary(), assigned_fils: 2850000, ready_to_assign_fils: -200000 };
    wrap();
    await screen.findByText("(2,000.00)");
    const fig = document.querySelector("[data-rta]")!;
    expect(fig.getAttribute("data-rta")).toBe("negative");
    expect(fig.className).toContain("text-bad");
  });

  it("auto-assign posts once and reports the result in a toast with undo", async () => {
    wrap();
    fireEvent.click(await screen.findByRole("button", { name: "Auto-assign" }));
    expect(await screen.findByText("Assigned 1 envelope")).toBeInTheDocument();
    const post = calls.find((c) => c.url === "/api/envelopes/auto-assign");
    expect(post?.method).toBe("POST");
    expect(post?.body).toEqual({ month: "2026-07" });
    // RTA moved to zero from the returned summary — no refetch needed
    expect(screen.getByText("Every dirham assigned.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Undo" })).toBeInTheDocument();
  });

  it("row tap opens the assign sheet prefilled; save posts the absolute assignment", async () => {
    wrap();
    fireEvent.click(await screen.findByRole("button", { name: "Open Groceries" }));
    const input = await screen.findByLabelText("Assigned this month");
    expect((input as HTMLInputElement).value).toBe("1200");
    fireEvent.change(input, { target: { value: "1,500" } });
    expect(screen.getByText(/available becomes 1,025\.00/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      const post = calls.find((c) => c.url === "/api/envelopes/assign");
      expect(post?.body).toEqual({ month: "2026-07", assignments: [{ category_id: 5, assigned_fils: 150000 }] });
    });
    await waitFor(() => expect(screen.queryByLabelText("Assigned this month")).toBeNull());
  });

  it("assign sheet rejects junk amounts inline and keeps the input", async () => {
    wrap();
    fireEvent.click(await screen.findByRole("button", { name: "Open Groceries" }));
    const input = await screen.findByLabelText("Assigned this month");
    fireEvent.change(input, { target: { value: "12abc" } });
    expect(screen.getByText(/Enter an amount like 150\.00/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect((input as HTMLInputElement).value).toBe("12abc");
  });

  it("move money: two taps — source, then a prefilled amount — posts one atomic move", async () => {
    wrap();
    fireEvent.click(await screen.findByRole("button", { name: "Open Dining out" }));
    fireEvent.click(await screen.findByRole("button", { name: "Move money in" }));
    // step 1: sources sorted most-available first, destination excluded
    expect(await screen.findByText("Take from")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Japan trip/ }));
    // step 2: prefilled with the overspend shortfall (242.00)
    const amount = await screen.findByLabelText("Amount");
    expect((amount as HTMLInputElement).value).toBe("242");
    expect(screen.getByTestId("move-preview").textContent).toContain("Japan trip 1,000.00 → 758.00");
    fireEvent.click(screen.getByRole("button", { name: "Move" }));
    await waitFor(() => {
      const post = calls.find((c) => c.url === "/api/envelopes/move");
      expect(post?.body).toEqual({ month: "2026-07", from_category_id: 9, to_category_id: 7, amount_fils: 24200 });
    });
    expect(await screen.findByText("Moved money from Japan trip")).toBeInTheDocument();
  });

  it("target sheet: save-by-date demands a date, then puts the target", async () => {
    wrap();
    fireEvent.click(await screen.findByRole("button", { name: "Open Groceries" }));
    fireEvent.click(await screen.findByRole("button", { name: "Edit target" }));
    // prefilled from the existing set_aside target
    const amount = await screen.findByLabelText("Amount");
    expect((amount as HTMLInputElement).value).toBe("1600");
    fireEvent.click(screen.getByRole("button", { name: "By date" }));
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("By"), { target: { value: "2026-12-01" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      const put = calls.find((c) => c.url === "/api/targets/5" && c.method === "PUT");
      expect(put?.body).toEqual({ month: "2026-07", target_type: "save_by_date", amount_fils: 160000, cadence: "monthly", due_date: "2026-12-01" });
    });
  });

  it("target sheet: removing an existing target deletes and offers undo", async () => {
    wrap();
    fireEvent.click(await screen.findByRole("button", { name: "Open Groceries" }));
    fireEvent.click(await screen.findByRole("button", { name: "Edit target" }));
    fireEvent.click(await screen.findByRole("button", { name: "Remove target" }));
    await waitFor(() => {
      const d = calls.find((c) => c.url === "/api/targets/5?month=2026-07" && c.method === "DELETE");
      expect(d).toBeTruthy();
    });
    expect(await screen.findByText("Target removed from Groceries")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Undo" })).toBeInTheDocument();
  });
});
