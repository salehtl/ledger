import { useRef, type ReactNode } from "react";
import { m, useMotionValue, useTransform } from "motion/react";
import { fire } from "../../lib/feedback";
import { SPRING_ROW } from "../../lib/motion";
import { swipeCommits, ROW_COMMIT, type RowActions, type RowSwipeAction } from "../../lib/rowSwipe";

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
  const moved = useRef(false);

  // The live offset. A motion value, not React state: the previous version
  // called setDx() on every pointermove, which re-rendered the row and
  // dirtied layout on two `width`-driven panels — per frame, inside a
  // scrolling list.
  const x = useMotionValue(0);

  // The panels are full-width and revealed by clip-path, so nothing animates
  // a layout property. clip-path also keeps the label's text from reflowing
  // as the panel grows, which a width animation could not avoid.
  const leadClip = useTransform(x, (v) => `inset(0 ${Math.max(0, 100 - (v / ROW_COMMIT) * 100)}% 0 0)`);
  const trailClip = useTransform(x, (v) => `inset(0 0 0 ${Math.max(0, 100 - (-v / ROW_COMMIT) * 100)}%)`);
  const leadOpacity = useTransform(x, [0, ROW_COMMIT], [0, 1], { clamp: true });
  const trailOpacity = useTransform(x, [0, -ROW_COMMIT], [0, 1], { clamp: true });

  if (!lead && !trail) return <>{children}</>;

  // A swipe must not also register as a tap on the child (which opens detail).
  const onClickCapture = (e: React.MouseEvent) => {
    if (moved.current) {
      e.stopPropagation();
      e.preventDefault();
      moved.current = false;
    }
  };

  return (
    <div className="relative overflow-hidden" onClickCapture={onClickCapture}>
      {lead && (
        <m.div
          aria-hidden
          className="absolute inset-0 flex items-center gap-2 pl-4 text-sm font-medium"
          style={{ clipPath: leadClip, opacity: leadOpacity, background: lead.color, color: lead.fg ?? "#fff" }}
        >
          {lead.icon}
          <span>{lead.label}</span>
        </m.div>
      )}
      {trail && (
        <m.div
          aria-hidden
          className="absolute inset-0 flex items-center justify-end gap-2 pr-4 text-sm font-medium"
          style={{ clipPath: trailClip, opacity: trailOpacity, background: trail.color, color: trail.fg ?? "#fff" }}
        >
          <span>{trail.label}</span>
          {trail.icon}
        </m.div>
      )}
      <m.div
        className="relative bg-surface"
        style={{ x }}
        drag="x"
        // Vertical drags must fall through to the scroller. Framer decides the
        // axis on the first few pixels, exactly as the hand-rolled swipeAxis
        // used to, and then locks it for the rest of the gesture.
        dragDirectionLock
        dragSnapToOrigin
        dragElastic={0.4}
        dragMomentum={false}
        onDragStart={() => { moved.current = true; }}
        onDragEnd={(_, info) => {
          const committed = swipeCommits(info.offset.x, info.velocity.x, actions);
          if (committed) { fire("selection"); onCommit(committed); }
        }}
        dragTransition={{ bounceStiffness: SPRING_ROW.stiffness, bounceDamping: SPRING_ROW.damping }}
      >
        {children}
      </m.div>
    </div>
  );
}
