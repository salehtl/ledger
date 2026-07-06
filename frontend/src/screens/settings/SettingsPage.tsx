import type { ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import { IconButton } from "../../components/ui/IconButton";

/**
 * Shared full-screen drill-in shell for a Settings subpage. Matches the
 * CategoryManager / RulesManager panel: a back-arrow header over a scrolling
 * body. `headerRight` hosts the page's autosave feedback.
 */
export function SettingsPage({
  title,
  onClose,
  headerRight,
  children,
}: {
  title: string;
  onClose: () => void;
  headerRight?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-40 bg-bg flex flex-col">
      <header className="flex items-center gap-3 px-4 pt-4 pb-3 border-b border-border">
        <IconButton label={`Back from ${title}`} className="-ml-2" onClick={onClose}>
          <ArrowLeft size={20} />
        </IconButton>
        <h1 className="flex-1 text-lg font-semibold text-fg">{title}</h1>
        {headerRight}
      </header>
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-6 max-w-screen-sm w-full mx-auto">
        {children}
      </div>
    </div>
  );
}
