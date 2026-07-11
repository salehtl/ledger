import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ProjectsScreen } from "./ProjectsScreen";
import * as client from "../../api/client";
import type { Project } from "../../api/types";

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
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

describe("ProjectsScreen", () => {
  it("shows Active and Completed sections", async () => {
    vi.spyOn(client, "getProjects").mockResolvedValue([
      makeProject({ id: 1, name: "Kitchen reno", status: "active" }),
      makeProject({ id: 2, name: "Old trip", status: "completed" }),
    ]);
    wrap(<ProjectsScreen onClose={() => {}} onNewProject={() => {}} onOpenProject={() => {}} />);
    expect(await screen.findByText("Kitchen reno")).toBeInTheDocument();
    expect(screen.getByText("Old trip")).toBeInTheDocument();
    expect(screen.getByText(/^active$/i)).toBeInTheDocument();
    expect(screen.getByText(/^completed$/i)).toBeInTheDocument();
  });

  it("shows the + New project action", async () => {
    vi.spyOn(client, "getProjects").mockResolvedValue([]);
    wrap(<ProjectsScreen onClose={() => {}} onNewProject={() => {}} onOpenProject={() => {}} />);
    expect(await screen.findByText(/new project/i)).toBeInTheDocument();
  });

  it("shows an empty state when there are no projects", async () => {
    vi.spyOn(client, "getProjects").mockResolvedValue([]);
    wrap(<ProjectsScreen onClose={() => {}} onNewProject={() => {}} onOpenProject={() => {}} />);
    expect(await screen.findByText(/no projects yet/i)).toBeInTheDocument();
  });

  it("calls onOpenProject when a card is tapped", async () => {
    const onOpenProject = vi.fn();
    vi.spyOn(client, "getProjects").mockResolvedValue([makeProject({ id: 42, name: "Kitchen reno" })]);
    wrap(<ProjectsScreen onClose={() => {}} onNewProject={() => {}} onOpenProject={onOpenProject} />);
    fireEvent.click(await screen.findByText("Kitchen reno"));
    expect(onOpenProject).toHaveBeenCalledWith(42);
  });

  it("calls onNewProject when + New project is tapped", async () => {
    const onNewProject = vi.fn();
    vi.spyOn(client, "getProjects").mockResolvedValue([]);
    wrap(<ProjectsScreen onClose={() => {}} onNewProject={onNewProject} onOpenProject={() => {}} />);
    fireEvent.click(await screen.findByText(/new project/i));
    expect(onNewProject).toHaveBeenCalledTimes(1);
  });
});
