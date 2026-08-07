import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "../components/Toast";
import { Settings } from "./Settings";

let accounts: { id: number; name: string; bank: string; last4: string }[] = [];

const fetchMock = vi.fn(async (url: string) => {
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
  fireEvent.click(await screen.findByRole("button", { name: /^transfers/i }));
}

// Account CRUD moved to the Accounts tab in v3; the Settings page keeps the
// transfer sweep and points at the new home. AccountsPage.test.tsx covers the
// page in isolation — this file covers reaching it through Settings.
describe("Settings accounts & transfers (absorbed by the Accounts tab)", () => {
  it("shows the moved notice with the registered-account count", async () => {
    renderSettings();
    await openAccounts();
    expect(await screen.findByText(/1 account registered\./)).toBeInTheDocument();
    expect(screen.getByText(/live under Accounts/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/account name/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /^add$/i })).toBeNull();
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
