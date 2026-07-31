import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";
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

// A Framer drag CAN be driven here — PanSession listens on `window` and
// schedules through the frame loop, both of which jsdom provides — so the
// press-vs-drag guard is regressable without a browser. Real timers, because
// PanSession's velocity sampling reads the wall clock; these drags commit on
// distance (TOAST_DISMISS_PX = 80) rather than speed, so nothing here depends
// on how fast the frames actually landed.
const frame = () => act(async () => { await new Promise((r) => requestAnimationFrame(r)); });

const undoButton = () => screen.queryByRole("button", { name: /undo/i });

/**
 * A dismissed toast is removed from provider state immediately but stays in
 * the DOM for AnimatePresence's 200ms exit, so "gone" has to be waited for.
 * The negative cases below settle for longer than this window before asserting
 * the toast is still there, so a dismissal that merely ran slowly cannot pass
 * as a dismissal that never happened.
 */
const EXIT_SETTLE_MS = 600;

async function dragFrom(el: Element, dx: number) {
  fireEvent.pointerDown(el, { pointerId: 1, clientX: 0, clientY: 0, isPrimary: true, buttons: 1 });
  for (const step of [0.2, 0.6, 1]) {
    fireEvent.pointerMove(window, { pointerId: 1, clientX: dx * step, clientY: 0, isPrimary: true, buttons: 1 });
    await frame();
  }
  fireEvent.pointerUp(window, { pointerId: 1, clientX: dx, clientY: 0, isPrimary: true, buttons: 0 });
  await frame();
}

describe("toast press-vs-drag guard", () => {
  it("dismisses on a swipe that starts on the message", async () => {
    // The control. Without this passing, the guard test below proves nothing:
    // a toast that never drags would satisfy it for the wrong reason.
    wrap(<ToastProvider><Trigger /></ToastProvider>);
    fireEvent.click(screen.getByText("go"));
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    await dragFrom(screen.getByText("Ignored Spinneys"), 200);
    await waitFor(() => expect(undoButton()).toBeNull(), { timeout: 2000 });
  });

  it("does not dismiss when the press lands on the Undo button", async () => {
    // The regression. `drag="x"` on the toast wrapped both Pressables, so a
    // press on Undo that wandered a few pixels became a toast drag; the
    // dismissal then fired while the pointer-up landed off the button, so no
    // click ran. The user tapped Undo, the toast vanished, and the undo never
    // happened — and SwipeDeck's undo is one-shot, so it could not be retried.
    wrap(<ToastProvider><Trigger /></ToastProvider>);
    fireEvent.click(screen.getByText("go"));
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    await dragFrom(screen.getByRole("button", { name: /undo/i }), 200);
    await act(async () => { await new Promise((r) => setTimeout(r, EXIT_SETTLE_MS)); });
    expect(undoButton()).toBeInTheDocument();
  });

  it("does not dismiss when the press lands on the × button", async () => {
    wrap(<ToastProvider><Trigger /></ToastProvider>);
    fireEvent.click(screen.getByText("go"));
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    await dragFrom(screen.getByRole("button", { name: "Dismiss" }), 200);
    await act(async () => { await new Promise((r) => setTimeout(r, EXIT_SETTLE_MS)); });
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeInTheDocument();
  });
});

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
