import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { MotionProvider } from "../../app/MotionProvider";
import { SwipeableRow } from "./SwipeableRow";
import { ROW_COMMIT } from "../../lib/rowSwipe";

// Most of what a row does needs no pointer, and the commit decision itself is
// covered directly in lib/rowSwipe.test.ts. But a Framer drag *can* be driven
// here, contrary to a note this file used to carry: PanSession listens on
// `window` for raw pointer events and schedules through the frame loop, both of
// which jsdom provides, so `onDragStart`/`onDirectionLock`/`onDragEnd` all fire
// with real offsets. What jsdom cannot give is layout, so anything reading a
// bounding box (dragConstraints resolution, the clip-path reveal) is still
// harness territory — as is any assertion about a *specific* velocity, which
// depends on wall-clock spacing between frames. The drags below therefore
// commit on distance, never on speed.
const wrap = (ui: React.ReactNode) => render(<MotionProvider>{ui}</MotionProvider>);

const lead = { label: "Categorize", icon: <span>lead-icon</span>, color: "#000" };
const trail = { label: "Archive", icon: <span>trail-icon</span>, color: "#111" };

/** Let LazyMotion's feature bundle resolve before touching the element. */
const ready = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });
const frame = () => act(async () => { await new Promise((r) => requestAnimationFrame(r)); });

/**
 * Drive a pointer gesture over `el` along `path` (absolute offsets from the
 * press point), one frame per waypoint. Moves go to `window` because that is
 * where PanSession listens once the gesture has started.
 */
async function drag(el: Element, path: Array<{ x: number; y: number }>) {
  fireEvent.pointerDown(el, { pointerId: 1, clientX: 0, clientY: 0, isPrimary: true, buttons: 1 });
  for (const p of path) {
    fireEvent.pointerMove(window, { pointerId: 1, clientX: p.x, clientY: p.y, isPrimary: true, buttons: 1 });
    await frame();
  }
  const last = path[path.length - 1] ?? { x: 0, y: 0 };
  fireEvent.pointerUp(window, { pointerId: 1, clientX: last.x, clientY: last.y, isPrimary: true, buttons: 0 });
  await frame();
}

describe("SwipeableRow", () => {
  it("renders a plain row when it has no actions", () => {
    const onCommit = vi.fn();
    wrap(<SwipeableRow onCommit={onCommit}><button>row</button></SwipeableRow>);
    expect(screen.getByText("row")).toBeInTheDocument();
    expect(screen.queryByText("Categorize")).not.toBeInTheDocument();
    expect(screen.queryByText("Archive")).not.toBeInTheDocument();
  });

  it("renders both panels, unconditionally, when both actions are given", () => {
    const onCommit = vi.fn();
    wrap(<SwipeableRow lead={lead} trail={trail} onCommit={onCommit}><div>row</div></SwipeableRow>);
    expect(screen.getByText("row")).toBeInTheDocument();
    // The labels render unconditionally now — clip-path reveals them rather
    // than a `committing && dx > 0` gate mounting/unmounting the <span>.
    expect(screen.getByText("Categorize")).toBeInTheDocument();
    expect(screen.getByText("Archive")).toBeInTheDocument();
  });

  it("renders only the lead panel when no trail action is given", () => {
    const onCommit = vi.fn();
    wrap(<SwipeableRow lead={lead} onCommit={onCommit}><div>row</div></SwipeableRow>);
    expect(screen.getByText("Categorize")).toBeInTheDocument();
    expect(screen.queryByText("Archive")).not.toBeInTheDocument();
  });
});

describe("SwipeableRow direction lock", () => {
  it("commits the lead action on a purely horizontal drag past the threshold", async () => {
    const onCommit = vi.fn();
    wrap(<SwipeableRow lead={lead} trail={trail} onCommit={onCommit}><div>row</div></SwipeableRow>);
    await ready();
    await drag(screen.getByText("row"), [
      { x: 20, y: 0 },
      { x: 60, y: 0 },
      { x: ROW_COMMIT + 30, y: 0 },
    ]);
    expect(onCommit).toHaveBeenCalledWith("lead");
  });

  it("commits nothing when the gesture locked to the vertical axis", async () => {
    // The regression. `dragDirectionLock`'s getCurrentDirection tests y first
    // against a 10px threshold, so a first coalesced move carrying 12px down
    // and 30px right locks the gesture to "y" — the row never moves again for
    // the rest of the drag. But `info.offset` is raw pointer travel, so on
    // release it still reports the full 100px of leftward movement, and an
    // ungated onDragEnd hands that straight to swipeCommits: a transaction is
    // archived with nothing on screen having moved at all.
    const onCommit = vi.fn();
    wrap(<SwipeableRow lead={lead} trail={trail} onCommit={onCommit}><div>row</div></SwipeableRow>);
    await ready();
    await drag(screen.getByText("row"), [
      { x: 30, y: 12 },      // locks to "y": |12| > 10 and y is tested first
      { x: -40, y: 14 },
      { x: -(ROW_COMMIT + 30), y: 16 },   // well past the commit distance
    ]);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("commits nothing on a twitch too small to lock an axis at all", async () => {
    const onCommit = vi.fn();
    wrap(<SwipeableRow lead={lead} trail={trail} onCommit={onCommit}><div>row</div></SwipeableRow>);
    await ready();
    await drag(screen.getByText("row"), [{ x: 5, y: 2 }, { x: 7, y: 1 }]);
    expect(onCommit).not.toHaveBeenCalled();
  });
});
