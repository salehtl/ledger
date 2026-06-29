import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Dialog } from "./Dialog";
import { SHEET_EXIT_MS } from "../../lib/motion";

describe("Dialog", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("renders the title and children", () => {
    render(<Dialog title="Choose period" onClose={vi.fn()}>body</Dialog>);
    expect(screen.getByRole("dialog", { name: "Choose period" })).toBeInTheDocument();
    expect(screen.getByText("body")).toBeInTheDocument();
  });

  it("gives the panel a transform transition for the slide", () => {
    render(<Dialog title="T" onClose={vi.fn()}>x</Dialog>);
    expect(screen.getByRole("dialog").style.transition).toContain("transform");
  });

  it("plays the exit before calling onClose", () => {
    const onClose = vi.fn();
    render(<Dialog title="T" onClose={onClose}>x</Dialog>);
    fireEvent.click(screen.getByLabelText("Close"));
    expect(onClose).not.toHaveBeenCalled();          // exit in flight
    vi.advanceTimersByTime(SHEET_EXIT_MS);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not double-fire onClose when closed twice quickly", () => {
    const onClose = vi.fn();
    render(<Dialog title="T" onClose={onClose}>x</Dialog>);
    fireEvent.click(screen.getByLabelText("Close"));
    fireEvent.keyDown(document, { key: "Escape" });
    vi.advanceTimersByTime(SHEET_EXIT_MS);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
