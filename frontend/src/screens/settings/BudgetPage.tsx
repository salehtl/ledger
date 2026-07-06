import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getJSON, postJSON } from "../../api/client";
import type { BudgetConfig } from "../../api/types";
import { dirhamsToFils, filsToDirhams, fractionToPercent, percentToFraction } from "../../lib/format";
import { pctsValid, splitSegments } from "../../lib/split";
import { Switch } from "../../components/ui/Switch";
import { Input } from "../../components/ui/Field";
import { useToast } from "../../components/Toast";
import { SettingsPage } from "./SettingsPage";
import { SavedFlash, useSavedFlash } from "./SavedFlash";

/**
 * The 50/30/20 split, live: segment widths track the inputs, and
 * under-allocated income reads as a literal gap in the bar.
 */
function SplitBar({ need, want, saving }: { need: number; want: number; saving: number }) {
  const seg = splitSegments(need, want, saving);
  const bar = "h-full transition-[width] duration-300 motion-reduce:transition-none";
  return (
    <div
      className="h-3 flex overflow-hidden rounded-full bg-surface-2"
      role="img"
      aria-label={`Budget split: need ${fractionToPercent(need)}%, want ${fractionToPercent(want)}%, saving ${fractionToPercent(saving)}%`}
    >
      <div className={`${bar} bg-need`} style={{ width: `${seg.needPct}%` }} />
      <div className={`${bar} bg-want`} style={{ width: `${seg.wantPct}%` }} />
      <div className={`${bar} bg-save`} style={{ width: `${seg.savingPct}%` }} />
    </div>
  );
}

export function BudgetPage({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const { show } = useToast();
  const { saved, flash } = useSavedFlash();
  const budget = useQuery({ queryKey: ["budget"], queryFn: () => getJSON<BudgetConfig>("/api/budget") });
  const [draft, setDraft] = useState<BudgetConfig | null>(null);
  const [error, setError] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout>>();

  const cfg = draft ?? budget.data ?? null;
  const split = cfg ? splitSegments(cfg.need_pct, cfg.want_pct, cfg.saving_pct) : null;

  // Autosave: every edit persists on its own once the split is valid. The whole
  // BudgetConfig saves at once (the endpoint takes it whole), so an in-progress
  // invalid split holds the save and surfaces inline until it's fixed.
  const persist = async (next: BudgetConfig) => {
    if (!pctsValid(next.need_pct, next.want_pct, next.saving_pct)) {
      setError("Need / Want / Saving must add up to 100%.");
      return;
    }
    setError("");
    try {
      await postJSON("/api/budget", next, "PUT");
      qc.invalidateQueries({ queryKey: ["budget"] });
      qc.invalidateQueries({ queryKey: ["summary"] });
      flash();
    } catch {
      show({ message: "Couldn't save budget", tone: "error" });
    }
  };

  // Debounce so typing doesn't fire a save per keystroke.
  const patch = (p: Partial<BudgetConfig>, immediate = false) => {
    if (!cfg) return;
    const next = { ...cfg, ...p };
    setDraft(next);
    clearTimeout(timer.current);
    if (immediate) void persist(next);
    else timer.current = setTimeout(() => void persist(next), 600);
  };

  return (
    <SettingsPage title="Budget & income" onClose={onClose} headerRight={<SavedFlash saved={saved} />}>
      {cfg && split && (
        <div className="space-y-4">
          <label className="block text-sm">
            Monthly income (AED)
            <Input
              type="number"
              inputMode="decimal"
              min="0"
              step="0.01"
              className="mt-1"
              value={filsToDirhams(cfg.monthly_income)}
              onChange={(e) => patch({ monthly_income: dirhamsToFils(Number(e.target.value)) })}
            />
          </label>

          <div>
            <div className="flex items-baseline justify-between mb-1.5">
              <span className="text-sm">Split</span>
              <span className={`text-xs font-medium tnum ${split.ok ? "text-muted" : "text-bad"}`}>
                {split.totalPct}% allocated
              </span>
            </div>
            <SplitBar need={cfg.need_pct} want={cfg.want_pct} saving={cfg.saving_pct} />
            <div className="grid grid-cols-3 gap-2 mt-2.5">
              <label className="text-sm">
                Need %
                <Input type="number" inputMode="numeric" min="0" max="100" className="mt-1"
                  value={fractionToPercent(cfg.need_pct)}
                  onChange={(e) => patch({ need_pct: percentToFraction(Number(e.target.value)) })} />
              </label>
              <label className="text-sm">
                Want %
                <Input type="number" inputMode="numeric" min="0" max="100" className="mt-1"
                  value={fractionToPercent(cfg.want_pct)}
                  onChange={(e) => patch({ want_pct: percentToFraction(Number(e.target.value)) })} />
              </label>
              <label className="text-sm">
                Saving %
                <Input type="number" inputMode="numeric" min="0" max="100" className="mt-1"
                  value={fractionToPercent(cfg.saving_pct)}
                  onChange={(e) => patch({ saving_pct: percentToFraction(Number(e.target.value)) })} />
              </label>
            </div>
            {error && <p role="alert" className="text-bad text-sm mt-2">{error}</p>}
          </div>

          <label className="flex items-center justify-between gap-3 text-sm pt-1">
            <span>
              Freeze history
              <span className="block text-xs text-muted">Keep closed months as they were when budget numbers change.</span>
            </span>
            <Switch
              aria-label="Freeze history"
              checked={cfg.freeze_history}
              onChange={(e) => patch({ freeze_history: e.target.checked }, true)}
            />
          </label>
        </div>
      )}
    </SettingsPage>
  );
}
