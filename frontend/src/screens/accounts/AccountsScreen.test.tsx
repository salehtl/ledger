import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PersistQueryClientProvider, type Persister } from "@tanstack/react-query-persist-client";
import { ToastProvider } from "../../components/Toast";
import { AccountsScreen } from "./AccountsScreen";
import type { AccountBalanceSummary, BalancePoint, CheckinResult } from "../../lib/reconcile";

function acct(over: Partial<AccountBalanceSummary>): AccountBalanceSummary {
  return {
    account_id: 0,
    name: "",
    bank: "",
    last4: "0000",
    kind: "budget",
    has_checkin: false,
    ...over,
  };
}

function makeAccounts(): AccountBalanceSummary[] {
  return [
    acct({
      account_id: 1, name: "ENBD Current", bank: "Emirates NBD", last4: "3921",
      has_checkin: true, anchor_fils: 800000, anchor_as_of: "2026-07-25T10:00:00Z",
      anchor_source: "checkin", activity_since_fils: -55000, txn_count: 2, computed_fils: 745000,
    }),
    acct({
      account_id: 2, name: "ENBD Credit Card", bank: "Emirates NBD", last4: "7104",
      has_checkin: true, anchor_fils: -20000, anchor_as_of: "2026-07-20T10:00:00Z",
      anchor_source: "checkin", activity_since_fils: -103000, txn_count: 9, computed_fils: -123000,
    }),
    acct({ account_id: 3, name: "DIB Savings", bank: "Dubai Islamic Bank", last4: "5566" }),
    acct({
      account_id: 4, name: "Sarwa Portfolio", bank: "Sarwa", last4: "9001", kind: "tracking",
      has_checkin: true, anchor_fils: 5250000, anchor_as_of: "2026-07-01T10:00:00Z",
      anchor_source: "checkin", activity_since_fils: 0, txn_count: 0, computed_fils: 5250000,
    }),
  ];
}

const history1: BalancePoint[] = [
  { id: 4, account_id: 1, as_of: "2026-07-25T10:00:00Z", balance_fils: 800000, source: "checkin", created_at: "2026-07-25T10:00:00Z" },
  { id: 3, account_id: 1, as_of: "2026-06-30T10:00:00Z", balance_fils: 600000, source: "checkin", note: "monthly", created_at: "2026-06-30T10:00:00Z" },
  { id: 2, account_id: 1, as_of: "2026-05-31T10:00:00Z", balance_fils: 700000, source: "checkin", created_at: "2026-05-31T10:00:00Z" },
];

function checkinResponse(stated: number): CheckinResult {
  const expected = 745000;
  const delta = stated - expected;
  return {
    account_id: 1,
    stated_fils: stated,
    expected_fils: expected,
    delta_fils: delta,
    since: "2026-07-25T10:00:00Z",
    txn_count: 2,
    unconverted_count: 0,
    first_checkin: false,
    balance_id: 10,
    unparsed:
      delta === 0
        ? []
        : [{ id: 88, received_at: "2026-07-27T09:00:00Z", from_addr: "alerts@emiratesnbd.com", subject: "Card alert", parse_error: "no amount found" }],
  };
}

let accounts: AccountBalanceSummary[];
let calls: { url: string; method: string; body: unknown }[];

beforeEach(() => {
  accounts = makeAccounts();
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });
    if (url === "/api/accounts/balances") return new Response(JSON.stringify(accounts));
    if (/^\/api\/accounts\/\d+\/balances\?/.test(url) && method === "GET") {
      return new Response(JSON.stringify(url.startsWith("/api/accounts/1/") ? history1 : []));
    }
    if (url === "/api/accounts/1/checkin") {
      return new Response(JSON.stringify(checkinResponse(body.stated_fils)));
    }
    if (url === "/api/accounts/1/adjust") {
      return new Response(JSON.stringify({ ok: true, transaction_id: 913 }), { status: 201 });
    }
    if (url === "/api/accounts/4/balances" && method === "POST") {
      return new Response(JSON.stringify({ ok: true, id: 30 }), { status: 201 });
    }
    if (url === "/api/accounts/1" && method === "PUT") {
      return new Response(JSON.stringify({ id: 1, name: "ENBD Current", bank: "Emirates NBD", last4: "3921", kind: body.kind }));
    }
    if (url === "/api/accounts" && method === "POST") {
      return new Response(JSON.stringify({ id: 9 }), { status: 201 });
    }
    return new Response("[]");
  }));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

function wrap() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <AccountsScreen />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

async function openDetail(name: string) {
  fireEvent.click(await screen.findByRole("button", { name: `Open ${name}` }));
  return await screen.findByRole("heading", { name });
}

describe("AccountsScreen", () => {
  it("shows the skeleton while the persisted cache restores (isPending, not isLoading)", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const neverRestores: Persister = {
      persistClient: () => {},
      restoreClient: () => new Promise(() => {}),
      removeClient: () => {},
    };
    render(
      <PersistQueryClientProvider client={qc} persistOptions={{ persister: neverRestores }}>
        <ToastProvider><AccountsScreen /></ToastProvider>
      </PersistQueryClientProvider>,
    );
    expect(screen.getByLabelText("Loading")).toBeInTheDocument();
  });

  it("shows the error empty-state when the balances call fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "db error" }), { status: 500 })));
    wrap();
    expect(await screen.findByText("Couldn't load accounts")).toBeInTheDocument();
  });

  it("empty registry: distinct empty state that routes to adding an account", async () => {
    accounts = [];
    wrap();
    expect(await screen.findByText("No accounts yet")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add account" }));
    expect(await screen.findByRole("dialog", { name: "Add account" })).toBeInTheDocument();
  });

  it("renders the books total, group sections, and per-row freshness", async () => {
    wrap();
    // 745000 − 123000 + 5250000 = 5872000
    expect(await screen.findByText("58,720.00")).toBeInTheDocument();
    expect(screen.getByText(/across 3 accounts · 1 awaiting first check-in/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Budget accounts" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Tracking" })).toBeInTheDocument();
    const savings = screen.getByRole("button", { name: "Open DIB Savings" });
    expect(within(savings).getByText("no check-in yet")).toBeInTheDocument();
    expect(within(savings).getByText("—")).toBeInTheDocument();
  });

  it("row tap opens the detail with balance, anchor meta, sparkline and history", async () => {
    wrap();
    await openDetail("ENBD Current");
    expect((await screen.findAllByText("7,450.00")).length).toBeGreaterThan(0);
    expect(screen.getByText(/anchor 8,000\.00 · checked in/)).toBeInTheDocument();
    await waitFor(() => expect(document.querySelector("[data-spark]")).not.toBeNull());
    expect(document.querySelector("[data-spark]")!.getAttribute("data-spark")).toBe("3");
    expect(screen.getByText(/low 6,000\.00 · high 8,000\.00/)).toBeInTheDocument();
    expect(screen.getByText(/monthly/)).toBeInTheDocument(); // history note
  });

  it("clean check-in: type the bank's number, get 'Books match', one POST", async () => {
    wrap();
    await openDetail("ENBD Current");
    fireEvent.click(screen.getByRole("button", { name: "Check in" }));
    const input = await screen.findByLabelText("Balance in your bank app");
    fireEvent.change(input, { target: { value: "7,450" } });
    const sheet = screen.getByRole("dialog", { name: "Balance check-in" });
    fireEvent.click(within(sheet).getByRole("button", { name: "Check in" }));
    await screen.findByText("Books match");
    expect(document.querySelector("[data-checkin-result]")!.getAttribute("data-checkin-result")).toBe("match");
    const post = calls.find((c) => c.url === "/api/accounts/1/checkin");
    expect(post?.method).toBe("POST");
    expect(post?.body).toEqual({ stated_fils: 745000, note: "" });
  });

  it("junk amount is rejected inline; input survives; submit stays disabled", async () => {
    wrap();
    await openDetail("ENBD Current");
    fireEvent.click(screen.getByRole("button", { name: "Check in" }));
    const input = await screen.findByLabelText("Balance in your bank app");
    fireEvent.change(input, { target: { value: "74abc" } });
    expect(screen.getByText(/Enter an amount like 8,250\.00/)).toBeInTheDocument();
    expect((input as HTMLInputElement).value).toBe("74abc");
    const sheet = screen.getByRole("dialog", { name: "Balance check-in" });
    expect(within(sheet).getByRole("button", { name: "Check in" })).toBeDisabled();
  });

  it("mismatch: discrepancy card lists the unparsed email; one tap posts the delta verbatim", async () => {
    wrap();
    await openDetail("ENBD Current");
    fireEvent.click(screen.getByRole("button", { name: "Check in" }));
    const input = await screen.findByLabelText("Balance in your bank app");
    fireEvent.change(input, { target: { value: "7270" } });
    const sheet = screen.getByRole("dialog", { name: "Balance check-in" });
    fireEvent.click(within(sheet).getByRole("button", { name: "Check in" }));
    expect(await screen.findByText("Bank shows 180.00 less")).toBeInTheDocument();
    expect(screen.getByText("Card alert")).toBeInTheDocument();
    expect(screen.getByText(/no amount found/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Write 180.00 adjustment" }));
    await screen.findByText("Adjustment written — books match");
    const post = calls.find((c) => c.url === "/api/accounts/1/adjust");
    expect(post?.body).toEqual({ delta_fils: -18000, note: "" });
  });

  it("credit-card check-in defaults the sign toggle to negative", async () => {
    wrap();
    await openDetail("ENBD Credit Card");
    fireEvent.click(screen.getByRole("button", { name: "Check in" }));
    await screen.findByLabelText("Balance in your bank app");
    const signGroup = screen.getByRole("group", { name: "Balance sign" });
    expect(within(signGroup).getByRole("button", { name: "−" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("tracking account takes a plain balance update, no reconcile", async () => {
    wrap();
    await openDetail("Sarwa Portfolio");
    fireEvent.click(screen.getByRole("button", { name: "Update balance" }));
    const input = await screen.findByLabelText("Balance now");
    fireEvent.change(input, { target: { value: "53,000" } });
    fireEvent.click(screen.getByRole("button", { name: "Save balance" }));
    await waitFor(() => {
      const post = calls.find((c) => c.url === "/api/accounts/4/balances" && c.method === "POST");
      expect(post?.body).toEqual({ balance_fils: 5300000, note: "" });
    });
    expect(await screen.findByText(/Sarwa Portfolio updated to 53,000\.00/)).toBeInTheDocument();
  });

  it("kind switch flips budget → tracking over PUT", async () => {
    wrap();
    await openDetail("ENBD Current");
    fireEvent.click(screen.getByLabelText("Tracking account"));
    await waitFor(() => {
      const put = calls.find((c) => c.url === "/api/accounts/1" && c.method === "PUT");
      expect(put?.body).toEqual({ kind: "tracking" });
    });
  });
});
