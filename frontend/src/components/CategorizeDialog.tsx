// frontend/src/components/CategorizeDialog.tsx
import { useMemo, useState } from "react";
import type { Category, Txn } from "../api/types";
import { Money } from "./Money";
import { Modal } from "./Modal";

const BUCKET_LABELS: Record<string, string> = { need: "Needs", want: "Wants", saving: "Savings" };

export function CategorizeDialog(props: {
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
    const matched = props.categories.filter((c) => !q || c.Name.toLowerCase().includes(q));
    const byBucket = new Map<string, Category[]>();
    for (const c of matched) {
      const list = byBucket.get(c.Bucket) ?? [];
      list.push(c);
      byBucket.set(c.Bucket, list);
    }
    return [...byBucket.entries()];
  }, [props.categories, query]);

  return (
    <Modal title="Categorize" onClose={props.onClose}>
      <p className="dialog-txn">{props.txn.MerchantRaw || "—"} · <Money fils={-props.txn.AmountFils} /></p>
      <input
        className="search"
        type="search"
        placeholder="Search categories…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="cat-list">
        {groups.map(([bucket, list]) => (
          <fieldset key={bucket} className="cat-group">
            <legend>{BUCKET_LABELS[bucket] ?? bucket}</legend>
            {list.map((c) => (
              <label key={c.ID} className="cat-option">
                <input type="radio" name="cat" value={c.ID} onChange={() => setCatID(c.ID)} /> {c.Name}
              </label>
            ))}
          </fieldset>
        ))}
        {groups.length === 0 && <p className="muted">No matching categories.</p>}
      </div>
      <label className="rule-toggle">
        <input type="checkbox" checked={makeRule} onChange={(e) => setMakeRule(e.target.checked)} /> Save as rule
      </label>
      <div className="dialog-actions">
        <button onClick={props.onClose}>Cancel</button>
        <button
          disabled={catID === null}
          onClick={() => catID !== null && props.onSubmit({ category_id: catID, make_rule: makeRule })}
        >OK</button>
      </div>
    </Modal>
  );
}
