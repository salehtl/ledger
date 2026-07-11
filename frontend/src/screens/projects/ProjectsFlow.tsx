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
 * into that project's detail via `initialProjectId`). Each sub-screen is its
 * own full-screen SettingsPage, so the back arrow / edge-swipe unwinds one
 * level at a time.
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

  if (view.kind === "form") {
    const back = () =>
      setView(view.from === "detail" && view.project ? { kind: "detail", id: view.project.id } : { kind: "list" });
    return <ProjectForm project={view.project} onClose={back} onSaved={back} />;
  }
  if (view.kind === "bulk") {
    const backToDetail = () => setView({ kind: "detail", id: view.id });
    return <BulkBackfill id={view.id} onClose={backToDetail} onDone={backToDetail} />;
  }
  if (view.kind === "detail") {
    return (
      <ProjectDetail
        id={view.id}
        onClose={() => setView({ kind: "list" })}
        onEdit={(project) => setView({ kind: "form", project, from: "detail" })}
        onAddTransactions={() => setView({ kind: "bulk", id: view.id })}
      />
    );
  }
  return (
    <ProjectsScreen
      onClose={onClose}
      onNewProject={() => setView({ kind: "form", from: "list" })}
      onOpenProject={(id) => setView({ kind: "detail", id })}
    />
  );
}
