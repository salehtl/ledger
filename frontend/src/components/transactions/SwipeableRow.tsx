import { useRef, type ReactNode } from "react";
import { m, useMotionValue, useTransform } from "motion/react";
import { fire } from "../../lib/feedback";
import { INERTIA_ROW } from "../../lib/motion";
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

  // Reset unconditionally at the start of every gesture — the direct analogue
  // of the old onPointerDown handler this component used to have. Framer's
  // onDragStart (below) fires from PanSession as soon as ANY 2D movement
  // crosses a ~3px threshold, which is *before* dragDirectionLock has decided
  // the axis — so a plain vertical scroll that merely started on this row
  // also sets moved=true. Nothing else clears it: onClickCapture only runs
  // if a click actually follows, and a scroll never produces one. Without
  // this reset, the next genuine tap on the same row would still see a stale
  // moved=true from the earlier scroll and have its click wrongly swallowed.
  const onPointerDownCapture = () => { moved.current = false; };

  return (
    <div className="relative overflow-hidden" onClickCapture={onClickCapture} onPointerDownCapture={onPointerDownCapture}>
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
        // dragElastic only ever applies beyond a dragConstraints boundary —
        // with no dragConstraints it is a silent no-op and the row tracks the
        // finger 1:1 forever in both directions. `left`/`right` here are not
        // pixel travel caps; they are which side of rest (x=0) is "inside"
        // the constraint box. A real action's side gets `-Infinity`/`Infinity`
        // (never outside, so never elastic — normal 1:1 tracking all the way
        // to the commit threshold and beyond). A missing action's side gets
        // `0` (any movement that way is immediately outside), so dragElastic
        // resists from the very first pixel. That reproduces what the
        // deleted `swipeOffset`'s `resist()` did — "only rubber-bands, never
        // fully opens, toward a missing action" — without reintroducing a
        // second, redundant clamp on the side that already has one (the
        // commit threshold plus the spring back on release).
        dragConstraints={{ left: actions.trail ? -Infinity : 0, right: actions.lead ? Infinity : 0 }}
        dragElastic={0.4}
        dragMomentum={false}
        onDragStart={() => { moved.current = true; }}
        onDragEnd={(_, info) => {
          const committed = swipeCommits(info.offset.x, info.velocity.x, actions);
          if (committed) { fire("selection"); onCommit(committed); }
        }}
        // The bounce that carries the row home, not a mass-spring — see
        // INERTIA_ROW in lib/motion.ts for why the distinction is typed.
        dragTransition={INERTIA_ROW}
      >
        {children}
      </m.div>
    </div>
  );
}
