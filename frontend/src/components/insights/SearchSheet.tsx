import { useMemo, useState } from "react";
import { Search } from "../ui/PixelIcon";
import type { Category, Txn } from "../../api/types";
import { Dialog } from "../ui/Dialog";
import { Input } from "../ui/Field";
import { EmptyState } from "../EmptyState";
import { FilterBar } from "../transactions/FilterBar";
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
  const { categorize } = useTxnActions();

  const rows = useMemo(() => searchTxns(applyTxnFilters(txns, filters), term), [txns, filters, term]);

  return (
    <Dialog title="Search & filter" onClose={onClose}>
      <div className="mb-3">
        <Input
          inset
          autoFocus
          icon={Search}
          type="search"
          enterKeyHint="search"
          autoCorrect="off"
          placeholder="Search merchant…"
          value={term}
          onChange={(e) => setTerm(e.target.value)}
        />
      </div>
      <FilterBar filters={filters} categories={categories} txns={txns} open onChange={setFilters} />
      <p className="mb-2 mt-3 text-xs text-muted tnum" aria-live="polite">
        {rows.length} result{rows.length === 1 ? "" : "s"}
      </p>
      {rows.length === 0 ? (
        <EmptyState title="No transactions match" />
      ) : (
        <ul className="divide-y divide-border">
          {rows.map((t) => (
            <li key={t.ID}>
              <TransactionRow txn={t} onOpen={setActive} />
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
