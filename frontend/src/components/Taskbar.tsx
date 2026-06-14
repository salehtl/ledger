export type Tab = "dashboard" | "review" | "transactions";

export function Taskbar(props: {
  active: Tab;
  reviewCount: number;
  onMenu: () => void;
  onNavigate: (tab: Tab) => void;
}) {
  const tab = (id: Tab, label: string, badge?: number) => (
    <button
      className={props.active === id ? "tab-active" : ""}
      aria-pressed={props.active === id}
      onClick={() => props.onNavigate(id)}
    >
      {label}
      {badge ? <span className="badge">{badge}</span> : null}
    </button>
  );
  return (
    <nav className="taskbar">
      <button className="menu-btn" aria-label="menu" onClick={props.onMenu}>≡</button>
      {tab("dashboard", "Dashboard")}
      {tab("review", "Review", props.reviewCount)}
      {tab("transactions", "Transactions")}
    </nav>
  );
}
