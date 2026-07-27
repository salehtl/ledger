import { projectColor } from "../../lib/paletteColor";
import type { Project } from "../../api/types";
import { Card } from "../ui/Card";
import { ProgressBar } from "../ui/ProgressBar";
import { formatFils } from "../../lib/money";
import { isOverBudget, projectPctUsed, projectRemaining } from "../../lib/projectMath";

/**
 * Shared project summary tile: name + color dot, net spent, a budget bar +
 * remaining (or "spent · no budget" when the project has no budget), and a
 * pending sub-line when there's unconfirmed spend. Reused on the Projects
 * list (Task 8a) and Home (Task 9).
 */
export function ProjectCard({ project, onOpen }: { project: Project; onOpen: () => void }) {
  const { name, color, budget_fils, net_spent_fils, pending_fils } = project;
  const pct = projectPctUsed(budget_fils, net_spent_fils);
  const remaining = projectRemaining(budget_fils, net_spent_fils);
  const over = isOverBudget(budget_fils, net_spent_fils);

  return (
    <button type="button" onClick={onOpen} className="w-full text-left press">
      <Card className={`space-y-2 ${over ? "border border-bad/40" : ""}`}>
        <div className="flex items-center gap-2">
          {color && (
            <span aria-hidden className="w-2.5 h-2.5 rounded-[var(--radius)] shrink-0 border" style={{ borderColor: projectColor(color) }} />
          )}
          <span className="font-medium text-fg truncate flex-1">{name}</span>
          <span className={`tnum text-sm ${over ? "text-bad font-semibold" : "text-fg"}`}>
            {formatFils(net_spent_fils)}
          </span>
        </div>

        {budget_fils != null && pct != null ? (
          <div className="space-y-1">
            <ProgressBar pct={pct} label={`${name} budget used`} />
            <p className={`text-xs ${over ? "text-bad font-medium" : "text-muted"}`}>
              {over
                ? `${formatFils(Math.abs(remaining ?? 0))} over budget`
                : `${formatFils(remaining ?? 0)} remaining`}
            </p>
          </div>
        ) : (
          <p className="text-xs text-muted">spent · no budget</p>
        )}

        {pending_fils > 0 && <p className="text-xs text-muted">{formatFils(pending_fils)} pending</p>}
      </Card>
    </button>
  );
}
