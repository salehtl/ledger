// frontend/src/components/transactions/CategorizeSheet.tsx
import { useMemo, useState } from "react";
import type { Category, Txn } from "../../api/types";
import { Money } from "../Money";
import { Dialog } from "../ui/Dialog";
import { Button } from "../ui/Button";

const BUCKET_LABEL: Record<string, string> = { need: "Needs", want: "Wants", saving: "Savings" };

export function CategorizeSheet({ txn, categories, onSubmit, onClose }: {
  txn: Txn;
  categories: Category[];
  onSubmit: (body: { category_id: number; make_rule: boolean }) => void;
  onClose: () => void;
}) {
  const [catID, setCatID] = useState<number | null>(null);
  const [makeRule, setMakeRule] = useState(false);
  const [query, setQuery] = useState("");

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matched = categories.filter((c) => !q || c.Name.toLowerCase().includes(q));
    const byBucket = new Map<string, Category[]>();
    for (const c of matched) {
      const list = byBucket.get(c.Bucket) ?? [];
      list.push(c);
      byBucket.set(c.Bucket, list);
    }
    return [...byBucket.entries()];
  }, [categories, query]);

  return (
    <Dialog title="Categorize" onClose={onClose}>
      <p className="text-sm text-muted mb-3">{txn.MerchantRaw || "—"} · <Money fils={-txn.AmountFils} /></p>
      <input
        type="search"
        placeholder="Search categories…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        className="w-full mb-3 px-3 py-2 rounded-lg border border-border bg-bg text-sm"
      />
      <div className="space-y-3">
        {groups.map(([bucket, list]) => (
          <fieldset key={bucket}>
            <legend className="text-xs uppercase tracking-wide text-muted mb-1">{BUCKET_LABEL[bucket] ?? bucket}</legend>
            <div className="space-y-1">
              {list.map((c) => (
                <label key={c.ID} className="flex items-center gap-3 py-1.5 cursor-pointer">
                  <input type="radio" name="cat" onChange={() => setCatID(c.ID)} />
                  {c.Name}
                </label>
              ))}
            </div>
          </fieldset>
        ))}
        {groups.length === 0 && <p className="text-sm text-muted">No matching categories.</p>}
      </div>
      <label className="flex items-center gap-2 my-3 text-sm">
        <input type="checkbox" checked={makeRule} onChange={(e) => setMakeRule(e.target.checked)} />
        Make a rule for future "{txn.MerchantRaw || "—"}"
      </label>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={catID === null} onClick={() => catID !== null && onSubmit({ category_id: catID, make_rule: makeRule })}>Save</Button>
      </div>
    </Dialog>
  );
}
