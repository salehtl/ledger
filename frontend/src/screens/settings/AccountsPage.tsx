import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { getAccounts, createAccount, deleteAccount, sweepTransfers } from "../../api/client";
import { Button } from "../../components/ui/Button";
import { Input } from "../../components/ui/Field";
import { IconButton } from "../../components/ui/IconButton";
import { useToast } from "../../components/Toast";
import { SettingsPage } from "./SettingsPage";
import { SavedFlash, useSavedFlash } from "./SavedFlash";

export function AccountsPage({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const { show } = useToast();
  const { saved, flash } = useSavedFlash();
  const accounts = useQuery({ queryKey: ["accounts"], queryFn: getAccounts });
  const [name, setName] = useState("");
  const [last4, setLast4] = useState("");
  const [addError, setAddError] = useState("");
  const [sweeping, setSweeping] = useState(false);

  const add = async () => {
    if (!name.trim()) {
      setAddError("Name is required");
      return;
    }
    if (!/^\d{4}$/.test(last4)) {
      setAddError("Last 4 must be exactly 4 digits");
      return;
    }
    setAddError("");
    try {
      await createAccount({ name: name.trim(), last4 });
      setName("");
      setLast4("");
      qc.invalidateQueries({ queryKey: ["accounts"] });
      flash();
    } catch {
      show({ message: "Couldn't add account", tone: "error" });
    }
  };

  const remove = async (id: number) => {
    try {
      await deleteAccount(id);
      qc.invalidateQueries({ queryKey: ["accounts"] });
    } catch {
      show({ message: "Couldn't delete account", tone: "error" });
    }
  };

  const sweep = async () => {
    setSweeping(true);
    try {
      const res = await sweepTransfers();
      show({
        message:
          res.marked === 0
            ? "No matching transfer pairs found"
            : `Marked ${res.marked} transaction${res.marked === 1 ? "" : "s"} as transfers`,
        tone: "success",
      });
      for (const k of ["transactions", "review", "summary", "insights-categories", "insights-trend"]) {
        qc.invalidateQueries({ queryKey: [k] });
      }
    } catch {
      show({ message: "Sweep failed", tone: "error" });
    } finally {
      setSweeping(false);
    }
  };

  return (
    <SettingsPage title="Accounts & transfers" onClose={onClose} headerRight={<SavedFlash saved={saved} />}>
      <div className="space-y-6">
        <div>
          <p className="text-xs text-muted mb-4">
            Register your own accounts (by card/account last 4) so money moved between them is
            recognized as a transfer and nets to zero. With no accounts registered, matching falls
            back to amount + timing only.
          </p>
          <div className="space-y-3">
            {(accounts.data ?? []).map((a) => (
              <div key={a.id} className="flex items-center gap-2">
                <span className="text-sm font-medium flex-1 truncate">{a.name}</span>
                <span className="text-xs text-muted tabular-nums">•••• {a.last4}</span>
                <IconButton label={`Delete ${a.name}`} tone="danger" className="-mr-2" onClick={() => remove(a.id)}>
                  <Trash2 size={16} />
                </IconButton>
              </div>
            ))}

            <div className="space-y-1 pt-3 border-t border-border">
              <p className="text-sm font-medium">Add account</p>
              <div className="flex items-center gap-2">
                <Input
                  type="text"
                  placeholder="Name"
                  aria-label="Account name"
                  autoCapitalize="words"
                  autoCorrect="off"
                  className="flex-1"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
                <Input
                  type="text"
                  inputMode="numeric"
                  maxLength={4}
                  placeholder="Last 4"
                  aria-label="Last 4 digits"
                  className="!w-24"
                  value={last4}
                  onChange={(e) => setLast4(e.target.value.replace(/\D/g, ""))}
                />
                <Button variant="secondary" onClick={add}>Add</Button>
              </div>
              {addError && <p role="alert" className="text-bad text-xs">{addError}</p>}
            </div>
          </div>
        </div>

        <div className="pt-3 border-t border-border space-y-2">
          <p className="text-sm font-medium">Net existing transfers</p>
          <p className="text-xs text-muted">
            Scans all transactions and marks matching debit/credit pairs (same amount, close in
            time) as transfers. Wrong matches can be reverted from the Transactions screen.
          </p>
          <Button variant="secondary" onClick={sweep} disabled={sweeping}>
            {sweeping ? "Scanning…" : "Net matching transfers"}
          </Button>
        </div>
      </div>
    </SettingsPage>
  );
}
