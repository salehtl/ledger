// frontend/src/components/transactions/RenameMerchantSheet.test.tsx
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RenameMerchantSheet } from "./RenameMerchantSheet";
import type { DepthRule } from "./merchantRename";
import type { TxnDepth } from "../../lib/txSplit";
import type { Txn } from "../../api/types";

const txn = (over: Partial<TxnDepth> = {}): TxnDepth => ({
  ID: 9, PostedAt: "2026-07-10", AmountFils: 3900, AmountAedFils: 3900, Currency: "AED",
  Direction: "debit", MerchantRaw: "NETFLIX.COM AMSTERDAM", Status: "confirmed", Confidence: 0,
  Source: "email", CategoryID: 11, CategoryName: "Subscriptions", Bucket: "want", Kind: "spending",
  BucketSnapshot: "", ...over,
});

const rules: DepthRule[] = [
  { ID: 4, MatchType: "contains", Pattern: "netflix", CategoryID: 11, Priority: 100, Source: "ai_confirmed", IsActive: true },
];

const txns: Txn[] = [txn({ ID: 1 }), txn({ ID: 2 }), txn({ ID: 3, MerchantRaw: "SPINNEYS" })];

let calls: { url: string; method?: string; body?: string }[];
let createdRule: DepthRule | null;

beforeEach(() => {
  calls = [];
  createdRule = null;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method, body: init?.body as string });
    if (url === "/api/rules" && init?.method === "POST") {
      const b = JSON.parse(init.body as string);
      createdRule = {
        ID: 99, MatchType: b.match_type, Pattern: b.pattern, CategoryID: b.category_id,
        Priority: b.priority, Source: "manual", IsActive: true,
      };
      return new Response(JSON.stringify({ ok: true }), { status: 201 });
    }
    if (url === "/api/rules" && !init?.method) {
      return new Response(JSON.stringify(createdRule ? [...rules, createdRule] : rules));
    }
    return new Response(JSON.stringify({ ok: true }));
  }));
});

afterEach(() => vi.unstubAllGlobals());

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe("RenameMerchantSheet", () => {
  it("shows the raw merchant as provenance and how many rows the rename touches", () => {
    wrap(<RenameMerchantSheet txn={txn()} rules={rules} txns={txns} onClose={() => {}} onSaved={() => {}} />);
    expect(screen.getByText("NETFLIX.COM AMSTERDAM")).toBeInTheDocument();
    expect(screen.getByText(/applies to 2 transactions from this merchant/i)).toBeInTheDocument();
  });

  it("writes the name onto the matching rule and reports back", async () => {
    const onSaved = vi.fn();
    wrap(<RenameMerchantSheet txn={txn()} rules={rules} txns={txns} onClose={() => {}} onSaved={onSaved} />);
    fireEvent.change(screen.getByLabelText(/shown as/i), { target: { value: "Netflix" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith("Netflix"));
    expect(calls).toEqual([
      { url: "/api/rules/4/display-name", method: "PUT", body: JSON.stringify({ display_name: "Netflix" }) },
    ]);
  });

  it("creates the write-back rule first when none matches", async () => {
    const onSaved = vi.fn();
    wrap(<RenameMerchantSheet txn={txn()} rules={[]} txns={txns} onClose={() => {}} onSaved={onSaved} />);
    fireEvent.change(screen.getByLabelText(/shown as/i), { target: { value: "Netflix" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith("Netflix"));
    expect(calls[0]).toEqual({
      url: "/api/rules",
      method: "POST",
      body: JSON.stringify({ match_type: "contains", pattern: "NETFLIX.COM AMSTERDAM", category_id: 11, priority: 100 }),
    });
    expect(calls[1].url).toBe("/api/rules"); // re-list to find the new rule's id
    expect(calls[2]).toEqual({
      url: "/api/rules/99/display-name",
      method: "PUT",
      body: JSON.stringify({ display_name: "Netflix" }),
    });
  });

  it("blocks calmly when there is no rule and no category to seed one", () => {
    wrap(
      <RenameMerchantSheet
        txn={txn({ CategoryID: null, CategoryName: "" })}
        rules={[]}
        txns={txns}
        onClose={() => {}}
        onSaved={() => {}}
      />,
    );
    expect(screen.getByText(/categorize it first/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/shown as/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("disables Save until the name actually changes", () => {
    wrap(
      <RenameMerchantSheet
        txn={txn({ DisplayName: "Netflix" })}
        rules={rules}
        txns={txns}
        onClose={() => {}}
        onSaved={() => {}}
      />,
    );
    expect(screen.getByLabelText(/shown as/i)).toHaveValue("Netflix");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("offers clearing an existing name, stating the consequence", async () => {
    const onSaved = vi.fn();
    wrap(
      <RenameMerchantSheet
        txn={txn({ DisplayName: "Netflix" })}
        rules={rules}
        txns={txns}
        onClose={() => {}}
        onSaved={onSaved}
      />,
    );
    fireEvent.change(screen.getByLabelText(/shown as/i), { target: { value: "" } });
    expect(screen.getByText(/original name again/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear name" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(""));
    expect(calls[0].body).toBe(JSON.stringify({ display_name: "" }));
  });

  it("surfaces a failed save inline and keeps the input", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ error: "boom" }), { status: 500 }),
    ));
    wrap(<RenameMerchantSheet txn={txn()} rules={rules} txns={txns} onClose={() => {}} onSaved={() => {}} />);
    const input = screen.getByLabelText(/shown as/i);
    fireEvent.change(input, { target: { value: "Netflix" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/couldn't save the name/i);
    expect(input).toHaveValue("Netflix");
  });
});
