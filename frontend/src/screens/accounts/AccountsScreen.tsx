import { useState } from "react";
import { EmptyState } from "../../components/EmptyState";
import { RollingNumber } from "../../components/RollingNumber";
import { Skeleton } from "../../components/Skeleton";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { SectionLabel } from "../../components/ui/SectionLabel";
import { AlertTriangle, FolderKanban } from "../../components/ui/PixelIcon";
import { balanceLabel, booksTotal, groupAccounts, type AccountBalanceSummary } from "../../lib/reconcile";
import { useAccountBalances } from "./api";
import { AccountRow } from "./AccountRow";
import { AccountDetail } from "./AccountDetail";
import { AddAccountSheet } from "./AddAccountSheet";

/**
 * Balance ground truth. Every registered account with its live computed
 * balance (last check-in anchor ± signed activity since), grouped budget vs
 * tracking, topped by the one number that matters: everything on the books.
 * Tap a row for detail, history and the 30-second check-in.
 */
export function AccountsScreen() {
  const balances = useAccountBalances();
  const [detailId, setDetailId] = useState<number | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  // isPending, not isLoading: the persisted-cache provider leaves restoring
  // queries pending-but-not-fetching, where isLoading lies (false, no data).
  if (balances.isPending) return <Skeleton rows={6} />;
  if (balances.isError) {
    return (
      <EmptyState
        icon={AlertTriangle}
        title="Couldn't load accounts"
        hint="Check your connection and try again."
      />
    );
  }

  const accounts = balances.data;
  const detail = detailId !== null ? accounts.find((a) => a.account_id === detailId) : undefined;
  const open = (a: AccountBalanceSummary) => setDetailId(a.account_id);

  if (accounts.length === 0) {
    return (
      <div className="space-y-2">
        <EmptyState
          icon={FolderKanban}
          title="No accounts yet"
          hint="Register the accounts behind your bank emails — balances, check-ins and net worth start here."
        />
        <div className="flex justify-center">
          <Button variant="primary" onClick={() => setAddOpen(true)}>Add account</Button>
        </div>
        {addOpen && <AddAccountSheet onClose={() => setAddOpen(false)} onCreated={setDetailId} />}
      </div>
    );
  }

  const groups = groupAccounts(accounts);
  const totals = booksTotal(accounts);

  return (
    <div className="space-y-4">
      <Card>
        <SectionLabel>On the books</SectionLabel>
        <p
          data-books={totals.counted === 0 ? "empty" : "total"}
          className={`mt-1.5 text-2xl leading-none font-semibold tracking-[-0.02em] tnum ${
            totals.counted === 0 ? "text-muted" : totals.total_fils < 0 ? "text-bad" : ""
          }`}
        >
          {totals.counted === 0 ? "—" : <RollingNumber value={balanceLabel(totals.total_fils)} />}
        </p>
        <p className="mt-2 font-mono text-[10px] tracking-[0.04em] text-muted tnum">
          {totals.counted === 0
            ? "check in below to start tracking balances"
            : `across ${totals.counted} account${totals.counted === 1 ? "" : "s"}${
                totals.unanchored > 0 ? ` · ${totals.unanchored} awaiting first check-in` : ""
              }`}
        </p>
      </Card>

      {groups.budget.length > 0 && (
        <section className="space-y-2">
          <SectionLabel as="h2" className="px-1">Budget accounts</SectionLabel>
          <Card className="!p-0">
            <div className="divide-y divide-border">
              {groups.budget.map((a) => (
                <AccountRow key={a.account_id} account={a} onOpen={open} />
              ))}
            </div>
          </Card>
        </section>
      )}

      {groups.tracking.length > 0 && (
        <section className="space-y-2">
          <SectionLabel as="h2" className="px-1">Tracking</SectionLabel>
          <Card className="!p-0">
            <div className="divide-y divide-border">
              {groups.tracking.map((a) => (
                <AccountRow key={a.account_id} account={a} onOpen={open} />
              ))}
            </div>
          </Card>
        </section>
      )}

      <Button variant="secondary" className="w-full" onClick={() => setAddOpen(true)}>
        Add account
      </Button>

      {detail && <AccountDetail account={detail} onClose={() => setDetailId(null)} />}
      {addOpen && <AddAccountSheet onClose={() => setAddOpen(false)} onCreated={setDetailId} />}
    </div>
  );
}
