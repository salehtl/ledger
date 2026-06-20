import { type LucideIcon } from "lucide-react";
export function EmptyState({ icon: Icon, title, hint }: { icon?: LucideIcon; title: string; hint?: string }) {
  return (
    <div className="text-center py-10 px-4 text-muted">
      {Icon && (
        <div className="inline-flex items-center justify-center w-14 h-14 rounded-full bg-surface-2 text-muted mx-auto mb-3">
          <Icon size={28} aria-hidden />
        </div>
      )}
      <p className="font-semibold text-fg">{title}</p>
      {hint && <p className="text-sm mt-1">{hint}</p>}
    </div>
  );
}
