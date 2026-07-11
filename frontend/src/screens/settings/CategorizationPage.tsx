import { useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getJSON, postJSON } from "../../api/client";
import type { AppSettings, CategorizeStatus } from "../../api/types";
import { type Scope, scopeBounds, scopeLabel, DEFAULT_SCOPE } from "../../lib/scope";
import { PeriodSheet } from "../../components/ui/PeriodSheet";
import { Button } from "../../components/ui/Button";
import { Switch } from "../../components/ui/Switch";
import { SectionLabel } from "../../components/ui/SectionLabel";
import { Card } from "../../components/ui/Card";
import { useToast } from "../../components/Toast";
import { SettingsPage } from "./SettingsPage";
import { SavedFlash, useSavedFlash } from "./SavedFlash";

/** Setting row: label + explanation on the left, a control on the right. */
function ToggleRow({ title, hint, children }: { title: string; hint: string; children: ReactNode }) {
  return (
    <label className="flex items-center justify-between gap-3 text-sm py-2">
      <span>
        {title}
        <span className="block text-xs text-muted">{hint}</span>
      </span>
      {children}
    </label>
  );
}

export function CategorizationPage({ scope, onClose }: { scope?: Scope; onClose: () => void }) {
  const qc = useQueryClient();
  const { show } = useToast();
  const { saved, flash } = useSavedFlash();
  const settings = useQuery({ queryKey: ["settings"], queryFn: () => getJSON<AppSettings>("/api/settings") });
  const catStatus = useQuery({ queryKey: ["categorize-status"], queryFn: () => getJSON<CategorizeStatus>("/api/categorize/status") });
  const [runScope, setRunScope] = useState<Scope>(() => scope ?? DEFAULT_SCOPE);
  const [periodOpen, setPeriodOpen] = useState(false);

  const saveSettings = async (next: AppSettings) => {
    try {
      // Send only the writable fields — ai_key_present is read-only (env-only).
      await postJSON("/api/settings", {
        auto_categorize: next.auto_categorize, ai_enabled: next.ai_enabled,
        ai_auto_accept: next.ai_auto_accept, ai_threshold: next.ai_threshold,
        ingest_silence_days: next.ingest_silence_days,
      }, "PUT");
      qc.invalidateQueries({ queryKey: ["settings"] });
      flash();
    } catch { show({ message: "Couldn't save settings", tone: "error" }); }
  };

  const running = catStatus.data?.status === "running";

  // The manual run is a no-op when auto-categorize is off (the categorizer isn't
  // built), and the AI tier fails on every merchant when AI is on but no API key
  // is loaded. In both cases there's nothing useful to do, so Run is disabled
  // with a reason. Rules-only runs (AI off) still work without a key.
  const aiNeedsKey = !!settings.data?.ai_enabled && !settings.data?.ai_key_present;
  const runDisabled = !settings.data?.auto_categorize || aiNeedsKey;
  const runDisabledReason = !settings.data?.auto_categorize
    ? "Turn on Auto-categorize to run categorization."
    : aiNeedsKey
      ? "AI suggestions need the Anthropic API key — add LEDGER_AI_API_KEY to the env file and restart."
      : "";

  const runCategorization = async () => {
    const b = scopeBounds(runScope);
    try {
      await postJSON("/api/categorize/run", { from: b.from ?? "", to: b.to ?? "" });
      qc.invalidateQueries({ queryKey: ["categorize-status"] });
    } catch { show({ message: "Couldn't start categorization", tone: "error" }); }
  };

  const stopCategorization = async () => {
    try {
      await postJSON("/api/categorize/stop", {});
      qc.invalidateQueries({ queryKey: ["categorize-status"] });
    } catch { show({ message: "Couldn't stop categorization", tone: "error" }); }
  };

  const s = settings.data;

  return (
    <SettingsPage title="Categorization" onClose={onClose} headerRight={<SavedFlash saved={saved} />}>
      {s && (
        <>
          <section className="space-y-1">
            <ToggleRow title="Auto-categorize new transactions" hint="Off = everything waits in Needs review for you to categorize.">
              <Switch aria-label="Auto-categorize"
                checked={s.auto_categorize}
                onChange={(e) => saveSettings({ ...s, auto_categorize: e.target.checked })} />
            </ToggleRow>
            <ToggleRow title="AI features (master switch)" hint="Off = zero calls to Anthropic. Manage usage & spend cap under AI & API usage.">
              <Switch aria-label="AI features"
                checked={s.ai_enabled}
                onChange={(e) => saveSettings({ ...s, ai_enabled: e.target.checked })} />
            </ToggleRow>
            <ToggleRow title="AI auto-accept" hint="Auto-confirm confident AI suggestions instead of just suggesting.">
              <Switch aria-label="AI auto-accept"
                disabled={!s.ai_enabled}
                checked={s.ai_auto_accept}
                onChange={(e) => saveSettings({ ...s, ai_auto_accept: e.target.checked })} />
            </ToggleRow>
            <div className="flex items-center justify-between gap-3 pt-2">
              <span className="text-sm">Anthropic API key</span>
              {s.ai_key_present
                ? <span className="text-xs font-medium text-good">Loaded</span>
                : <span className="text-xs text-muted text-right">Not set · add LEDGER_AI_API_KEY to the env file and restart</span>}
            </div>
          </section>

          <section className="space-y-2">
            <SectionLabel as="h2" className="px-1">Run now</SectionLabel>
            <Card>
              {running ? (
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm tnum">{catStatus.data!.processed} of {catStatus.data!.total} categorized</span>
                  <Button variant="secondary" onClick={stopCategorization}>Stop</Button>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <Button variant="secondary" onClick={() => setPeriodOpen(true)}>{scopeLabel(runScope)}</Button>
                  <Button variant="primary" onClick={runCategorization} disabled={runDisabled}>Run</Button>
                </div>
              )}
              <p className="text-xs text-muted mt-1.5">
                {runDisabled && !running
                  ? runDisabledReason
                  : `Categorizes Needs review for ${scopeLabel(runScope)} (${s.ai_enabled ? "rules + AI" : "rules"}).`}
              </p>
              {catStatus.data && (catStatus.data.failed > 0 || catStatus.data.error) && (
                <p role="alert" className="text-bad text-xs mt-2">
                  {catStatus.data.failed > 0
                    ? `${catStatus.data.failed} ${catStatus.data.failed === 1 ? "transaction" : "transactions"} couldn’t be categorized`
                    : "Categorization ran into a problem"}
                  {catStatus.data.error ? ` — ${catStatus.data.error}` : ""}
                </p>
              )}
            </Card>
          </section>

          {periodOpen && (
            <PeriodSheet
              scope={runScope}
              onApply={(sc) => { setRunScope(sc); setPeriodOpen(false); }}
              onClose={() => setPeriodOpen(false)}
            />
          )}
        </>
      )}
    </SettingsPage>
  );
}
