import { TABS, type TabId } from "../../app/nav";
import { fire } from "../../lib/feedback";
import { Pressable } from "./Pressable";

export function BottomNav({
  active, reviewCount, onNavigate,
}: { active: TabId; reviewCount: number; onNavigate: (id: TabId) => void }) {
  return (
    // The column count comes from {@link TABS}, not a `grid-cols-N` literal:
    // Tailwind cannot build a class name at runtime, and the literal that was
    // here (`grid-cols-5`) silently left two dead cells the moment the nav was
    // trimmed to three. An inline `gridTemplateColumns` is the one place in the
    // chrome where a computed value beats a token.
    <nav
      style={{ gridTemplateColumns: `repeat(${TABS.length}, minmax(0, 1fr))` }}
      className="shrink-0 grid bg-bg border-t border-border pb-[env(safe-area-inset-bottom)]"
    >
      {TABS.map((t) => {
        const Icon = t.icon;
        const isActive = active === t.id;
        return (
          <Pressable
            key={t.id}
            aria-label={t.id === "review" && reviewCount > 0 ? `Review, ${reviewCount} need review` : t.label}
            aria-current={isActive ? "page" : undefined}
            onClick={() => { fire("navigation"); onNavigate(t.id); }}
            className={`relative min-h-14 flex flex-col items-center justify-center gap-1 font-mono text-[8px] uppercase tracking-[0.1em] ${isActive ? "text-fg font-medium" : "text-muted"}`}
          >
            {/* The active mark: a 2px spot tick on the top rule. */}
            {isActive && (
              <span data-active-tick aria-hidden className="absolute top-0 left-1/2 h-0.5 w-6 -translate-x-1/2 bg-accent" />
            )}
            <span className="relative">
              <span className="flex items-center justify-center w-14 h-8">
                <Icon size={22} aria-hidden />
              </span>
              {t.id === "review" && reviewCount > 0 && (
                <span className="absolute -top-0.5 right-1.5 min-w-4 h-4 px-1 rounded-[var(--radius)] bg-accent text-accent-fg text-[10px] leading-4 text-center">
                  {reviewCount}
                </span>
              )}
            </span>
            {t.label}
          </Pressable>
        );
      })}
    </nav>
  );
}
