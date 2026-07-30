import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getJSON, postJSON } from "../api/client";
import { type Scope } from "../lib/scope";
import { CategoryManager } from "./CategoryManager";
import { RulesManager } from "./RulesManager";
import { Button } from "../components/ui/Button";
import { Dialog, DialogFooter } from "../components/ui/Dialog";
import { useToast } from "../components/Toast";
import { SettingsHub, type SettingsPageId } from "./settings/SettingsHub";
import { BudgetPage } from "./settings/BudgetPage";
import { CategorizationPage } from "./settings/CategorizationPage";
import { AiUsagePage } from "./settings/AiUsagePage";
import { SwipePage } from "./settings/SwipePage";
import { CurrenciesPage } from "./settings/CurrenciesPage";
import { AccountsPage } from "./settings/AccountsPage";
import { TextSizePage } from "./settings/TextSizePage";
import { IngestHealthPage } from "./settings/IngestHealthPage";
import { NotificationsPage } from "./settings/NotificationsPage";

export { pctsValid } from "../lib/split";

/** Cross-tab deep link into a settings drill-in (e.g. banner → Email ingest).
 *  nonce forces re-navigation when Settings is already mounted. */
export interface SettingsIntent { page: SettingsPageId; nonce: number }

export function Settings({
  scope,
  intent,
  onOpenProjects,
  onOpenAccounts,
  onOpenRecurring,
}: {
  scope?: Scope;
  intent?: SettingsIntent | null;
  /** Projects is hosted at the AppShell level (overlay, independent of the
   *  Settings tab) so it can be deep-linked from Home too — the hub's
   *  "Projects" row delegates to this instead of the local page dispatch.
   *  Optional so standalone Settings tests don't need to stub it. */
  onOpenProjects?: () => void;
  /** Accounts / Recurring are AppShell-level drill-ins for the same reason. */
  onOpenAccounts?: () => void;
  onOpenRecurring?: () => void;
}) {
  const qc = useQueryClient();
  const { show } = useToast();
  const [page, setPage] = useState<SettingsPageId | null>(null);
  const [clearOpen, setClearOpen] = useState(false);
  const [clearBusy, setClearBusy] = useState(false);

  useEffect(() => {
    if (intent) setPage(intent.page);
  }, [intent]);

  const txns = useQuery({ queryKey: ["transactions"], queryFn: () => getJSON<unknown[]>("/api/transactions") });
  const txnCount = txns.data?.length ?? 0;

  const clearCategorization = async () => {
    setClearBusy(true);
    try {
      const res = await postJSON<{ cleared: number }>("/api/categorization/clear", {});
      show({ message: `Cleared ${res.cleared} transaction${res.cleared === 1 ? "" : "s"}`, tone: "success" });
      for (const k of ["transactions", "review", "summary", "insights-categories", "insights-trend"]) {
        qc.invalidateQueries({ queryKey: [k] });
      }
      setClearOpen(false);
    } catch {
      show({ message: "Couldn't clear categorization", tone: "error" });
    } finally {
      setClearBusy(false);
    }
  };

  const close = () => setPage(null);

  return (
    <>
      <SettingsHub
        onOpen={setPage}
        onClear={() => setClearOpen(true)}
        onOpenProjects={() => onOpenProjects?.()}
        onOpenAccounts={onOpenAccounts}
        onOpenRecurring={onOpenRecurring}
      />

      {page === "budget" && <BudgetPage onClose={close} />}
      {page === "categorization" && <CategorizationPage scope={scope} onClose={close} />}
      {page === "ai" && <AiUsagePage onClose={close} />}
      {page === "swipe" && <SwipePage onClose={close} />}
      {page === "currencies" && <CurrenciesPage onClose={close} />}
      {page === "accounts" && <AccountsPage onClose={close} />}
      {page === "textsize" && <TextSizePage onClose={close} />}
      {page === "ingest" && <IngestHealthPage onClose={close} />}
      {page === "notifications" && <NotificationsPage onClose={close} />}
      {page === "categories" && <CategoryManager onClose={close} />}
      {page === "rules" && <RulesManager onClose={close} />}

      {clearOpen && (
        <Dialog title="Clear all categorization?" onClose={() => setClearOpen(false)}>
          <p className="text-sm mb-4">
            This moves {txnCount} transaction{txnCount === 1 ? "" : "s"} back to Needs review and clears their categories.
            Learned rules are kept. This can't be undone.
          </p>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setClearOpen(false)}>Cancel</Button>
            <Button variant="danger" onClick={clearCategorization} disabled={clearBusy}>
              {clearBusy ? "Clearing…" : "Clear"}
            </Button>
          </DialogFooter>
        </Dialog>
      )}
    </>
  );
}
