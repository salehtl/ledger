import { useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { type Scope, addMonth, scopeLabel } from "../../lib/scope";
import { PeriodSheet } from "./PeriodSheet";

export function TopBar({ title, scope, onScopeChange, showScope }: {
  title: string;
  scope: Scope;
  onScopeChange: (s: Scope) => void;
  showScope: boolean;
}) {
  const [open, setOpen] = useState(false);
  const isMonth = scope.kind === "month";

  return (
    <header className="shrink-0 bg-surface border-b border-border pt-[env(safe-area-inset-top)]">
      <div className="min-h-[48px] px-4 flex items-center justify-between gap-3">
        <h1 className="text-base font-semibold truncate">{title}</h1>
        {showScope && (
          <div className="flex items-center gap-0.5">
            {isMonth && (
              <button
                aria-label="Previous month"
                onClick={() => onScopeChange({ kind: "month", period: addMonth(scope.period, -1) })}
                className="p-1.5 rounded-lg text-muted hover:bg-bg"
              >
                <ChevronLeft size={18} />
              </button>
            )}
            <button
              onClick={() => setOpen(true)}
              aria-haspopup="dialog"
              aria-expanded={open}
              className="px-3 py-1.5 rounded-lg text-sm font-medium bg-bg text-fg tnum truncate"
            >
              {scopeLabel(scope)}
            </button>
            {isMonth && (
              <button
                aria-label="Next month"
                onClick={() => onScopeChange({ kind: "month", period: addMonth(scope.period, 1) })}
                className="p-1.5 rounded-lg text-muted hover:bg-bg"
              >
                <ChevronRight size={18} />
              </button>
            )}
          </div>
        )}
      </div>
      {open && (
        <PeriodSheet
          scope={scope}
          onApply={(s) => { onScopeChange(s); setOpen(false); }}
          onClose={() => setOpen(false)}
        />
      )}
    </header>
  );
}
