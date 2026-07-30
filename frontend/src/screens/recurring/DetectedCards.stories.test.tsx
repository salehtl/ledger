import "@/test/storybook";
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { composeStories } from "@storybook/react-vite";
import * as stories from "./DetectedCards.stories";

const { Proposals, IncomeProposal, Busy } = composeStories(stories);

describe("DetectedCards stories", () => {
  it("shows the provenance line with the mined evidence", () => {
    render(<Proposals />);
    expect(screen.getByText(/seen 3× every ~30 days at 56\.00/)).toBeInTheDocument();
    expect(screen.getByText("netflix.com")).toBeInTheDocument();
  });

  it("marks a stepped price in the provenance line", () => {
    render(<Proposals />);
    expect(screen.getByText(/price stepped/)).toBeInTheDocument();
  });

  it("resolves the category name into the meta line", () => {
    render(<Proposals />);
    expect(screen.getByText(/Subscriptions · every month/)).toBeInTheDocument();
  });

  it("labels income proposals", () => {
    render(<IncomeProposal />);
    expect(screen.getByText(/income · every month/)).toBeInTheDocument();
  });

  it("fires confirm and dismiss callbacks", () => {
    const onConfirm = vi.fn();
    const onDismiss = vi.fn();
    render(<Proposals onConfirm={onConfirm} onDismiss={onDismiss} />);
    fireEvent.click(screen.getAllByText("Track this bill")[0]);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getAllByText("Dismiss")[0]);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("opens the matched transactions from the provenance tap target", () => {
    const onShowMatches = vi.fn();
    render(<Proposals onShowMatches={onShowMatches} />);
    fireEvent.click(screen.getByText(/seen 3× every ~30 days at 56\.00/));
    expect(onShowMatches).toHaveBeenCalledTimes(1);
  });

  it("disables actions on the busy card", () => {
    render(<Busy />);
    expect(screen.getByText("Track this bill").closest("button")).toBeDisabled();
    expect(screen.getByText("Dismiss").closest("button")).toBeDisabled();
  });

  it("never spends the spot ink on card actions", () => {
    const { container } = render(<Proposals />);
    // Confirm is tonal (bg-surface-2), dismiss is ghost — no bg-accent fills.
    expect(container.querySelector(".bg-accent")).toBeNull();
  });
});
