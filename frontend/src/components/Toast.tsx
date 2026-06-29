import { createContext, useCallback, useContext, useEffect, useReducer, useMemo, useRef, useState, type ReactNode } from "react";
import { usePrefersReducedMotion } from "../hooks/usePrefersReducedMotion";

export interface ToastAction { label: string; onAction: () => void; }
export interface Toast {
  id: number;
  message: string;
  tone?: "info" | "success" | "error";
  action?: ToastAction;
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
  const reduced = usePrefersReducedMotion();
  const [mounted, setMounted] = useState(false);
  const [leaving, setLeaving] = useState(false);

  // Slide/fade out, then ask the provider to drop it from state.
  const beginDismiss = useCallback(() => {
    if (reduced) { onDismissRef.current(); return; }
    setLeaving(true);
    window.setTimeout(() => onDismissRef.current(), 200);
  }, [reduced]);
  const beginRef = useRef(beginDismiss);
  beginRef.current = beginDismiss;

  // Trigger the enter transition one frame after mount.
  useEffect(() => {
    const r = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(r);
  }, []);

  // Auto-dismiss after 5s, pausing while the tab is hidden so a backgrounded
  // toast still gets its full on-screen time when the user returns.
  useEffect(() => {
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
  }, []); // mount-only; beginRef holds the latest callback

  const tone = toast.tone === "success" ? "bg-good" : toast.tone === "error" ? "bg-bad" : "bg-fg";
  const hidden = !mounted || leaving;
  return (
    <div
      style={{
        transition: reduced
          ? "opacity 150ms var(--ease-out)"
          : "transform 200ms var(--ease-out), opacity 200ms var(--ease-out)",
        transform: reduced ? undefined : hidden ? "translateY(12px)" : "translateY(0)",
        opacity: hidden ? 0 : 1,
        willChange: reduced ? "opacity" : "transform, opacity",
      }}
      className={`pointer-events-auto flex items-center gap-3 max-w-[92vw] text-bg px-3 py-2.5 rounded-lg shadow-lg ${tone}`}
    >
      <span className="flex-1 text-sm">{toast.message}</span>
      {toast.action && (
        <button
          className="text-sm font-semibold text-bg/90 underline press"
          onClick={() => { try { toast.action!.onAction(); } finally { beginDismiss(); } }}
        >
          {toast.action.label}
        </button>
      )}
      <button aria-label="Dismiss" className="text-bg/70 press" onClick={beginDismiss}>×</button>
    </div>
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
        {toasts.map((t) => (
          <ToastItem key={t.id} toast={t} onDismiss={() => dispatch({ type: "remove", id: t.id })} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): Ctx {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within ToastProvider");
  return ctx;
}
