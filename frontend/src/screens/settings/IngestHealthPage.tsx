import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getJSON, postJSON } from "../../api/client";
import type { AppSettings } from "../../api/types";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { useToast } from "../../components/Toast";
import { SettingsPage } from "./SettingsPage";
import { SavedFlash, useSavedFlash } from "./SavedFlash";
import { useIngestHealth } from "../../hooks/useIngestHealth";
import { ingestStatusLabel, reasonText, relTime } from "../../lib/ingestHealth";

const DAY_OPTIONS = [1, 2, 3, 5, 7, 14].map((n) => ({ value: String(n), label: `${n}d` }));

function FactRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 text-sm py-2">
      <span className="text-muted">{label}</span>
      <span className="text-right tnum">{value}</span>
    </div>
  );
}

export function IngestHealthPage({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const { show } = useToast();
  const { saved, flash } = useSavedFlash();
  const health = useIngestHealth();
  const settings = useQuery({ queryKey: ["settings"], queryFn: () => getJSON<AppSettings>("/api/settings") });

  const ih = health.data?.ingest;
  const s = settings.data;
  const now = new Date();

  const saveDays = async (days: number) => {
    if (!s) return;
    try {
      // Send every writable field — a partial PUT would clobber the rest.
      await postJSON("/api/settings", {
        auto_categorize: s.auto_categorize, ai_enabled: s.ai_enabled,
        ai_auto_accept: s.ai_auto_accept, ai_threshold: s.ai_threshold,
        ingest_silence_days: days,
      }, "PUT");
      qc.invalidateQueries({ queryKey: ["settings"] });
      qc.invalidateQueries({ queryKey: ["health"] });
      flash();
    } catch { show({ message: "Couldn't save settings", tone: "error" }); }
  };

  return (
    <SettingsPage title="Email ingest" onClose={onClose} headerRight={<SavedFlash saved={saved} />}>
      {ih && (
        <>
          <section className="bg-surface rounded-[var(--radius-card)] shadow-1 p-4 space-y-1">
            <p className="text-sm font-semibold">{ingestStatusLabel(ih.status)}</p>
            {ih.status === "warn" && ih.reasons.map((r) => (
              <p key={r} className="text-xs text-warn">{reasonText(r, ih)}</p>
            ))}
            {ih.status === "ok" && (
              <p className="text-xs text-muted">Mailbox checks are running and mail is arriving.</p>
            )}
            {ih.status === "starting" && (
              <p className="text-xs text-muted">The mailbox worker just started — first check pending.</p>
            )}
            {ih.status === "off" && (
              <p className="text-xs text-muted">No IMAP mailbox is configured.</p>
            )}
          </section>

          <section className="bg-surface rounded-[var(--radius-card)] shadow-1 px-4 py-2 divide-y divide-border">
            <FactRow label="Last email seen" value={relTime(ih.last_at, now)} />
            <FactRow label="Last successful check" value={relTime(ih.last_poll_success_at, now)} />
            <FactRow label="Last attempted check" value={relTime(ih.last_poll_attempt_at, now)} />
            {ih.consecutive_failures > 0 && (
              <FactRow label="Failed checks in a row" value={String(ih.consecutive_failures)} />
            )}
            {ih.last_error && (
              <p role="alert" className="text-bad text-xs py-2 break-words">{ih.last_error}</p>
            )}
          </section>

          <section>
            <p className="text-sm mb-1">Warn when no email for</p>
            <p className="text-xs text-muted mb-3">
              Catches a broken auto-forward rule even when mailbox checks succeed.
            </p>
            <div className="overflow-x-auto -mx-1 px-1">
              <SegmentedControl
                value={String(s?.ingest_silence_days ?? ih.silence_days)}
                onChange={(v) => saveDays(Number(v))}
                options={DAY_OPTIONS}
              />
            </div>
          </section>
        </>
      )}
    </SettingsPage>
  );
}
