import { TABS, type TabId } from "../../app/nav";

export function BottomNav({
  active, reviewCount, onNavigate,
}: { active: TabId; reviewCount: number; onNavigate: (id: TabId) => void }) {
  return (
    <nav className="fixed bottom-0 inset-x-0 z-30 bg-surface border-t border-border grid grid-cols-4 pb-[env(safe-area-inset-bottom)]">
      {TABS.map((t) => {
        const Icon = t.icon;
        const isActive = active === t.id;
        return (
          <button
            key={t.id}
            aria-label={t.id === "transactions" && reviewCount > 0 ? `Transactions, ${reviewCount} need review` : t.label}
            aria-current={isActive ? "page" : undefined}
            onClick={() => onNavigate(t.id)}
            className={`min-h-14 flex flex-col items-center justify-center gap-0.5 text-xs ${isActive ? "text-accent" : "text-muted"}`}
          >
            <span className="relative">
              <Icon size={22} aria-hidden />
              {t.id === "transactions" && reviewCount > 0 && (
                <span className="absolute -top-1.5 -right-2 min-w-4 h-4 px-1 rounded-full bg-bad text-white text-[10px] leading-4 text-center">
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
