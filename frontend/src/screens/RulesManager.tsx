import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Trash2 } from "lucide-react";
import { getJSON, postJSON, del } from "../api/client";
import type { Category, Rule } from "../api/types";
import { useToast } from "../components/Toast";
import { Switch } from "../components/ui/Switch";

export function RulesManager({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const { show } = useToast();
  const rules = useQuery({ queryKey: ["rules"], queryFn: () => getJSON<Rule[]>("/api/rules") });
  const cats = useQuery({ queryKey: ["categories"], queryFn: () => getJSON<Category[]>("/api/categories") });

  const catName = (id: number) => cats.data?.find((c) => c.ID === id)?.Name ?? `#${id}`;

  const toggleRule = async (r: Rule) => {
    try {
      await postJSON(`/api/rules/${r.ID}/active`, { active: !r.IsActive }, "PUT");
      qc.invalidateQueries({ queryKey: ["rules"] });
    } catch {
      show({ message: "Couldn't update rule", tone: "error" });
    }
  };

  const deleteRule = async (id: number) => {
    try {
      await del(`/api/rules/${id}`);
      qc.invalidateQueries({ queryKey: ["rules"] });
    } catch {
      show({ message: "Couldn't delete rule", tone: "error" });
    }
  };

  const list = rules.data ?? [];

  return (
    <div className="fixed inset-0 z-40 bg-bg flex flex-col">
      <header className="flex items-center gap-3 px-4 pt-4 pb-3 border-b border-border">
        <button onClick={onClose} className="p-2 -ml-2 rounded-lg hover:bg-bg text-muted" aria-label="Close rules">
          <ArrowLeft size={20} />
        </button>
        <h1 className="text-lg font-semibold text-fg">Rules</h1>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-4 max-w-screen-sm w-full mx-auto">
        <p className="text-xs text-muted mb-3">
          Learned when you categorize — transactions that match a rule skip review.
          Turn a rule off to pause it without losing it.
        </p>
        {list.length === 0 ? (
          <p className="text-sm text-muted">No rules yet — categorize a transaction and ledger learns from it.</p>
        ) : (
          <ul className="bg-surface rounded-[var(--radius-card)] shadow-1 divide-y divide-border">
            {list.map((r) => (
              <li key={r.ID} className={`flex items-center gap-3 px-4 py-3 ${r.IsActive ? "" : "opacity-50"}`}>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium truncate">“{r.Pattern}”</p>
                  <p className="text-xs text-muted truncate">{r.MatchType} → {catName(r.CategoryID)}</p>
                </div>
                <Switch aria-label={`Rule ${r.ID} active`} checked={r.IsActive} onChange={() => toggleRule(r)} />
                <button aria-label="Delete rule" className="p-2 -mr-2 text-muted hover:text-bad" onClick={() => deleteRule(r.ID)}>
                  <Trash2 size={16} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
