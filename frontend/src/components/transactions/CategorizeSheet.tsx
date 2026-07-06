// frontend/src/components/transactions/CategorizeSheet.tsx
import { useMemo, useState } from "react";
import type { Category, Txn } from "../../api/types";
import { Money } from "../Money";
import { Dialog } from "../ui/Dialog";
import { Button } from "../ui/Button";
import { Input } from "../ui/Field";
import { SectionLabel } from "../ui/SectionLabel";
import { aedFils, nativeAmountTag } from "../../lib/money";

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
      <p className="text-sm text-muted mb-3">
        {txn.MerchantRaw || "—"} · <Money fils={-(aedFils(txn) ?? txn.AmountFils)} />
        {nativeAmountTag(txn) ? ` · ${nativeAmountTag(txn)}` : ""}
        {aedFils(txn) === null ? " · no AED rate" : ""}
      </p>
      <Input
        inset
        type="search"
        enterKeyHint="search"
        autoCorrect="off"
        placeholder="Search categories…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        className="mb-3"
      />
      <div className="space-y-3">
        {groups.map(([bucket, list]) => (
          <fieldset key={bucket}>
            <SectionLabel as="legend" className="mb-1">{BUCKET_LABEL[bucket] ?? bucket}</SectionLabel>
            <div className="space-y-1">
              {list.map((c) => (
                <label key={c.ID} className="flex items-center gap-3 py-3 cursor-pointer">
                  <input type="radio" name="cat" className="w-5 h-5 accent-accent" onChange={() => setCatID(c.ID)} />
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
