import { useState } from "react";
import { ChevronLeft, ChevronRight, Settings as SettingsIcon } from "./PixelIcon";
import { type Scope, addMonth, scopeLabel } from "../../lib/scope";
import { IconButton } from "./IconButton";
import { Pressable } from "./Pressable";
import { PeriodSheet } from "./PeriodSheet";

export function TopBar({ title, scope, onScopeChange, showScope, onOpenSettings }: {
  title: string;
  scope: Scope;
  onScopeChange: (s: Scope) => void;
  showScope: boolean;
  /** Settings is not a tab: the gear here is its one persistent entry point. */
  onOpenSettings?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const isMonth = scope.kind === "month";

  return (
    <header className="shrink-0 bg-bg pt-[env(safe-area-inset-top)]">
      <div className="min-h-[48px] px-4 flex items-center justify-between gap-3">
        <h1 className="text-base font-semibold tracking-[-0.015em] truncate">{title}</h1>
        <div className="flex items-center gap-0.5">
          {showScope && (
            <>
              {isMonth && (
                <IconButton
                  label="Previous month"
                  onClick={() => onScopeChange({ kind: "month", period: addMonth(scope.period, -1) })}
                >
                  <ChevronLeft size={18} />
                </IconButton>
              )}
              <Pressable
                onClick={() => setOpen(true)}
                aria-haspopup="dialog"
                aria-expanded={open}
                className="min-h-11 px-3 py-1.5 rounded-[var(--radius)] font-mono text-[10px] font-medium uppercase tracking-[0.12em] bg-surface-2 text-fg truncate"
              >
                {scopeLabel(scope)}
              </Pressable>
              {isMonth && (
                <IconButton
                  label="Next month"
                  onClick={() => onScopeChange({ kind: "month", period: addMonth(scope.period, 1) })}
                >
                  <ChevronRight size={18} />
                </IconButton>
              )}
            </>
          )}
          {onOpenSettings && (
            <IconButton label="Settings" onClick={onOpenSettings}>
              <SettingsIcon size={18} />
            </IconButton>
          )}
        </div>
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
