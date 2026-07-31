import { createContext, useCallback, useContext, useEffect, useReducer, useMemo, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, m, useDragControls, useMotionValue } from "motion/react";
import { toastExitX } from "../lib/toastSwipe";
import { FADE, SPRING_SNAP } from "../lib/motion";
import { Pressable } from "./ui/Pressable";

export interface ToastAction { label: string; onAction: () => void; }
export interface Toast {
  id: number;
  message: string;
  tone?: "info" | "success" | "error";
  action?: ToastAction;
  /** When true, the toast does not auto-dismiss after 5s — it stays until the
   *  user taps its action, ×, or swipes it away. For prompts that must not be
   *  missed (e.g. "a new version is available"). */
  sticky?: boolean;
}

type State = Toast[];
type Action = { type: "add"; toast: Toast } | { type: "remove"; id: number };

export function toastReducer(state: State, action: Action): State {
  switch (action.type) {
    case "add": return [...state, action.toast];
    case "remove": return state.filter((t) => t.id !== action.id);
  }
}

interface Ctx { show: (t: Omit<Toast, "id">) => void; }
const ToastContext = createContext<Ctx | null>(null);

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;

  // The live horizontal offset. A motion value, so dragging never re-renders
  // React — and, crucially, so the exit animation can read where the finger
  // actually left the toast. The previous version wrote `transform` directly
  // to the DOM and React overwrote it on the very next render, discarding the
  // swipe direction at the moment of commitment.
  const x = useMotionValue(0);
  const [exitX, setExitX] = useState(0);

  // The toast is draggable everywhere EXCEPT its buttons, which is why the drag
  // is started by hand instead of by Framer's own listener.
  //
  // A toast is the one draggable surface in the app with interactive children,
  // and its Undo is destructive to miss: `SwipeDeck.undoCommit` is one-shot, so
  // a press on "Undo" that turns into a dismissal doesn't just fail to undo, it
  // spends the undo. With a plain `drag="x"` the press became a drag as soon as
  // the finger moved a few pixels.
  //
  // The obvious guard — `e.stopPropagation()` in the button's React
  // `onPointerDown` — cannot work here, and it is worth writing down why so it
  // is not "fixed" back. Framer registers a NATIVE pointerdown listener on the
  // element itself (`VisualElementDragControls.addListeners`), while React 19
  // delegates all its listeners to the root container. Stopping propagation on
  // a synthetic event stops the synthetic tree only; the native listener on an
  // ancestor has already been reached by the time React's root handler runs.
  // (The same reasoning applies to SwipeCard's "View source email" button.)
  //
  // `dragListener={false}` removes Framer's listener altogether and hands the
  // decision to the handler below, which is ours and therefore can gate it.
  // This is the deleted `if (e.target.closest("button")) return;` restored to
  // the one place it still has authority.
  const dragControls = useDragControls();

  const beginDismiss = useCallback((direction = 0) => {
    setExitX(direction);
    onDismissRef.current();
  }, []);
  const beginRef = useRef(beginDismiss);
  beginRef.current = beginDismiss;

  // Auto-dismiss after 5s, pausing while the tab is hidden so a backgrounded
  // toast still gets its full on-screen time. Sticky toasts skip the timer.
  useEffect(() => {
    if (toast.sticky) return;
    let remaining = 5000;
    let startedAt = Date.now();
    let id = window.setTimeout(() => beginRef.current(), remaining);
    const onVis = () => {
      if (document.hidden) {
        clearTimeout(id);
        remaining -= Date.now() - startedAt;
      } else {
        startedAt = Date.now();
        id = window.setTimeout(() => beginRef.current(), Math.max(0, remaining));
      }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => { clearTimeout(id); document.removeEventListener("visibilitychange", onVis); };
  }, [toast.sticky]);

  // "error" spends the app's one fill register (bg-accent) and so needs the
  // fill's own constant-white text (text-accent-fg) rather than text-bg, which
  // flips with theme and would go dark-on-vermilion in the dark theme.
  const isError = toast.tone === "error";
  const tone = toast.tone === "success" ? "bg-good" : isError ? "bg-accent" : "bg-fg";
  const fg = isError ? "text-accent-fg" : "text-bg";

  return (
    <m.div
      layout
      style={{ x }}
      drag="x"
      dragListener={false}
      dragControls={dragControls}
      onPointerDown={(e) => {
        if ((e.target as HTMLElement).closest("button")) return;
        dragControls.start(e);
      }}
      dragSnapToOrigin
      // No `dragConstraints`, and therefore deliberately no `dragElastic`.
      // Elasticity is only ever applied to the part of a drag that is OUTSIDE
      // the constraint box: `resolveConstraints()` sets `this.constraints =
      // false` when the prop is absent, and the elastic branch in
      // `updateAxis()` is guarded on `this.constraints[axis]`. With no box
      // there is no outside, so `dragElastic` here was a no-op and was
      // removed rather than made real.
      //
      // Making it real would be wrong anyway. A row rubber-bands to say "this
      // direction has no action" — but a toast dismisses BOTH ways
      // (`toastExitX` reads the sign), so there is no dead side to resist,
      // and 1:1 tracking is what lets a short flick reach the threshold.
      //
      // `SPRING_SNAP` is a spring `Transition`, not inertia options: spread
      // into the drag it overwrites `type: "inertia"`, so an uncommitted
      // swipe springs home instead of decaying. That one is intentional.
      dragTransition={SPRING_SNAP}
      onDragEnd={(_, info) => {
        const exit = toastExitX(info.offset.x, info.velocity.x);
        if (exit !== 0) beginDismiss(exit);
      }}
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      // The toast leaves the way it was sent: swiped toasts continue in the
      // swipe direction, timed-out toasts just fade.
      exit={{ opacity: 0, x: exitX, y: exitX === 0 ? 12 : 0 }}
      transition={FADE}
      className={`pointer-events-auto flex touch-pan-y items-center gap-3 max-w-[92vw] ${fg} px-3 py-2.5 rounded-[var(--radius)] shadow-lg ${tone}`}
    >
      <span className="flex-1 text-sm">{toast.message}</span>
      {toast.action && (
        <Pressable
          className={`text-sm font-semibold ${isError ? "text-accent-fg/90" : "text-bg/90"} underline`}
          onClick={() => { try { toast.action!.onAction(); } finally { beginDismiss(); } }}
        >
          {toast.action.label}
        </Pressable>
      )}
      <Pressable
        aria-label="Dismiss"
        className={isError ? "text-accent-fg/70" : "text-bg/70"}
        onClick={() => beginDismiss()}
      >
        ×
      </Pressable>
    </m.div>
  );
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, dispatch] = useReducer(toastReducer, []);
  const nextId = useRef(1);

  const show = useCallback((t: Omit<Toast, "id">) => {
    const id = nextId.current++;
    dispatch({ type: "add", toast: { ...t, id } });
  }, []);

  // Memoize the context value so show stays a stable reference.
  const ctx = useMemo(() => ({ show }), [show]);

  return (
    <ToastContext.Provider value={ctx}>
      {children}
      <div className="fixed inset-x-0 bottom-[calc(3.5rem+env(safe-area-inset-bottom)+1rem)] z-40 flex flex-col items-center gap-2 px-4 pointer-events-none" role="region" aria-label="Notifications">
        <AnimatePresence initial={false}>
          {toasts.map((t) => (
            <ToastItem key={t.id} toast={t} onDismiss={() => dispatch({ type: "remove", id: t.id })} />
          ))}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): Ctx {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within ToastProvider");
  return ctx;
}
