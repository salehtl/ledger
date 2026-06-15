import { type LucideIcon } from "lucide-react";
export function EmptyState({ icon: Icon, title, hint }: { icon?: LucideIcon; title: string; hint?: string }) {
  return (
    <div className="text-center py-10 px-4 text-muted">
      {Icon && <Icon className="mx-auto mb-2" size={36} aria-hidden />}
      <p className="font-semibold text-fg">{title}</p>
      {hint && <p className="text-sm mt-1">{hint}</p>}
    </div>
  );
}
