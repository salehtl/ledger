import { useId, useState, type FormEvent } from "react";
import { Dialog, DialogFooter } from "../../components/ui/Dialog";
import { Button } from "../../components/ui/Button";
import { Input } from "../../components/ui/Field";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { useToast } from "../../components/Toast";
import type { AccountKind } from "../../lib/reconcile";
import { useCreateAccount } from "./api";

const KIND_HINT: Record<AccountKind, string> = {
  budget: "Spendable money — feeds check-ins, envelopes and transfer matching.",
  tracking: "Net worth only — investments, property. Gets plain balance updates.",
};

/**
 * Register an account: name, bank, the card/account last-4 that bank emails
 * carry, and whether it's spendable (budget) or net-worth-only (tracking).
 */
export function AddAccountSheet({ onClose, onCreated }: {
  onClose: () => void;
  onCreated?: (id: number) => void;
}) {
  const nameId = useId();
  const bankId = useId();
  const last4Id = useId();
  const toast = useToast();
  const create = useCreateAccount();
  const [name, setName] = useState("");
  const [bank, setBank] = useState("");
  const [last4, setLast4] = useState("");
  const [kind, setKind] = useState<AccountKind>("budget");
  const [attempted, setAttempted] = useState(false);

  const nameError = name.trim() === "" ? "Name is required." : undefined;
  const last4Error = !/^\d{4}$/.test(last4) ? "Exactly 4 digits." : undefined;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setAttempted(true);
    if (nameError || last4Error || create.isPending) return;
    create.mutate(
      { name: name.trim(), bank: bank.trim(), last4, kind },
      {
        onSuccess: (id) => {
          toast.show({
            message:
              kind === "tracking"
                ? `${name.trim()} added — set its first balance.`
                : `${name.trim()} added — check in to anchor its balance.`,
          });
          onCreated?.(id);
          onClose();
        },
        onError: (err) => toast.show({ message: `Couldn't add the account — ${err.message}`, tone: "error" }),
      },
    );
  };

  return (
    <Dialog title="Add account" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <div>
          <label htmlFor={nameId} className="block text-sm font-medium mb-1.5">Name</label>
          <Input
            id={nameId}
            inset
            type="text"
            autoCapitalize="words"
            autoCorrect="off"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          {attempted && nameError && <p role="alert" className="mt-1.5 text-xs text-bad">{nameError}</p>}
        </div>
        <div>
          <label htmlFor={bankId} className="block text-sm font-medium mb-1.5">Bank (optional)</label>
          <Input
            id={bankId}
            inset
            type="text"
            autoCapitalize="words"
            autoCorrect="off"
            value={bank}
            onChange={(e) => setBank(e.target.value)}
          />
        </div>
        <div>
          <label htmlFor={last4Id} className="block text-sm font-medium mb-1.5">Last 4 digits</label>
          <Input
            id={last4Id}
            inset
            type="text"
            inputMode="numeric"
            maxLength={4}
            autoComplete="off"
            className="!w-28"
            value={last4}
            onChange={(e) => setLast4(e.target.value.replace(/\D/g, ""))}
          />
          {attempted && last4Error ? (
            <p role="alert" className="mt-1.5 text-xs text-bad">{last4Error}</p>
          ) : (
            <p className="mt-1.5 text-xs text-muted">
              Matches this account in bank emails. No card? Any 4 digits work.
            </p>
          )}
        </div>
        <div>
          <span className="block text-sm font-medium mb-1.5">Type</span>
          <SegmentedControl<AccountKind>
            value={kind}
            onChange={setKind}
            fullWidth
            options={[
              { value: "budget", label: "Budget" },
              { value: "tracking", label: "Tracking" },
            ]}
          />
          <p className="mt-1.5 text-xs text-muted">{KIND_HINT[kind]}</p>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" disabled={create.isPending}>
            {create.isPending ? "Adding…" : "Add account"}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
