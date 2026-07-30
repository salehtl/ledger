import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "../../components/Toast";
import { AccountsPage } from "./AccountsPage";

let sweepResult: { marked: number };
let sweepStatus: number;
let calls: { url: string; method: string }[];

beforeEach(() => {
  sweepResult = { marked: 3 };
  sweepStatus = 200;
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method });
    if (url === "/api/accounts") {
      return new Response(JSON.stringify([
        { id: 1, name: "ENBD Current", bank: "Emirates NBD", last4: "3921", kind: "budget" },
        { id: 2, name: "ENBD Credit Card", bank: "Emirates NBD", last4: "7104", kind: "budget" },
      ]));
    }
    if (url === "/api/transfers/sweep") {
      return new Response(JSON.stringify(sweepStatus === 200 ? sweepResult : { error: "db error" }), { status: sweepStatus });
    }
    return new Response("[]");
  }));
  vi.spyOn(console, "error").mockImplementation(() => {});
});

function wrap() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <AccountsPage onClose={() => {}} />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe("settings AccountsPage (absorbed by the Accounts tab)", () => {
  it("points at the Accounts tab and reports the registered-account count", async () => {
    wrap();
    expect(screen.getByRole("heading", { name: "Accounts & transfers" })).toBeInTheDocument();
    expect(screen.getByText("Accounts moved")).toBeInTheDocument();
    expect(await screen.findByText(/2 accounts registered/)).toBeInTheDocument();
    expect(screen.getByText(/now live in the Accounts tab/)).toBeInTheDocument();
    // Account CRUD is gone from Settings — no add form, no delete buttons.
    expect(screen.queryByLabelText("Account name")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Delete/ })).toBeNull();
  });

  it("keeps the transfer sweep: posts once and reports the marked count", async () => {
    wrap();
    fireEvent.click(await screen.findByRole("button", { name: "Net matching transfers" }));
    expect(await screen.findByText("Marked 3 transactions as transfers")).toBeInTheDocument();
    const post = calls.find((c) => c.url === "/api/transfers/sweep");
    expect(post?.method).toBe("POST");
  });

  it("sweep failure surfaces as an error toast, button recovers", async () => {
    sweepStatus = 500;
    wrap();
    fireEvent.click(await screen.findByRole("button", { name: "Net matching transfers" }));
    expect(await screen.findByText("Sweep failed")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Net matching transfers" })).not.toBeDisabled(),
    );
  });
});
