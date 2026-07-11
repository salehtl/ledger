import { useRef, useState, type PointerEvent, type ReactNode } from "react";
import { fire } from "../../lib/feedback";
import { usePrefersReducedMotion } from "../../hooks/usePrefersReducedMotion";
import {
  swipeAxis, swipeOffset, swipeCommits, swipeProgress,
  ROW_COMMIT, type RowActions, type RowSwipeAction,
} from "../../lib/rowSwipe";

export interface SwipeActionSpec {
  label: string;
  icon: ReactNode;
  /** CSS color for the revealed panel behind the row. */
  color: string;
  /** Foreground (icon + label) color; defaults to white. */
  fg?: string;
}

/**
 * A list row you can swipe: right reveals the leading action, left the trailing
 * one. Crossing the commit threshold and releasing fires it (haptic + onCommit);
 * a short swipe springs back. Vertical drags fall through to the scroller, and a
 * swipe suppresses the row's own click so it never doubles as a tap.
 *
 * Touch-only enhancement: every action is also reachable by tapping the row open
 * (keyboard/mouse users lose nothing). Pass no lead/trail to render a plain row.
 */
export function SwipeableRow({ lead, trail, onCommit, children }: {
  lead?: SwipeActionSpec;
  trail?: SwipeActionSpec;
  onCommit: (action: RowSwipeAction) => void;
  children: ReactNode;
}) {
  const actions: RowActions = { lead: !!lead, trail: !!trail };
  const reduced = usePrefersReducedMotion();
  const [dx, setDx] = useState(0);
  const [dragging, setDragging] = useState(false);
  const start = useRef<{ x: number; y: number } | null>(null);
  const raw = useRef(0);
  const axis = useRef<"h" | "v" | null>(null);
  const moved = useRef(false);

  if (!lead && !trail) return <>{children}</>;

  const onPointerDown = (e: PointerEvent) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    start.current = { x: e.clientX, y: e.clientY };
    axis.current = null;
    moved.current = false;
  };

  const onPointerMove = (e: PointerEvent) => {
    const s = start.current;
    if (!s) return;
    const ddx = e.clientX - s.x;
    const ddy = e.clientY - s.y;
    if (axis.current === null) {
      const a = swipeAxis(ddx, ddy);
      if (!a) return;
      axis.current = a;
      if (a === "h") {
        setDragging(true);
        try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* older browsers */ }
      }
    }
    if (axis.current !== "h") return;
    moved.current = true;
    raw.current = ddx;
    setDx(swipeOffset(ddx, actions));
  };

  const endGesture = () => {
    if (axis.current === "h") {
      const committed = swipeCommits(raw.current, actions);
      setDragging(false);
      setDx(0);
      if (committed) { fire("selection"); onCommit(committed); }
    }
    start.current = null;
    axis.current = null;
    raw.current = 0;
  };

  // A swipe must not also register as a tap on the child (which opens detail).
  const onClickCapture = (e: React.MouseEvent) => {
    if (moved.current) {
      e.stopPropagation();
      e.preventDefault();
      moved.current = false;
    }
  };

  const progress = swipeProgress(dx);
  const committing = Math.abs(dx) >= ROW_COMMIT;

  return (
    <div className="relative overflow-hidden" onClickCapture={onClickCapture}>
      {lead && (
        <div
          aria-hidden
          className="absolute inset-y-0 left-0 flex items-center gap-2 pl-4 text-sm font-medium"
          style={{ width: Math.max(0, dx), background: lead.color, color: lead.fg ?? "#fff", opacity: dx > 0 ? progress : 0 }}
        >
          {lead.icon}
          {committing && dx > 0 && <span>{lead.label}</span>}
        </div>
      )}
      {trail && (
        <div
          aria-hidden
          className="absolute inset-y-0 right-0 flex items-center justify-end gap-2 pr-4 text-sm font-medium"
          style={{ width: Math.max(0, -dx), background: trail.color, color: trail.fg ?? "#fff", opacity: dx < 0 ? progress : 0 }}
        >
          {committing && dx < 0 && <span>{trail.label}</span>}
          {trail.icon}
        </div>
      )}
      <div
        className="relative bg-surface"
        style={{
          transform: `translateX(${dx}px)`,
          transition: dragging || reduced ? "none" : "transform 240ms var(--ease-out)",
          touchAction: "pan-y",
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endGesture}
        onPointerCancel={endGesture}
      >
        {children}
      </div>
    </div>
  );
}
