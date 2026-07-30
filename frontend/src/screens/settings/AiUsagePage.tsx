import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getJSON, postJSON, getAIUsage } from "../../api/client";
import type { AppSettings } from "../../api/types";
import { Switch } from "../../components/ui/Switch";
import { Card } from "../../components/ui/Card";
import { SectionLabel } from "../../components/ui/SectionLabel";
import { Button } from "../../components/ui/Button";
import { Input } from "../../components/ui/Field";
import { useToast } from "../../components/Toast";
import { Skeleton } from "../../components/Skeleton";
import { EmptyState } from "../../components/EmptyState";
import { AlertTriangle } from "../../components/ui/PixelIcon";
import { SettingsPage } from "./SettingsPage";
import { SavedFlash, useSavedFlash } from "./SavedFlash";
import { formatMuUSD, dollarsToMuUSD, muUSDToDollars } from "../../lib/aiCost";

export function AiUsagePage({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const { show } = useToast();
  const { saved, flash } = useSavedFlash();
  const settings = useQuery({ queryKey: ["settings"], queryFn: () => getJSON<AppSettings>("/api/settings") });
  const usage = useQuery({ queryKey: ["ai-usage"], queryFn: getAIUsage });
  const s = settings.data;
  const [capInput, setCapInput] = useState<string>("");

  const save = async (next: AppSettings) => {
    try {
      await postJSON("/api/settings", {
        auto_categorize: next.auto_categorize, ai_enabled: next.ai_enabled,
        ai_auto_accept: next.ai_auto_accept, ai_threshold: next.ai_threshold,
        ingest_silence_days: next.ingest_silence_days,
        ai_spend_cap_musd: next.ai_spend_cap_musd ?? 0,
      }, "PUT");
      qc.invalidateQueries({ queryKey: ["settings"] });
      qc.invalidateQueries({ queryKey: ["ai-usage"] });
      flash();
    } catch { show({ message: "Couldn't save settings", tone: "error" }); }
  };

  const capDollars = s?.ai_spend_cap_musd ? muUSDToDollars(s.ai_spend_cap_musd) : 0;

  return (
    <SettingsPage title="AI & API usage" onClose={onClose} headerRight={<SavedFlash saved={saved} />}>
      {settings.isPending ? (
        <Skeleton rows={3} />
      ) : settings.isError || !s ? (
        // A bare `{s && …}` guard renders the page as an empty body under the
        // header — indistinguishable from a screen with nothing on it.
        <EmptyState icon={AlertTriangle} title="Couldn't load AI settings" hint="Check your connection and try again." />
      ) : (
        <>
          <section className="space-y-1">
            <label className="flex items-center justify-between gap-3 text-sm py-2">
              <span>
                AI features
                <span className="block text-xs text-muted">
                  {s.ai_key_present
                    ? "When off, the app makes zero calls to Anthropic."
                    : "Add an Anthropic API key to the env file and restart to turn this on."}
                </span>
              </span>
              {/* Without a key this switch turns on, saves, and changes
                  nothing — every AI call is refused at the gate. Disable it and
                  say why rather than offering a control that does nothing. */}
              <Switch aria-label="AI features"
                disabled={!s.ai_key_present}
                checked={s.ai_enabled}
                onChange={(e) => save({ ...s, ai_enabled: e.target.checked })} />
            </label>
            <div className="flex items-center justify-between gap-3 pt-1">
              <span className="text-sm">Anthropic API key</span>
              {s.ai_key_present
                ? <span className="text-xs font-medium text-good">Loaded</span>
                : <span className="text-xs text-muted text-right">Not set · add LEDGER_AI_API_KEY to the env file and restart</span>}
            </div>
          </section>

          {s.ai_cap_latched && (
            <Card className="border border-bad/40">
              <p role="alert" className="text-sm text-bad">
                AI auto-disabled — you hit your monthly spend cap. Turn <strong>AI features</strong> back on to resume.
              </p>
            </Card>
          )}

          <section className="space-y-2">
            <SectionLabel as="h2" className="px-1">Usage</SectionLabel>
            <Card>
              <div className="flex items-center justify-between text-sm">
                <span>Last 30 days</span>
                <span className="tnum">{usage.data?.count_30d ?? 0} calls · <span>{usage.data ? formatMuUSD(usage.data.cost_30d_musd) : "—"}</span></span>
              </div>
              <div className="flex items-center justify-between text-sm mt-1 text-muted">
                <span>All time</span>
                <span className="tnum">{usage.data?.count_all ?? 0} calls · <span>{usage.data ? formatMuUSD(usage.data.cost_all_musd) : "—"}</span></span>
              </div>
            </Card>
          </section>

          <section className="space-y-2">
            <SectionLabel as="h2" className="px-1">Monthly spend cap</SectionLabel>
            <Card>
              <div className="flex items-center gap-2">
                <span className="text-sm">$</span>
                <Input
                  type="number" inputMode="decimal" min="0" step="1"
                  aria-label="Monthly spend cap in dollars"
                  className="flex-1"
                  placeholder={capDollars ? String(capDollars) : "No cap"}
                  value={capInput}
                  onChange={(e) => setCapInput(e.target.value)} />
                <Button variant="secondary" disabled={capInput.trim() === ""} onClick={() => {
                  if (capInput.trim() === "") return; // empty field is a no-op — never silently clears the cap
                  const d = parseFloat(capInput);
                  if (isNaN(d) || d < 0) return;
                  save({ ...s, ai_spend_cap_musd: d === 0 ? 0 : dollarsToMuUSD(d) });
                  setCapInput("");
                }}>Save</Button>
              </div>
              <p className="text-xs text-muted mt-1.5">
                {capDollars > 0
                  ? `At $${capDollars}/month spent, AI auto-disables until you turn it back on. Enter 0 to remove the cap.`
                  : "No cap set. Enter a dollar amount to auto-disable AI when monthly spend crosses it."}
              </p>
            </Card>
          </section>

          <section className="space-y-2">
            <SectionLabel as="h2" className="px-1">Recent calls</SectionLabel>
            <Card className="!p-0 divide-y divide-border overflow-hidden">
              {(usage.data?.recent ?? []).length === 0 && (
                <p className="text-xs text-muted px-4 py-3">No API calls recorded.</p>
              )}
              {(usage.data?.recent ?? []).map((row, i) => (
                <div key={i} className="flex items-center justify-between gap-2 px-4 py-2.5 text-xs">
                  <span className="flex items-center gap-2 min-w-0">
                    <span className={`shrink-0 rounded-[var(--radius)] px-1.5 py-0.5 ${row.path === "extract" ? "bg-surface-2 text-muted" : "bg-surface-2 text-fg"}`}>{row.path}</span>
                    <span className="truncate text-muted">{row.detail || row.model}</span>
                  </span>
                  <span className="tnum text-right shrink-0">
                    {row.input_tokens}/{row.output_tokens} tok · {formatMuUSD(row.cost_musd)}
                  </span>
                </div>
              ))}
            </Card>
          </section>
        </>
      )}
    </SettingsPage>
  );
}
