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

  it("seeds scrim opacity to 0 even under reduced motion", () => {
    // Override matchMedia so prefers-reduced-motion: reduce matches true.
    window.matchMedia = vi.fn().mockImplementation(query => ({
      matches: query === "(prefers-reduced-motion: reduce)",
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    const { container } = render(<Dialog title="T" onClose={vi.fn()}>x</Dialog>);
    const scrim = container.querySelector('[data-testid="dialog-scrim"]') as HTMLElement;
    expect(scrim).not.toBeNull();
    // The mount effect must seed opacity="0" before the rAF fires (rAF doesn't
    // run in jsdom under fake timers), proving the scrim fade path was entered.
    expect(scrim.style.opacity).toBe("0");
  });

  it("dismisses when the handle is flicked down", () => {
    const onClose = vi.fn();
    render(<Dialog title="T" onClose={onClose}>x</Dialog>);
    const handle = screen.getByText("T").closest("div")!; // the drag region wrapping the header
    fireEvent.pointerDown(handle, { clientY: 0, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientY: 60, pointerId: 1 });
    fireEvent.pointerUp(handle, { clientY: 60, pointerId: 1 });
    vi.advanceTimersByTime(SHEET_EXIT_MS);
    expect(onClose).toHaveBeenCalled();
  });

  it("closes synchronously under reduced motion without advancing timers", () => {
    window.matchMedia = vi.fn().mockImplementation(query => ({
      matches: query === "(prefers-reduced-motion: reduce)",
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    const onClose = vi.fn();
    render(<Dialog title="T" onClose={onClose}>x</Dialog>);
    fireEvent.click(screen.getByLabelText("Close"));
    // No timer advancement — reduced motion must fire onClose immediately.
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
