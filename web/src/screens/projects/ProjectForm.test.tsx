import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ProjectForm } from "./ProjectForm";
import * as client from "../../api/client";
import { ToastProvider } from "../../components/Toast";
import type { Project } from "../../api/types";

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>{ui}</ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.spyOn(client, "createProject").mockResolvedValue({ id: 1 });
  vi.spyOn(client, "updateProject").mockResolvedValue(undefined);
});

describe("ProjectForm", () => {
  it("renders empty create fields", () => {
    wrap(<ProjectForm onClose={() => {}} onSaved={() => {}} />);
    expect(screen.getByText(/new project/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^name$/i)).toHaveValue("");
    expect(screen.getByLabelText(/budget \(aed\)/i)).toHaveValue("");
  });

  it("submits name, budget_fils, and count_in_monthly on create", async () => {
    const onSaved = vi.fn();
    wrap(<ProjectForm onClose={() => {}} onSaved={onSaved} />);
    fireEvent.change(screen.getByLabelText(/^name$/i), { target: { value: "Wedding" } });
    fireEvent.change(screen.getByLabelText(/budget \(aed\)/i), { target: { value: "150" } });
    fireEvent.click(screen.getByLabelText(/count in monthly budget/i));
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => expect(client.createProject).toHaveBeenCalled());
    expect(client.createProject).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Wedding", budget_fils: 15_000, count_in_monthly: true }),
    );
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it("treats an empty budget field as no budget", async () => {
    wrap(<ProjectForm onClose={() => {}} onSaved={() => {}} />);
    fireEvent.change(screen.getByLabelText(/^name$/i), { target: { value: "Trip" } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(client.createProject).toHaveBeenCalled());
    expect(client.createProject).toHaveBeenCalledWith(expect.objectContaining({ budget_fils: null }));
  });

  it("shows an error and does not submit when name is empty", () => {
    wrap(<ProjectForm onClose={() => {}} onSaved={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(client.createProject).not.toHaveBeenCalled();
  });

  it("pre-fills fields in edit mode and calls updateProject with the project id", async () => {
    const project: Project = {
      id: 7,
      name: "Kitchen reno",
      budget_fils: 500_000,
      color: "#7b35b8",
      starts_on: "2026-01-01",
      ends_on: "2026-06-30",
      status: "active",
      count_in_monthly: false,
      completed_at: "",
      net_spent_fils: 100_000,
      pending_fils: 0,
      txn_count: 4,
    };
    wrap(<ProjectForm project={project} onClose={() => {}} onSaved={() => {}} />);
    expect(screen.getByLabelText(/^name$/i)).toHaveValue("Kitchen reno");
    expect(screen.getByLabelText(/budget \(aed\)/i)).toHaveValue("5000");

    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(client.updateProject).toHaveBeenCalled());
    expect(client.updateProject).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ name: "Kitchen reno", budget_fils: 500_000 }),
    );
  });
});
