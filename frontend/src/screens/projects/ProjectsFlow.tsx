import { useState } from "react";
import type { Project } from "../../api/types";
import { ProjectsScreen } from "./ProjectsScreen";
import { ProjectForm } from "./ProjectForm";
import { ProjectDetail } from "./ProjectDetail";

type View = { kind: "list" } | { kind: "form"; project?: Project } | { kind: "detail"; id: number };

/**
 * Hosts the Projects list → form → detail navigation as a full-screen overlay
 * mounted at the AppShell level (not tied to the Settings tab), so it can be
 * opened either from the Settings hub's "Projects" row (list) or from a
 * project card on Home (deep-linked straight into that project's detail via
 * `initialProjectId`). Each sub-screen is its own full-screen SettingsPage,
 * so the back arrow / edge-swipe unwinds one level at a time: form/detail
 * close back to the list, and the list's onClose (passed in) unmounts the
 * whole overlay.
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
    return (
      <ProjectForm
        project={view.project}
        onClose={() => setView({ kind: "list" })}
        onSaved={() => setView({ kind: "list" })}
      />
    );
  }
  if (view.kind === "detail") {
    return <ProjectDetail id={view.id} onClose={() => setView({ kind: "list" })} />;
  }
  return (
    <ProjectsScreen
      onClose={onClose}
      onNewProject={() => setView({ kind: "form" })}
      onOpenProject={(id) => setView({ kind: "detail", id })}
    />
  );
}
