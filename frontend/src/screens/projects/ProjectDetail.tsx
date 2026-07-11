import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getJSON, getProject, updateProject, deleteProject } from "../../api/client";
import type { Project, Txn } from "../../api/types";
import { formatFils } from "../../lib/money";
import { isOverBudget, projectPctUsed, projectRemaining } from "../../lib/projectMath";
import { Card } from "../../components/ui/Card";
import { ProgressBar } from "../../components/ui/ProgressBar";
import { SectionLabel } from "../../components/ui/SectionLabel";
import { Switch } from "../../components/ui/Switch";
import { Button } from "../../components/ui/Button";
import { Dialog } from "../../components/ui/Dialog";
import { TransactionRow } from "../../components/transactions/TransactionRow";
import { useTxnActions } from "../../hooks/useTxnActions";
import { useToast } from "../../components/Toast";
import { SettingsPage } from "../settings/SettingsPage";

/**
 * Full project detail: budget state, the count-in-monthly opt-in, status
 * actions, a by-category breakdown, and the transactions currently assigned
 * to this project. "Add transactions" hands off to the bulk-backfill
 * sub-view (Task 8b) rather than a modal — this whole screen is a drill-in
 * page, consistent with the rest of the app's calm, non-sheet navigation.
 *
 * Assigned transactions are sourced by client-filtering the same
 * `["transactions"]` query the Transactions screen uses (unfiltered — every
 * status except archived), rather than a dedicated endpoint, so this list
 * stays in the same cache and gets invalidated by every txn mutation.
 */
export function ProjectDetail({
  id,
  onClose,
  onEdit,
  onAddTransactions,
}: {
  id: number;
  onClose: () => void;
  onEdit: (project: Project) => void;
  onAddTransactions: () => void;
}) {
  const qc = useQueryClient();
  const { show } = useToast();
  const { setStatus, archiveTxn, restoreTxn } = useTxnActions();
  const [confirmDelete, setConfirmDelete] = useState(false);

  const project = useQuery({ queryKey: ["projects", id], queryFn: () => getProject(id) });
  const txns = useQuery({
    queryKey: ["transactions", "", "", ""],
    queryFn: () => getJSON<Txn[]>("/api/transactions"),
  });

  const p = project.data;
  const assigned = (txns.data ?? []).filter((t) => t.ProjectID === id);

  const invalidateAfterChange = () => {
    qc.invalidateQueries({ queryKey: ["projects"] });
    qc.invalidateQueries({ queryKey: ["projects", id] });
    qc.invalidateQueries({ queryKey: ["summary"] });
  };

  const toggleCountInMonthly = async (checked: boolean) => {
    if (!p) return;
    try {
      await updateProject(id, {
        name: p.name, budget_fils: p.budget_fils, color: p.color,
        starts_on: p.starts_on, ends_on: p.ends_on, count_in_monthly: checked,
      });
      invalidateAfterChange();
    } catch {
      show({ message: "Couldn't update project", tone: "error" });
    }
  };

  const toggleStatus = async () => {
    if (!p) return;
    const nextStatus = p.status === "active" ? "completed" : "active";
    try {
      await updateProject(id, {
        name: p.name, budget_fils: p.budget_fils, color: p.color,
        starts_on: p.starts_on, ends_on: p.ends_on, count_in_monthly: p.count_in_monthly,
        status: nextStatus,
      });
      invalidateAfterChange();
    } catch {
      show({ message: "Couldn't update project", tone: "error" });
    }
  };

  const confirmDeleteProject = async () => {
    try {
      await deleteProject(id);
      qc.invalidateQueries({ queryKey: ["projects"] });
      qc.invalidateQueries({ queryKey: ["summary"] });
      qc.invalidateQueries({ queryKey: ["transactions"] });
      setConfirmDelete(false);
      onClose();
    } catch {
      show({ message: "Couldn't delete project", tone: "error" });
    }
  };

  if (!p) {
    return (
      <SettingsPage title="Project" onClose={onClose}>
        <p className="text-sm text-muted">Loading…</p>
      </SettingsPage>
    );
  }

  const pct = projectPctUsed(p.budget_fils, p.net_spent_fils);
  const remaining = projectRemaining(p.budget_fils, p.net_spent_fils);
  const over = isOverBudget(p.budget_fils, p.net_spent_fils);
  const dates = [p.starts_on, p.ends_on].filter(Boolean).join(" – ");

  return (
    <SettingsPage title={p.name} onClose={onClose}>
      <div className="space-y-6">
        <Card className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-sm text-muted">Net spent</span>
            <span className={`tnum font-semibold ${over ? "text-bad" : "text-fg"}`}>{formatFils(p.net_spent_fils)}</span>
          </div>

          {p.budget_fils != null && pct != null ? (
            <div className="space-y-1">
              <ProgressBar pct={pct} label={`${p.name} budget used`} />
              <p className={`text-xs ${over ? "text-bad font-medium" : "text-muted"}`}>
                {over
                  ? `${formatFils(Math.abs(remaining ?? 0))} over budget`
                  : `${formatFils(remaining ?? 0)} remaining`}
              </p>
            </div>
          ) : (
            <p className="text-xs text-muted">No budget set</p>
          )}

          {p.pending_fils > 0 && (
            <p className="text-xs text-muted">+ {formatFils(p.pending_fils)} pending review</p>
          )}
        </Card>

        {dates && <p className="text-xs text-muted px-1">{dates}</p>}

        <label className="flex items-center justify-between gap-3 text-sm">
          <span>
            Count in monthly budget
            <span className="block text-xs text-muted">Off keeps this project's spend out of your 50/30/20.</span>
          </span>
          <Switch
            aria-label="Count in monthly budget"
            checked={p.count_in_monthly}
            onChange={(e) => toggleCountInMonthly(e.target.checked)}
          />
        </label>

        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => onEdit(p)}>Edit</Button>
          <Button variant="secondary" onClick={toggleStatus}>
            {p.status === "active" ? "Mark complete" : "Reopen"}
          </Button>
          <Button variant="danger" onClick={() => setConfirmDelete(true)}>Delete</Button>
        </div>

        {p.by_category.length > 0 && (
          <section className="space-y-2">
            <SectionLabel as="h2" className="px-1">By category</SectionLabel>
            <Card className="!p-0 divide-y divide-border overflow-hidden">
              {p.by_category.map((row) => (
                <div key={row.category} className="flex items-center justify-between px-4 py-2.5 text-sm">
                  <span>{row.category}</span>
                  <span className="tnum">{formatFils(row.net_fils)}</span>
                </div>
              ))}
            </Card>
          </section>
        )}

        <section className="space-y-2">
          <div className="flex items-center justify-between px-1">
            <SectionLabel as="h2">Transactions ({assigned.length})</SectionLabel>
            <Button variant="ghost" onClick={onAddTransactions}>Add transactions</Button>
          </div>
          {assigned.length === 0 ? (
            <p className="text-sm text-muted px-1">No transactions assigned yet.</p>
          ) : (
            <Card className="!p-0">
              <ul className="divide-y divide-border px-4">
                {assigned.map((t) => (
                  <li key={t.ID}>
                    <TransactionRow txn={t} onOpen={() => {}} onStatus={setStatus} onArchive={archiveTxn} onRestore={restoreTxn} />
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </section>
      </div>

      {confirmDelete && (
        <Dialog title="Delete project?" onClose={() => setConfirmDelete(false)}>
          <p className="text-sm text-muted mb-4">
            This removes "{p.name}" and unassigns its transactions. This can't be undone.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setConfirmDelete(false)}>Cancel</Button>
            <Button variant="danger" onClick={confirmDeleteProject}>Delete</Button>
          </div>
        </Dialog>
      )}
    </SettingsPage>
  );
}
