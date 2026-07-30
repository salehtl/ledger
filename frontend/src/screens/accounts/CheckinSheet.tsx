import { useId, useState, type FormEvent } from "react";
import { Dialog, DialogFooter } from "../../components/ui/Dialog";
import { Button } from "../../components/ui/Button";
import { Check } from "../../components/ui/PixelIcon";
import { useToast } from "../../components/Toast";
import {
  agoLabel,
  balanceLabel,
  checkinMeta,
  checkinVerdict,
  composeStated,
  verdictTitle,
  type AccountBalanceSummary,
  type CheckinResult,
  type Sign,
} from "../../lib/reconcile";
import { useAdjust, useCheckin } from "./api";
import { BalanceField } from "./BalanceField";
import { DiscrepancyCard } from "./DiscrepancyCard";

const MASK = "••••";

/** Small calm confirmation block for the happy endings. */
function Confirmation({ title, meta, hint, testid }: {
  title: string;
  meta?: string;
  hint?: string;
  testid: string;
}) {
  return (
    <div data-checkin-result={testid} className="py-2">
      <div className="flex items-center gap-2">
        <Check size={24} aria-hidden className="text-fg" />
        <p className="text-base font-semibold">{title}</p>
      </div>
      {meta && <p className="mt-1.5 font-mono text-[10px] tracking-[0.04em] text-muted tnum">{meta}</p>}
      {hint && <p className="mt-2 text-xs text-muted">{hint}</p>}
    </div>
  );
}

/**
 * The 30-second reconcile: type the balance from the bank app, ledger answers
 * with expected vs stated. A clean match ends in one line; a mismatch shows
 * the DiscrepancyCard with candidate causes and a one-tap adjustment. The
 * stated balance is persisted as the new anchor the moment the check-in
 * lands, whatever the delta.
 */
export function CheckinSheet({ account, onClose }: {
  account: AccountBalanceSummary;
  onClose: () => void;
}) {
  const a = account;
  const inputId = useId();
  const toast = useToast();
  const checkin = useCheckin(a.account_id);
  const adjust = useAdjust(a.account_id);
  const [text, setText] = useState("");
  const [sign, setSign] = useState<Sign>((a.computed_fils ?? 0) < 0 ? "neg" : "pos");
  const [result, setResult] = useState<CheckinResult | null>(null);
  const [adjusted, setAdjusted] = useState(false);

  const stated = composeStated(text, sign);
  const showParseError = text.trim() !== "" && stated === null;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (stated === null || checkin.isPending) return;
    checkin.mutate({ stated_fils: stated }, { onSuccess: setResult });
  };

  const writeAdjustment = () => {
    if (!result || adjust.isPending) return;
    adjust.mutate(
      { delta_fils: result.delta_fils },
      {
        onSuccess: () => setAdjusted(true),
        onError: (err) => toast.show({ message: `Couldn't write the adjustment — ${err.message}`, tone: "error" }),
      },
    );
  };

  const verdict = result ? checkinVerdict(result) : null;

  return (
    <Dialog title="Balance check-in" onClose={onClose}>
      <p className="mb-4 font-mono text-[10px] tracking-[0.04em] text-muted tnum">
        {a.name} · {MASK} {a.last4}
      </p>

      {result === null && (
        <form onSubmit={submit}>
          <BalanceField
            id={inputId}
            label="Balance in your bank app"
            text={text}
            onText={setText}
            sign={sign}
            onSign={setSign}
            autoFocus
            error={showParseError ? "Enter an amount like 8,250.00." : undefined}
            helper={
              a.has_checkin && a.anchor_as_of
                ? `expected ${balanceLabel(a.computed_fils ?? 0)} · last check-in ${agoLabel(a.anchor_as_of)}`
                : "First check-in — this sets the account's anchor."
            }
          />
          {checkin.isError && (
            <p role="alert" className="mt-3 text-xs text-bad">
              Couldn't check in — {checkin.error.message}. Try again.
            </p>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            <Button variant="primary" type="submit" disabled={stated === null || checkin.isPending}>
              {checkin.isPending ? "Checking…" : "Check in"}
            </Button>
          </DialogFooter>
        </form>
      )}

      {result !== null && adjusted && (
        <>
          <Confirmation
            title="Adjustment written — books match"
            meta={`${balanceLabel(result.stated_fils)} is the new anchor`}
            hint="The gap now lives as a transaction, so history and net worth stay honest."
            testid="adjusted"
          />
          <DialogFooter>
            <Button variant="primary" onClick={onClose}>Done</Button>
          </DialogFooter>
        </>
      )}

      {result !== null && !adjusted && verdict === "first" && (
        <>
          <Confirmation
            title={verdictTitle(result)}
            meta={`${balanceLabel(result.stated_fils)} anchored today`}
            hint="Future check-ins compare the bank against this point."
            testid="first"
          />
          <DialogFooter>
            <Button variant="primary" onClick={onClose}>Done</Button>
          </DialogFooter>
        </>
      )}

      {result !== null && !adjusted && verdict === "match" && (
        <>
          <Confirmation title={verdictTitle(result)} meta={checkinMeta(result)} testid="match" />
          <DialogFooter>
            <Button variant="primary" onClick={onClose}>Done</Button>
          </DialogFooter>
        </>
      )}

      {result !== null && !adjusted && (verdict === "less" || verdict === "more") && (
        <DiscrepancyCard
          result={result}
          onAdjust={writeAdjustment}
          adjustPending={adjust.isPending}
          onKeep={onClose}
        />
      )}
    </Dialog>
  );
}
