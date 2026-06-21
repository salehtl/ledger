import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TransactionRow } from "./TransactionRow";
import type { Txn } from "../../api/types";

const mk = (over: Partial<Txn>): Txn => ({
  ID: 1, PostedAt: "2026-06-10", AmountFils: 5000, Currency: "AED", Direction: "debit",
  MerchantRaw: "SPINNEYS", Status: "confirmed", Confidence: 0, Source: "email",
  CategoryID: null, CategoryName: "", Bucket: "", Kind: "", BucketSnapshot: "", ...over,
});

const noop = () => {};

describe("TransactionRow archive actions", () => {
  it("offers Archive on a non-archived row", () => {
    const onArchive = vi.fn();
    render(<TransactionRow txn={mk({})} onOpen={noop} onStatus={noop} onArchive={onArchive} onRestore={noop} />);
    fireEvent.click(screen.getByRole("button", { name: /archive/i }));
    expect(onArchive).toHaveBeenCalledTimes(1);
  });

  it("offers Restore (and not Archive) on an archived row", () => {
    const onRestore = vi.fn();
    render(<TransactionRow txn={mk({ Status: "archived" })} onOpen={noop} onStatus={noop} onArchive={noop} onRestore={onRestore} />);
    expect(screen.queryByRole("button", { name: /^archive$/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /restore/i }));
    expect(onRestore).toHaveBeenCalledTimes(1);
  });

  it("shows Categorize, Transfer, Ignore and Archive on a needs_review row", () => {
    render(<TransactionRow txn={mk({ Status: "needs_review" })} onOpen={noop} onStatus={noop} onArchive={noop} onRestore={noop} />);
    for (const name of [/categorize/i, /transfer/i, /ignore/i, /^archive$/i]) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    }
  });
});
