import { useQuery } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";
import { getJSON, getRates } from "../../api/client";
import type { AppSettings, BudgetConfig, Category, Rule } from "../../api/types";
import { loadSwipeConfig } from "../../lib/swipe";
import {
  budgetSplitLabel,
  categorizationSummary,
  currenciesLabel,
  swipeSummary,
} from "../../lib/settingsSummary";

export type SettingsPageId =
  | "budget"
  | "categorization"
  | "swipe"
  | "currencies"
  | "categories"
  | "rules";

/** A drill-in row: label on the left, current-state preview + chevron on the right. */
function HubRow({
  label,
  value,
  tone = "default",
  onClick,
}: {
  label: string;
  value?: string;
  tone?: "default" | "danger";
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center justify-between gap-3 px-4 py-3.5 text-sm font-medium text-left press hover:bg-surface-2/50"
    >
      <span className={tone === "danger" ? "text-bad" : undefined}>{label}</span>
      <span className="flex items-center gap-2 text-muted min-w-0">
        {value !== undefined && <span className="truncate text-xs">{value}</span>}
        <ChevronRight size={16} aria-hidden className="shrink-0" />
      </span>
    </button>
  );
}

/** Eyebrow-labeled group of rows. */
function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h2 className="px-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">{label}</h2>
      <div className="bg-surface rounded-[var(--radius-card)] shadow-1 divide-y divide-border overflow-hidden">
        {children}
      </div>
    </section>
  );
}

export function SettingsHub({
  onOpen,
  onClear,
}: {
  onOpen: (page: SettingsPageId) => void;
  onClear: () => void;
}) {
  const budget = useQuery({ queryKey: ["budget"], queryFn: () => getJSON<BudgetConfig>("/api/budget") });
  const settings = useQuery({ queryKey: ["settings"], queryFn: () => getJSON<AppSettings>("/api/settings") });
  const cats = useQuery({ queryKey: ["categories"], queryFn: () => getJSON<Category[]>("/api/categories") });
  const rules = useQuery({ queryKey: ["rules"], queryFn: () => getJSON<Rule[]>("/api/rules") });
  const rates = useQuery({ queryKey: ["rates"], queryFn: getRates });
  const swipe = loadSwipeConfig();

  const count = (n?: number) => (n === undefined ? undefined : String(n));

  return (
    <div className="space-y-6">
      <Group label="Plan">
        <HubRow
          label="Budget & income"
          value={budget.data ? budgetSplitLabel(budget.data) : undefined}
          onClick={() => onOpen("budget")}
        />
      </Group>

      <Group label="Automation">
        <HubRow
          label="Categorization"
          value={settings.data ? categorizationSummary(settings.data) : undefined}
          onClick={() => onOpen("categorization")}
        />
        <HubRow label="Swipe actions" value={swipeSummary(swipe)} onClick={() => onOpen("swipe")} />
      </Group>

      <Group label="Library">
        <HubRow label="Categories" value={count(cats.data?.length)} onClick={() => onOpen("categories")} />
        <HubRow label="Rules" value={count(rules.data?.length)} onClick={() => onOpen("rules")} />
        <HubRow
          label="Currencies"
          value={rates.data?.rates ? currenciesLabel(rates.data) : undefined}
          onClick={() => onOpen("currencies")}
        />
      </Group>

      <Group label="Danger zone">
        <HubRow label="Clear all categorization" tone="danger" onClick={onClear} />
      </Group>

      <p className="text-center text-xs text-muted pb-4">Icons by Lucide (ISC)</p>
    </div>
  );
}
