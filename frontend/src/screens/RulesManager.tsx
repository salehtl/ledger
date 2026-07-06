import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { getJSON, postJSON, del } from "../api/client";
import type { Category, Rule } from "../api/types";
import { useToast } from "../components/Toast";
import { Switch } from "../components/ui/Switch";
import { SettingsPage } from "./settings/SettingsPage";
import { Card } from "../components/ui/Card";
import { IconButton } from "../components/ui/IconButton";

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
    <SettingsPage title="Rules" onClose={onClose}>
      <p className="text-xs text-muted mb-3">
        Learned when you categorize — transactions that match a rule skip review.
        Turn a rule off to pause it without losing it.
      </p>
      {list.length === 0 ? (
        <p className="text-sm text-muted">No rules yet — categorize a transaction and ledger learns from it.</p>
      ) : (
        <Card className="!p-0">
          <ul className="divide-y divide-border">
            {list.map((r) => (
              <li key={r.ID} className={`flex items-center gap-3 px-4 py-3 ${r.IsActive ? "" : "opacity-50"}`}>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium truncate">“{r.Pattern}”</p>
                  <p className="text-xs text-muted truncate">{r.MatchType} → {catName(r.CategoryID)}</p>
                </div>
                <Switch aria-label={`Rule ${r.ID} active`} checked={r.IsActive} onChange={() => toggleRule(r)} />
                <IconButton label="Delete rule" tone="danger" className="-mr-2" onClick={() => deleteRule(r.ID)}>
                  <Trash2 size={16} />
                </IconButton>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </SettingsPage>
  );
}
