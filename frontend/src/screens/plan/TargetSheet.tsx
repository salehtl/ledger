import { useId, useState } from "react";
import { Button } from "../../components/ui/Button";
import { Dialog, DialogFooter } from "../../components/ui/Dialog";
import { Input, Select } from "../../components/ui/Field";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { useToast } from "../../components/Toast";
import {
  filsToAmountText,
  parseAmountFils,
  type Cadence,
  type Envelope,
  type TargetType,
} from "../../lib/envelope";
import { useDeleteTarget, usePutTarget, type TargetBody } from "./api";

const EXPLAINER: Record<TargetType, string> = {
  set_aside: "Add this amount to the envelope each period, whatever is left.",
  refill: "Top the envelope back up to this amount each period.",
  save_by_date: "Build up to this amount by the date, in equal monthly steps.",
};

/**
 * Target editor for one category: three target types behind a segmented
 * control, cadence for the periodic types, a native date picker for
 * save-by-date. Removing is undoable via toast (targets are one PUT away).
 */
export function TargetSheet({ envelope, month, onClose }: {
  envelope: Envelope;
  month: string;
  onClose: () => void;
}) {
  const existing = envelope.target;
  const amountId = useId();
  const cadenceId = useId();
  const dateId = useId();
  const [type, setType] = useState<TargetType>(existing?.type ?? "set_aside");
  const [amountText, setAmountText] = useState(existing ? filsToAmountText(existing.amount_fils) : "");
  const [cadence, setCadence] = useState<Cadence>(existing?.cadence ?? "monthly");
  const [dueDate, setDueDate] = useState(existing?.due_date ?? "");

  const put = usePutTarget(month);
  const remove = useDeleteTarget(month);
  const toast = useToast();

  const parsed = parseAmountFils(amountText);
  const amountOk = parsed !== null && parsed > 0;
  const dateOk = type !== "save_by_date" || dueDate !== "";
  const busy = put.isPending || remove.isPending;

  const save = () => {
    if (!amountOk || !dateOk) return;
    const body: TargetBody = { target_type: type, amount_fils: parsed!, cadence };
    if (type === "save_by_date") body.due_date = dueDate;
    put.mutate({ categoryId: envelope.category_id, body }, { onSuccess: onClose });
  };

  const removeTarget = () => {
    const old = existing;
    remove.mutate(envelope.category_id, {
      onSuccess: () => {
        toast.show({
          message: `Target removed from ${envelope.category_name}`,
          action: old
            ? {
                label: "Undo",
                onAction: () => {
                  const body: TargetBody = { target_type: old.type, amount_fils: old.amount_fils, cadence: old.cadence };
                  if (old.type === "save_by_date") body.due_date = old.due_date;
                  put.mutate({ categoryId: envelope.category_id, body });
                },
              }
            : undefined,
        });
        onClose();
      },
    });
  };

  return (
    <Dialog title={`${envelope.category_name} target`} onClose={onClose}>
      <SegmentedControl
        fullWidth
        value={type}
        onChange={setType}
        options={[
          { value: "set_aside", label: "Set aside" },
          { value: "refill", label: "Refill" },
          { value: "save_by_date", label: "By date" },
        ]}
      />
      <p className="mt-2 text-xs text-muted">{EXPLAINER[type]}</p>

      <div className="mt-4">
        <label htmlFor={amountId} className="block text-sm font-medium mb-1">Amount</label>
        <Input
          id={amountId}
          inset
          inputMode="decimal"
          autoComplete="off"
          value={amountText}
          onChange={(ev) => setAmountText(ev.target.value)}
          aria-invalid={(!amountOk && amountText.trim() !== "") || undefined}
        />
        {!amountOk && amountText.trim() !== "" && (
          <p className="mt-1 text-xs text-bad">Enter an amount like 150.00.</p>
        )}
      </div>

      {type !== "save_by_date" ? (
        <div className="mt-3">
          <label htmlFor={cadenceId} className="block text-sm font-medium mb-1">Every</label>
          <Select id={cadenceId} inset value={cadence} onChange={(ev) => setCadence(ev.target.value as Cadence)}>
            <option value="weekly">Week</option>
            <option value="monthly">Month</option>
            <option value="yearly">Year</option>
          </Select>
        </div>
      ) : (
        <div className="mt-3">
          <label htmlFor={dateId} className="block text-sm font-medium mb-1">By</label>
          <Input id={dateId} inset type="date" value={dueDate} onChange={(ev) => setDueDate(ev.target.value)} />
          {!dateOk && <p className="mt-1 text-xs text-muted">Pick the date to save toward.</p>}
        </div>
      )}

      {(put.isError || remove.isError) && (
        <p className="mt-3 text-sm text-bad" role="alert">
          Couldn't save the target — {(put.error ?? remove.error)?.message}. Try again.
        </p>
      )}

      <DialogFooter className="!justify-between">
        <div>
          {existing && (
            <Button variant="ghost" className="text-bad" onClick={removeTarget} disabled={busy}>
              Remove target
            </Button>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={save} disabled={!amountOk || !dateOk || busy}>
            {put.isPending ? "Saving…" : "Save"}
          </Button>
        </div>
      </DialogFooter>
    </Dialog>
  );
}
