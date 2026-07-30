import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RecurringScreen } from "./RecurringScreen";
import { ToastProvider } from "../../components/Toast";
import * as client from "../../api/client";
import type { Schedule, UpcomingItem } from "./api";
import type { Category } from "../../api/types";

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>{ui}</ToastProvider>
    </QueryClientProvider>,
  );
}

const categories: Category[] = [
  { ID: 5, Name: "Subscriptions", Kind: "spending", Bucket: "want", IsActive: true },
];

function schedule(overrides: Partial<Schedule> = {}): Schedule {
  return {
    id: 1,
    merchant: "netflix.com",
    label: "",
    amount_fils: 5600,
    tolerance_pct: 10,
    interval_days: 30,
    next_due: "2026-08-07",
    direction: "debit",
    category_id: 5,
    account_id: null,
    source: "detected",
    status: "proposed",
    last_matched_tx_id: null,
    last_amount_fils: null,
    missed: false,
    price_change: false,
    provenance: { count: 3, avg_interval_days: 30, last_amounts_fils: [5600], tx_ids: [10, 50, 90] },
    created_at: "2026-07-29T10:00:00Z",
    updated_at: "2026-07-29T10:00:00Z",
    ...overrides,
  };
}

function upcomingItem(overrides: Partial<UpcomingItem> = {}): UpcomingItem {
  return { ...schedule({ status: "active", provenance: undefined }), due_in_days: 3, ...overrides };
}

function mockGets(data: {
  scheduled?: Schedule[];
  upcoming?: UpcomingItem[];
  failScheduled?: boolean;
}) {
  vi.spyOn(client, "getJSON").mockImplementation(async (url: string) => {
    if (url.startsWith("/api/scheduled")) {
      if (data.failScheduled) throw new Error("boom");
      return (data.scheduled ?? []) as never;
    }
    if (url.startsWith("/api/upcoming")) {
      return { days: 14, items: data.upcoming ?? [] } as never;
    }
    if (url.startsWith("/api/categories")) return categories as never;
    if (url.startsWith("/api/transactions")) return [] as never;
    throw new Error(`unexpected GET ${url}`);
  });
}

// Note: no vi.restoreAllMocks() here — the shared test setup installs
// window.matchMedia as a mock in its own beforeEach, and restoring would
// strip it. Each test installs fresh spies instead.

describe("RecurringScreen", () => {
  it("shows the empty state when nothing is tracked or proposed", async () => {
    mockGets({});
    wrap(<RecurringScreen />);
    expect(await screen.findByText("No recurring bills yet")).toBeInTheDocument();
  });

  it("shows the error state when the schedules query fails", async () => {
    mockGets({ failScheduled: true });
    wrap(<RecurringScreen />);
    expect(await screen.findByText("Couldn't load recurring bills")).toBeInTheDocument();
  });

  it("renders detected proposals with provenance and confirms one", async () => {
    mockGets({ scheduled: [schedule()] });
    const post = vi.spyOn(client, "postJSON").mockResolvedValue(schedule({ status: "active" }) as never);
    wrap(<RecurringScreen />);
    expect(await screen.findByText(/Detected · 1/)).toBeInTheDocument();
    expect(screen.getByText(/seen 3× every ~30 days at 56\.00/)).toBeInTheDocument();
    fireEvent.click(screen.getByText("Track this bill"));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/api/scheduled/1/confirm", {}));
    expect(await screen.findByText(/Now tracking netflix\.com/)).toBeInTheDocument();
  });

  it("dismiss hides the card immediately and undo restores it without a write", async () => {
    vi.useFakeTimers();
    try {
      mockGets({ scheduled: [schedule()] });
      const post = vi.spyOn(client, "postJSON").mockResolvedValue(schedule({ status: "dismissed" }) as never);
      wrap(<RecurringScreen />);
      // findBy* uses timers under fake timers; flush microtasks manually.
      await vi.waitFor(() => expect(screen.getByText("Track this bill")).toBeInTheDocument());
      fireEvent.click(screen.getByText("Dismiss"));
      expect(screen.queryByText("Track this bill")).toBeNull();
      fireEvent.click(screen.getByText("Undo"));
      await vi.waitFor(() => expect(screen.getByText("Track this bill")).toBeInTheDocument());
      vi.advanceTimersByTime(6000);
      expect(post).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("dismiss commits after the undo window closes", async () => {
    vi.useFakeTimers();
    try {
      mockGets({ scheduled: [schedule()] });
      const post = vi.spyOn(client, "postJSON").mockResolvedValue(schedule({ status: "dismissed" }) as never);
      wrap(<RecurringScreen />);
      await vi.waitFor(() => expect(screen.getByText("Dismiss")).toBeInTheDocument());
      fireEvent.click(screen.getByText("Dismiss"));
      vi.advanceTimersByTime(5100);
      await vi.waitFor(() => expect(post).toHaveBeenCalledWith("/api/scheduled/1/dismiss", {}));
    } finally {
      vi.useRealTimers();
    }
  });

  it("renders the upcoming feed with badges and total", async () => {
    mockGets({
      scheduled: [schedule({ id: 2, status: "active", provenance: undefined })],
      upcoming: [
        upcomingItem({ id: 2, label: "DEWA", merchant: "dewa", amount_fils: 48915, due_in_days: -3, missed: true }),
        upcomingItem({ id: 3, label: "du", merchant: "du telecom", amount_fils: 42790, due_in_days: 2, price_change: true, last_amount_fils: 38900 }),
      ],
    });
    wrap(<RecurringScreen />);
    expect(await screen.findByText("DEWA")).toBeInTheDocument();
    expect(screen.getByText("Missed")).toBeInTheDocument();
    expect(screen.getByText("Price change")).toBeInTheDocument();
    expect(screen.getByText(/3 days overdue/)).toBeInTheDocument();
    expect(screen.getByText(/917\.05 expected/)).toBeInTheDocument(); // 489.15 + 427.90
  });

  it("opens the edit sheet from a schedule row and pauses it", async () => {
    mockGets({ scheduled: [schedule({ id: 2, status: "active", label: "Netflix", provenance: undefined })] });
    const post = vi.spyOn(client, "postJSON").mockResolvedValue(schedule({ id: 2, status: "paused" }) as never);
    wrap(<RecurringScreen />);
    fireEvent.click(await screen.findByLabelText("Edit Netflix"));
    expect(await screen.findByText("Edit schedule")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Pause tracking"));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/api/scheduled/2/pause", {}));
    expect(await screen.findByText("Paused Netflix")).toBeInTheDocument();
  });

  it("marks paused schedules in the inventory", async () => {
    mockGets({ scheduled: [schedule({ id: 4, status: "paused", label: "Gym", provenance: undefined })] });
    wrap(<RecurringScreen />);
    expect(await screen.findByText("Paused")).toBeInTheDocument();
  });

  it("creates a manual schedule from the Fab", async () => {
    mockGets({});
    const post = vi.spyOn(client, "postJSON").mockResolvedValue(schedule({ id: 9, source: "manual", status: "active" }) as never);
    wrap(<RecurringScreen />);
    fireEvent.click(await screen.findByLabelText("Add schedule"));
    expect(await screen.findByText("Add schedule", { selector: "h2" })).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText("e.g. Gym Co"), { target: { value: "Gym Co" } });
    const amount = document.querySelector<HTMLInputElement>('input[inputmode="decimal"]');
    fireEvent.change(amount!, { target: { value: "250" } });
    fireEvent.click(screen.getByText("Add", { selector: "button" }));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/api/scheduled", expect.objectContaining({
      merchant: "Gym Co",
      amount_fils: 25000,
      interval_days: 30,
    })));
  });

  it("shows recently paid bills linking their matched transaction", async () => {
    const paidAt = new Date().toISOString();
    mockGets({
      scheduled: [schedule({ id: 6, status: "active", label: "Salary", direction: "credit", provenance: undefined, last_matched_tx_id: 812, last_matched_at: paidAt, last_amount_fils: 2_650_000 })],
    });
    wrap(<RecurringScreen />);
    expect(await screen.findByText("Recently paid")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Open payment for Salary"));
    // The txn index is empty in this test, so the sheet reports the miss
    // instead of silently rendering nothing.
    expect(await screen.findByText("No matched transactions")).toBeInTheDocument();
  });
});
