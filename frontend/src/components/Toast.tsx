import { createContext, useCallback, useContext, useReducer, useMemo, type ReactNode } from "react";

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

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, dispatch] = useReducer(toastReducer, []);

  const show = useCallback((t: Omit<Toast, "id">) => {
    const id = nextId++;
    dispatch({ type: "add", toast: { ...t, id } });
    setTimeout(() => dispatch({ type: "remove", id }), 5000);
  }, []);

  // Memoize the context value so it stays stable across re-renders caused by toasts changing.
  // This prevents consumers (like Trigger) from re-rendering when only toasts change.
  const ctx = useMemo(() => ({ show }), [show]);

  return (
    <ToastContext.Provider value={ctx}>
      {children}
      <div className="toast-stack" role="region" aria-label="Notifications">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.tone ?? "info"}`}>
            <span className="toast-msg">{t.message}</span>
            {t.action && (
              <button
                className="toast-action"
                onClick={() => { t.action!.onAction(); dispatch({ type: "remove", id: t.id }); }}
              >
                {t.action.label}
              </button>
            )}
            <button className="toast-close" aria-label="Dismiss" onClick={() => dispatch({ type: "remove", id: t.id })}>×</button>
          </div>
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
