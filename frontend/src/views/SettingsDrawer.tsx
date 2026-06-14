import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getJSON, postJSON, del } from "../api/client";
import type { BudgetConfig, Category, Rule } from "../api/types";

export function pctsValid(need: number, want: number, saving: number): boolean {
  return Math.abs(need + want + saving - 1.0) < 0.001;
}

const BUCKETS = ["need", "want", "saving"] as const;

export function SettingsDrawer({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const budget = useQuery({ queryKey: ["budget"], queryFn: () => getJSON<BudgetConfig>("/api/budget") });
  const cats = useQuery({ queryKey: ["categories"], queryFn: () => getJSON<Category[]>("/api/categories") });
  const rules = useQuery({ queryKey: ["rules"], queryFn: () => getJSON<Rule[]>("/api/rules") });

  const [draft, setDraft] = useState<BudgetConfig | null>(null);
  const cfg = draft ?? budget.data ?? null;
  const patch = (p: Partial<BudgetConfig>) => cfg && setDraft({ ...cfg, ...p });

  const saveBudget = async () => {
    if (!cfg) return;
    if (!pctsValid(cfg.need_pct, cfg.want_pct, cfg.saving_pct)) { alert("Percentages must sum to 100%."); return; }
    await postJSON("/api/budget", cfg, "PUT");
    setDraft(null);
    qc.invalidateQueries({ queryKey: ["budget"] });
    qc.invalidateQueries({ queryKey: ["summary"] });
  };

  const reassign = async (c: Category, bucket: string) => {
    await postJSON(`/api/categories/${c.ID}`, { name: c.Name, kind: c.Kind, bucket }, "PUT");
    qc.invalidateQueries({ queryKey: ["categories"] });
    qc.invalidateQueries({ queryKey: ["summary"] });
  };

  const deleteRule = async (id: number) => {
    await del(`/api/rules/${id}`);
    qc.invalidateQueries({ queryKey: ["rules"] });
  };

  const catName = (id: number) => cats.data?.find((c) => c.ID === id)?.Name ?? `#${id}`;

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <div className="drawer" onClick={(e) => e.stopPropagation()}>
        <h4>Settings</h4>

        {cfg && (
          <fieldset>
            <legend>Budget</legend>
            <label>Monthly income (fils)
              <input type="number" value={cfg.monthly_income}
                onChange={(e) => patch({ monthly_income: Number(e.target.value) })} />
            </label>
            <label>Income source
              <select value={cfg.income_source} onChange={(e) => patch({ income_source: e.target.value })}>
                <option value="config">Config figure</option>
                <option value="categories">Sum income categories</option>
              </select>
            </label>
            <div className="field-row">
              <label>Need % <input type="number" step="0.05" value={cfg.need_pct} onChange={(e) => patch({ need_pct: Number(e.target.value) })} /></label>
              <label>Want % <input type="number" step="0.05" value={cfg.want_pct} onChange={(e) => patch({ want_pct: Number(e.target.value) })} /></label>
              <label>Saving % <input type="number" step="0.05" value={cfg.saving_pct} onChange={(e) => patch({ saving_pct: Number(e.target.value) })} /></label>
            </div>
            <label><input type="checkbox" checked={cfg.freeze_history} onChange={(e) => patch({ freeze_history: e.target.checked })} /> Freeze history</label>
            <button onClick={saveBudget}>Save budget</button>
          </fieldset>
        )}

        {BUCKETS.map((bucket) => (
          <fieldset key={bucket}>
            <legend style={{ textTransform: "capitalize" }}>{bucket}</legend>
            {(cats.data ?? []).filter((c) => c.Kind === "spending" && c.Bucket === bucket).map((c) => (
              <div key={c.ID} className="field-row" style={{ justifyContent: "space-between" }}>
                <span>{c.Name}</span>
                <select value={c.Bucket} onChange={(e) => reassign(c, e.target.value)}>
                  {BUCKETS.map((b) => <option key={b} value={b}>{b}</option>)}
                </select>
              </div>
            ))}
          </fieldset>
        ))}

        <fieldset>
          <legend>Rules</legend>
          {(rules.data ?? []).map((r) => (
            <div key={r.ID} className="field-row" style={{ justifyContent: "space-between" }}>
              <span>{r.MatchType}: "{r.Pattern}" → {catName(r.CategoryID)}</span>
              <button onClick={() => deleteRule(r.ID)}>✕</button>
            </div>
          ))}
          {rules.data?.length === 0 && <small>No rules yet — confirm a review item with "Save as rule".</small>}
        </fieldset>

        <fieldset>
          <legend>About</legend>
          <small>Fugue Icons by Yusuke Kamiyamane (CC BY 3.0). Chrome: XP.css (MIT).</small>
        </fieldset>

        <button onClick={onClose}>Close</button>
      </div>
    </div>
  );
}
