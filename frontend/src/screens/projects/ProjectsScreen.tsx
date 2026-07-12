import { useQuery } from "@tanstack/react-query";
import { FolderKanban } from "lucide-react";
import { getProjects } from "../../api/client";
import { Button } from "../../components/ui/Button";
import { SectionLabel } from "../../components/ui/SectionLabel";
import { EmptyState } from "../../components/EmptyState";
import { ProjectCard } from "../../components/projects/ProjectCard";
import { SettingsPage } from "../settings/SettingsPage";

/** Projects list drill-in: an Active section and a Completed section, both
 *  drawn from the same `["projects", "all"]` query (include_completed=1) so the
 *  cache stays consistent with the Settings hub badge and the form's
 *  post-save invalidation (which invalidates the `["projects"]` prefix, so
 *  this sub-key refreshes too). Kept separate from the active-only
 *  `["projects", "active"]` key Home uses, since the two fetches return
 *  different result sets and must not collide in the cache. */
export function ProjectsScreen({
  onClose,
  onNewProject,
  onOpenProject,
}: {
  onClose: () => void;
  onNewProject: () => void;
  onOpenProject: (id: number) => void;
}) {
  const projects = useQuery({ queryKey: ["projects", "all"], queryFn: () => getProjects(true) });
  const all = projects.data ?? [];
  const active = all.filter((p) => p.status === "active");
  const completed = all.filter((p) => p.status === "completed");

  return (
    <SettingsPage title="Projects" onClose={onClose}>
      <div className="space-y-6">
        <Button variant="secondary" className="w-full" onClick={onNewProject}>
          + New project
        </Button>

        {projects.data && all.length === 0 && (
          <EmptyState
            icon={FolderKanban}
            title="No projects yet"
            hint="Create one to track spend against its own budget, separate from your monthly plan."
          />
        )}

        {active.length > 0 && (
          <section className="space-y-2">
            <SectionLabel as="h2" className="px-1">Active</SectionLabel>
            <div className="space-y-3">
              {active.map((p) => (
                <ProjectCard key={p.id} project={p} onOpen={() => onOpenProject(p.id)} />
              ))}
            </div>
          </section>
        )}

        {completed.length > 0 && (
          <section className="space-y-2">
            <SectionLabel as="h2" className="px-1">Completed</SectionLabel>
            <div className="space-y-3">
              {completed.map((p) => (
                <ProjectCard key={p.id} project={p} onOpen={() => onOpenProject(p.id)} />
              ))}
            </div>
          </section>
        )}
      </div>
    </SettingsPage>
  );
}
