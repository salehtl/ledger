import { Icon, type IconName } from "./Icon";

export function EmptyState({ icon, title, hint }: { icon?: IconName; title: string; hint?: string }) {
  return (
    <div className="empty">
      {icon && <Icon name={icon} size={40} alt="" />}
      <p className="empty-title">{title}</p>
      {hint && <p className="empty-hint">{hint}</p>}
    </div>
  );
}
