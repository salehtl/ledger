import { useState } from "react";
import type { Project } from "../../api/types";
import { ProjectsScreen } from "./ProjectsScreen";
import { ProjectForm } from "./ProjectForm";
import { ProjectDetail } from "./ProjectDetail";

type View = { kind: "list" } | { kind: "form"; project?: Project } | { kind: "detail"; id: number };

/**
 * Hosts the Projects list → form → detail navigation behind the Settings
 * hub's "Projects" row. Each sub-screen is its own full-screen SettingsPage,
 * so the back arrow / edge-swipe unwinds one level at a time: form/detail
 * close back to the list, and the list's onClose (passed in) returns to the
 * Settings hub.
 */
export function ProjectsFlow({ onClose }: { onClose: () => void }) {
  const [view, setView] = useState<View>({ kind: "list" });

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
