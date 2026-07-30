// frontend/src/components/transactions/SplitSheet.tsx
import { useMemo, useState } from "react";
import type { Category } from "../../api/types";
import { Money } from "../Money";
import { Dialog, DialogFooter } from "../ui/Dialog";
import { Button } from "../ui/Button";
import { Input } from "../ui/Field";
import { IconButton } from "../ui/IconButton";
import { SectionLabel } from "../ui/SectionLabel";
import { X } from "../ui/PixelIcon";
import { aedFils, formatFils, nativeAmountTag } from "../../lib/money";
import { bucketColor } from "../../lib/insights";
import {
  absorbRemainder,
  displayMerchant,
  draftAmounts,
  draftFromSplits,
  eligibleSplitCategories,
  evenAmounts,
  filsToAmountText,
  isSplitTxn,
  parseAmountToFils,
  splitAmountLabel,
  splitRemainder,
  validateSplitDraft,
  type SplitDraftLine,
  type SplitLineBody,
  type TxnDepth,
} from "../../lib/txSplit";

const BUCKET_LABEL: Record<string, string> = { income: "Income", need: "Needs", want: "Wants", saving: "Savings" };
const BUCKET_ORDER = ["income", "need", "want", "saving"];

/**
 * Divide one transaction across categories, integer-fils exact against the
 * parent's own currency. Categories toggle on a bucket-grouped chip grid
 * (CategorizeSheet's pattern, rebuilt here per the piece contract); each
 * selected category becomes a line with an amount + optional note. The
 * remainder is live; "add the rest" puts it on the last line, "split evenly"
 * floors and lets the last line absorb the rounding. Only categories the
 * server would accept appear (active; spending for debits, + income for
 * credits). Saving with no lines removes the split — the parent returns to
 * the review queue, and the sheet says so before it happens.
 */
export function SplitSheet({ txn, categories, onSubmit, onClose }: {
  txn: TxnDepth;
  categories: Category[];
  /** Receives the validated wire body; [] means un-split. Async submits keep
   *  the sheet open (input preserved) until the parent closes it. */
  onSubmit: (splits: SplitLineBody[]) => void | Promise<void>;
  onClose: () => void;
}) {
  const wasSplit = isSplitTxn(txn);
  const [lines, setLines] = useState<SplitDraftLine[]>(() => draftFromSplits(txn.Splits));
  const [query, setQuery] = useState("");
  const [saving, setSaving] = useState(false);

  const eligible = useMemo(() => eligibleSplitCategories(categories, txn.Direction), [categories, txn.Direction]);
  const byId = useMemo(() => new Map(eligible.map((c) => [c.ID, c])), [eligible]);
  const amounts = draftAmounts(lines);
  const remainder = splitRemainder(txn.AmountFils, amounts);
  const validation = validateSplitDraft({ amountFils: txn.AmountFils, direction: txn.Direction }, lines, categories);
  const canSave = validation.ok && (!validation.unsplit || wasSplit) && !saving;

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matched = eligible.filter((c) => !q || c.Name.toLowerCase().includes(q));
    const byBucket = new Map<string, Category[]>();
    for (const c of matched) {
      const group = c.Kind === "income" ? "income" : c.Bucket;
      const list = byBucket.get(group) ?? [];
      list.push(c);
      byBucket.set(group, list);
    }
    return [...byBucket.entries()].sort(
      ([a], [b]) => (BUCKET_ORDER.indexOf(a) + 1 || 99) - (BUCKET_ORDER.indexOf(b) + 1 || 99),
    );
  }, [eligible, query]);

  const toggle = (id: number) => {
    setLines((prev) => {
      const at = prev.findIndex((l) => l.categoryId === id);
      if (at >= 0) return prev.filter((_, i) => i !== at);
      // Prefill a new line with whatever is still unplaced, so the common
      // two-way split is: pick A, trim its amount, pick B — done.
      const left = splitRemainder(txn.AmountFils, draftAmounts(prev));
      return [...prev, { categoryId: id, amountText: left > 0 ? filsToAmountText(left) : "", note: "" }];
    });
  };

  const setLine = (index: number, patch: Partial<SplitDraftLine>) => {
    setLines((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  };

  const absorb = () => {
    const last = lines.length - 1;
    const value = absorbRemainder(txn.AmountFils, amounts, last);
    if (value !== null) setLine(last, { amountText: filsToAmountText(value) });
  };

  const splitEvenly = () => {
    const parts = evenAmounts(txn.AmountFils, lines.length);
    setLines((prev) => prev.map((l, i) => ({ ...l, amountText: filsToAmountText(parts[i]) })));
  };

  const save = async () => {
    if (!validation.ok || saving) return;
    setSaving(true);
    try {
      await onSubmit(validation.body);
    } finally {
      setSaving(false);
    }
  };

  const lastName = lines.length > 0 ? byId.get(lines[lines.length - 1].categoryId)?.Name : undefined;
  const canAbsorb =
    remainder !== 0 && lines.length > 0 && absorbRemainder(txn.AmountFils, amounts, lines.length - 1) !== null;

  return (
    <Dialog title={wasSplit ? "Edit split" : "Split transaction"} onClose={onClose}>
      <p className="text-sm text-muted mb-3 truncate">
        {displayMerchant(txn) || "—"} · <Money fils={(txn.Direction === "credit" ? 1 : -1) * (aedFils(txn) ?? txn.AmountFils)} />
        {nativeAmountTag(txn) ? ` · ${nativeAmountTag(txn)}` : ""}
      </p>

      {lines.length > 0 && (
        <div className="space-y-2 mb-3">
          {lines.map((line, i) => {
            const cat = byId.get(line.categoryId);
            const parsed = parseAmountToFils(line.amountText);
            const bad = line.amountText.trim() !== "" && (parsed === null || parsed === 0);
            return (
              <div key={line.categoryId} className="border border-border rounded-[var(--radius)] p-3">
                <div className="flex items-center justify-between gap-2 mb-2">
                  <span className="inline-flex items-center gap-1.5 min-w-0 font-mono text-xs tracking-[0.04em]">
                    <span
                      aria-hidden
                      className="w-2 h-2 rounded-[var(--radius)] shrink-0"
                      style={{ background: cat?.Kind === "income" ? "var(--color-good)" : bucketColor(cat?.Bucket ?? "") }}
                    />
                    <span className="truncate">{cat?.Name ?? "—"}</span>
                  </span>
                  <IconButton size="sm" label={`Remove ${cat?.Name ?? "line"}`} className="-mr-1.5" onClick={() => toggle(line.categoryId)}>
                    <X size={16} />
                  </IconButton>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <label className="block min-w-0">
                    <SectionLabel as="span" className="mb-1 block">Amount</SectionLabel>
                    <Input
                      inset
                      inputMode="decimal"
                      autoComplete="off"
                      value={line.amountText}
                      onChange={(e) => setLine(i, { amountText: e.target.value })}
                      aria-label={`Amount for ${cat?.Name ?? "line"}`}
                      aria-invalid={bad || undefined}
                      className="tnum"
                    />
                  </label>
                  <label className="block min-w-0">
                    <SectionLabel as="span" className="mb-1 block">Note · optional</SectionLabel>
                    <Input
                      inset
                      autoCapitalize="sentences"
                      value={line.note}
                      onChange={(e) => setLine(i, { note: e.target.value })}
                      aria-label={`Note for ${cat?.Name ?? "line"}`}
                    />
                  </label>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {lines.length === 0 ? (
        wasSplit ? (
          <p className="text-sm text-muted mb-3" data-testid="unsplit-note">
            No lines left. Saving removes the split and sends this back to the review queue to recategorize.
          </p>
        ) : (
          <p className="text-sm text-muted mb-3">
            Pick the categories this covers — each becomes a line with its share of{" "}
            <span className="tnum">{splitAmountLabel(txn.AmountFils, txn.Currency)}</span>.
          </p>
        )
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
          <p
            className={`font-mono text-xs tracking-[0.04em] tnum ${remainder < 0 ? "text-bad" : "text-muted"}`}
            role="status"
          >
            {remainder > 0 && `${formatFils(remainder)} left to place`}
            {remainder === 0 && "Adds up exactly"}
            {remainder < 0 && `${formatFils(-remainder)} over the total`}
          </p>
          <div className="flex items-center gap-2 shrink-0">
            {canAbsorb && lastName && (
              <Button className="text-xs px-3" onClick={absorb}>
                {remainder > 0 ? `Add the rest to ${lastName}` : `Balance on ${lastName}`}
              </Button>
            )}
            {lines.length >= 2 && (
              <Button className="text-xs px-3" onClick={splitEvenly}>Split evenly</Button>
            )}
          </div>
        </div>
      )}

      <Input
        inset
        type="search"
        enterKeyHint="search"
        autoCorrect="off"
        placeholder="Search categories…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        className="mb-3"
      />

      <div className="space-y-4">
        {groups.map(([bucket, list]) => (
          <div key={bucket}>
            <SectionLabel className="mb-2">{BUCKET_LABEL[bucket] ?? bucket}</SectionLabel>
            <div className="flex flex-wrap gap-2">
              {list.map((c) => {
                const selected = lines.some((l) => l.categoryId === c.ID);
                return (
                  <button
                    key={c.ID}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => toggle(c.ID)}
                    className={`min-h-11 px-3.5 rounded-[var(--radius)] text-sm font-medium inline-flex items-center gap-2 press transition-colors ${
                      selected ? "bg-accent text-accent-fg" : "bg-surface-2 text-fg hover:opacity-80"
                    }`}
                  >
                    <span
                      aria-hidden
                      className="w-2 h-2 rounded-[var(--radius)] shrink-0"
                      style={{ background: selected ? "currentColor" : c.Kind === "income" ? "var(--color-good)" : bucketColor(c.Bucket) }}
                    />
                    {c.Name}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
        {groups.length === 0 && <p className="text-sm text-muted">No matching categories.</p>}
      </div>

      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={!canSave} onClick={() => void save()}>
          {saving ? "Saving…" : validation.ok && validation.unsplit && wasSplit ? "Remove split" : "Save split"}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
