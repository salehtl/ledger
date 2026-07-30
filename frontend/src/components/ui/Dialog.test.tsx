import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

// TEMPORARY: Dialog.tsx's usePrefersReducedMotion shim (Task 1) delegates to
// Framer Motion's useReducedMotion(), which lazily reads matchMedia ONCE per
// module lifetime and caches the result (motion-dom's `hasReducedMotionListener`
// singleton) rather than re-reading it on every mount like the old hook did.
// That means reassigning window.matchMedia mid-suite — which this file's
// reduced-motion tests below rely on — no longer reaches it after the first
// Dialog render in this file. Mock the hook directly instead so those tests
// can still drive the reduced-motion branch. Task 4 removes this shim along
// with Dialog.tsx's own.
const mockReducedMotion = vi.hoisted(() => ({ value: false }));
vi.mock("motion/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("motion/react")>();
  return { ...actual, useReducedMotion: () => mockReducedMotion.value };
});

import { Dialog, DialogFooter } from "./Dialog";
// TEMPORARY: lib/motion.ts was rewritten (Task 1) and no longer exports this
// constant; Dialog.tsx now carries its own copy (see the TEMPORARY block
// there) until Task 4 rewrites both onto AnimatePresence.
const SHEET_EXIT_MS = 240;

describe("Dialog", () => {
  beforeEach(() => { vi.useFakeTimers(); mockReducedMotion.value = false; });
  afterEach(() => vi.useRealTimers());

  it("renders the title and children", () => {
    render(<Dialog title="Choose period" onClose={vi.fn()}>body</Dialog>);
    expect(screen.getByRole("dialog", { name: "Choose period" })).toBeInTheDocument();
    expect(screen.getByText("body")).toBeInTheDocument();
  });

  it("keeps footer actions sticky above scrolling content", () => {
    const { container } = render(<Dialog title="T" onClose={() => {}}><div>body</div><DialogFooter><button>Save</button></DialogFooter></Dialog>);
    const footer = container.querySelector("[data-dialog-footer]");
    expect(footer).toHaveClass("sticky", "bottom-0", "z-20", "bg-surface");
  });

  it("lets the footer own the bottom inset instead of the panel", () => {
    // `sticky bottom: 0` resolves against the scroll container's CONTENT box, so
    // padding-bottom on the panel rides the stuck footer *up* by that much —
    // over the last row of content. A negative margin-bottom on the footer does
    // not push it back down; it shrinks the content box, which is what caused
    // the overlap in the first place. On a phone with a 34px home-indicator
    // inset the footer ate 18px of the row above it.
    const { container } = render(
      <Dialog title="T" onClose={() => {}}><div>body</div><DialogFooter><button>Save</button></DialogFooter></Dialog>,
    );
    const panel = screen.getByRole("dialog");
    const footer = container.querySelector("[data-dialog-footer]")!;
    expect(panel).toHaveClass("sheet-panel");            // CSS zeroes its padding when a footer is present
    expect(panel.style.paddingBottom).toBe("");           // never inline — that would outrank the rule
    expect(footer.className).not.toMatch(/-mb-/);         // no negative-margin compensation
    expect(footer.className).toContain("pb-[var(--sheet-inset-bottom)]");
  });

  it("drops the home-indicator inset while the keyboard is up", () => {
    render(<Dialog title="T" onClose={() => {}}><DialogFooter><button>Save</button></DialogFooter></Dialog>);
    // No visualViewport in jsdom → keyboard closed → the shared inset var is
    // left to the stylesheet rather than pinned inline.
    expect(screen.getByRole("dialog").style.getPropertyValue("--sheet-inset-bottom")).toBe("");
  });

  it("freezes scrollable ancestors so the page cannot scroll behind the sheet", () => {
    // A fixed overlay's touch-scroll chains to the root scroller, not to its DOM
    // ancestor, so the ancestor's own overscroll-contain never sees the gesture.
    // The background must be frozen outright.
    const host = document.createElement("div");
    host.style.overflowY = "auto";
    document.body.appendChild(host);
    const { unmount } = render(<Dialog title="T" onClose={() => {}}>x</Dialog>, { container: host });
    expect(host.style.overflow).toBe("hidden");
    unmount();
    expect(host.style.overflow).toBe("");
    host.remove();
  });

  it("restores a scroll position it froze", () => {
    const host = document.createElement("div");
    host.style.overflowY = "scroll";
    document.body.appendChild(host);
    Object.defineProperty(host, "scrollTop", { value: 120, writable: true, configurable: true });
    const { unmount } = render(<Dialog title="T" onClose={() => {}}>x</Dialog>, { container: host });
    unmount();
    expect(host.scrollTop).toBe(120);
    host.remove();
  });

  it("makes the scrim swallow touch gestures rather than pass them to the page", () => {
    const { container } = render(<Dialog title="T" onClose={() => {}}>x</Dialog>);
    expect(container.querySelector('[data-testid="dialog-scrim"]')).toHaveClass("touch-none");
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
    mockReducedMotion.value = true;
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
    // Transition must be restored before dismiss so the slide-out animates (not jumps)
    const panel = screen.getByRole("dialog");
    expect(panel.style.transition).not.toBe("none");
    expect(panel.style.transition).toContain("transform");
    vi.advanceTimersByTime(SHEET_EXIT_MS);
    expect(onClose).toHaveBeenCalled();
  });

  it("closes synchronously under reduced motion without advancing timers", () => {
    mockReducedMotion.value = true;
    const onClose = vi.fn();
    render(<Dialog title="T" onClose={onClose}>x</Dialog>);
    fireEvent.click(screen.getByLabelText("Close"));
    // No timer advancement — reduced motion must fire onClose immediately.
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("renders a title adornment and applies titleStyle to the heading", () => {
    render(
      <Dialog
        title="Wants"
        titleAdornment={<span data-testid="dot" />}
        titleStyle={{ color: "rgb(123, 53, 184)" }}
        onClose={() => {}}
      >
        body
      </Dialog>,
    );
    expect(screen.getByTestId("dot")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Wants" })).toHaveStyle({ color: "rgb(123, 53, 184)" });
  });
});
