// frontend/src/components/transactions/CategorizeSheet.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CategorizeSheet } from "./CategorizeSheet";
import * as client from "../../api/client";
import type { Category, Project, Txn } from "../../api/types";

const cats: Category[] = [
  { ID: 1, Name: "Groceries", Kind: "spending", Bucket: "need", IsActive: true, Color: "" },
  { ID: 2, Name: "Dining", Kind: "spending", Bucket: "want", IsActive: true, Color: "" },
];
const txn: Txn = { ID: 9, PostedAt: "2026-06-10", AmountFils: 5000, AmountAedFils: 5000, Currency: "AED", Direction: "debit", MerchantRaw: "CARREFOUR", Status: "needs_review", Confidence: 0, Source: "email", CategoryID: null, CategoryName: "", Bucket: "", Kind: "", BucketSnapshot: "" };
const projects: Project[] = [
  { id: 3, name: "Kitchen reno", budget_fils: null, color: "#1373d9", starts_on: "", ends_on: "", status: "active", count_in_monthly: false, completed_at: "", net_spent_fils: 0, pending_fils: 0, txn_count: 0 },
  { id: 4, name: "Wedding", budget_fils: null, color: "#c9184a", starts_on: "", ends_on: "", status: "active", count_in_monthly: false, completed_at: "", net_spent_fils: 0, pending_fils: 0, txn_count: 0 },
];

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  vi.spyOn(client, "getProjects").mockResolvedValue(projects);
  vi.spyOn(client, "assignTxnProject").mockResolvedValue(undefined);
});

describe("CategorizeSheet", () => {
  it("submits the chosen category + make_rule", () => {
    const onSubmit = vi.fn();
    wrap(<CategorizeSheet txn={txn} categories={cats} onSubmit={onSubmit} onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Dining" }));
    fireEvent.click(screen.getByLabelText(/make a rule/i));
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    expect(onSubmit).toHaveBeenCalledWith({ category_id: 2, make_rule: true });
  });

  it("filters by search", () => {
    wrap(<CategorizeSheet txn={txn} categories={cats} onSubmit={() => {}} onClose={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText(/search/i), { target: { value: "din" } });
    expect(screen.getByRole("button", { name: "Dining" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Groceries" })).not.toBeInTheDocument();
  });

  it("paints each picker dot with the category's own colour, not its bucket", () => {
    // Same shape as CategoryManager's CategoryRow test, and it works for the
    // same reason: bucketColor can only ever return --color-need/want/save/
    // transfer/muted, so teal and orchid are unreachable through it. A
    // regression to bucketColor(c.Bucket) fails here rather than shipping
    // Groceries teal in Plan and amber in this sheet.
    const colored: Category[] = [
      { ...cats[0], Color: "teal" },
      { ...cats[1], Color: "orchid" },
    ];
    wrap(<CategorizeSheet txn={txn} categories={colored} onSubmit={() => {}} onClose={() => {}} />);
    const dot = (name: string) =>
      (screen.getByRole("button", { name }).querySelector("span[aria-hidden]") as HTMLElement).style.backgroundColor;
    expect(dot("Groceries")).toBe("var(--color-teal)");
    expect(dot("Dining")).toBe("var(--color-orchid)");
  });

  it("falls back to the neutral for a category with no stored colour", () => {
    // Not "no colour at all": an unset colour must render the slate neutral,
    // never an interpolated var(--color-) that resolves to nothing.
    wrap(<CategorizeSheet txn={txn} categories={cats} onSubmit={() => {}} onClose={() => {}} />);
    const el = screen.getByRole("button", { name: "Groceries" }).querySelector("span[aria-hidden]") as HTMLElement;
    expect(el.style.backgroundColor).toBe("var(--color-slate)");
  });

  it("marks an unconverted foreign row with the native tag and a no-rate note", () => {
    const foreign: Txn = { ...txn, AmountFils: 1009, Currency: "USD", AmountAedFils: null };
    wrap(<CategorizeSheet txn={foreign} categories={cats} onSubmit={() => {}} onClose={() => {}} />);
    expect(screen.getByText(/USD 10\.09/)).toBeInTheDocument();
    expect(screen.getByText(/no AED rate/)).toBeInTheDocument();
  });
});

describe("CategorizeSheet refund actions", () => {
  it("offers the refund link for unlinked credits", () => {
    const onLinkRefund = vi.fn();
    wrap(
      <CategorizeSheet
        txn={{ ...txn, Direction: "credit", RefundOfID: null }}
        categories={cats}
        onSubmit={() => {}}
        onClose={() => {}}
        onLinkRefund={onLinkRefund}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /refund/i }));
    expect(onLinkRefund).toHaveBeenCalled();
  });

  it("offers unlink for linked credits", () => {
    const onUnlinkRefund = vi.fn();
    wrap(
      <CategorizeSheet
        txn={{ ...txn, Direction: "credit", RefundOfID: 42 }}
        categories={cats}
        onSubmit={() => {}}
        onClose={() => {}}
        onUnlinkRefund={onUnlinkRefund}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /unlink refund/i }));
    expect(onUnlinkRefund).toHaveBeenCalled();
  });

  it("hides refund actions for debits", () => {
    wrap(
      <CategorizeSheet
        txn={{ ...txn, Direction: "debit" }}
        categories={cats}
        onSubmit={() => {}}
        onClose={() => {}}
        onLinkRefund={() => {}}
      />,
    );
    expect(screen.queryByRole("button", { name: /refund/i })).not.toBeInTheDocument();
  });
});

describe("CategorizeSheet project assignment", () => {
  it("lists active projects plus None, defaulting to the txn's current project", async () => {
    wrap(<CategorizeSheet txn={{ ...txn, ProjectID: 4 }} categories={cats} onSubmit={() => {}} onClose={() => {}} />);
    const select = await screen.findByLabelText(/project/i);
    expect(select).toHaveValue("4");
    expect(screen.getByRole("option", { name: "None" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Kitchen reno" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Wedding" })).toBeInTheDocument();
  });

  it("assigns the txn to the chosen project and invalidates caches", async () => {
    wrap(<CategorizeSheet txn={txn} categories={cats} onSubmit={() => {}} onClose={() => {}} />);
    const select = await screen.findByLabelText(/project/i);
    fireEvent.change(select, { target: { value: "3" } });
    await waitFor(() => expect(client.assignTxnProject).toHaveBeenCalledWith(9, 3));
  });

  it("unassigns (None) as project_id null", async () => {
    wrap(<CategorizeSheet txn={{ ...txn, ProjectID: 3 }} categories={cats} onSubmit={() => {}} onClose={() => {}} />);
    const select = await screen.findByLabelText(/project/i);
    fireEvent.change(select, { target: { value: "" } });
    await waitFor(() => expect(client.assignTxnProject).toHaveBeenCalledWith(9, null));
  });

  it("keeps the chosen project selected (txn prop stays stale)", async () => {
    wrap(<CategorizeSheet txn={txn} categories={cats} onSubmit={() => {}} onClose={() => {}} />);
    const select = await screen.findByLabelText(/project/i);
    fireEvent.change(select, { target: { value: "3" } });
    await waitFor(() => expect(client.assignTxnProject).toHaveBeenCalledWith(9, 3));
    expect((select as HTMLSelectElement).value).toBe("3");
  });

  it("reverts the picker when assignment fails", async () => {
    vi.mocked(client.assignTxnProject).mockRejectedValueOnce(new Error("boom"));
    wrap(<CategorizeSheet txn={{ ...txn, ProjectID: 4 }} categories={cats} onSubmit={() => {}} onClose={() => {}} />);
    const select = await screen.findByLabelText(/project/i);
    fireEvent.change(select, { target: { value: "3" } });
    await waitFor(() => expect((select as HTMLSelectElement).value).toBe("4"));
  });
});

describe("CategorizeSheet decategorization", () => {
  it("deselects the current category on tap and saves a decategorization", () => {
    const onSubmit = vi.fn();
    wrap(<CategorizeSheet txn={{ ...txn, CategoryID: 2, CategoryName: "Dining" }} categories={cats} onSubmit={onSubmit} onClose={() => {}} />);
    const chip = screen.getByRole("button", { name: "Dining" });
    expect(chip).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(chip);
    expect(chip).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByText(/back to the review queue/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    expect(onSubmit).toHaveBeenCalledWith({ category_id: null, make_rule: false });
  });

  it("keeps Save disabled when an uncategorized txn has no selection", () => {
    wrap(<CategorizeSheet txn={txn} categories={cats} onSubmit={() => {}} onClose={() => {}} />);
    expect(screen.getByRole("button", { name: /save/i })).toBeDisabled();
  });

  it("disables the rule toggle while decategorizing", () => {
    wrap(<CategorizeSheet txn={{ ...txn, CategoryID: 2 }} categories={cats} onSubmit={() => {}} onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Dining" }));
    expect(screen.getByLabelText(/make a rule/i)).toBeDisabled();
  });
});
