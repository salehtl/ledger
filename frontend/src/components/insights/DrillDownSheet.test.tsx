import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Txn } from "../../api/types";
import { ToastProvider } from "../../components/Toast";
import { DrillDownSheet, type DrillTarget } from "./DrillDownSheet";

function txn(p: Partial<Txn>): Txn {
  return {
    ID: 1, PostedAt: "2026-06-10T12:00:00Z", AmountFils: 1000, Currency: "AED",
    Direction: "debit", MerchantRaw: "Deliveroo", Status: "confirmed", Confidence: 1, Source: "email",
    CategoryID: 10, CategoryName: "Dining", Bucket: "want", Kind: "spending", BucketSnapshot: "",
    ...p,
  };
}

function renderSheet(target: DrillTarget, txns: Txn[]) {
  const qc = new QueryClient();
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <DrillDownSheet target={target} txns={txns} frozen={false} categories={[]} onClose={() => {}} />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe("DrillDownSheet", () => {
  const rows = [
    txn({ ID: 1, CategoryID: 10, CategoryName: "Dining", Bucket: "want", AmountFils: 600, MerchantRaw: "Deliveroo" }),
    txn({ ID: 2, CategoryID: 11, CategoryName: "Shopping", Bucket: "want", AmountFils: 400, MerchantRaw: "Noon" }),
    txn({ ID: 3, CategoryID: 12, CategoryName: "Rent", Bucket: "need", AmountFils: 1000, MerchantRaw: "Landlord" }),
  ];

  it("bucket target lists its categories and transactions, and narrows to a category", () => {
    renderSheet({ type: "bucket", bucket: "want" }, rows);
    // categories in the bucket
    expect(screen.getByText("Dining")).toBeInTheDocument();
    expect(screen.getByText("Shopping")).toBeInTheDocument();
    // want-bucket transactions shown, need-bucket excluded
    expect(screen.getByText("Deliveroo")).toBeInTheDocument();
    expect(screen.queryByText("Landlord")).not.toBeInTheDocument();
    // narrow to Dining
    fireEvent.click(screen.getByRole("button", { name: /drill into Dining/i }));
    expect(screen.getByText("Deliveroo")).toBeInTheDocument();
    expect(screen.queryByText("Noon")).not.toBeInTheDocument();
    // back returns to the bucket view
    fireEvent.click(screen.getByRole("button", { name: /back/i }));
    expect(screen.getByText("Shopping")).toBeInTheDocument();
  });

  it("merchant target lists only that merchant's transactions", () => {
    renderSheet({ type: "merchant", merchant: "Deliveroo" }, rows);
    // The dialog title and the transaction row both render the merchant name —
    // use getAllByText since both are intentionally present.
    expect(screen.getAllByText("Deliveroo").length).toBeGreaterThan(0);
    expect(screen.queryByText("Noon")).not.toBeInTheDocument();
  });
});
