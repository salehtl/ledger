import { useState } from "react";
import type { Category } from "../../api/types";
import { Button } from "../../components/ui/Button";
import { Dialog, DialogFooter } from "../../components/ui/Dialog";
import { Input, Select } from "../../components/ui/Field";
import { SectionLabel } from "../../components/ui/SectionLabel";
import {
  INTERVAL_CHOICES,
  buildSchedulePayload,
  intervalChoice,
  type SchedulePayload,
} from "../../lib/recurring";
import type { Schedule } from "./api";

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Manual schedule sheet: create a bill that never emails, or edit any
 * schedule. Edit mode opens pre-filled (P6) and carries the lifecycle
 * controls — pause/resume plus a two-tap delete kept at the bottom, away
 * from Save (P27). Validation lives in lib/recurring's buildSchedulePayload;
 * this component only holds field state.
 */
export function ScheduleForm({ initial, categories, busy = false, onSubmit, onClose, onPauseToggle, onDelete }: {
  initial?: Schedule;
  categories: Category[];
  busy?: boolean;
  onSubmit: (payload: SchedulePayload) => void;
  onClose: () => void;
  /** Edit mode: pause an active schedule / resume a paused one. */
  onPauseToggle?: () => void;
  /** Edit mode: delete the schedule outright. */
  onDelete?: () => void;
}) {
  const [merchant, setMerchant] = useState(initial?.merchant ?? "");
  const [label, setLabel] = useState(initial?.label ?? "");
  const [amountAed, setAmountAed] = useState(initial ? (initial.amount_fils / 100).toFixed(2) : "");
  const [choice, setChoice] = useState(initial ? intervalChoice(initial.interval_days) : "30");
  const [customDays, setCustomDays] = useState(
    initial && intervalChoice(initial.interval_days) === "custom" ? String(initial.interval_days) : "",
  );
  const [nextDue, setNextDue] = useState(initial?.next_due ?? today());
  const [direction, setDirection] = useState(initial?.direction ?? "debit");
  const [categoryId, setCategoryId] = useState<number | null>(initial?.category_id ?? null);
  const [error, setError] = useState("");
  const [deleteArmed, setDeleteArmed] = useState(false);

  const editing = initial != null;
  const paused = initial?.status === "paused";

  const submit = () => {
    const res = buildSchedulePayload({
      merchant, label, amountAed,
      intervalChoice: choice, customDays,
      nextDue, direction, categoryId,
    });
    if (!res.ok) { setError(res.error); return; }
    setError("");
    onSubmit(res.payload);
  };

  return (
    <Dialog title={editing ? "Edit schedule" : "Add schedule"} onClose={onClose}>
      <div className="space-y-3">
        <label className="block text-sm">Merchant
          <Input
            inset autoCapitalize="words" autoCorrect="off" enterKeyHint="next"
            value={merchant} onChange={(e) => setMerchant(e.target.value)}
            placeholder="e.g. Gym Co"
          />
          <span className="block font-mono text-[10px] tracking-[0.04em] text-muted mt-1">
            matches arriving bank emails, when the bill emails at all
          </span>
        </label>
        <label className="block text-sm">Label (optional)
          <Input
            inset autoCapitalize="sentences" autoCorrect="off" enterKeyHint="next"
            value={label} onChange={(e) => setLabel(e.target.value)}
            placeholder="e.g. Gym membership"
          />
        </label>
        <label className="block text-sm">Amount (AED)
          <Input
            inset type="number" inputMode="decimal" min="0" step="0.01"
            value={amountAed} onChange={(e) => setAmountAed(e.target.value)}
          />
        </label>
        <label className="block text-sm">Repeats
          <Select inset value={choice} onChange={(e) => setChoice(e.target.value)}>
            {INTERVAL_CHOICES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
          </Select>
        </label>
        {choice === "custom" && (
          <label className="block text-sm">Days between charges
            <Input
              inset type="number" inputMode="numeric" min="1" step="1"
              value={customDays} onChange={(e) => setCustomDays(e.target.value)}
            />
          </label>
        )}
        <label className="block text-sm">Next due
          <Input inset type="date" value={nextDue} onChange={(e) => setNextDue(e.target.value)} />
        </label>
        <label className="block text-sm">Direction
          <Select inset value={direction} onChange={(e) => setDirection(e.target.value)}>
            <option value="debit">Debit (money out)</option>
            <option value="credit">Credit (money in)</option>
          </Select>
        </label>
        <label className="block text-sm">Category (optional)
          <Select inset value={categoryId ?? ""} onChange={(e) => setCategoryId(e.target.value ? Number(e.target.value) : null)}>
            <option value="">Uncategorized</option>
            {categories.map((c) => <option key={c.ID} value={c.ID}>{c.Name}</option>)}
          </Select>
        </label>
        {error && <p role="alert" className="text-bad text-sm">{error}</p>}

        {editing && (onPauseToggle || onDelete) && (
          <div className="pt-2 space-y-2 border-t border-border">
            <SectionLabel>Manage</SectionLabel>
            {onPauseToggle && (
              <Button variant="secondary" className="w-full" disabled={busy} onClick={onPauseToggle}>
                {paused ? "Resume tracking" : "Pause tracking"}
              </Button>
            )}
            {paused && (
              <p className="font-mono text-[10px] tracking-[0.04em] text-muted">
                paused schedules stop matching emails and leave the upcoming feed
              </p>
            )}
            {onDelete && (
              <Button
                variant="ghost"
                className="w-full text-bad"
                disabled={busy}
                onClick={() => { if (deleteArmed) onDelete(); else setDeleteArmed(true); }}
              >
                {deleteArmed ? "Tap again to delete" : "Delete schedule"}
              </Button>
            )}
          </div>
        )}
      </div>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={busy} onClick={submit}>{editing ? "Save" : "Add"}</Button>
      </DialogFooter>
    </Dialog>
  );
}
