import { useState } from "react";
import { RollingNumber } from "../../components/RollingNumber";
import { Skeleton } from "../../components/Skeleton";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { SectionLabel } from "../../components/ui/SectionLabel";
import { Switch } from "../../components/ui/Switch";
import { useToast } from "../../components/Toast";
import { SettingsPage } from "../settings/SettingsPage";
import { shortDate } from "../../lib/format";
import {
  balanceLabel,
  detailMeta,
  sourceLabel,
  sparkRange,
  sparklinePoints,
  type AccountBalanceSummary,
} from "../../lib/reconcile";
import { useBalanceHistory, useDeleteAccount, useSetKind } from "./api";
import { BalanceAmount } from "./BalanceAmount";
import { BalanceSparkline } from "./BalanceSparkline";
import { CheckinSheet } from "./CheckinSheet";
import { UpdateBalanceSheet } from "./UpdateBalanceSheet";

const MASK = "••••";

/**
 * One account, full screen: the live computed balance with its anchor
 * provenance, the check-in / update action, the balance-history sparkline and
 * points, and the account's settings (kind, delete). Budget accounts reconcile
 * via the check-in sheet; tracking accounts take plain balance updates.
 */
export function AccountDetail({ account, onClose }: {
  account: AccountBalanceSummary;
  onClose: () => void;
}) {
  const a = account;
  const tracking = a.kind === "tracking";
  const toast = useToast();
  const history = useBalanceHistory(a.account_id);
  const setKind = useSetKind(a.account_id);
  const removeAccount = useDeleteAccount();
  const [sheet, setSheet] = useState<null | "balance">(null);
  const [armDelete, setArmDelete] = useState(false);

  const points = history.data ? sparklinePoints(history.data) : [];
  const range = history.data ? sparkRange(history.data) : null;

  const flipKind = (toTracking: boolean) => {
    setKind.mutate(toTracking ? "tracking" : "budget", {
      onError: (err) => toast.show({ message: `Couldn't change the account type — ${err.message}`, tone: "error" }),
    });
  };

  const reallyDelete = () => {
    removeAccount.mutate(a.account_id, {
      onSuccess: () => {
        toast.show({ message: `${a.name} deleted` });
        onClose();
      },
      onError: (err) => {
        toast.show({
          message:
            err.message === "in use"
              ? "Can't delete — this account has balance history behind net worth."
              : `Couldn't delete — ${err.message}`,
          tone: "error",
        });
        setArmDelete(false);
      },
    });
  };

  return (
    <SettingsPage title={a.name} onClose={onClose}>
      <div className="space-y-6">
        <div>
          <SectionLabel>{tracking ? "Tracking balance" : "Current balance"}</SectionLabel>
          {a.has_checkin ? (
            <>
              <p
                data-balance
                className={`mt-1.5 text-2xl leading-none font-semibold tracking-[-0.02em] tnum ${
                  (a.computed_fils ?? 0) < 0 ? "text-bad" : ""
                }`}
              >
                <RollingNumber value={balanceLabel(a.computed_fils ?? 0)} />
              </p>
              <p className="mt-2 font-mono text-[10px] tracking-[0.04em] text-muted tnum">{detailMeta(a)}</p>
            </>
          ) : (
            <>
              <p className="mt-1.5 text-2xl leading-none font-semibold tracking-[-0.02em] text-muted">—</p>
              <p className="mt-2 text-xs text-muted">
                {tracking
                  ? "No balance yet. Add one to start this account's net-worth line."
                  : "No check-in yet. Type the balance from your bank app to anchor this account."}
              </p>
            </>
          )}
          <Button variant="primary" className="w-full mt-4" onClick={() => setSheet("balance")}>
            {tracking ? "Update balance" : "Check in"}
          </Button>
        </div>

        <div>
          <SectionLabel as="h2">Balance history</SectionLabel>
          <Card className="mt-2">
            {history.isPending ? (
              <Skeleton rows={2} />
            ) : history.isError ? (
              <div className="text-sm text-muted">
                Couldn't load history.{" "}
                <button type="button" className="underline press" onClick={() => history.refetch()}>
                  Try again
                </button>
              </div>
            ) : points.length === 0 ? (
              <p className="text-sm text-muted">
                {tracking
                  ? "No balance points yet — the first update starts the line."
                  : "No balance points yet — the first check-in starts the line."}
              </p>
            ) : (
              <>
                <BalanceSparkline points={points} />
                {range && (
                  <div className="mt-2 flex items-baseline justify-between gap-3 font-mono text-[10px] tracking-[0.04em] text-muted tnum">
                    <span>low {balanceLabel(range.lo_fils)} · high {balanceLabel(range.hi_fils)}</span>
                    <span>since {shortDate(range.from)}</span>
                  </div>
                )}
              </>
            )}
          </Card>
          {history.data && history.data.length > 0 && (
            <Card className="!p-0 mt-2">
              <ul className="divide-y divide-border">
                {history.data.slice(0, 8).map((p) => (
                  <li key={p.id} className="flex items-baseline justify-between gap-3 px-4 py-2.5">
                    <span className="min-w-0 truncate font-mono text-[10px] tracking-[0.04em] text-muted tnum">
                      {shortDate(p.as_of)} · {sourceLabel(p.source)}
                      {p.note ? ` · ${p.note}` : ""}
                    </span>
                    <span className="shrink-0 text-sm tnum">
                      <BalanceAmount fils={p.balance_fils} />
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>

        <div className="pt-4 border-t border-border">
          <label className="flex items-center justify-between gap-3">
            <span className="min-w-0">
              <span className="block text-sm font-medium">Tracking account</span>
              <span className="block mt-0.5 text-xs text-muted">
                Counts in net worth only — investments, property. Budget accounts feed check-ins and envelopes.
              </span>
            </span>
            <Switch
              checked={tracking}
              disabled={setKind.isPending}
              onChange={(e) => flipKind(e.target.checked)}
              aria-label="Tracking account"
            />
          </label>
        </div>

        <div className="pt-4 border-t border-border">
          {armDelete ? (
            <div className="space-y-2">
              <p className="text-xs text-muted">
                Removes the registration. Accounts with balance history can't be deleted — check-ins are
                net-worth ground truth.
              </p>
              <div className="flex items-center gap-2">
                <Button variant="danger" onClick={reallyDelete} disabled={removeAccount.isPending}>
                  {removeAccount.isPending ? "Deleting…" : "Delete"}
                </Button>
                <Button variant="ghost" onClick={() => setArmDelete(false)}>Cancel</Button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              className="min-h-11 px-1 text-sm font-medium text-bad press"
              onClick={() => setArmDelete(true)}
            >
              Delete {MASK} {a.last4}…
            </button>
          )}
        </div>
      </div>

      {sheet === "balance" && !tracking && (
        <CheckinSheet account={a} onClose={() => setSheet(null)} />
      )}
      {sheet === "balance" && tracking && (
        <UpdateBalanceSheet account={a} onClose={() => setSheet(null)} />
      )}
    </SettingsPage>
  );
}
