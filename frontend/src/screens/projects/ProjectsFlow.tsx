import { useState } from "react";
import type { Project } from "../../api/types";
import { ProjectsScreen } from "./ProjectsScreen";
import { ProjectForm } from "./ProjectForm";
import { ProjectDetail } from "./ProjectDetail";
import { BulkBackfill } from "./BulkBackfill";

type View =
  | { kind: "list" }
  | { kind: "form"; project?: Project; from: "list" | "detail" }
  | { kind: "detail"; id: number }
  | { kind: "bulk"; id: number };

/**
 * Hosts the Projects list → form → detail → bulk-backfill navigation as a
 * full-screen overlay mounted at the AppShell level (not tied to the
 * Settings tab), so it can be opened either from the Settings hub's
 * "Projects" row (list) or from a project card on Home (deep-linked straight
 * into that project's detail via `initialProjectId`).
 *
 * Every page on the path to the current view stays mounted, stacked in DOM
 * order (each sub-screen is an opaque full-screen SettingsPage). That is what
 * makes back-navigation read correctly: the top page's slide-out reveals its
 * real parent already sitting underneath, instead of flashing the screen
 * below the whole flow and then sliding the parent in from the right.
 *
 * The form's `from` tag is what makes back-nav context-sensitive: "+ New
 * project" from the list returns to the list on save/cancel, while "Edit"
 * from a project's detail returns to that same detail (not the list).
 * Bulk-backfill always returns to the detail it was opened from.
 */
export function ProjectsFlow({
  initialProjectId,
  onClose,
}: {
  initialProjectId?: number;
  onClose: () => void;
}) {
  const [view, setView] = useState<View>(
    initialProjectId !== undefined ? { kind: "detail", id: initialProjectId } : { kind: "list" },
  );

  // The detail page is part of the stack for detail itself, bulk-backfill,
  // and an edit form opened from a detail.
  const detailId =
    view.kind === "detail" || view.kind === "bulk"
      ? view.id
      : view.kind === "form" && view.from === "detail" && view.project
        ? view.project.id
        : null;

  const formBack = () =>
    setView(
      view.kind === "form" && view.from === "detail" && view.project
        ? { kind: "detail", id: view.project.id }
        : { kind: "list" },
    );
  const bulkBack = () => setView(view.kind === "bulk" ? { kind: "detail", id: view.id } : { kind: "list" });

  return (
    <>
      <ProjectsScreen
        onClose={onClose}
        onNewProject={() => setView({ kind: "form", from: "list" })}
        onOpenProject={(id) => setView({ kind: "detail", id })}
      />
      {detailId !== null && (
        <ProjectDetail
          id={detailId}
          onClose={() => setView({ kind: "list" })}
          onEdit={(project) => setView({ kind: "form", project, from: "detail" })}
          onAddTransactions={() => setView({ kind: "bulk", id: detailId })}
        />
      )}
      {view.kind === "bulk" && <BulkBackfill id={view.id} onClose={bulkBack} onDone={bulkBack} />}
      {view.kind === "form" && <ProjectForm project={view.project} onClose={formBack} onSaved={formBack} />}
    </>
  );
}
