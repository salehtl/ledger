// frontend/src/components/ui/Dialog.tsx
import { useEffect, useId, useRef, type ReactNode } from "react";

export function Dialog({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useEffect(() => {
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center" onClick={onClose}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="w-full sm:max-w-md bg-surface rounded-t-2xl sm:rounded-2xl p-4 max-h-[85vh] overflow-y-auto outline-none"
      >
        <div className="flex items-center justify-between mb-3">
          <h2 id={titleId} className="text-lg font-semibold">{title}</h2>
          <button aria-label="Close" className="text-muted text-xl" onClick={onClose}>×</button>
        </div>
        {children}
      </div>
    </div>
  );
}
