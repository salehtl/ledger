import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ProjectsFlow } from "./ProjectsFlow";
import * as client from "../../api/client";
import { ToastProvider } from "../../components/Toast";
import type { Project, ProjectDetail } from "../../api/types";

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>{ui}</ToastProvider>
    </QueryClientProvider>,
  );
}

function makeProject(overrides: Partial<Project> = {}): Project {
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
    ...overrides,
  };
}

describe("ProjectsFlow", () => {
  it("boots into the list view when no initialProjectId is given", async () => {
    vi.spyOn(client, "getProjects").mockResolvedValue([makeProject()]);
    wrap(<ProjectsFlow onClose={() => {}} />);
    expect(await screen.findByRole("heading", { name: /^projects$/i })).toBeInTheDocument();
    expect(await screen.findByText("Kitchen reno")).toBeInTheDocument();
  });

  it("boots straight into a project's detail when initialProjectId is given", async () => {
    const project: ProjectDetail = { ...makeProject({ id: 42, name: "Wedding" }), by_category: [] };
    vi.spyOn(client, "getProject").mockResolvedValue(project);
    wrap(<ProjectsFlow initialProjectId={42} onClose={() => {}} />);
    expect(await screen.findByRole("heading", { name: /wedding/i })).toBeInTheDocument();
    expect(client.getProject).toHaveBeenCalledWith(42);
  });

  it("goes back to the list from a deep-linked detail view", async () => {
    const project: ProjectDetail = { ...makeProject({ id: 42, name: "Wedding" }), by_category: [] };
    vi.spyOn(client, "getProject").mockResolvedValue(project);
    vi.spyOn(client, "getProjects").mockResolvedValue([makeProject({ id: 42, name: "Wedding" })]);
    wrap(<ProjectsFlow initialProjectId={42} onClose={() => {}} />);
    await screen.findByRole("heading", { name: /wedding/i });
    fireEvent.click(screen.getByRole("button", { name: /back from wedding/i }));
    expect(await screen.findByRole("heading", { name: /^projects$/i })).toBeInTheDocument();
  });

  it("keeps the list mounted beneath an opened detail page", async () => {
    const project: ProjectDetail = { ...makeProject(), by_category: [] };
    vi.spyOn(client, "getProjects").mockResolvedValue([makeProject()]);
    vi.spyOn(client, "getProject").mockResolvedValue(project);
    wrap(<ProjectsFlow onClose={() => {}} />);
    fireEvent.click(await screen.findByText("Kitchen reno"));
    await screen.findByRole("heading", { name: /kitchen reno/i });
    // The list must stay in the DOM so back-nav reveals it beneath the
    // detail's slide-out instead of flashing the screen under the flow.
    expect(screen.getByRole("heading", { name: /^projects$/i })).toBeInTheDocument();
  });

  it("unmounts the detail after backing out of it", async () => {
    const project: ProjectDetail = { ...makeProject({ id: 42, name: "Wedding" }), by_category: [] };
    vi.spyOn(client, "getProject").mockResolvedValue(project);
    vi.spyOn(client, "getProjects").mockResolvedValue([makeProject({ id: 42, name: "Wedding" })]);
    wrap(<ProjectsFlow initialProjectId={42} onClose={() => {}} />);
    await screen.findByRole("heading", { name: /wedding/i });
    fireEvent.click(screen.getByRole("button", { name: /back from wedding/i }));
    await waitFor(() => expect(screen.queryByRole("heading", { name: /wedding/i })).not.toBeInTheDocument());
    expect(screen.getByRole("heading", { name: /^projects$/i })).toBeInTheDocument();
  });

  it("calls onClose when backing out of the list", async () => {
    vi.spyOn(client, "getProjects").mockResolvedValue([]);
    const onClose = vi.fn();
    wrap(<ProjectsFlow onClose={onClose} />);
    await screen.findByRole("heading", { name: /^projects$/i });
    fireEvent.click(screen.getByRole("button", { name: /back from projects/i }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });
});
