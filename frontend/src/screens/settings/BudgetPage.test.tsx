import { render } from "@testing-library/react";
import { MotionProvider } from "../../app/MotionProvider";
import { SegmentFill } from "./BudgetPage";

// SegmentFill is SplitBar's one coloured slice: three of them stack in the
// same box and reveal only their own [start, start+width] range via
// clip-path. `lib/split.test.ts` already covers the need/want/saving ->
// percent math (splitSegments); this file is only about the clip-path
// geometry SegmentFill derives from an already-computed start/width, which
// is the part a review found no automated coverage for.
//
// Every render goes through MotionProvider: SegmentFill is an m.div, and an
// unwrapped m.* renders with no features loaded, so the clip-path this file
// asserts on would be silently inert.
const wrap = (ui: React.ReactNode) => render(<MotionProvider>{ui}</MotionProvider>);

describe("SegmentFill clip-path geometry", () => {
  it("clips a zero-width segment to an empty window", () => {
    // start=30 mid-bar, width=0: nothing to reveal, so left+right insets sum
    // to the full 100% and the slice shows nothing.
    const { container } = wrap(<SegmentFill start={30} width={0} className="bg-test" />);
    const el = container.querySelector(".bg-test") as HTMLElement;
    expect(el.style.clipPath).toBe("inset(0 70% 0 30%)");
  });

  it("reveals the full bar for a single segment spanning 0..100", () => {
    const { container } = wrap(<SegmentFill start={0} width={100} className="bg-test" />);
    const el = container.querySelector(".bg-test") as HTMLElement;
    expect(el.style.clipPath).toBe("inset(0 0% 0 0%)");
  });

  it("three segments summing under 100% leave the deliberate gap at the end", () => {
    // Mirrors splitSegments(0.4, 0.3, 0.2)'s needPct/wantPct/savingPct
    // (40/30/20, totalling 90) — the same under-allocated case
    // lib/split.test.ts covers for the percent math; here it's the resulting
    // clip windows, including the cumulative offsets a fixed 3-slice stack
    // depends on to abut without overlapping.
    const { container } = wrap(
      <div>
        <SegmentFill start={0} width={40} className="bg-need" />
        <SegmentFill start={40} width={30} className="bg-want" />
        <SegmentFill start={70} width={20} className="bg-save" />
      </div>,
    );
    expect((container.querySelector(".bg-need") as HTMLElement).style.clipPath).toBe("inset(0 60% 0 0%)");
    expect((container.querySelector(".bg-want") as HTMLElement).style.clipPath).toBe("inset(0 30% 0 40%)");
    // Right inset is 10%, not 0: the bar stops at 90%, leaving the last 10%
    // as the track's own background showing through — the literal gap.
    expect((container.querySelector(".bg-save") as HTMLElement).style.clipPath).toBe("inset(0 10% 0 70%)");
  });

  it("cumulative offsets of a normal 50/30/20 split abut with no overlap and no gap", () => {
    const { container } = wrap(
      <div>
        <SegmentFill start={0} width={50} className="bg-need" />
        <SegmentFill start={50} width={30} className="bg-want" />
        <SegmentFill start={80} width={20} className="bg-save" />
      </div>,
    );
    expect((container.querySelector(".bg-need") as HTMLElement).style.clipPath).toBe("inset(0 50% 0 0%)");
    expect((container.querySelector(".bg-want") as HTMLElement).style.clipPath).toBe("inset(0 20% 0 50%)");
    // Right inset is exactly 0: the last segment reaches the bar's own end.
    expect((container.querySelector(".bg-save") as HTMLElement).style.clipPath).toBe("inset(0 0% 0 80%)");
  });
});
