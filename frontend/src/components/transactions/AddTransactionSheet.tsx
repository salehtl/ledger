// frontend/src/components/transactions/AddTransactionSheet.tsx
import { useState } from "react";
import type { Category } from "../../api/types";
import { Dialog } from "../ui/Dialog";
import { Button } from "../ui/Button";
import { Input, Select } from "../ui/Field";
import { buildManualTxnPayload, type ManualTxnPayload } from "../../lib/transactions";

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function AddTransactionSheet({ categories, onSubmit, onClose }: {
  categories: Category[];
  onSubmit: (payload: ManualTxnPayload) => void;
  onClose: () => void;
}) {
  const [merchant, setMerchant] = useState("");
  const [amountAed, setAmountAed] = useState("");
  const [direction, setDirection] = useState("debit");
  const [date, setDate] = useState(today());
  const [categoryId, setCategoryId] = useState<number | null>(null);
  const [error, setError] = useState("");

  const submit = () => {
    const res = buildManualTxnPayload({ merchant, amountAed, direction, date, categoryId });
    if (!res.ok) { setError(res.error); return; }
    setError("");
    onSubmit(res.payload);
  };

  return (
    <Dialog title="Add transaction" onClose={onClose}>
      <div className="space-y-3">
        <label className="block text-sm">Merchant
          <Input inset autoCapitalize="words" autoCorrect="off" enterKeyHint="next" value={merchant} onChange={(e) => setMerchant(e.target.value)} placeholder="e.g. Carrefour" />
        </label>
        <label className="block text-sm">Amount (AED)
          <Input inset type="number" inputMode="decimal" min="0" step="0.01" value={amountAed} onChange={(e) => setAmountAed(e.target.value)} />
        </label>
        <label className="block text-sm">Direction
          <Select inset value={direction} onChange={(e) => setDirection(e.target.value)}>
            <option value="debit">Debit (money out)</option>
            <option value="credit">Credit (money in)</option>
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
      <div className="flex justify-end gap-2 mt-4">
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={submit}>Add</Button>
      </div>
    </Dialog>
  );
}
