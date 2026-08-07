import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Search, Trash2 } from "../components/ui/PixelIcon";
import { getJSON, postJSON, del } from "../api/client";
import type { Category, Rule } from "../api/types";
import { useToast } from "../components/Toast";
import { Switch } from "../components/ui/Switch";
import { SettingsPage } from "./settings/SettingsPage";
import { Card } from "../components/ui/Card";
import { IconButton } from "../components/ui/IconButton";
import { Input } from "../components/ui/Field";
import { Dialog, DialogFooter } from "../components/ui/Dialog";
import { Button } from "../components/ui/Button";
import { Skeleton } from "../components/Skeleton";

export function RulesManager({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const { show } = useToast();
  const rules = useQuery({ queryKey: ["rules"], queryFn: () => getJSON<Rule[]>("/api/rules") });
  const cats = useQuery({ queryKey: ["categories"], queryFn: () => getJSON<Category[]>("/api/categories") });
  const [query, setQuery] = useState("");
  const [pendingDelete, setPendingDelete] = useState<Rule | null>(null);

  const catName = (id: number) => cats.data?.find((c) => c.ID === id)?.Name ?? `Category #${id}`;

  const toggleRule = async (rule: Rule) => {
    try {
      await postJSON(`/api/rules/${rule.ID}/active`, { active: !rule.IsActive }, "PUT");
      qc.invalidateQueries({ queryKey: ["rules"] });
      show({ message: rule.IsActive ? "Rule paused" : "Rule resumed", tone: "success" });
    } catch { show({ message: "Couldn't update rule", tone: "error" }); }
  };

  const deleteRule = async (rule: Rule) => {
    try {
      await del(`/api/rules/${rule.ID}`);
      setPendingDelete(null);
      qc.invalidateQueries({ queryKey: ["rules"] });
      show({ message: "Rule deleted", tone: "success" });
    } catch { show({ message: "Couldn't delete rule", tone: "error" }); }
  };

  const list = rules.data ?? [];
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return list
      .filter((rule) => !q || rule.Pattern.toLowerCase().includes(q) || catName(rule.CategoryID).toLowerCase().includes(q))
      .sort((a, b) => Number(b.IsActive) - Number(a.IsActive));
  // catName depends on the category query result.
  }, [list, cats.data, query]);
  const active = list.filter((rule) => rule.IsActive).length;

  return (
    <SettingsPage title="Learned rules" onClose={onClose}>
      <div>
        <p className="text-sm text-muted">Rules automatically categorize matching merchants so they skip review.</p>
        {!rules.isPending && <p className="mt-1 text-xs text-muted tnum">{active} active · {list.length - active} paused</p>}
      </div>

      <Input icon={Search} type="search" aria-label="Search rules" placeholder="Search merchants or categories…" value={query} onChange={(e) => setQuery(e.target.value)} />

      {rules.isPending ? <Skeleton rows={6} /> : list.length === 0 ? (
        <div className="py-10 text-center">
          <p className="font-medium">No learned rules yet</p>
          <p className="mt-1 text-sm text-muted">Enable “make a rule” when categorizing a transaction to create one.</p>
        </div>
      ) : filtered.length === 0 ? (
        <p className="py-10 text-center text-sm text-muted">No rules match “{query.trim()}”.</p>
      ) : (
        <Card className="!p-0">
          <ul className="divide-y divide-border">
            {filtered.map((rule) => (
              <li key={rule.ID} className={`flex items-center gap-3 px-4 py-3 ${rule.IsActive ? "" : "opacity-60"}`}>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium break-words">“{rule.Pattern}”</p>
                  <p className="mt-0.5 text-xs text-muted">Categorize as {catName(rule.CategoryID)}</p>
                  <p className="mt-0.5 font-mono text-[10px] uppercase tracking-[0.08em] text-muted">{rule.MatchType} match · {rule.IsActive ? "Active" : "Paused"}</p>
                </div>
                <Switch aria-label={`Rule ${rule.ID} active — ${rule.Pattern}`} checked={rule.IsActive} onChange={() => toggleRule(rule)} />
                <IconButton label={`Delete ${rule.Pattern} rule`} tone="danger" className="-mr-2" onClick={() => setPendingDelete(rule)}>
                  <Trash2 size={16} />
                </IconButton>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {pendingDelete && (
        <Dialog title="Delete learned rule?" onClose={() => setPendingDelete(null)}>
          <p className="text-sm text-muted">Future transactions matching “{pendingDelete.Pattern}” will return to review instead of being categorized automatically.</p>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setPendingDelete(null)}>Cancel</Button>
            <Button variant="danger" onClick={() => deleteRule(pendingDelete)}>Delete rule</Button>
          </DialogFooter>
        </Dialog>
      )}
    </SettingsPage>
  );
}
