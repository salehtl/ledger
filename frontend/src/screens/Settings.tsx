import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getJSON, postJSON, del } from "../api/client";
import type { BudgetConfig, Category, Rule } from "../api/types";
import { dirhamsToFils, filsToDirhams, fractionToPercent, percentToFraction } from "../lib/format";
import { Card } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import { Trash2 } from "lucide-react";

export function pctsValid(need: number, want: number, saving: number): boolean {
  return Math.abs(need + want + saving - 1.0) < 0.001;
}

const BUCKETS = ["need", "want", "saving"] as const;

export function Settings() {
  const qc = useQueryClient();
  const budget = useQuery({ queryKey: ["budget"], queryFn: () => getJSON<BudgetConfig>("/api/budget") });
  const cats = useQuery({ queryKey: ["categories"], queryFn: () => getJSON<Category[]>("/api/categories") });
  const rules = useQuery({ queryKey: ["rules"], queryFn: () => getJSON<Rule[]>("/api/rules") });

  const [draft, setDraft] = useState<BudgetConfig | null>(null);
  const [error, setError] = useState("");
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

  const field = "w-full px-3 py-2 rounded-lg border border-border bg-surface text-sm";

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Settings</h1>

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

      <Card>
        <p className="text-sm font-medium mb-3">Categories → buckets</p>
        <div className="space-y-2">
          {(cats.data ?? []).filter((c) => c.Kind === "spending").map((c) => (
            <div key={c.ID} className="flex items-center justify-between gap-3">
              <span className="text-sm">{c.Name}</span>
              <select value={c.Bucket} onChange={(e) => reassign(c, e.target.value)} className="border border-border rounded-lg px-2 py-1 text-sm bg-surface">
                {BUCKETS.map((b) => <option key={b} value={b}>{b}</option>)}
              </select>
            </div>
          ))}
        </div>
      </Card>

      <Card>
        <p className="text-sm font-medium mb-3">Rules</p>
        {(rules.data ?? []).length === 0 ? (
          <p className="text-sm text-muted">No rules yet — create one when you categorize a transaction.</p>
        ) : (
          <ul className="space-y-2">
            {(rules.data ?? []).map((r) => (
              <li key={r.ID} className="flex items-center justify-between gap-3 text-sm">
                <span className="min-w-0 truncate">{r.MatchType}: "{r.Pattern}" → {catName(r.CategoryID)}</span>
                <button aria-label="Delete rule" className="text-muted hover:text-bad" onClick={() => deleteRule(r.ID)}><Trash2 size={16} /></button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <p className="text-sm font-medium mb-1">About</p>
        <p className="text-xs text-muted">Icons by Lucide (ISC). Charts by Recharts (MIT).</p>
      </Card>
    </div>
  );
}
