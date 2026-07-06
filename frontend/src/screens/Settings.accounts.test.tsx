import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "../components/Toast";
import { Settings } from "./Settings";

let accounts: { id: number; name: string; bank: string; last4: string }[] = [];

const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
  if (url === "/api/accounts" && init?.method === "POST") {
    const body = JSON.parse(String(init.body));
    accounts = [...accounts, { id: accounts.length + 1, bank: "", ...body }];
    return new Response(JSON.stringify({ id: accounts.length }), { status: 201 });
  }
  if (/^\/api\/accounts\/\d+$/.test(url) && init?.method === "DELETE") {
    accounts = accounts.slice(0, -1);
    return new Response(JSON.stringify({ ok: true }));
  }
  if (url === "/api/accounts") return new Response(JSON.stringify(accounts));
  if (url === "/api/transfers/sweep") return new Response(JSON.stringify({ marked: 4 }));
  if (url === "/api/settings")
    return new Response(
      JSON.stringify({ auto_categorize: true, ai_enabled: false, ai_auto_accept: false, ai_threshold: 0.85, ai_key_present: true }),
    );
  if (url === "/api/budget")
    return new Response(
      JSON.stringify({ monthly_income: 0, need_pct: 0.5, want_pct: 0.3, saving_pct: 0.2, income_source: "config", freeze_history: false }),
    );
  if (url === "/api/rates") return new Response(JSON.stringify({ rates: [], missing: [] }));
  return new Response("[]");
});

beforeEach(() => {
  fetchMock.mockClear();
  accounts = [{ id: 1, name: "DIB Current", bank: "DIB", last4: "1234" }];
  vi.stubGlobal("fetch", fetchMock);
});

function renderSettings() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <Settings />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

async function openAccounts() {
  fireEvent.click(await screen.findByRole("button", { name: /accounts & transfers/i }));
}

describe("Settings accounts & transfers", () => {
  it("lists registered accounts", async () => {
    renderSettings();
    await openAccounts();
    expect(await screen.findByText("DIB Current")).toBeInTheDocument();
    expect(screen.getByText(/1234/)).toBeInTheDocument();
  });

  it("adds an account", async () => {
    renderSettings();
    await openAccounts();
    fireEvent.change(await screen.findByLabelText(/account name/i), { target: { value: "ENBD Savings" } });
    fireEvent.change(screen.getByLabelText(/last 4/i), { target: { value: "5678" } });
    fireEvent.click(screen.getByRole("button", { name: /^add$/i }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/accounts",
        expect.objectContaining({ method: "POST" }),
      ),
    );
  });

  it("rejects a bad last4 before hitting the network", async () => {
    renderSettings();
    await openAccounts();
    fireEvent.change(await screen.findByLabelText(/account name/i), { target: { value: "X" } });
    fireEvent.change(screen.getByLabelText(/last 4/i), { target: { value: "12" } });
    fireEvent.click(screen.getByRole("button", { name: /^add$/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/4 digits/i);
  });

  it("runs the sweep and reports the count", async () => {
    renderSettings();
    await openAccounts();
    fireEvent.click(await screen.findByRole("button", { name: /net matching transfers/i }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/transfers/sweep",
        expect.objectContaining({ method: "POST" }),
      ),
    );
    expect(await screen.findByText(/marked 4/i)).toBeInTheDocument();
  });
});
