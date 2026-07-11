import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SwipeableRow } from "./SwipeableRow";

const lead = { label: "Categorize", icon: <span>lead</span>, color: "#000" };
const trail = { label: "Archive", icon: <span>trail</span>, color: "#111" };

function swipe(el: Element, to: number) {
  fireEvent.pointerDown(el, { clientX: 0, clientY: 0, pointerId: 1, button: 0, pointerType: "touch" });
  fireEvent.pointerMove(el, { clientX: to, clientY: 0, pointerId: 1, pointerType: "touch" });
  fireEvent.pointerUp(el, { clientX: to, clientY: 0, pointerId: 1, pointerType: "touch" });
}

describe("SwipeableRow", () => {
  it("renders a plain row when it has no actions", () => {
    const onCommit = vi.fn();
    render(<SwipeableRow onCommit={onCommit}><button>row</button></SwipeableRow>);
    expect(screen.getByText("row")).toBeInTheDocument();
  });

  it("commits the leading action on a full right swipe", () => {
    const onCommit = vi.fn();
    render(<SwipeableRow lead={lead} trail={trail} onCommit={onCommit}><div>row</div></SwipeableRow>);
    swipe(screen.getByText("row"), 120);
    expect(onCommit).toHaveBeenCalledWith("lead");
  });

  it("commits the trailing action on a full left swipe", () => {
    const onCommit = vi.fn();
    render(<SwipeableRow lead={lead} trail={trail} onCommit={onCommit}><div>row</div></SwipeableRow>);
    swipe(screen.getByText("row"), -120);
    expect(onCommit).toHaveBeenCalledWith("trail");
  });

  it("springs back without committing on a short swipe", () => {
    const onCommit = vi.fn();
    render(<SwipeableRow lead={lead} trail={trail} onCommit={onCommit}><div>row</div></SwipeableRow>);
    swipe(screen.getByText("row"), 24);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("suppresses the child tap that follows a swipe", () => {
    const onCommit = vi.fn();
    const onTap = vi.fn();
    render(
      <SwipeableRow lead={lead} trail={trail} onCommit={onCommit}>
        <button onClick={onTap}>row</button>
      </SwipeableRow>,
    );
    const el = screen.getByText("row");
    swipe(el, 120);
    fireEvent.click(el);
    expect(onTap).not.toHaveBeenCalled();
  });
});
