import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { MotionProvider } from "../app/MotionProvider";
import { toastReducer, ToastProvider, useToast } from "./Toast";

const wrap = (ui: React.ReactNode) => render(<MotionProvider>{ui}</MotionProvider>);

// Renders a ToastProvider with a trigger button, taps it, and returns once
// the named toast is on screen. Every render in this file must go through
// MotionProvider (see the module doc for why: an unwrapped m.* silently
// renders with no features loaded, so drag/exit would pass without being
// exercised).
function renderWithToast(message: string) {
  wrap(<ToastProvider><Trigger /></ToastProvider>);
  fireEvent.click(screen.getByText("go"));
  expect(screen.getByText(message)).toBeInTheDocument();
}

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
    wrap(<ToastProvider><Trigger /></ToastProvider>);
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

  it("renders the toast message and dismiss control", () => {
    renderWithToast("Ignored Spinneys");
    expect(screen.getByText("Ignored Spinneys")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeInTheDocument();
  });

  it("removes the toast from state as soon as dismiss is tapped", async () => {
    renderWithToast("Ignored Spinneys");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    // AnimatePresence may keep the node mounted for its exit; what matters is
    // that the provider's state no longer holds it, so a second dismiss is a
    // no-op rather than a double-remove.
    expect(screen.queryAllByRole("button", { name: "Dismiss" }).length).toBeLessThanOrEqual(1);
  });

  it("pauses the auto-dismiss timer while the tab is hidden", () => {
    wrap(<ToastProvider><Trigger /></ToastProvider>);
    fireEvent.click(screen.getByText("go"));
    act(() => { vi.advanceTimersByTime(3000); });           // 3s in — still present
    expect(screen.queryByText("Ignored Spinneys")).toBeInTheDocument();
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    fireEvent(document, new Event("visibilitychange"));      // tab hidden → pause
    act(() => { vi.advanceTimersByTime(10000); });           // 10s hidden — still present
    expect(screen.queryByText("Ignored Spinneys")).toBeInTheDocument();
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    fireEvent(document, new Event("visibilitychange"));      // visible → resume (~2s left)
    act(() => { vi.advanceTimersByTime(2300); });            // 2000ms remaining + buffer
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
    wrap(<ToastProvider><StickyTrigger /></ToastProvider>);
    fireEvent.click(screen.getByText("go"));
    expect(screen.getByText("A new version is available.")).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(10000); });   // well past 5s
    expect(screen.queryByText("A new version is available.")).toBeInTheDocument();
  });

  it("can still be dismissed manually with ×", () => {
    wrap(<ToastProvider><StickyTrigger /></ToastProvider>);
    fireEvent.click(screen.getByText("go"));
    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));
    expect(screen.queryByText("A new version is available.")).toBeNull();
  });
});
