// frontend/src/components/transactions/RenameMerchantSheet.tsx
import { useMemo, useState } from "react";
import type { Txn } from "../../api/types";
import { Dialog, DialogFooter } from "../ui/Dialog";
import { Button } from "../ui/Button";
import { Input } from "../ui/Field";
import { SectionLabel } from "../ui/SectionLabel";
import type { TxnDepth } from "../../lib/txSplit";
import { affectedCount, currentDisplayName, renameTarget, type DepthRule } from "./merchantRename";
import { useRenameMerchant } from "../../api/hooks";

/**
 * Rename a merchant once, everywhere: the clean name is written onto the rule
 * that matches this merchant (creating the write-back rule when none exists
 * yet), so history and all future mail print it — no per-transaction payee
 * editing. The raw string stays visible as provenance, and the sheet states
 * up front how many transactions the rename touches.
 */
export function RenameMerchantSheet({ txn, rules, txns, onClose, onSaved }: {
  txn: TxnDepth;
  rules: DepthRule[];
  /** Loaded transactions, for the honest "applies to N" line. */
  txns: Txn[];
  onClose: () => void;
  onSaved: (name: string) => void;
}) {
  const existing = txn.DisplayName || currentDisplayName(rules, txn.MerchantRaw);
  const [name, setName] = useState(existing);
  const rename = useRenameMerchant();

  const target = useMemo(() => renameTarget(rules, txn), [rules, txn]);
  const affected = useMemo(
    () => affectedCount(txns, target, txn.MerchantRaw),
    [txns, target, txn.MerchantRaw],
  );

  const trimmed = name.trim();
  const blocked = target.kind === "blocked";
  const clearing = trimmed === "" && existing !== "";
  const canSave = !blocked && !rename.isPending && trimmed !== existing && (trimmed !== "" || clearing);

  const save = () => {
    if (!canSave) return;
    rename.mutate(
      { txn, rules, name: trimmed },
      { onSuccess: () => onSaved(trimmed) },
    );
  };

  return (
    <Dialog title="Rename merchant" onClose={onClose}>
      <div className="mb-3">
        <SectionLabel className="mb-1">From bank emails as</SectionLabel>
        <p className="font-mono text-xs tracking-[0.04em] break-words">{txn.MerchantRaw || "—"}</p>
      </div>

      {blocked ? (
        <p className="text-sm text-muted mb-3">
          {target.kind === "blocked" && target.reason === "no-merchant"
            ? "The bank email carried no merchant text for this transaction, so there's nothing for a rename rule to match."
            : "No rule carries this merchant yet, and this transaction has no category to seed one. Categorize it first — the rule that creates will hold the name."}
        </p>
      ) : (
        <>
          <label className="block mb-2">
            <SectionLabel as="span" className="mb-1 block">Shown as</SectionLabel>
            <Input
              inset
              value={name}
              placeholder={txn.MerchantRaw}
              autoCapitalize="words"
              autoCorrect="off"
              enterKeyHint="done"
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <p className="text-xs text-muted mb-1">
            Applies to {affected} transaction{affected === 1 ? "" : "s"} from this merchant — past and future.
          </p>
          {clearing && (
            <p className="text-xs text-muted">Clearing shows the original name again.</p>
          )}
        </>
      )}

      {rename.isError && (
        <p className="mt-2 text-sm text-bad" role="alert">
          Couldn't save the name — {rename.error.message}. Try again.
        </p>
      )}

      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={!canSave} onClick={save}>
          {rename.isPending ? "Saving…" : clearing ? "Clear name" : "Save"}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
