import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { DeltaBadge } from "./DeltaBadge";

describe("DeltaBadge", () => {
  it("shows an up percentage with a vs-last-month label for an increase", () => {
    render(<DeltaBadge delta={320} deltaPct={0.32} />);
    expect(screen.getByText("32%")).toBeInTheDocument();
    expect(screen.getByLabelText(/up 32% vs last month/i)).toBeInTheDocument();
  });
  it("shows 'new' when the category is new", () => {
    render(<DeltaBadge delta={300} deltaPct={null} isNew />);
    expect(screen.getByText("new")).toBeInTheDocument();
  });
  it("shows 'gone' when spending stopped", () => {
    render(<DeltaBadge delta={-600} deltaPct={-1} isGone />);
    expect(screen.getByText("gone")).toBeInTheDocument();
  });
  it("shows an em dash for no change", () => {
    render(<DeltaBadge delta={0} deltaPct={0} />);
    expect(screen.getByText("—")).toBeInTheDocument();
  });
  it("falls back to a fils amount when deltaPct is null but it's not new", () => {
    render(<DeltaBadge delta={-500} deltaPct={null} />);
    expect(screen.getByText("5.00")).toBeInTheDocument();
  });
});
