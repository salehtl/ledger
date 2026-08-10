/**
 * Add a transaction by hand, and correct one that was added by hand.
 *
 * # Money is a TEXT draft, not a number
 *
 * `AddTransactionSheet.tsx` — v1's, on the REST API — is where the field layout
 * and the "Spending"/"Income" wording come from, and it is where the money
 * handling deliberately does NOT come from. That sheet holds a `number` in a
 * `NumberField`; a v2 amount is `bigint` minor units, which a `number` corrupts
 * past 2^53, and `Number("") === 0` means an emptied field springs back to a
 * zero-dirham purchase. So this holds the text exactly as typed and parses it
 * once, in `manualTxnPayload`, the rule `MonthlyTotalField.tsx` sets out.
 *
 * What cannot be read is refused **in words**, in the `role="status"` line under
 * the field, while it is being typed. Nothing here rewrites what was typed.
 *
 * # When a correction can change the amount, and when it cannot
 *
 * On a row you typed, it can: nothing will ever reparse it, so there is no
 * pipeline for an edit to contradict, and `replay.ts` accepts
 * `amount_minor`/`currency`/`direction` in a `txn_edited` there. A typo in the
 * amount is the likeliest mistake in hand entry and has to be fixable.
 *
 * On a row from the mailbox, it cannot: those three come from the parse, a
 * reprocess would move them back, and the fold refuses the edit with an
 * `unsupported_edit_field` anomaly. `moneyLocked` follows that same line — it is
 * `!moneyEditable(txn)` in `sources/transactions.ts`, read from the row's
 * provenance — so the sheet never offers a field whose op would be discarded.
 */

import { useMemo, useState } from "react";

import { Button } from "../ui/Button";
import { Dialog, DialogFooter } from "../ui/Dialog";
import { Input, Select } from "../ui/Field";
import { manualAmountAdvice, type Direction, type ManualDraft } from "../../v2/sources/transactions";

/** Today, in the `YYYY-MM-DD` a native date field speaks. */
function todayISO(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function emptyDraft(currency: string, now?: Date): ManualDraft {
  return { amount: "", currency, direction: "debit", merchant: "", date: todayISO(now), category: null };
}

export function ManualTxnSheet({ mode, moneyLocked = false, initial, categories, currencies, error, onClose, onSave }: {
  /** `"add"` authors a new row; `"edit"` corrects one this device already has. */
  mode: "add" | "edit";
  /**
   * Whether the amount, currency and type are read-only. Pass
   * `!moneyEditable(txn)` — a row from the mailbox, or one already split.
   */
  moneyLocked?: boolean;
  initial: ManualDraft;
  /** The names the category picker offers, in the screen's own vocabulary. */
  categories: readonly string[];
  /** Currencies worth offering: the home currency plus whatever is already here. */
  currencies: readonly string[];
  /** A refusal from the op author, shown under the footer. */
  error?: string;
  onClose: () => void;
  onSave: (draft: ManualDraft) => void;
}) {
  const [draft, setDraft] = useState<ManualDraft>(initial);
  const set = <K extends keyof ManualDraft>(key: K, value: ManualDraft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  const editing = mode === "edit";
  const locked = moneyLocked;
  // The row's own category may predate the grid — a rule wrote it, or it came
  // from an import — and a picker that could not show the current answer would
  // look like it had none.
  const options = useMemo(() => {
    const known = draft.category;
    if (known === null || categories.some((c) => c.toLowerCase() === known.toLowerCase())) return categories;
    return [known, ...categories];
  }, [categories, draft.category]);
  // The draft's own currency first, so a row in a currency nothing else on the
  // account uses still opens on the value it actually holds.
  const currencyOptions = useMemo(
    () => [...new Set([draft.currency, ...currencies].filter((c) => c !== ""))],
    [currencies, draft.currency],
  );

  return (
    <Dialog title={editing ? "Edit transaction" : "Add transaction"} onClose={onClose}>
      <div className="space-y-3">
        <label className="block text-sm" htmlFor="manual-amount">
          Amount
          <Input
            id="manual-amount"
            inset
            // `type="text"` with `inputMode="decimal"`, never `type="number"`: a
            // number input reports "" for text it dislikes, which makes "empty"
            // and "not an amount" the same thing to read — and telling those
            // apart is what the status line below is for.
            type="text"
            inputMode="decimal"
            enterKeyHint="next"
            autoComplete="off"
            placeholder="0.00"
            className="tnum"
            disabled={locked}
            value={draft.amount}
            onChange={(e) => set("amount", e.target.value)}
          />
        </label>
        {/* Announced as it changes, so the amount that will be saved is known
            before it is saved. */}
        <p role="status" className="-mt-2 text-xs text-muted">
          {locked ? "This came from your inbox, so the amount, currency and type can't be changed." : manualAmountAdvice(draft.amount, draft.currency)}
        </p>

        <label className="block text-sm" htmlFor="manual-currency">
          Currency
          <Select
            id="manual-currency"
            inset
            disabled={locked}
            value={draft.currency}
            onChange={(e) => set("currency", e.target.value)}
          >
            {currencyOptions.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </Select>
        </label>

        <label className="block text-sm" htmlFor="manual-direction">
          Type
          {/* The same two words the filter panel on this screen uses. v1's sheet
              said "Debit"/"Credit" while the filters said "Spending"/"Income". */}
          <Select
            id="manual-direction"
            inset
            disabled={locked}
            value={draft.direction}
            onChange={(e) => set("direction", e.target.value as Direction)}
          >
            <option value="debit">Spending</option>
            <option value="credit">Income</option>
          </Select>
        </label>

        <label className="block text-sm" htmlFor="manual-merchant">
          Merchant
          <Input
            id="manual-merchant"
            inset
            autoCapitalize="words"
            autoCorrect="off"
            enterKeyHint="next"
            placeholder="e.g. Carrefour"
            value={draft.merchant}
            onChange={(e) => set("merchant", e.target.value)}
          />
        </label>

        <label className="block text-sm" htmlFor="manual-date">
          Date
          <Input id="manual-date" inset type="date" value={draft.date} onChange={(e) => set("date", e.target.value)} />
        </label>

        <label className="block text-sm" htmlFor="manual-category">
          Category
          <Select
            id="manual-category"
            inset
            value={draft.category ?? ""}
            onChange={(e) => set("category", e.target.value === "" ? null : e.target.value)}
          >
            <option value="">No category — send to Review</option>
            {options.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </Select>
        </label>

        {error !== undefined && error !== "" && (
          <p role="alert" className="text-sm text-bad">{error}</p>
        )}
      </div>

      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={() => onSave(draft)}>{editing ? "Save" : "Add"}</Button>
      </DialogFooter>
    </Dialog>
  );
}
