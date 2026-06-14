import { createContext, useCallback, useContext, useEffect, useReducer, useMemo, type ReactNode } from "react";

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

let nextId = 1;

function ToastItem({ toast, dispatch }: { toast: Toast; dispatch: React.Dispatch<Action> }) {
  useEffect(() => {
    const id = setTimeout(() => dispatch({ type: "remove", id: toast.id }), 5000);
    return () => clearTimeout(id);
  }, [toast.id, dispatch]);

  return (
    <div className={`toast toast-${toast.tone ?? "info"}`}>
      <span className="toast-msg">{toast.message}</span>
      {toast.action && (
        <button
          className="toast-action"
          onClick={() => { toast.action!.onAction(); dispatch({ type: "remove", id: toast.id }); }}
        >
          {toast.action.label}
        </button>
      )}
      <button className="toast-close" aria-label="Dismiss" onClick={() => dispatch({ type: "remove", id: toast.id })}>×</button>
    </div>
  );
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, dispatch] = useReducer(toastReducer, []);

  const show = useCallback((t: Omit<Toast, "id">) => {
    const id = nextId++;
    dispatch({ type: "add", toast: { ...t, id } });
  }, []);

  // Memoize the context value so it stays stable across re-renders caused by toasts changing.
  // This prevents consumers (like Trigger) from re-rendering when only toasts change.
  const ctx = useMemo(() => ({ show }), [show]);

  return (
    <ToastContext.Provider value={ctx}>
      {children}
      <div className="toast-stack" role="region" aria-label="Notifications">
        {toasts.map((t) => (
          <ToastItem key={t.id} toast={t} dispatch={dispatch} />
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
