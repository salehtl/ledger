import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Project } from "../../api/types";
import { createProject, updateProject } from "../../api/client";
import { dirhamsToFils, filsToDirhams } from "../../lib/format";
import { Input } from "../../components/ui/Field";
import { Button } from "../../components/ui/Button";
import { Switch } from "../../components/ui/Switch";
import { useToast } from "../../components/Toast";
import { SettingsPage } from "../settings/SettingsPage";

const COLOR_PRESETS = ["#1373d9", "#7b35b8", "#2e7d52", "#b45309", "#dc2626", "#0891b2"];

/**
 * Create-or-edit drill-in for a project. Budget is entered in AED and
 * converted to fils on save (dirhamsToFils/filsToDirhams, the same helper
 * BudgetPage uses); an empty budget field means no budget (`budget_fils:
 * null`), not zero. `count_in_monthly` defaults off so project spend stays
 * out of the 50/30/20 plan unless explicitly opted in.
 */
export function ProjectForm({
  project,
  onClose,
  onSaved,
}: {
  project?: Project;
  onClose: () => void;
  onSaved: () => void;
}) {
  const qc = useQueryClient();
  const { show } = useToast();
  const [name, setName] = useState(project?.name ?? "");
  const [budgetAed, setBudgetAed] = useState(
    project?.budget_fils != null ? String(filsToDirhams(project.budget_fils)) : "",
  );
  const [color, setColor] = useState(project?.color || COLOR_PRESETS[0]);
  const [startsOn, setStartsOn] = useState(project?.starts_on ?? "");
  const [endsOn, setEndsOn] = useState(project?.ends_on ?? "");
  const [countInMonthly, setCountInMonthly] = useState(project?.count_in_monthly ?? false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!name.trim()) {
      setError("Name is required");
      return;
    }
    setError("");
    setSaving(true);
    const body: Partial<Project> = {
      name: name.trim(),
      budget_fils: budgetAed.trim() === "" ? null : dirhamsToFils(Number(budgetAed)),
      color,
      starts_on: startsOn,
      ends_on: endsOn,
      count_in_monthly: countInMonthly,
    };
    try {
      if (project) {
        await updateProject(project.id, body);
      } else {
        await createProject(body);
      }
      qc.invalidateQueries({ queryKey: ["projects"] });
      onSaved();
    } catch {
      show({ message: "Couldn't save project", tone: "error" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsPage title={project ? "Edit project" : "New project"} onClose={onClose}>
      <div className="space-y-5">
        <label className="block text-sm">
          Name
          <Input
            className="mt-1"
            autoCapitalize="words"
            autoCorrect="off"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Kitchen reno"
          />
        </label>

        <label className="block text-sm">
          Budget (AED)
          <Input
            type="number"
            inputMode="decimal"
            min="0"
            step="0.01"
            className="mt-1"
            value={budgetAed}
            onChange={(e) => setBudgetAed(e.target.value)}
            placeholder="No budget"
          />
        </label>

        <div>
          <p className="text-sm mb-1.5">Color</p>
          <div className="flex gap-2">
            {COLOR_PRESETS.map((c) => (
              <button
                key={c}
                type="button"
                aria-label={`Color ${c}`}
                aria-pressed={color === c}
                onClick={() => setColor(c)}
                className={`w-8 h-8 rounded-[var(--radius)] press ${
                  color === c ? "ring-2 ring-offset-2 ring-offset-bg ring-fg" : ""
                }`}
                style={{ backgroundColor: c }}
              />
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <label className="text-sm">
            Start date
            <Input
              type="date"
              className="mt-1"
              value={startsOn}
              onChange={(e) => setStartsOn(e.target.value)}
            />
          </label>
          <label className="text-sm">
            End date
            <Input type="date" className="mt-1" value={endsOn} onChange={(e) => setEndsOn(e.target.value)} />
          </label>
        </div>

        <label className="flex items-center justify-between gap-3 text-sm pt-1">
          <span>
            Count in monthly budget
            <span className="block text-xs text-muted">
              Off by default, so project spend stays out of your 50/30/20.
            </span>
          </span>
          <Switch
            aria-label="Count in monthly budget"
            checked={countInMonthly}
            onChange={(e) => setCountInMonthly(e.target.checked)}
          />
        </label>

        {error && (
          <p role="alert" className="text-bad text-sm">
            {error}
          </p>
        )}

        <Button variant="primary" className="w-full" onClick={save} disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
    </SettingsPage>
  );
}
