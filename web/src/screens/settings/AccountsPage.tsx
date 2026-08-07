import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getAccounts, sweepTransfers } from "../../api/client";
import { Button } from "../../components/ui/Button";
import { useToast } from "../../components/Toast";
import { SettingsPage } from "./SettingsPage";

/**
 * Settings → Transfers. Account management itself (registration, balances,
 * check-ins, budget vs tracking) moved to the Accounts drill-in in v3 —
 * this page keeps the transfer-netting tool and points at the new home.
 */
export function AccountsPage({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const { show } = useToast();
  const accounts = useQuery({ queryKey: ["accounts"], queryFn: getAccounts });
  const [sweeping, setSweeping] = useState(false);

  const n = accounts.data?.length ?? 0;

  const sweep = async () => {
    setSweeping(true);
    try {
      const res = await sweepTransfers();
      show({
        message:
          res.marked === 0
            ? "No matching transfer pairs found"
            : `Marked ${res.marked} transaction${res.marked === 1 ? "" : "s"} as transfers`,
        tone: "success",
      });
      for (const k of ["transactions", "review", "summary", "insights-categories", "insights-trend"]) {
        qc.invalidateQueries({ queryKey: [k] });
      }
    } catch {
      show({ message: "Sweep failed", tone: "error" });
    } finally {
      setSweeping(false);
    }
  };

  return (
    <SettingsPage title="Transfers" onClose={onClose}>
      <div className="space-y-6">
        <div className="space-y-2">
          <p className="text-xs text-muted">
            Money moved between registered accounts is recognized as a transfer and nets to zero.
            Account registration, balances and check-ins live under Accounts —
            {accounts.isPending
              ? " loading your registered accounts…"
              : accounts.isError
                ? " couldn't load your registered accounts right now."
                : n === 0
                  ? " none registered yet."
                  : ` ${n} account${n === 1 ? "" : "s"} registered.`}
          </p>
        </div>

        <div className="pt-3 border-t border-border space-y-2">
          <p className="text-sm font-medium">Net existing transfers</p>
          <p className="text-xs text-muted">
            Scans all transactions and marks matching debit/credit pairs (same amount, close in
            time) as transfers. Wrong matches can be reverted from the Transactions screen.
          </p>
          <Button variant="secondary" onClick={sweep} disabled={sweeping}>
            {sweeping ? "Scanning…" : "Net matching transfers"}
          </Button>
        </div>
      </div>
    </SettingsPage>
  );
}
