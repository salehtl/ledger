import { TABS, type TabId } from "../../app/nav";

export function BottomNav({
  active, reviewCount, onNavigate,
}: { active: TabId; reviewCount: number; onNavigate: (id: TabId) => void }) {
  return (
    <nav className="shrink-0 bg-surface grid grid-cols-5 pb-[env(safe-area-inset-bottom)]">
      {TABS.map((t) => {
        const Icon = t.icon;
        const isActive = active === t.id;
        return (
          <button
            key={t.id}
            aria-label={t.id === "review" && reviewCount > 0 ? `Review, ${reviewCount} need review` : t.label}
            aria-current={isActive ? "page" : undefined}
            onClick={() => onNavigate(t.id)}
            className={`min-h-14 flex flex-col items-center justify-center gap-1 text-xs ${isActive ? "text-accent font-medium" : "text-muted"}`}
          >
            <span className="relative">
              {/* Material active-indicator pill behind the icon */}
              <span className={`flex items-center justify-center w-14 h-8 rounded-full transition-colors ${isActive ? "bg-accent/10" : ""}`}>
                <Icon size={22} aria-hidden />
              </span>
              {t.id === "review" && reviewCount > 0 && (
                <span className="absolute -top-0.5 right-1.5 min-w-4 h-4 px-1 rounded-full bg-bad text-bg text-[10px] leading-4 text-center">
                  {reviewCount}
                </span>
              )}
            </span>
            {t.label}
          </button>
        );
      })}
    </nav>
  );
}
