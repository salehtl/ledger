import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MotionProvider } from "../../app/MotionProvider";
import { SwipeableRow } from "./SwipeableRow";

// jsdom cannot produce a Framer drag gesture with real velocity (no layout,
// no frame clock behind the pointer stream) — the commit decision itself is
// covered directly in lib/rowSwipe.test.ts. This file stays render-level:
// does the row wire up the right panels for the actions it's given.
const wrap = (ui: React.ReactNode) => render(<MotionProvider>{ui}</MotionProvider>);

const lead = { label: "Categorize", icon: <span>lead-icon</span>, color: "#000" };
const trail = { label: "Archive", icon: <span>trail-icon</span>, color: "#111" };

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
