import { useState } from "react";
import type { Category, Txn } from "../api/types";
import { Money } from "./Money";

export function CategorizeDialog(props: {
  txn: Txn;
  categories: Category[];
  onSubmit: (body: { category_id: number; make_rule: boolean }) => void;
  onClose: () => void;
}) {
  const [catID, setCatID] = useState<number | null>(null);
  const [makeRule, setMakeRule] = useState(false);
  return (
    <div className="drawer-backdrop" onClick={props.onClose}>
      <div className="window" style={{ maxWidth: 360, margin: "20vh auto" }} onClick={(e) => e.stopPropagation()}>
        <div className="title-bar"><div className="title-bar-text">Categorize</div></div>
        <div className="window-body">
          <p>{props.txn.MerchantRaw || "—"} · <Money fils={-props.txn.AmountFils} /></p>
          <div style={{ maxHeight: 240, overflowY: "auto" }}>
            {props.categories.map((c) => (
              <label key={c.ID} style={{ display: "block", padding: "6px 0" }}>
                <input type="radio" name="cat" value={c.ID} onChange={() => setCatID(c.ID)} /> {c.Name}
              </label>
            ))}
          </div>
          <label style={{ display: "block", margin: "8px 0" }}>
            <input type="checkbox" checked={makeRule} onChange={(e) => setMakeRule(e.target.checked)} /> Save as rule
          </label>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button onClick={props.onClose}>Cancel</button>
            <button
              disabled={catID === null}
              onClick={() => catID !== null && props.onSubmit({ category_id: catID, make_rule: makeRule })}
            >OK</button>
          </div>
        </div>
      </div>
    </div>
  );
}
