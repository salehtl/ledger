import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getJSON, postJSON } from "../../api/client";
import type { AppSettings } from "../../api/types";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { Card } from "../../components/ui/Card";
import { useToast } from "../../components/Toast";
import { Skeleton } from "../../components/Skeleton";
import { EmptyState } from "../../components/EmptyState";
import { AlertTriangle } from "../../components/ui/PixelIcon";
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
      // ai_spend_cap_musd was missing here, and changing the silence window
      // used to wipe the user's monthly AI spend cap as a side effect.
      await postJSON("/api/settings", {
        auto_categorize: s.auto_categorize, ai_enabled: s.ai_enabled,
        ai_auto_accept: s.ai_auto_accept, ai_threshold: s.ai_threshold,
        ingest_silence_days: days,
        ai_spend_cap_musd: s.ai_spend_cap_musd ?? 0,
      }, "PUT");
      qc.invalidateQueries({ queryKey: ["settings"] });
      qc.invalidateQueries({ queryKey: ["health"] });
      flash();
    } catch { show({ message: "Couldn't save settings", tone: "error" }); }
  };

  return (
    <SettingsPage title="Email ingest" onClose={onClose} headerRight={<SavedFlash saved={saved} />}>
      {health.isPending ? (
        <Skeleton rows={3} />
      ) : health.isError || !ih ? (
        // A bare `{ih && …}` guard rendered an empty body under the header,
        // which reads as "ingest is fine" rather than "this failed to load".
        <EmptyState
          icon={AlertTriangle}
          title="Couldn't load ingest health"
          hint="Check your connection and try again."
        />
      ) : (
        <>
          <Card className="space-y-1">
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
          </Card>

          <Card className="!py-2 divide-y divide-border">
            <FactRow label="Last email seen" value={relTime(ih.last_at, now)} />
            <FactRow label="Last successful check" value={relTime(ih.last_poll_success_at, now)} />
            <FactRow label="Last attempted check" value={relTime(ih.last_poll_attempt_at, now)} />
            {ih.consecutive_failures > 0 && (
              <FactRow label="Failed checks in a row" value={String(ih.consecutive_failures)} />
            )}
            {ih.last_error && (
              <p role="alert" className="text-bad text-xs py-2 break-words">{ih.last_error}</p>
            )}
          </Card>

          <section>
            <p className="text-sm mb-1">Warn when no email for</p>
            <p className="text-xs text-muted mb-3">
              Catches a broken auto-forward rule even when mailbox checks succeed.
            </p>
            {/* fullWidth, not a horizontal scroller: at 320px the scroller clipped
                the control at the viewport edge, and the clipped segment was the
                selected one. */}
            <SegmentedControl
              fullWidth
              value={String(s?.ingest_silence_days ?? ih.silence_days)}
              onChange={(v) => saveDays(Number(v))}
              options={DAY_OPTIONS}
            />
          </section>
        </>
      )}
    </SettingsPage>
  );
}
