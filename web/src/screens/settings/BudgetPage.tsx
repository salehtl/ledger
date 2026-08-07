import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { m, useReducedMotion } from "motion/react";
import { getJSON, postJSON } from "../../api/client";
import type { BudgetConfig } from "../../api/types";
import { dirhamsToFils, filsToDirhams, fractionToPercent, percentToFraction } from "../../lib/format";
import { pctsValid, splitSegments } from "../../lib/split";
import { DUR, EASE_OUT } from "../../lib/motion";
import { Switch } from "../../components/ui/Switch";
import { PixelSpinner } from "../../components/ui/PixelSpinner";
import { EmptyState } from "../../components/EmptyState";
import { AlertTriangle } from "../../components/ui/PixelIcon";
import { NumberField } from "../../components/ui/Field";
import { useToast } from "../../components/Toast";
import { SettingsPage } from "./SettingsPage";
import { SavedFlash, useSavedFlash } from "./SavedFlash";

/**
 * One coloured slice of the split bar. All three segments share the same
 * box (absolutely stacked, not flex-sized) and are revealed with clip-path
 * insets rather than a `width` that grows/shrinks the box itself — the same
 * shape ProgressBar uses for its fill, and for the same reason: `width` is a
 * layout property, and this bar's segments animate on every keystroke.
 */
export function SegmentFill({ start, width, className }: { start: number; width: number; className: string }) {
  // clipPath is not a transform, so Framer's global reducedMotion policy does
  // not cover it — this one is gated by hand.
  const reduced = useReducedMotion();
  return (
    <m.div
      className={`absolute inset-0 h-full w-full ${className}`}
      initial={false}
      animate={{ clipPath: `inset(0 ${100 - start - width}% 0 ${start}%)` }}
      transition={reduced ? { duration: 0 } : { duration: DUR.sheet, ease: EASE_OUT }}
    />
  );
}

/**
 * The 50/30/20 split, live: segment widths track the inputs, and
 * under-allocated income reads as a literal gap in the bar.
 */
function SplitBar({ need, want, saving }: { need: number; want: number; saving: number }) {
  const seg = splitSegments(need, want, saving);
  const wantStart = seg.needPct;
  const saveStart = seg.needPct + seg.wantPct;
  return (
    <div
      className="relative h-3 overflow-hidden rounded-[var(--radius)] bg-surface-2"
      role="img"
      aria-label={`Budget split: need ${fractionToPercent(need)}%, want ${fractionToPercent(want)}%, saving ${fractionToPercent(saving)}%`}
    >
      <SegmentFill start={0} width={seg.needPct} className="bg-need" />
      <SegmentFill start={wantStart} width={seg.wantPct} className="bg-want" />
      <SegmentFill start={saveStart} width={seg.savingPct} className="bg-save" />
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
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

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
      {/* isPending, not isLoading: the persisted-cache restore window leaves
          queries pending-but-not-fetching, where isLoading reports false with
          no data — which rendered this page completely blank. */}
      {budget.isPending && (
        <div className="flex justify-center py-12">
          <PixelSpinner size={32} role="status" aria-label="Loading budget" className="text-muted" />
        </div>
      )}
      {!budget.isPending && !cfg && (
        <EmptyState
          icon={AlertTriangle}
          title="Couldn't load your budget"
          hint="Check your connection and try again."
        />
      )}
      {cfg && split && (
        <div className="space-y-4">
          <label className="block text-sm">
            Monthly income (AED)
            {/* Ignoring a null keeps the last saved income while the field is
                empty mid-edit, so clearing it can't autosave a zero budget. */}
            <NumberField
              className="mt-1"
              min={0}
              decimals={2}
              value={filsToDirhams(cfg.monthly_income)}
              onValueChange={(n) => n !== null && patch({ monthly_income: dirhamsToFils(n) })}
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
                <NumberField className="mt-1" min={0} max={100} allowDecimal={false}
                  value={fractionToPercent(cfg.need_pct)}
                  onValueChange={(n) => n !== null && patch({ need_pct: percentToFraction(n) })} />
              </label>
              <label className="text-sm">
                Want %
                <NumberField className="mt-1" min={0} max={100} allowDecimal={false}
                  value={fractionToPercent(cfg.want_pct)}
                  onValueChange={(n) => n !== null && patch({ want_pct: percentToFraction(n) })} />
              </label>
              <label className="text-sm">
                Saving %
                <NumberField className="mt-1" min={0} max={100} allowDecimal={false}
                  value={fractionToPercent(cfg.saving_pct)}
                  onValueChange={(n) => n !== null && patch({ saving_pct: percentToFraction(n) })} />
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
