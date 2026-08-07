import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getJSON, postJSON } from "../../api/client";
import { Switch } from "../../components/ui/Switch";
import { Select } from "../../components/ui/Field";
import { Skeleton } from "../../components/Skeleton";
import { useToast } from "../../components/Toast";
import { SettingsPage } from "./SettingsPage";
import { SavedFlash, useSavedFlash } from "./SavedFlash";
import { PushSection } from "./PushSection";

type NotifySettings = { notify_thresholds: boolean; notify_upcoming_days: number };

const UPCOMING_CHOICES = [0, 1, 2, 3, 5, 7, 14] as const;

/**
 * Settings → Notifications: the two push gates from the v3 contract.
 * Threshold pushes fire when an envelope or bucket crosses 80%/100%;
 * the upcoming-days window gates upcoming-, missed- and detected-bill
 * pushes together (0 = off). Autosaves per change like the other pages.
 */
export function NotificationsPage({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const { show } = useToast();
  const { saved, flash } = useSavedFlash();
  const q = useQuery({
    queryKey: ["settings-notifications"],
    queryFn: () => getJSON<NotifySettings>("/api/settings/notifications"),
  });

  const commit = async (next: NotifySettings) => {
    qc.setQueryData(["settings-notifications"], next);
    try {
      await postJSON("/api/settings/notifications", next, "PUT");
      flash();
    } catch {
      show({ message: "Couldn't save notification settings", tone: "error" });
      qc.invalidateQueries({ queryKey: ["settings-notifications"] });
    }
  };

  const s = q.data;

  return (
    <SettingsPage title="Notifications" onClose={onClose} headerRight={<SavedFlash saved={saved} />}>
      {q.isPending ? (
        <Skeleton rows={2} />
      ) : q.isError || !s ? (
        <p className="text-sm text-muted">Couldn't load notification settings. Pull down to retry.</p>
      ) : (
        <>
          <PushSection />

          <div className="flex items-center justify-between gap-3 min-h-11">
            <div className="min-w-0">
              <p className="text-sm font-medium">Budget thresholds</p>
              <p className="text-xs text-muted">Push when an envelope or bucket crosses 80% or 100%.</p>
            </div>
            <Switch
              aria-label="Budget threshold alerts"
              checked={s.notify_thresholds}
              onChange={(e) => commit({ ...s, notify_thresholds: e.target.checked })}
            />
          </div>

          <div>
            <p className="text-sm font-medium mb-1">Upcoming bills</p>
            <Select
              aria-label="Upcoming-bill window"
              value={String(s.notify_upcoming_days)}
              onChange={(e) => commit({ ...s, notify_upcoming_days: Number(e.target.value) })}
            >
              {UPCOMING_CHOICES.map((d) => (
                <option key={d} value={d}>
                  {d === 0 ? "Off" : d === 1 ? "1 day ahead" : `${d} days ahead`}
                </option>
              ))}
            </Select>
            <p className="text-xs text-muted mt-1.5">
              Also gates pushes for missed bills and newly detected schedules.
            </p>
          </div>
        </>
      )}
    </SettingsPage>
  );
}
