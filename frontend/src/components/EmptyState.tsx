import { type LucideIcon } from "lucide-react";
// icon accepts a LucideIcon component (new screens) or a legacy string (old views, removed in Phase F).
export function EmptyState({ icon: Icon, title, hint }: { icon?: LucideIcon | string; title: string; hint?: string }) {
  const isComponent = typeof Icon === "function";
  return (
    <div className="text-center py-10 px-4 text-muted">
      {isComponent && <Icon className="mx-auto mb-2" size={36} aria-hidden />}
      <p className="font-semibold text-fg">{title}</p>
      {hint && <p className="text-sm mt-1">{hint}</p>}
    </div>
  );
}
