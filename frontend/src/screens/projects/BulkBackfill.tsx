import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getJSON, getProject, bulkAssignProject } from "../../api/client";
import type { Category, Txn } from "../../api/types";
import { Input, Select } from "../../components/ui/Field";
import { Button } from "../../components/ui/Button";
import { TransactionRow } from "../../components/transactions/TransactionRow";
import { useTxnActions } from "../../hooks/useTxnActions";
import { useToast } from "../../components/Toast";
import { applyTxnFilters, EMPTY_FILTERS } from "../../lib/transactions";
import { searchTxns } from "../../lib/analysis";
import { SettingsPage } from "../settings/SettingsPage";

/**
 * Bulk-backfill drill-in: inline date/merchant/category filters narrow the
 * full transactions list down to candidates, already-assigned-to-this-
 * project rows are excluded, and "Assign N" bulk-assigns the visible set.
 * Deliberately a page (not a sheet) with filters shown inline, per house
 * style — see ProjectDetail and FilterChips for the same convention.
 *
 * Only `from`/`to` go to the server (same as the Transactions screen); the
 * merchant term and category are applied client-side with the existing
 * `searchTxns`/`applyTxnFilters` helpers so filtering stays instant as the
 * user types.
 */
export function BulkBackfill({ id, onClose, onDone }: { id: number; onClose: () => void; onDone: () => void }) {
  const qc = useQueryClient();
  const { show } = useToast();
  const { setStatus, archiveTxn, restoreTxn } = useTxnActions();
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [merchant, setMerchant] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [assigning, setAssigning] = useState(false);

  const project = useQuery({ queryKey: ["projects", id], queryFn: () => getProject(id) });
  const txns = useQuery({
    queryKey: ["transactions", "", from, to],
    queryFn: () => {
      const params = new URLSearchParams();
      if (from) params.set("from", from);
      if (to) params.set("to", to);
      const qs = params.toString();
      return getJSON<Txn[]>(qs ? `/api/transactions?${qs}` : "/api/transactions");
    },
  });
  const categories = useQuery({ queryKey: ["categories"], queryFn: () => getJSON<Category[]>("/api/categories") });

  const matching = useMemo(() => {
    const notAssigned = (txns.data ?? []).filter((t) => t.ProjectID !== id);
    const byCategory = applyTxnFilters(notAssigned, {
      ...EMPTY_FILTERS,
      categoryIds: categoryId ? [Number(categoryId)] : [],
    });
    return searchTxns(byCategory, merchant);
  }, [txns.data, merchant, categoryId, id]);

  const projectName = project.data?.name ?? "project";

  const assign = async () => {
    if (matching.length === 0) return;
    setAssigning(true);
    try {
      await bulkAssignProject(id, matching.map((t) => t.ID));
      qc.invalidateQueries({ queryKey: ["projects"] });
      qc.invalidateQueries({ queryKey: ["transactions"] });
      qc.invalidateQueries({ queryKey: ["summary"] });
      onDone();
    } catch {
      show({ message: "Couldn't assign transactions", tone: "error" });
    } finally {
      setAssigning(false);
    }
  };

  return (
    <SettingsPage title="Add transactions" onClose={onClose}>
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <label className="text-sm">
            From
            <Input type="date" className="mt-1" value={from} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label className="text-sm">
            To
            <Input type="date" className="mt-1" value={to} onChange={(e) => setTo(e.target.value)} />
          </label>
        </div>

        <label className="block text-sm">
          Merchant contains
          <Input
            className="mt-1"
            autoCorrect="off"
            value={merchant}
            onChange={(e) => setMerchant(e.target.value)}
            placeholder="e.g. Ikea"
          />
        </label>

        <label className="block text-sm">
          Category
          <Select className="mt-1" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
            <option value="">Any category</option>
            {(categories.data ?? []).map((c) => (
              <option key={c.ID} value={c.ID}>{c.Name}</option>
            ))}
          </Select>
        </label>

        <p className="text-sm text-muted px-1">
          {matching.length} matching transaction{matching.length === 1 ? "" : "s"}
        </p>

        {matching.length === 0 ? (
          <p className="text-sm text-muted px-1">No transactions match these filters.</p>
        ) : (
          <div className="divide-y divide-border px-1">
            {matching.map((t) => (
              <TransactionRow key={t.ID} txn={t} onOpen={() => {}} onStatus={setStatus} onArchive={archiveTxn} onRestore={restoreTxn} />
            ))}
          </div>
        )}

        <Button variant="primary" className="w-full" disabled={matching.length === 0 || assigning} onClick={assign}>
          {assigning ? "Assigning…" : `Assign ${matching.length} to ${projectName}`}
        </Button>
      </div>
    </SettingsPage>
  );
}
