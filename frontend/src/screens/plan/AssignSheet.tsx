import { useId, useState } from "react";
import { Button } from "../../components/ui/Button";
import { Dialog, DialogFooter } from "../../components/ui/Dialog";
import { Input } from "../../components/ui/Field";
import { bucketColor } from "../../lib/insights";
import {
  assignPreview,
  claimShort,
  claimText,
  filsLabel,
  filsToAmountText,
  isOverspent,
  neededLabel,
  parseAmountFils,
  targetLabel,
  type CategoryClaim,
  type Envelope,
} from "../../lib/envelope";
import { formatFils } from "../../lib/money";
import { useAssignEnvelopes } from "../../api/hooks";

/** One mono ledger line inside the sheet's math block. */
function MathRow({ label, fils, strong = false }: { label: string; fils: number; strong?: boolean }) {
  return (
    <>
      <span className={strong ? "font-medium text-fg" : "text-muted"}>{label}</span>
      {/* filsLabel, not formatFils: this is a ledger of amounts, where zero is
          a real figure. formatFils prints "—" for 0, which turned a fresh
          envelope's whole math block into a column of em dashes. */}
      <span className={`text-right ${strong ? "font-medium" : ""} ${strong && fils < 0 ? "text-bad" : ""}`}>
        {filsLabel(fils)}
      </span>
    </>
  );
}

/**
 * The per-envelope sheet: the envelope's ledger math, an absolute "assigned
 * this month" input with smart prefill chips, and the doors to Move Money and
 * the target editor. Saving posts the absolute assignment; the fresh summary
 * lands in the cache so every number on the screen moves at once.
 */
export function AssignSheet({ envelope, claim, month, canMoveIn, onClose, onMoveMoney, onEditTarget }: {
  envelope: Envelope;
  claim?: CategoryClaim;
  month: string;
  /** Whether any other envelope has money to take (enables "Move money in"). */
  canMoveIn: boolean;
  onClose: () => void;
  onMoveMoney: () => void;
  onEditTarget: () => void;
}) {
  const e = envelope;
  const inputId = useId();
  const [text, setText] = useState(filsToAmountText(e.assigned_fils));
  const parsed = parseAmountFils(text);
  const invalid = parsed === null;
  const assign = useAssignEnvelopes(month);

  const overspentBy = isOverspent(e) ? -e.available_fils : 0;
  const targetAsk = e.target && !e.target.funded ? e.target.still_needed_fils : 0;
  const billShort = claim ? claimShort(claim, e.available_fils) : 0;

  const chips: { label: string; fils: number }[] = [];
  if (targetAsk > 0) chips.push({ label: `Fund target · ${formatFils(targetAsk)}`, fils: e.assigned_fils + targetAsk });
  if (overspentBy > 0) chips.push({ label: `Cover overspend · ${formatFils(overspentBy)}`, fils: e.assigned_fils + overspentBy });
  if (billShort > 0 && billShort !== targetAsk) {
    chips.push({ label: `Cover bills · ${formatFils(billShort)}`, fils: e.assigned_fils + billShort });
  }

  const save = () => {
    if (parsed === null) return;
    assign.mutate([{ category_id: e.category_id, assigned_fils: parsed }], { onSuccess: onClose });
  };

  return (
    <Dialog
      title={e.category_name}
      titleAdornment={
        <span aria-hidden className="w-2.5 h-2.5 shrink-0 rounded-[var(--radius)]" style={{ background: bucketColor(e.bucket) }} />
      }
      onClose={onClose}
    >
      <div className="grid grid-cols-2 gap-y-1 font-mono text-xs tracking-[0.04em] tnum" data-testid="envelope-math">
        <MathRow label="carried over" fils={e.carryover_fils} />
        <MathRow label="assigned" fils={e.assigned_fils} />
        <MathRow label="spent" fils={e.activity_fils} />
        <MathRow label="available" fils={e.available_fils} strong />
      </div>

      {e.target && (
        <p className="mt-2 font-mono text-[10px] tracking-[0.04em] text-muted tnum">
          {targetLabel(e.target)} · {neededLabel(e.target)}
        </p>
      )}
      {claim && (
        <p className="mt-1 font-mono text-[10px] tracking-[0.04em] text-muted tnum">{claimText(claim)}</p>
      )}

      <div className="mt-4">
        <label htmlFor={inputId} className="block text-sm font-medium mb-1">Assigned this month</label>
        <Input
          id={inputId}
          inset
          inputMode="decimal"
          autoComplete="off"
          value={text}
          onChange={(ev) => setText(ev.target.value)}
          aria-invalid={invalid || undefined}
        />
        {invalid && text.trim() !== "" && (
          <p className="mt-1 text-xs text-bad">Enter an amount like 150.00.</p>
        )}
        {!invalid && parsed !== e.assigned_fils && (
          <p className="mt-1 text-xs text-muted tnum">available becomes {filsLabel(assignPreview(e, parsed))}</p>
        )}
      </div>

      {chips.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-2">
          {chips.map((c) => (
            <Button key={c.label} className="text-xs px-3 tnum" onClick={() => setText(filsToAmountText(c.fils))}>
              {c.label}
            </Button>
          ))}
        </div>
      )}

      <div className="mt-4 grid grid-cols-2 gap-2">
        <Button onClick={onMoveMoney} disabled={!canMoveIn}>Move money in</Button>
        <Button onClick={onEditTarget}>{e.target ? "Edit target" : "Set target"}</Button>
      </div>

      {assign.isError && (
        <p className="mt-3 text-sm text-bad" role="alert">
          Couldn't save — {assign.error.message}. Try again.
        </p>
      )}

      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={save} disabled={invalid || assign.isPending}>
          {assign.isPending ? "Saving…" : "Save"}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
