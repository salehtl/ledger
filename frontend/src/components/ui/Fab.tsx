import type { LucideIcon } from "lucide-react";

/** Material floating action button, fixed above the bottom nav. */
export function Fab({ icon: Icon, label, onClick }: { icon: LucideIcon; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="fixed right-4 z-30 flex items-center justify-center w-14 h-14 rounded-lg bg-accent text-accent-fg shadow-1 hover:opacity-90 press bottom-[calc(env(safe-area-inset-bottom)+4.5rem)]"
    >
      <Icon size={24} aria-hidden />
    </button>
  );
}
