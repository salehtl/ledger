import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ProjectDetail } from "./ProjectDetail";
import * as client from "../../api/client";
import { ToastProvider } from "../../components/Toast";
import type { ProjectDetail as ProjectDetailType, Txn } from "../../api/types";

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>{ui}</ToastProvider>
    </QueryClientProvider>,
  );
}

function makeProject(overrides: Partial<ProjectDetailType> = {}): ProjectDetailType {
  return {
    id: 1,
    name: "Kitchen reno",
    budget_fils: 1_000_000,
    color: "#1373d9",
    starts_on: "",
    ends_on: "",
    status: "active",
    count_in_monthly: false,
    completed_at: "",
    net_spent_fils: 400_000,
    pending_fils: 0,
    txn_count: 2,
    by_category: [],
    ...overrides,
  };
}

function makeTxn(overrides: Partial<Txn> = {}): Txn {
  return {
    ID: 1, PostedAt: "2026-06-01T10:00:00Z", AmountFils: 10000, AmountAedFils: 10000, Currency: "AED",
    Direction: "debit", MerchantRaw: "Ikea", Status: "confirmed", Confidence: 1, Source: "email",
    CategoryID: 1, CategoryName: "Home", Bucket: "want", Kind: "normal", BucketSnapshot: "want",
    ProjectID: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.spyOn(client, "updateProject").mockResolvedValue(undefined);
  vi.spyOn(client, "deleteProject").mockResolvedValue(undefined);
  vi.spyOn(client, "getJSON").mockImplementation(async (url: string) => {
    if (url.startsWith("/api/transactions")) {
      return [
        makeTxn({ ID: 1, ProjectID: 1, MerchantRaw: "Ikea" }),
        makeTxn({ ID: 2, ProjectID: null, MerchantRaw: "Carrefour" }),
      ] as unknown as Txn[];
    }
    return [] as unknown as Txn[];
  });
});

describe("ProjectDetail", () => {
  it("shows net spent, a budget bar, and remaining", async () => {
    vi.spyOn(client, "getProject").mockResolvedValue(makeProject());
    wrap(<ProjectDetail id={1} onClose={() => {}} onEdit={() => {}} onAddTransactions={() => {}} />);
    expect(await screen.findByText("4,000.00")).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toBeInTheDocument();
    expect(screen.getByText(/remaining/i)).toBeInTheDocument();
  });

  it("shows 'No budget set' when the project has no budget", async () => {
    vi.spyOn(client, "getProject").mockResolvedValue(makeProject({ budget_fils: null }));
    wrap(<ProjectDetail id={1} onClose={() => {}} onEdit={() => {}} onAddTransactions={() => {}} />);
    expect(await screen.findByText(/no budget set/i)).toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });

  it("shows a pending sub-line when pending_fils > 0", async () => {
    vi.spyOn(client, "getProject").mockResolvedValue(makeProject({ pending_fils: 50_000 }));
    wrap(<ProjectDetail id={1} onClose={() => {}} onEdit={() => {}} onAddTransactions={() => {}} />);
    expect(await screen.findByText(/pending review/i)).toBeInTheDocument();
  });

  it("does not show a pending sub-line when pending_fils is 0", async () => {
    vi.spyOn(client, "getProject").mockResolvedValue(makeProject({ pending_fils: 0 }));
    wrap(<ProjectDetail id={1} onClose={() => {}} onEdit={() => {}} onAddTransactions={() => {}} />);
    await screen.findByText("4,000.00");
    expect(screen.queryByText(/pending review/i)).not.toBeInTheDocument();
  });

  it("shows by-category rows", async () => {
    vi.spyOn(client, "getProject").mockResolvedValue(
      makeProject({ by_category: [{ category: "Furniture", net_fils: 300_000 }] }),
    );
    wrap(<ProjectDetail id={1} onClose={() => {}} onEdit={() => {}} onAddTransactions={() => {}} />);
    expect(await screen.findByText("Furniture")).toBeInTheDocument();
    expect(screen.getByText("3,000.00")).toBeInTheDocument();
  });

  it("lists only transactions assigned to this project", async () => {
    vi.spyOn(client, "getProject").mockResolvedValue(makeProject());
    wrap(<ProjectDetail id={1} onClose={() => {}} onEdit={() => {}} onAddTransactions={() => {}} />);
    expect(await screen.findByText("Ikea")).toBeInTheDocument();
    expect(screen.queryByText("Carrefour")).not.toBeInTheDocument();
  });

  it("toggles count_in_monthly via the switch", async () => {
    vi.spyOn(client, "getProject").mockResolvedValue(makeProject({ count_in_monthly: false }));
    wrap(<ProjectDetail id={1} onClose={() => {}} onEdit={() => {}} onAddTransactions={() => {}} />);
    const sw = await screen.findByLabelText(/count in monthly budget/i);
    fireEvent.click(sw);
    await waitFor(() =>
      expect(client.updateProject).toHaveBeenCalledWith(1, expect.objectContaining({ count_in_monthly: true })),
    );
  });

  it("marks an active project complete", async () => {
    vi.spyOn(client, "getProject").mockResolvedValue(makeProject({ status: "active" }));
    wrap(<ProjectDetail id={1} onClose={() => {}} onEdit={() => {}} onAddTransactions={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: /mark complete/i }));
    await waitFor(() =>
      expect(client.updateProject).toHaveBeenCalledWith(1, expect.objectContaining({ status: "completed" })),
    );
  });

  it("reopens a completed project", async () => {
    vi.spyOn(client, "getProject").mockResolvedValue(makeProject({ status: "completed" }));
    wrap(<ProjectDetail id={1} onClose={() => {}} onEdit={() => {}} onAddTransactions={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: /^reopen$/i }));
    await waitFor(() =>
      expect(client.updateProject).toHaveBeenCalledWith(1, expect.objectContaining({ status: "active" })),
    );
  });

  it("calls onEdit with the current project when Edit is tapped", async () => {
    const project = makeProject();
    vi.spyOn(client, "getProject").mockResolvedValue(project);
    const onEdit = vi.fn();
    wrap(<ProjectDetail id={1} onClose={() => {}} onEdit={onEdit} onAddTransactions={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: /^edit$/i }));
    expect(onEdit).toHaveBeenCalledWith(expect.objectContaining({ id: 1, name: "Kitchen reno" }));
  });

  it("calls onAddTransactions when 'Add transactions' is tapped", async () => {
    vi.spyOn(client, "getProject").mockResolvedValue(makeProject());
    const onAddTransactions = vi.fn();
    wrap(<ProjectDetail id={1} onClose={() => {}} onEdit={() => {}} onAddTransactions={onAddTransactions} />);
    fireEvent.click(await screen.findByRole("button", { name: /add transactions/i }));
    expect(onAddTransactions).toHaveBeenCalledTimes(1);
  });

  it("opens the CategorizeSheet when an assigned transaction row is tapped", async () => {
    vi.spyOn(client, "getProject").mockResolvedValue(makeProject());
    wrap(<ProjectDetail id={1} onClose={() => {}} onEdit={() => {}} onAddTransactions={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: /open ikea/i }));
    expect(await screen.findByText("Categorize")).toBeInTheDocument();
  });

  it("opens a confirm dialog and deletes the project on confirm", async () => {
    vi.spyOn(client, "getProject").mockResolvedValue(makeProject());
    const onClose = vi.fn();
    wrap(<ProjectDetail id={1} onClose={onClose} onEdit={() => {}} onAddTransactions={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: /^delete$/i }));
    const confirmButtons = await screen.findAllByRole("button", { name: /^delete$/i });
    expect(client.deleteProject).not.toHaveBeenCalled();
    fireEvent.click(confirmButtons[confirmButtons.length - 1]);
    await waitFor(() => expect(client.deleteProject).toHaveBeenCalledWith(1));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("does not delete when the confirm dialog is cancelled", async () => {
    vi.spyOn(client, "getProject").mockResolvedValue(makeProject());
    wrap(<ProjectDetail id={1} onClose={() => {}} onEdit={() => {}} onAddTransactions={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: /^delete$/i }));
    fireEvent.click(await screen.findByRole("button", { name: /^cancel$/i }));
    expect(client.deleteProject).not.toHaveBeenCalled();
  });
});
