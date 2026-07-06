import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import type { Category, Txn } from "../../api/types";
import { Dialog } from "../ui/Dialog";
import { Input } from "../ui/Field";
import { EmptyState } from "../EmptyState";
import { FilterChips } from "../transactions/FilterChips";
import { TransactionRow } from "../transactions/TransactionRow";
import { CategorizeSheet } from "../transactions/CategorizeSheet";
import { useTxnActions } from "../../hooks/useTxnActions";
import { applyTxnFilters, EMPTY_FILTERS, type TxnFilters } from "../../lib/transactions";
import { searchTxns } from "../../lib/analysis";

export function SearchSheet({ txns, categories, onClose }: {
  txns: Txn[];
  categories: Category[];
  onClose: () => void;
}) {
  const [term, setTerm] = useState("");
  const [filters, setFilters] = useState<TxnFilters>(EMPTY_FILTERS);
  const [active, setActive] = useState<Txn | null>(null);
  const { setStatus, archiveTxn, restoreTxn, categorize } = useTxnActions();

  const rows = useMemo(() => searchTxns(applyTxnFilters(txns, filters), term), [txns, filters, term]);

  return (
    <Dialog title="Search & filter" onClose={onClose}>
      <div className="mb-3">
        <Input
          inset
          icon={Search}
          type="search"
          enterKeyHint="search"
          autoCorrect="off"
          placeholder="Search merchant…"
          value={term}
          onChange={(e) => setTerm(e.target.value)}
        />
      </div>
      <div className="mb-3">
        <FilterChips filters={filters} categories={categories} txns={txns} onChange={setFilters} />
      </div>
      {rows.length === 0 ? (
        <EmptyState title="No transactions match" />
      ) : (
        <ul className="divide-y divide-border">
          {rows.map((t) => (
            <li key={t.ID}>
              <TransactionRow txn={t} onOpen={setActive} onStatus={setStatus} onArchive={archiveTxn} onRestore={restoreTxn} />
            </li>
          ))}
        </ul>
      )}
      {active && (
        <CategorizeSheet
          txn={active}
          categories={categories}
          onSubmit={async (body) => { if (await categorize(active, body)) setActive(null); }}
          onClose={() => setActive(null)}
        />
      )}
    </Dialog>
  );
}
