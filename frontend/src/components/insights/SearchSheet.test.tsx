import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Txn } from "../../api/types";
import { ToastProvider } from "../../components/Toast";
import { SearchSheet } from "./SearchSheet";

function txn(p: Partial<Txn>): Txn {
  return {
    ID: 1, PostedAt: "2026-06-10T12:00:00Z", AmountFils: 1000, Currency: "AED",
    Direction: "debit", MerchantRaw: "Deliveroo", Status: "confirmed", Confidence: 1, Source: "email",
    CategoryID: 10, CategoryName: "Dining", Bucket: "want", Kind: "spending", BucketSnapshot: "",
    ...p,
  };
}

describe("SearchSheet", () => {
  it("filters the list by merchant text", () => {
    const qc = new QueryClient();
    render(
      <QueryClientProvider client={qc}>
        <ToastProvider>
          <SearchSheet
            txns={[txn({ ID: 1, MerchantRaw: "Deliveroo" }), txn({ ID: 2, MerchantRaw: "Noon" })]}
            categories={[]}
            onClose={() => {}}
          />
        </ToastProvider>
      </QueryClientProvider>,
    );
    expect(screen.getByText("Deliveroo")).toBeInTheDocument();
    expect(screen.getByText("Noon")).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText(/search merchant/i), { target: { value: "deliv" } });
    expect(screen.getByText("Deliveroo")).toBeInTheDocument();
    expect(screen.queryByText("Noon")).not.toBeInTheDocument();
  });
});
