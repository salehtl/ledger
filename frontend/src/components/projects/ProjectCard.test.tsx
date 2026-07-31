import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MotionProvider } from "../../app/MotionProvider";
import { ProjectCard } from "./ProjectCard";
import type { Project } from "../../api/types";

const wrap = (ui: React.ReactNode) => render(<MotionProvider>{ui}</MotionProvider>);

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 1,
    name: "Kitchen reno",
    budget_fils: null,
    color: "#1373d9",
    starts_on: "",
    ends_on: "",
    status: "active",
    count_in_monthly: false,
    completed_at: "",
    net_spent_fils: 500000,
    pending_fils: 0,
    txn_count: 3,
    ...overrides,
  };
}

describe("ProjectCard", () => {
  it("shows a progress bar and remaining amount when a budget is set", () => {
    wrap(
      <ProjectCard
        project={makeProject({ budget_fils: 1_000_000, net_spent_fils: 400_000 })}
        onOpen={() => {}}
      />,
    );
    expect(screen.getByRole("progressbar")).toBeInTheDocument();
    expect(screen.getByText(/remaining/i)).toBeInTheDocument();
  });

  it("shows spent-only with a no-budget label when budget is null", () => {
    wrap(<ProjectCard project={makeProject({ budget_fils: null })} onOpen={() => {}} />);
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.getByText(/no budget/i)).toBeInTheDocument();
  });

  it("shows a pending sub-line when pending_fils > 0", () => {
    wrap(<ProjectCard project={makeProject({ pending_fils: 20_000 })} onOpen={() => {}} />);
    expect(screen.getByText(/pending/i)).toBeInTheDocument();
  });

  it("does not show a pending sub-line when pending_fils is 0", () => {
    wrap(<ProjectCard project={makeProject({ pending_fils: 0 })} onOpen={() => {}} />);
    expect(screen.queryByText(/pending/i)).toBeNull();
  });

  it("applies over-budget styling and messaging when net spend exceeds budget", () => {
    wrap(
      <ProjectCard
        project={makeProject({ budget_fils: 100_000, net_spent_fils: 150_000 })}
        onOpen={() => {}}
      />,
    );
    expect(screen.getByText(/over budget/i)).toBeInTheDocument();
  });

  it("calls onOpen when tapped", () => {
    const onOpen = vi.fn();
    wrap(<ProjectCard project={makeProject()} onOpen={onOpen} />);
    fireEvent.click(screen.getByRole("button"));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});
