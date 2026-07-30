import { useId, useState, type FormEvent } from "react";
import { Dialog, DialogFooter } from "../../components/ui/Dialog";
import { Button } from "../../components/ui/Button";
import { Input } from "../../components/ui/Field";
import { useToast } from "../../components/Toast";
import {
  agoLabel,
  balanceLabel,
  composeStated,
  signedAmountText,
  type AccountBalanceSummary,
  type Sign,
} from "../../lib/reconcile";
import { usePostBalance } from "../../api/hooks";
import { BalanceField } from "./BalanceField";

/**
 * Plain balance update for tracking accounts (investments, property): no
 * reconcile math, just a new point on the net-worth line. Budget accounts use
 * the check-in sheet instead. Opens prefilled with the last known balance —
 * an update is usually a small edit of it (P6: edit forms open pre-filled).
 */
export function UpdateBalanceSheet({ account, onClose }: {
  account: AccountBalanceSummary;
  onClose: () => void;
}) {
  const a = account;
  const inputId = useId();
  const noteId = useId();
  const toast = useToast();
  const post = usePostBalance(a.account_id);
  const [text, setText] = useState(
    a.has_checkin && a.anchor_fils != null ? signedAmountText(a.anchor_fils) : "",
  );
  const [sign, setSign] = useState<Sign>((a.computed_fils ?? 0) < 0 ? "neg" : "pos");
  const [touched, setTouched] = useState(false);
  const [note, setNote] = useState("");

  const balance = composeStated(text, sign);
  // Only after blur or a submit attempt — never mid-keystroke. The
  // disabled-submit guard below stays live throughout.
  const showParseError = touched && text.trim() !== "" && balance === null;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (balance === null || post.isPending) return;
    post.mutate(
      { balance_fils: balance, note: note.trim() },
      {
        onSuccess: () => {
          toast.show({ message: `${a.name} updated to ${balanceLabel(balance)}` });
          onClose();
        },
      },
    );
  };

  return (
    <Dialog title="Update balance" onClose={onClose}>
      <p className="mb-4 font-mono text-[10px] tracking-[0.04em] text-muted tnum">
        {a.name} · tracking — counts in net worth only
      </p>
      <form onSubmit={submit} className="space-y-4">
        <BalanceField
          id={inputId}
          label="Balance now"
          text={text}
          onText={setText}
          sign={sign}
          onSign={setSign}
          autoFocus
          onBlur={() => setTouched(true)}
          error={showParseError ? "Enter an amount like 50,000.00." : undefined}
          helper={
            a.has_checkin && a.anchor_as_of
              ? `last ${balanceLabel(a.anchor_fils ?? 0)} · updated ${agoLabel(a.anchor_as_of)}`
              : "First balance — this starts the account's net-worth line."
          }
        />
        <div>
          <label htmlFor={noteId} className="block text-sm font-medium mb-1.5">Note (optional)</label>
          <Input
            id={noteId}
            inset
            type="text"
            autoComplete="off"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
        {post.isError && (
          <p role="alert" className="text-xs text-bad">
            Couldn't save the balance — {post.error.message}. Try again.
          </p>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" disabled={balance === null || post.isPending}>
            {post.isPending ? "Saving…" : "Save balance"}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
