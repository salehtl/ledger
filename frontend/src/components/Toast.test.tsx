import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { toastReducer, ToastProvider, useToast } from "./Toast";

describe("toastReducer", () => {
  it("adds and removes by id", () => {
    const added = toastReducer([], { type: "add", toast: { id: 1, message: "Hi" } });
    expect(added).toHaveLength(1);
    const removed = toastReducer(added, { type: "remove", id: 1 });
    expect(removed).toHaveLength(0);
  });
});

function Trigger() {
  const { show } = useToast();
  const onUndo = vi.fn();
  // expose the spy so the test can assert it fired
  (globalThis as Record<string, unknown>).__undo = onUndo;
  return (
    <button onClick={() => show({ message: "Ignored Spinneys", action: { label: "Undo", onAction: onUndo } })}>
      go
    </button>
  );
}

describe("ToastProvider", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("shows a toast and fires its action", () => {
    render(<ToastProvider><Trigger /></ToastProvider>);
    fireEvent.click(screen.getByText("go"));
    expect(screen.getByText("Ignored Spinneys")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /undo/i }));
    expect((globalThis as Record<string, unknown>).__undo).toBeTruthy();
    expect(((globalThis as unknown as Record<string, () => void> & { __undo: ReturnType<typeof vi.fn> }).__undo)).toHaveBeenCalled();
  });
});

describe("toast enter/exit motion", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
  });

  it("keeps the toast mounted briefly after × is clicked (exit animation)", () => {
    render(<ToastProvider><Trigger /></ToastProvider>);
    fireEvent.click(screen.getByText("go"));
    const toast = screen.getByText("Ignored Spinneys");
    expect(toast).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));
    // Still present immediately after click — exit is animating.
    expect(screen.queryByText("Ignored Spinneys")).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(200); });
    expect(screen.queryByText("Ignored Spinneys")).toBeNull();
  });

  it("gives the toast a transform+opacity transition", () => {
    render(<ToastProvider><Trigger /></ToastProvider>);
    fireEvent.click(screen.getByText("go"));
    const el = screen.getByText("Ignored Spinneys").closest("[style]") as HTMLElement;
    expect(el.style.transition).toContain("opacity");
  });

  it("does not start the drag (pointer capture) when the press lands on a button", () => {
    // Real browsers retarget the click to the capture element, which would
    // swallow the action button's onClick — so a press on a button must never
    // begin the swipe-to-dismiss gesture.
    render(<ToastProvider><Trigger /></ToastProvider>);
    fireEvent.click(screen.getByText("go"));
    const capture = vi.fn();
    const toast = screen.getByText("Ignored Spinneys").closest("[style]") as HTMLElement;
    toast.setPointerCapture = capture;
    const undo = screen.getByRole("button", { name: /undo/i });
    fireEvent.pointerDown(undo, { clientX: 0, pointerId: 1 });
    expect(capture).not.toHaveBeenCalled();
    fireEvent.pointerDown(toast, { clientX: 0, pointerId: 1 });
    expect(capture).toHaveBeenCalled();
  });

  it("snaps back (does not dismiss) when the pointer is cancelled mid-drag", () => {
    render(<ToastProvider><Trigger /></ToastProvider>);
    fireEvent.click(screen.getByText("go"));
    const toast = screen.getByText("Ignored Spinneys").closest("[style]") as HTMLElement;
    fireEvent.pointerDown(toast, { clientX: 0, pointerId: 1 });
    fireEvent.pointerMove(toast, { clientX: 30, pointerId: 1 });   // small horizontal drag (< 80px)
    fireEvent.pointerCancel(toast, { clientX: 30, pointerId: 1 });
    expect(screen.queryByText("Ignored Spinneys")).toBeInTheDocument();  // not dismissed
  });

  it("pauses the auto-dismiss timer while the tab is hidden", () => {
    render(<ToastProvider><Trigger /></ToastProvider>);
    fireEvent.click(screen.getByText("go"));
    act(() => { vi.advanceTimersByTime(3000); });           // 3s in — still present
    expect(screen.queryByText("Ignored Spinneys")).toBeInTheDocument();
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    fireEvent(document, new Event("visibilitychange"));      // tab hidden → pause
    act(() => { vi.advanceTimersByTime(10000); });           // 10s hidden — still present
    expect(screen.queryByText("Ignored Spinneys")).toBeInTheDocument();
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    fireEvent(document, new Event("visibilitychange"));      // visible → resume (~2s left)
    act(() => { vi.advanceTimersByTime(2300); });            // 2000ms remaining + 200ms exit anim + buffer
    expect(screen.queryByText("Ignored Spinneys")).toBeNull();
  });
});

function StickyTrigger() {
  const { show } = useToast();
  return (
    <button onClick={() => show({ message: "A new version is available.", sticky: true })}>
      go
    </button>
  );
}

describe("sticky toast", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("does not auto-dismiss after the normal 5s window", () => {
    render(<ToastProvider><StickyTrigger /></ToastProvider>);
    fireEvent.click(screen.getByText("go"));
    expect(screen.getByText("A new version is available.")).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(10000); });   // well past 5s
    expect(screen.queryByText("A new version is available.")).toBeInTheDocument();
  });

  it("can still be dismissed manually with ×", () => {
    render(<ToastProvider><StickyTrigger /></ToastProvider>);
    fireEvent.click(screen.getByText("go"));
    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));
    act(() => { vi.advanceTimersByTime(200); });      // exit animation
    expect(screen.queryByText("A new version is available.")).toBeNull();
  });
});
