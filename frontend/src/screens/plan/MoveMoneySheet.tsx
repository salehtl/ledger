import { useId, useState } from "react";
import { Button } from "../../components/ui/Button";
import { Dialog, DialogFooter } from "../../components/ui/Dialog";
import { Input } from "../../components/ui/Field";
import { Money } from "../../components/Money";
import { SectionLabel } from "../../components/ui/SectionLabel";
import { Pressable } from "../../components/ui/Pressable";
import { useToast } from "../../components/Toast";
import {
  filsLabel,
  filsToAmountText,
  movePreview,
  moveSources,
  moveSuggestionFils,
  parseAmountFils,
  type CategoryClaim,
  type Envelope,
} from "../../lib/envelope";
import { formatFils } from "../../lib/money";
import { moveMoneyOnce } from "../../api/client";
import { useMoveMoney, writeSummary } from "../../api/hooks";
import { useQueryClient } from "@tanstack/react-query";

/**
 * Two-tap move money: pick the source envelope (step 1), confirm the amount
 * (step 2, prefilled with the destination's shortfall). Both legs land in one
 * atomic server call; the toast offers Undo, which is just the reverse move.
 */
export function MoveMoneySheet({ envelopes, toId, claim, month, onClose }: {
  envelopes: Envelope[];
  /** Destination category (the envelope the user started from). */
  toId: number;
  /** Destination's upcoming-bill claim, feeding the shortfall suggestion. */
  claim?: CategoryClaim;
  month: string;
  onClose: () => void;
}) {
  const inputId = useId();
  const to = envelopes.find((e) => e.category_id === toId);
  const sources = moveSources(envelopes, toId);
  const [fromId, setFromId] = useState<number | null>(null);
  const from = fromId === null ? undefined : envelopes.find((e) => e.category_id === fromId);
  const [text, setText] = useState("");
  const move = useMoveMoney(month);
  const qc = useQueryClient();
  const toast = useToast();

  if (!to) return null;

  const parsed = parseAmountFils(text);
  const valid = parsed !== null && parsed > 0;
  const overdraws = from !== undefined && parsed !== null && parsed > from.available_fils;

  const pick = (source: Envelope) => {
    setFromId(source.category_id);
    const suggestion = moveSuggestionFils(source, to, claim);
    setText(suggestion > 0 ? filsToAmountText(suggestion) : "");
  };

  const confirm = () => {
    if (!from || parsed === null || parsed <= 0) return;
    const body = { from_category_id: from.category_id, to_category_id: to.category_id, amount_fils: parsed };
    move.mutate(body, {
      onSuccess: (_, vars) => {
        toast.show({
          // Figure-free on purpose: Toast sets its body in Sans, and §1.3
          // keeps money out of Sans; the moved numbers are already on screen.
          message: `Moved money from ${from.category_name}`,
          action: {
            label: "Undo",
            // Plain call, not move.mutate: this closure outlives the sheet,
            // and an unmounted mutation hook drops its callbacks — the undo
            // would neither write the cache nor surface a failure.
            onAction: () =>
              moveMoneyOnce(month, {
                from_category_id: vars.to_category_id,
                to_category_id: vars.from_category_id,
                amount_fils: vars.amount_fils,
              })
                .then((summary) => writeSummary(qc, summary))
                .catch(() => toast.show({ message: "Couldn't undo", tone: "error" })),
          },
        });
        onClose();
      },
    });
  };

  return (
    <Dialog title="Move money" onClose={onClose}>
      <p className="text-sm text-muted">
        To <span className="font-medium text-fg">{to.category_name}</span>
        <span className="tnum"> · available <Money fils={to.available_fils} /></span>
      </p>

      {from === undefined ? (
        <div className="mt-4">
          <SectionLabel as="h3">Take from</SectionLabel>
          {sources.length === 0 ? (
            <p className="mt-3 text-sm text-muted">
              Nothing available to move — every other envelope is spent or empty.
            </p>
          ) : (
            <ul className="mt-1 divide-y divide-border">
              {sources.map((s) => (
                <li key={s.category_id}>
                  <Pressable
                    onClick={() => pick(s)}
                    className="w-full min-h-11 py-2 flex items-center justify-between gap-3 text-left"
                  >
                    <span className="min-w-0 truncate text-sm font-medium">{s.category_name}</span>
                    <span className="tnum shrink-0"><Money fils={s.available_fils} /></span>
                  </Pressable>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <div className="mt-4">
          <div className="flex items-center justify-between gap-3">
            <p className="min-w-0 truncate text-sm">
              From <span className="font-medium">{from.category_name}</span>
              <span className="tnum text-muted"> · <Money fils={from.available_fils} /></span>
            </p>
            <Button variant="ghost" className="shrink-0 text-xs px-3" onClick={() => { setFromId(null); setText(""); }}>
              Change
            </Button>
          </div>

          <div className="mt-3">
            <label htmlFor={inputId} className="block text-sm font-medium mb-1">Amount</label>
            <Input
              id={inputId}
              inset
              inputMode="decimal"
              autoComplete="off"
              value={text}
              onChange={(ev) => setText(ev.target.value)}
              aria-invalid={(!valid && text.trim() !== "") || undefined}
            />
            {!valid && text.trim() !== "" && (
              <p className="mt-1 text-xs text-bad">Enter an amount like 150.00.</p>
            )}
          </div>

          <div className="mt-2 flex flex-wrap gap-2">
            <Button className="text-xs px-3 tnum" onClick={() => setText(filsToAmountText(from.available_fils))}>
              All · {formatFils(from.available_fils)}
            </Button>
          </div>

          {valid && (
            <p className="mt-3 font-mono text-[10px] tracking-[0.04em] text-muted tnum" data-testid="move-preview">
              {from.category_name} {filsLabel(from.available_fils)} → {filsLabel(movePreview(from, to, parsed).from_after_fils)}
              {" · "}
              {to.category_name} {filsLabel(to.available_fils)} → {filsLabel(movePreview(from, to, parsed).to_after_fils)}
            </p>
          )}
          {overdraws && (
            <p className="mt-1 text-xs text-fg">
              That's more than {from.category_name} has — it will go negative.
            </p>
          )}
        </div>
      )}

      {move.isError && (
        <p className="mt-3 text-sm text-bad" role="alert">
          Couldn't move — {move.error.message}. Try again.
        </p>
      )}

      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={confirm} disabled={!from || !valid || move.isPending}>
          {move.isPending ? "Moving…" : "Move"}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
