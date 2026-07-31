// frontend/src/components/transactions/CategorizeSheet.tsx
import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Category, Txn } from "../../api/types";
import { Money } from "../Money";
import { Dialog, DialogFooter } from "../ui/Dialog";
import { Button } from "../ui/Button";
import { Input, Select } from "../ui/Field";
import { Switch } from "../ui/Switch";
import { SectionLabel } from "../ui/SectionLabel";
import { Pressable } from "../ui/Pressable";
import { aedFils, nativeAmountTag } from "../../lib/money";
import { categoryColor } from "../../lib/categoryColor";
import { assignTxnProject, getProjects } from "../../api/client";

const BUCKET_LABEL: Record<string, string> = { income: "Income", need: "Needs", want: "Wants", saving: "Savings", excluded: "Excluded" };
const BUCKET_ORDER = ["income", "need", "want", "saving", "excluded"];

/**
 * Pick a category as a grid of tap targets grouped by bucket — no radio list.
 * The current category is preselected (recategorize reads as a change, not a
 * blank form), a search narrows long lists, and "make a rule" is one toggle.
 * Tapping the selected category deselects it; saving with no selection on a
 * categorized transaction decategorizes it (back to the review queue).
 */
export function CategorizeSheet({ txn, categories, onSubmit, onClose, onLinkRefund, onUnlinkRefund, title = "Categorize" }: {
  txn: Txn;
  categories: Category[];
  onSubmit: (body: { category_id: number | null; make_rule: boolean }) => void;
  onClose: () => void;
  onLinkRefund?: () => void;
  onUnlinkRefund?: () => void;
  title?: string;
}) {
  const [catID, setCatID] = useState<number | null>(txn.CategoryID ?? null);
  const [makeRule, setMakeRule] = useState(false);
  const [query, setQuery] = useState("");
  // Local so the picker reflects the change immediately — the txn prop is a
  // snapshot held by the parent and won't refresh while the sheet is open.
  const [projectID, setProjectID] = useState<number | null>(txn.ProjectID ?? null);

  const qc = useQueryClient();
  const projects = useQuery({ queryKey: ["projects", "active"], queryFn: () => getProjects(false) });

  const handleProjectChange = (value: string) => {
    const next = value === "" ? null : Number(value);
    const prev = projectID;
    setProjectID(next);
    void assignTxnProject(txn.ID, next)
      .then(() => {
        qc.invalidateQueries({ queryKey: ["transactions"] });
        qc.invalidateQueries({ queryKey: ["projects"] });
        qc.invalidateQueries({ queryKey: ["summary"] });
      })
      .catch(() => setProjectID(prev));
  };

  // Decategorizing an already-categorized txn counts as a change to save.
  const canSave = catID !== null || txn.CategoryID != null;

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matched = categories.filter((c) => c.IsActive && (!q || c.Name.toLowerCase().includes(q)));
    const byBucket = new Map<string, Category[]>();
    for (const c of matched) {
      const group = c.Kind === "income" ? "income" : c.Kind === "excluded" ? "excluded" : c.Bucket;
      const list = byBucket.get(group) ?? [];
      list.push(c);
      byBucket.set(group, list);
    }
    return [...byBucket.entries()].sort(
      ([a], [b]) => (BUCKET_ORDER.indexOf(a) + 1 || 99) - (BUCKET_ORDER.indexOf(b) + 1 || 99),
    );
  }, [categories, query]);

  return (
    <Dialog title={title} onClose={onClose}>
      <p className="text-sm text-muted mb-3 truncate">
        {txn.MerchantRaw || "—"} · <Money fils={(txn.Direction === "credit" ? 1 : -1) * (aedFils(txn) ?? txn.AmountFils)} />
        {nativeAmountTag(txn) ? ` · ${nativeAmountTag(txn)}` : ""}
        {aedFils(txn) === null ? " · no AED rate" : ""}
      </p>

      {txn.Direction === "credit" && !txn.RefundOfID && onLinkRefund && (
        <Button variant="secondary" className="w-full mb-3" onClick={onLinkRefund}>
          This is a refund — link the purchase
        </Button>
      )}
      {txn.RefundOfID != null && onUnlinkRefund && (
        <Button variant="secondary" className="w-full mb-3" onClick={onUnlinkRefund}>
          Unlink refund
        </Button>
      )}
      {projects.data && projects.data.length > 0 && (
        <label className="block text-sm mb-3">
          <SectionLabel as="span" className="mb-1 block">Project</SectionLabel>
          <Select inset value={projectID ?? ""} onChange={(e) => handleProjectChange(e.target.value)}>
            <option value="">None</option>
            {projects.data.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </Select>
        </label>
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
                const selected = catID === c.ID;
                return (
                  <Pressable
                    key={c.ID}
                    aria-pressed={selected}
                    onClick={() => setCatID(selected ? null : c.ID)}
                    className={`min-h-11 px-3.5 rounded-[var(--radius)] text-sm font-medium inline-flex items-center gap-2 transition-colors ${
                      selected ? "bg-accent text-accent-fg" : "bg-surface-2 text-fg hover:opacity-80"
                    }`}
                  >
                    {/* The category's own colour, not bucketColor(c.Bucket): the
                        same Groceries dot has to be the same teal here as in Plan
                        and Settings, or the colour teaches nothing. The old
                        income special-case (var(--color-good)) goes with it —
                        income categories carry a stored colour like any other.
                        Only a *transaction's* bucket mark still uses
                        bucketColor (SplitLines, TransactionRow, the detail
                        sheet), because that one reads bucket_snapshot. */}
                    <span
                      aria-hidden
                      className="w-2 h-2 rounded-[var(--radius)] shrink-0"
                      style={{ backgroundColor: selected ? "currentColor" : categoryColor(c.Color) }}
                    />
                    {c.Name}
                  </Pressable>
                );
              })}
            </div>
          </div>
        ))}
        {groups.length === 0 && <p className="text-sm text-muted">No matching categories.</p>}
      </div>

      <label className="flex items-center justify-between gap-3 my-4 text-sm">
        <span className="min-w-0">Make a rule for future “{txn.MerchantRaw || "—"}”</span>
        <Switch checked={catID !== null && makeRule} disabled={catID === null} onChange={(e) => setMakeRule(e.target.checked)} />
      </label>

      {catID === null && txn.CategoryID != null && (
        <p className="text-xs text-muted mb-4">Saving with no category moves this back to the review queue.</p>
      )}

      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button
          variant="primary"
          disabled={!canSave}
          onClick={() => canSave && onSubmit({ category_id: catID, make_rule: catID !== null && makeRule })}
        >
          Save
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
