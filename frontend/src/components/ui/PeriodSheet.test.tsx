import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { PeriodSheet } from "./PeriodSheet";
import { currentPeriod } from "../../lib/insights";
import type { Scope } from "../../lib/scope";

function open(onApply: (s: Scope) => void) {
  render(<PeriodSheet scope={{ kind: "month", period: "2026-06" }} onApply={onApply} onClose={() => {}} />);
}

describe("PeriodSheet", () => {
  it("offers quick presets", () => {
    open(() => {});
    expect(screen.getByRole("button", { name: /this month/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /last 3 months/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /year to date/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /all time/i })).toBeInTheDocument();
  });

  it("applies This month as a single-month scope", () => {
    const onApply = vi.fn();
    open(onApply);
    fireEvent.click(screen.getByRole("button", { name: /this month/i }));
    expect(onApply).toHaveBeenCalledWith({ kind: "month", period: currentPeriod() });
  });

  it("applies All time", () => {
    const onApply = vi.fn();
    open(onApply);
    fireEvent.click(screen.getByRole("button", { name: /all time/i }));
    expect(onApply).toHaveBeenCalledWith({ kind: "all" });
  });

  it("picks a single month from the grid", () => {
    const onApply = vi.fn();
    open(onApply); // seeded to year 2026
    fireEvent.click(screen.getByRole("button", { name: "Mar" }));
    fireEvent.click(screen.getByRole("button", { name: /^show$/i }));
    expect(onApply).toHaveBeenCalledWith({ kind: "month", period: "2026-03" });
  });

  it("forms a range from two grid taps", () => {
    const onApply = vi.fn();
    open(onApply);
    fireEvent.click(screen.getByRole("button", { name: "Mar" }));
    fireEvent.click(screen.getByRole("button", { name: "Jun" }));
    fireEvent.click(screen.getByRole("button", { name: /^show$/i }));
    expect(onApply).toHaveBeenCalledWith({ kind: "range", from: "2026-03", to: "2026-06" });
  });
});
