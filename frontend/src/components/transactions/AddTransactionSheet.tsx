// frontend/src/components/transactions/AddTransactionSheet.tsx
import { useState } from "react";
import type { Category } from "../../api/types";
import { Dialog, DialogFooter } from "../ui/Dialog";
import { Button } from "../ui/Button";
import { Input, NumberField, Select } from "../ui/Field";
import { buildManualTxnPayload, type ManualTxnPayload } from "../../lib/transactions";

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function AddTransactionSheet({ categories, onSubmit, onClose, accountId }: {
  categories: Category[];
  onSubmit: (payload: ManualTxnPayload & { account_id?: number }) => void;
  onClose: () => void;
  /** Optional: attribute the entry to a registered account so it joins
   *  check-in expected-balance math and net worth (api-contract §4). */
  accountId?: number;
}) {
  const [merchant, setMerchant] = useState("");
  const [amountAed, setAmountAed] = useState<number | null>(null);
  const [direction, setDirection] = useState("debit");
  const [date, setDate] = useState(today());
  const [categoryId, setCategoryId] = useState<number | null>(null);
  const [error, setError] = useState("");

  const submit = () => {
    const res = buildManualTxnPayload({
      merchant,
      amountAed: amountAed === null ? "" : String(amountAed),
      direction,
      date,
      categoryId,
    });
    if (!res.ok) { setError(res.error); return; }
    setError("");
    onSubmit(accountId != null ? { ...res.payload, account_id: accountId } : res.payload);
  };

  return (
    <Dialog title="Add transaction" onClose={onClose}>
      <div className="space-y-3">
        <label className="block text-sm">Merchant
          <Input inset autoCapitalize="words" autoCorrect="off" enterKeyHint="next" value={merchant} onChange={(e) => setMerchant(e.target.value)} placeholder="e.g. Carrefour" />
        </label>
        <label className="block text-sm">Amount (AED)
          {/* The catalog's numeric control, not a bare type="number": it starts
              empty rather than at 0 and survives the intermediate "12." state. */}
          <NumberField inset min={0} decimals={2} allowEmpty value={amountAed} onValueChange={setAmountAed} placeholder="0.00" />
        </label>
        <label className="block text-sm">Type
          {/* Same words as the filter panel on this screen — it said
              "Spending"/"Income" while this sheet said "Debit"/"Credit". */}
          <Select inset value={direction} onChange={(e) => setDirection(e.target.value)}>
            <option value="debit">Spending</option>
            <option value="credit">Income</option>
          </Select>
        </label>
        <label className="block text-sm">Date
          <Input inset type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
        <label className="block text-sm">Category (optional)
          <Select inset value={categoryId ?? ""} onChange={(e) => setCategoryId(e.target.value ? Number(e.target.value) : null)}>
            <option value="">Uncategorized — send to Needs review</option>
            {categories.map((c) => <option key={c.ID} value={c.ID}>{c.Name}</option>)}
          </Select>
        </label>
        {error && <p role="alert" className="text-bad text-sm">{error}</p>}
      </div>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={submit}>Add</Button>
      </DialogFooter>
    </Dialog>
  );
}
