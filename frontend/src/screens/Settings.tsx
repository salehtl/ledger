import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getJSON, postJSON, del } from "../api/client";
import type { AppSettings, BudgetConfig, Category, Rule } from "../api/types";
import { CategoryManager } from "./CategoryManager";
import { dirhamsToFils, filsToDirhams, fractionToPercent, percentToFraction } from "../lib/format";
import { Card } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import { useToast } from "../components/Toast";
import { Trash2 } from "lucide-react";
import {
  loadSwipeConfig,
  saveSwipeConfig,
  DEFAULT_SWIPE_CONFIG,
  type SwipeConfig,
  type SwipeDirection,
} from '../lib/swipe'

export function pctsValid(need: number, want: number, saving: number): boolean {
  return Math.abs(need + want + saving - 1.0) < 0.001;
}

export function Settings() {
  const qc = useQueryClient();
  const { show } = useToast();
  const budget = useQuery({ queryKey: ["budget"], queryFn: () => getJSON<BudgetConfig>("/api/budget") });
  const cats = useQuery({ queryKey: ["categories"], queryFn: () => getJSON<Category[]>("/api/categories") });
  const rules = useQuery({ queryKey: ["rules"], queryFn: () => getJSON<Rule[]>("/api/rules") });
  const settings = useQuery({ queryKey: ["settings"], queryFn: () => getJSON<AppSettings>("/api/settings") });
  const saveSettings = async (next: AppSettings) => {
    try {
      await postJSON("/api/settings", next, "PUT");
      qc.invalidateQueries({ queryKey: ["settings"] });
    } catch { show({ message: "Couldn't save settings", tone: "error" }); }
  };

  const [draft, setDraft] = useState<BudgetConfig | null>(null);
  const [error, setError] = useState("");
  const [swipeCfg, setSwipeCfg] = useState<SwipeConfig>(loadSwipeConfig);
  const [managerOpen, setManagerOpen] = useState(false);
  const cfg = draft ?? budget.data ?? null;
  const patch = (p: Partial<BudgetConfig>) => cfg && setDraft({ ...cfg, ...p });

  const saveBudget = async () => {
    if (!cfg) return;
    if (!pctsValid(cfg.need_pct, cfg.want_pct, cfg.saving_pct)) { setError("Need / Want / Saving must add up to 100%."); return; }
    setError("");
    try {
      await postJSON("/api/budget", cfg, "PUT");
      setDraft(null);
      qc.invalidateQueries({ queryKey: ["budget"] });
      qc.invalidateQueries({ queryKey: ["summary"] });
    } catch {
      setError("Couldn’t save — please try again.");
    }
  };
  const deleteRule = async (id: number) => {
    try { await del(`/api/rules/${id}`); qc.invalidateQueries({ queryKey: ["rules"] }); }
    catch { show({ message: "Couldn't delete rule", tone: "error" }); }
  };
  const toggleRule = async (r: Rule) => {
    try {
      await postJSON(`/api/rules/${r.ID}/active`, { active: !r.IsActive }, "PUT");
      qc.invalidateQueries({ queryKey: ["rules"] });
    } catch { show({ message: "Couldn't update rule", tone: "error" }); }
  };
  const catName = (id: number) => cats.data?.find((c) => c.ID === id)?.Name ?? `#${id}`;

  const setSwipeDir = (dir: SwipeDirection, value: string) => {
    const next: SwipeConfig = { ...swipeCfg }
    if (value === 'transfer') {
      next[dir] = { ...DEFAULT_SWIPE_CONFIG.up }
    } else {
      const template = Object.values(DEFAULT_SWIPE_CONFIG).find(a => a.bucket === value)
      if (template) next[dir] = { ...template }
    }
    setSwipeCfg(next)
    saveSwipeConfig(next)
  }

  const field = "w-full px-3 py-2 rounded-lg border border-border bg-surface text-sm";

  return (
    <div className="space-y-4">
      {cfg && (
        <Card>
          <p className="text-sm font-medium mb-3">Budget</p>
          <label className="block text-sm mb-3">Monthly income (AED)
            <input type="number" min="0" step="0.01" className={field}
              value={filsToDirhams(cfg.monthly_income)}
              onChange={(e) => patch({ monthly_income: dirhamsToFils(Number(e.target.value)) })} />
          </label>
          <div className="grid grid-cols-3 gap-2">
            <label className="text-sm">Need %
              <input type="number" min="0" max="100" className={field}
                value={fractionToPercent(cfg.need_pct)}
                onChange={(e) => patch({ need_pct: percentToFraction(Number(e.target.value)) })} />
            </label>
            <label className="text-sm">Want %
              <input type="number" min="0" max="100" className={field}
                value={fractionToPercent(cfg.want_pct)}
                onChange={(e) => patch({ want_pct: percentToFraction(Number(e.target.value)) })} />
            </label>
            <label className="text-sm">Saving %
              <input type="number" min="0" max="100" className={field}
                value={fractionToPercent(cfg.saving_pct)}
                onChange={(e) => patch({ saving_pct: percentToFraction(Number(e.target.value)) })} />
            </label>
          </div>
          <label className="flex items-center gap-2 text-sm mt-3">
            <input type="checkbox" checked={cfg.freeze_history} onChange={(e) => patch({ freeze_history: e.target.checked })} /> Freeze history
          </label>
          {error && <p role="alert" className="text-bad text-sm mt-2">{error}</p>}
          <div className="mt-3"><Button variant="primary" onClick={saveBudget}>Save budget</Button></div>
        </Card>
      )}

      {settings.data && (
        <Card>
          <p className="text-sm font-medium mb-3">Categorization</p>
          <label className="flex items-center justify-between gap-3 text-sm py-1.5">
            <span>Auto-categorize new transactions
              <span className="block text-xs text-muted">Off = everything waits in Needs review for you to categorize.</span>
            </span>
            <input type="checkbox" aria-label="Auto-categorize"
              checked={settings.data.auto_categorize}
              onChange={(e) => saveSettings({ ...settings.data!, auto_categorize: e.target.checked })} />
          </label>
          <label className="flex items-center justify-between gap-3 text-sm py-1.5">
            <span>AI suggestions
              <span className="block text-xs text-muted">Let AI propose a category when no rule matches.</span>
            </span>
            <input type="checkbox" aria-label="AI suggestions"
              checked={settings.data.ai_enabled}
              onChange={(e) => saveSettings({ ...settings.data!, ai_enabled: e.target.checked })} />
          </label>
          <label className="flex items-center justify-between gap-3 text-sm py-1.5">
            <span>AI auto-accept
              <span className="block text-xs text-muted">Auto-confirm confident AI suggestions instead of just suggesting.</span>
            </span>
            <input type="checkbox" aria-label="AI auto-accept"
              disabled={!settings.data.ai_enabled}
              checked={settings.data.ai_auto_accept}
              onChange={(e) => saveSettings({ ...settings.data!, ai_auto_accept: e.target.checked })} />
          </label>
        </Card>
      )}

      <Card>
        <button
          onClick={() => setManagerOpen(true)}
          className="w-full flex items-center justify-between text-sm font-medium"
        >
          <span>Manage categories</span>
          <span className="text-muted" aria-hidden>→</span>
        </button>
      </Card>

      <Card>
        <p className="text-sm font-medium mb-3">Rules</p>
        {(rules.data ?? []).length === 0 ? (
          <p className="text-sm text-muted">No rules yet — create one when you categorize a transaction.</p>
        ) : (
          <ul className="space-y-2">
            {(rules.data ?? []).map((r) => (
              <li key={r.ID} className={`flex items-center justify-between gap-3 text-sm ${r.IsActive ? "" : "opacity-50"}`}>
                <span className="min-w-0 truncate">{r.MatchType}: "{r.Pattern}" → {catName(r.CategoryID)}</span>
                <div className="flex items-center gap-2">
                  <label className="flex items-center gap-1 text-xs text-muted">
                    <input type="checkbox" aria-label={`Rule ${r.ID} active`} checked={r.IsActive} onChange={() => toggleRule(r)} />
                    on
                  </label>
                  <button aria-label="Delete rule" className="text-muted hover:text-bad" onClick={() => deleteRule(r.ID)}><Trash2 size={16} /></button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* Swipe Directions */}
      <Card>
        <h2 className="font-semibold mb-1">Swipe Directions</h2>
        <p className="text-sm text-muted mb-4">
          Customize what each swipe direction means when reviewing transactions.
        </p>
        <div className="space-y-3">
          {(['left', 'right', 'up', 'down'] as const).map(dir => {
            const dirLabel: Record<SwipeDirection, string> = {
              left: '← Left', right: '→ Right', up: '↑ Up', down: '↓ Down',
            }
            const current = swipeCfg[dir]
            const value = current.statusOverride === 'transfer' ? 'transfer' : current.bucket ?? ''
            return (
              <div key={dir} className="flex items-center justify-between gap-3">
                <span className="text-sm font-medium text-fg w-20">{dirLabel[dir]}</span>
                <select
                  value={value}
                  onChange={e => setSwipeDir(dir, e.target.value)}
                  className={field}
                >
                  <option value="want">Want</option>
                  <option value="need">Need</option>
                  <option value="saving">Save</option>
                  <option value="transfer">Transfer</option>
                </select>
              </div>
            )
          })}
        </div>
        <Button
          variant="ghost"
          className="mt-3 text-sm"
          onClick={() => {
            setSwipeCfg(DEFAULT_SWIPE_CONFIG)
            saveSwipeConfig(DEFAULT_SWIPE_CONFIG)
          }}
        >
          Reset to defaults
        </Button>
      </Card>

      <Card>
        <p className="text-sm font-medium mb-1">About</p>
        <p className="text-xs text-muted">Icons by Lucide (ISC). Charts by Recharts (MIT).</p>
      </Card>
      {managerOpen && <CategoryManager onClose={() => setManagerOpen(false)} />}
    </div>
  );
}
