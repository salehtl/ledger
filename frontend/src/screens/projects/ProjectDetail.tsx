import { useQuery } from "@tanstack/react-query";
import { getProject } from "../../api/client";
import { SettingsPage } from "../settings/SettingsPage";

/**
 * Placeholder detail screen (Task 8a). Task 8b replaces this with the full
 * project detail: category breakdown, assigned transactions, bulk
 * backfill/unassign, and delete. For now it just proves the list → detail
 * navigation and back-out work.
 */
export function ProjectDetail({ id, onClose }: { id: number; onClose: () => void }) {
  const project = useQuery({ queryKey: ["projects", id], queryFn: () => getProject(id) });

  return (
    <SettingsPage title={project.data?.name ?? "Project"} onClose={onClose}>
      <p className="text-sm text-muted">Project detail coming soon.</p>
    </SettingsPage>
  );
}
