import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import type { Txn } from "../../api/types";
import { SwipeCard } from "./SwipeCard";

function txn(p: Partial<Txn>): Txn {
  return {
    ID: 1, PostedAt: "2026-07-03T10:00:00Z", AmountFils: 5000, AmountAedFils: 5000, Currency: "AED",
    Direction: "debit", MerchantRaw: "Carrefour", Status: "needs_review", Confidence: 0.97, Source: "email",
    CategoryID: null, CategoryName: "", Bucket: "", Kind: "", BucketSnapshot: "", RefundOfID: null,
    ...p,
  };
}

function renderCard(t: Txn) {
  render(
    <SwipeCard
      txn={t}
      onDirectionCommit={() => {}}
      onTripleTap={() => {}}
      onExitComplete={() => {}}
    />,
  );
}

beforeEach(() => {
  Element.prototype.setPointerCapture = vi.fn();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SwipeCard context line", () => {
  it("shows the account name and the review reason", () => {
    renderCard(txn({ Last4: "4821", AccountName: "Main current" }));
    expect(screen.getByText("Main current")).toBeInTheDocument();
    expect(screen.getByText("New merchant")).toBeInTheDocument();
  });

  it("masks an unregistered account to its last4", () => {
    renderCard(txn({ Last4: "9999", Confidence: 0.4 }));
    expect(screen.getByText("···9999")).toBeInTheDocument();
    expect(screen.getByText(/auto-read from the email/i)).toBeInTheDocument();
  });

  it("shows only the reason when no account digits exist", () => {
    renderCard(txn({ Source: "import" }));
    expect(screen.getByText("Imported from a file")).toBeInTheDocument();
    expect(screen.queryByText(/···/)).not.toBeInTheDocument();
  });
});
