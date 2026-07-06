import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";
import { getAccounts, getJSON, getRates } from "../../api/client";
import type { AppSettings, BudgetConfig, Category, Rule } from "../../api/types";
import { Switch } from "../../components/ui/Switch";
import { SectionLabel } from "../../components/ui/SectionLabel";
import { Card } from "../../components/ui/Card";
import { loadSwipeConfig } from "../../lib/swipe";
import { loadFontScale } from "../../lib/fontScale";
import { useIngestHealth } from "../../hooks/useIngestHealth";
import { ingestStatusLabel } from "../../lib/ingestHealth";
import {
  fire,
  isHapticsEnabled,
  setHapticsEnabled,
  isSoundEnabled,
  setSoundEnabled,
} from "../../lib/feedback";
import {
  budgetSplitLabel,
  categorizationSummary,
  currenciesLabel,
  fontScaleLabel,
  swipeSummary,
} from "../../lib/settingsSummary";

export type SettingsPageId =
  | "budget"
  | "categorization"
  | "swipe"
  | "currencies"
  | "accounts"
  | "categories"
  | "rules"
  | "textsize"
  | "ingest";

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

/** An inline toggle row: label on the left, switch on the right. */
function ToggleRow({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="w-full flex items-center justify-between gap-3 px-4 py-3.5 text-sm font-medium cursor-pointer select-none">
      <span>{label}</span>
      <Switch checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}

/** Eyebrow-labeled group of rows. */
function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <SectionLabel as="h2" className="px-1">{label}</SectionLabel>
      <Card className="!p-0 divide-y divide-border overflow-hidden">
        {children}
      </Card>
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
  const health = useIngestHealth();
  const accounts = useQuery({ queryKey: ["accounts"], queryFn: getAccounts });
  const swipe = loadSwipeConfig();
  const [haptics, setHaptics] = useState(isHapticsEnabled());
  const [sound, setSound] = useState(isSoundEnabled());

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
        <HubRow
          label="Email ingest"
          value={health.data?.ingest ? ingestStatusLabel(health.data.ingest.status) : undefined}
          onClick={() => onOpen("ingest")}
        />
      </Group>

      <Group label="Device">
        <HubRow label="Text size" value={fontScaleLabel(loadFontScale())} onClick={() => onOpen("textsize")} />
        <ToggleRow
          label="Haptics"
          checked={haptics}
          onChange={(v) => {
            setHapticsEnabled(v);
            setHaptics(v);
            if (v) fire("selection"); // confirm with a tick when switching on
          }}
        />
        <ToggleRow
          label="Sound"
          checked={sound}
          onChange={(v) => {
            setSoundEnabled(v);
            setSound(v);
            if (v) fire("selection"); // let the user hear it immediately
          }}
        />
      </Group>

      <Group label="Library">
        <HubRow label="Categories" value={count(cats.data?.length)} onClick={() => onOpen("categories")} />
        <HubRow label="Rules" value={count(rules.data?.length)} onClick={() => onOpen("rules")} />
        <HubRow
          label="Currencies"
          value={rates.data?.rates ? currenciesLabel(rates.data) : undefined}
          onClick={() => onOpen("currencies")}
        />
        <HubRow
          label="Accounts & transfers"
          value={
            accounts.data && accounts.data.length > 0
              ? `${accounts.data.length} account${accounts.data.length === 1 ? "" : "s"}`
              : undefined
          }
          onClick={() => onOpen("accounts")}
        />
      </Group>

      <Group label="Danger zone">
        <HubRow label="Clear all categorization" tone="danger" onClick={onClear} />
      </Group>

      <p className="text-center text-xs text-muted pb-4">Icons by Lucide (ISC)</p>
    </div>
  );
}
