import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { getRates, putRate, deleteRate } from "../../api/client";
import { parseRateForm } from "../../lib/rates";
import { Button } from "../../components/ui/Button";
import { Input } from "../../components/ui/Field";
import { IconButton } from "../../components/ui/IconButton";
import { useToast } from "../../components/Toast";
import { SettingsPage } from "./SettingsPage";
import { SavedFlash, useSavedFlash } from "./SavedFlash";

export function CurrenciesPage({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const { show } = useToast();
  const { saved, flash } = useSavedFlash();
  const rates = useQuery({ queryKey: ["rates"], queryFn: getRates });
  const [rateDrafts, setRateDrafts] = useState<Record<string, string>>({});
  const [rateErrors, setRateErrors] = useState<Record<string, string>>({});
  const [newRateCode, setNewRateCode] = useState("");
  const [newRateValue, setNewRateValue] = useState("");
  const [newRateError, setNewRateError] = useState("");

  const invalidateRates = () => {
    qc.invalidateQueries({ queryKey: ["rates"] });
    qc.invalidateQueries({ queryKey: ["transactions"] });
  };

  const rateDraftFor = (code: string, current: string) => rateDrafts[code] ?? current;

  // Rate edits autosave on blur — no per-row Save button.
  const saveRate = async (code: string, rawValue: string, current?: string) => {
    // Nothing typed, or unchanged from the stored value: skip the round-trip.
    if (current !== undefined && rawValue === current) return;
    const parsed = parseRateForm(code, rawValue);
    if (!parsed.ok) {
      setRateErrors((prev) => ({ ...prev, [code]: parsed.error }));
      return;
    }
    setRateErrors((prev) => ({ ...prev, [code]: "" }));
    try {
      await putRate(parsed.currency, parsed.rate);
      invalidateRates();
      flash();
    } catch {
      show({ message: `Couldn't save ${code} rate`, tone: "error" });
    }
  };

  const removeRate = async (code: string) => {
    try {
      await deleteRate(code);
      invalidateRates();
    } catch {
      show({ message: `Couldn't delete ${code} rate`, tone: "error" });
    }
  };

  const addRate = async () => {
    const parsed = parseRateForm(newRateCode, newRateValue);
    if (!parsed.ok) {
      setNewRateError(parsed.error);
      return;
    }
    setNewRateError("");
    try {
      await putRate(parsed.currency, parsed.rate);
      setNewRateCode("");
      setNewRateValue("");
      invalidateRates();
      flash();
    } catch {
      show({ message: `Couldn't add ${parsed.currency} rate`, tone: "error" });
    }
  };

  return (
    <SettingsPage title="Currencies" onClose={onClose} headerRight={<SavedFlash saved={saved} />}>
      <div>
        <p className="text-xs text-muted mb-4">
          AED per 1 unit. Snapshots are taken when a transaction arrives; changing a rate only affects future and unconverted transactions.
        </p>
        <div className="space-y-3">
          {(rates.data?.rates ?? []).map((r) => (
            <div key={r.currency} className="space-y-1">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium w-12">{r.currency}</span>
                <Input
                  type="number"
                  inputMode="decimal"
                  step="0.0001"
                  min="0"
                  className="flex-1"
                  value={rateDraftFor(r.currency, String(r.rate))}
                  onChange={(e) => setRateDrafts((prev) => ({ ...prev, [r.currency]: e.target.value }))}
                  onBlur={(e) => saveRate(r.currency, e.target.value, String(r.rate))}
                />
                <IconButton label={`Delete ${r.currency} rate`} tone="danger" className="-mr-2" onClick={() => removeRate(r.currency)}>
                  <Trash2 size={16} />
                </IconButton>
              </div>
              {rateErrors[r.currency] && <p role="alert" className="text-bad text-xs">{rateErrors[r.currency]}</p>}
            </div>
          ))}

          {(rates.data?.missing ?? []).map((code) => (
            <div key={code} className="space-y-1">
              <p className="text-xs text-warn">{code} — no rate configured; these transactions are excluded from budgets</p>
              <div className="flex items-center gap-2">
                <Input
                  type="number"
                  inputMode="decimal"
                  step="0.0001"
                  min="0"
                  aria-label={`Rate for ${code}`}
                  className="flex-1"
                  value={rateDrafts[code] ?? ""}
                  onChange={(e) => setRateDrafts((prev) => ({ ...prev, [code]: e.target.value }))}
                  onBlur={(e) => saveRate(code, e.target.value)}
                />
              </div>
              {rateErrors[code] && <p role="alert" className="text-bad text-xs">{rateErrors[code]}</p>}
            </div>
          ))}

          <div className="space-y-1 pt-3 border-t border-border">
            <p className="text-sm font-medium">Add currency</p>
            <div className="flex items-center gap-2">
              <Input
                type="text"
                placeholder="USD"
                aria-label="New currency code"
                autoCapitalize="characters"
                autoCorrect="off"
                maxLength={3}
                className="!w-24"
                value={newRateCode}
                onChange={(e) => setNewRateCode(e.target.value)}
              />
              <Input
                type="number"
                inputMode="decimal"
                step="0.0001"
                min="0"
                placeholder="Rate"
                aria-label="New currency rate"
                className="flex-1"
                value={newRateValue}
                onChange={(e) => setNewRateValue(e.target.value)}
              />
              <Button variant="secondary" onClick={addRate}>Add</Button>
            </div>
            {newRateError && <p role="alert" className="text-bad text-xs">{newRateError}</p>}
          </div>
        </div>
      </div>
    </SettingsPage>
  );
}
