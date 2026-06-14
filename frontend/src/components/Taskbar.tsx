import { Icon, type IconName } from "./Icon";

export type Tab = "dashboard" | "review" | "transactions";

const TABS: { id: Tab; label: string; icon: IconName }[] = [
  { id: "dashboard", label: "Dashboard", icon: "chart" },
  { id: "review", label: "Review", icon: "flag" },
  { id: "transactions", label: "History", icon: "table" },
];

export function Taskbar(props: {
  active: Tab;
  reviewCount: number;
  onMenu: () => void;
  onNavigate: (tab: Tab) => void;
}) {
  return (
    <nav className="taskbar">
      <button className="menu-btn" aria-label="menu" onClick={props.onMenu}>
        <Icon name="gear" alt="" />
        <span className="tab-label">Settings</span>
      </button>
      {TABS.map((t) => (
        <button
          key={t.id}
          className={props.active === t.id ? "tab-active" : ""}
          aria-pressed={props.active === t.id}
          aria-label={t.label}
          onClick={() => props.onNavigate(t.id)}
        >
          <span className="tab-icon">
            <Icon name={t.icon} alt="" />
            {t.id === "review" && props.reviewCount ? <span className="badge">{props.reviewCount}</span> : null}
          </span>
          <span className="tab-label">{t.label}</span>
        </button>
      ))}
    </nav>
  );
}
