// frontend/src/components/ui/Dialog.tsx
import { useEffect, useId, useRef, type ReactNode } from "react";

export function Dialog({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const titleId = useId();
  useEffect(() => {
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { onCloseRef.current(); return; }
      if (e.key !== "Tab" || !ref.current) return;
      const focusable = ref.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;
      const first = focusable[0], last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === ref.current)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []); // mount-only; ref holds the latest onClose
  return (
    <div className="fixed inset-x-0 top-0 h-[100dvh] z-50 bg-black/40 flex items-end sm:items-center justify-center" onClick={onClose}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="w-full sm:max-w-md bg-surface rounded-t-2xl sm:rounded-2xl px-4 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))] max-h-[85dvh] overflow-y-auto overscroll-contain outline-none"
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
