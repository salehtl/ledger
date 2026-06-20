import { createContext, useCallback, useContext, useEffect, useReducer, useMemo, useRef, type ReactNode } from "react";

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
  useEffect(() => {
    const id = setTimeout(() => onDismissRef.current(), 5000);
    return () => clearTimeout(id);
  }, []); // mount-only; ref keeps the latest callback

  const tone = toast.tone === "success" ? "bg-good" : toast.tone === "error" ? "bg-bad" : "bg-fg";
  return (
    <div className={`pointer-events-auto flex items-center gap-3 max-w-[92vw] text-white px-3 py-2.5 rounded-2xl shadow-lg ${tone}`}>
      <span className="flex-1 text-sm">{toast.message}</span>
      {toast.action && (
        <button
          className="text-sm font-semibold text-white/90 underline"
          onClick={() => { try { toast.action!.onAction(); } finally { onDismiss(); } }}
        >
          {toast.action.label}
        </button>
      )}
      <button aria-label="Dismiss" className="text-white/70" onClick={onDismiss}>×</button>
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
