import "@/test/storybook";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { composeStories } from "@storybook/react-vite";
import * as stories from "./ReadyToAssignBanner.stories";

const { Positive, Zero, Negative, WithOverspendDebt, FirstRun, Assigning } = composeStories(stories);

describe("ReadyToAssignBanner stories", () => {
  it("positive: plain ink figure with the auto-assign action", () => {
    const { container } = render(<Positive />);
    const fig = container.querySelector("[data-rta]")!;
    expect(fig.getAttribute("data-rta")).toBe("positive");
    expect(fig.className).not.toContain("text-bad");
    expect(screen.getByRole("button", { name: "Auto-assign" })).toBeInTheDocument();
  });

  it("zero: explicit 0.00 (not the em-dash), no auto-assign button", () => {
    const { container } = render(<Zero />);
    expect(screen.getByText("Every dirham assigned.")).toBeInTheDocument();
    expect(container.querySelector(".sr-only")!.textContent).toBe("0.00");
    expect(screen.queryByRole("button", { name: "Auto-assign" })).toBeNull();
  });

  it("negative: red only here — over-assigned is the one red state", () => {
    const { container } = render(<Negative />);
    const fig = container.querySelector("[data-rta]")!;
    expect(fig.getAttribute("data-rta")).toBe("negative");
    expect(fig.className).toContain("text-bad");
    expect(screen.getByText(/more than you have/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Auto-assign" })).toBeNull();
  });

  it("overspend debt joins the income · assigned meta line", () => {
    render(<WithOverspendDebt />);
    expect(screen.getByText(/overspend 450\.00/)).toBeInTheDocument();
  });

  it("first run routes to Settings income", () => {
    render(<FirstRun />);
    expect(screen.getByText(/Set your monthly income in Settings/)).toBeInTheDocument();
  });

  it("pending: the button reads Assigning… and is disabled", () => {
    render(<Assigning />);
    const btn = screen.getByRole("button", { name: "Assigning…" });
    expect(btn).toBeDisabled();
  });
});
