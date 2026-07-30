import "@/test/storybook";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { composeStories } from "@storybook/react-vite";
import * as stories from "./EnvelopeRow.stories";

const { Funded, UnfundedTarget, NeedsMore, SaveByDate, Overspent, WithBillClaim, JarRow } = composeStories(stories);

describe("EnvelopeRow stories", () => {
  it("funded target: dithered bar, target meta, quiet 'funded' verdict", () => {
    const { container } = render(<Funded />);
    expect(container.querySelector("[data-envelope]")!.getAttribute("data-envelope")).toBe("funded");
    expect(screen.getByRole("progressbar", { name: "Groceries envelope used" })).toBeInTheDocument();
    expect(screen.getByText("set aside 1,200.00/mo")).toBeInTheDocument();
    expect(screen.getByText("funded")).toBeInTheDocument();
  });

  it("unfunded target: a calm ask — jar mode, no bar, no red, spend in the column", () => {
    const { container } = render(<UnfundedTarget />);
    expect(container.querySelector("[data-envelope]")!.getAttribute("data-envelope")).toBe("jar");
    expect(container.querySelector('[role="progressbar"]')).toBeNull();
    expect(container.querySelector(".money-neg")).toBeNull();
    expect(screen.queryByText("Overspent")).toBeNull();
    expect(screen.getByText("refill to 800.00/mo")).toBeInTheDocument();
    expect(screen.getByText(/needs 1,678\.15 more/)).toBeInTheDocument();
  });

  it("needs more: still-needed ask in the meta line", () => {
    render(<NeedsMore />);
    expect(screen.getByText(/needs 400\.00 more/)).toBeInTheDocument();
  });

  it("save by date: amount and due month", () => {
    render(<SaveByDate />);
    expect(screen.getByText(/save 15,000\.00 by Dec 2026/)).toBeInTheDocument();
  });

  it("overspent: negative available prints .money-neg and the verdict says Overspent", () => {
    const { container } = render(<Overspent />);
    expect(container.querySelector("[data-envelope]")!.getAttribute("data-envelope")).toBe("overspent");
    expect(container.querySelector(".money-neg")).not.toBeNull();
    expect(screen.getByText("Overspent")).toBeInTheDocument();
    expect(container.querySelector('[data-state="overbudget"]')).not.toBeNull();
  });

  it("bill claim: hint line with the shortfall called out in words", () => {
    const { container } = render(<WithBillClaim />);
    expect(screen.getByText(/Netflix due in 2d · 39\.00/)).toBeInTheDocument();
    expect(screen.getByText(/short 19\.00/)).toBeInTheDocument();
    expect(container.querySelector("[data-claim]")!.getAttribute("data-claim")).toBe("short");
  });

  it("jar row: no bar, no overspend shouting — spend only", () => {
    const { container } = render(<JarRow />);
    expect(container.querySelector("[data-envelope]")!.getAttribute("data-envelope")).toBe("jar");
    expect(container.querySelector('[role="progressbar"]')).toBeNull();
    expect(screen.queryByText("Overspent")).toBeNull();
    expect(screen.getByText("spent")).toBeInTheDocument();
    expect(screen.getByText(/no envelope yet/)).toBeInTheDocument();
  });
});
