// frontend/src/components/transactions/CategorizeSheet.tsx
import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Category, Txn } from "../../api/types";
import { Money } from "../Money";
import { Dialog } from "../ui/Dialog";
import { Button } from "../ui/Button";
import { Input, Select } from "../ui/Field";
import { Switch } from "../ui/Switch";
import { SectionLabel } from "../ui/SectionLabel";
import { aedFils, nativeAmountTag } from "../../lib/money";
import { bucketColor } from "../../lib/insights";
import { assignTxnProject, getProjects } from "../../api/client";

const BUCKET_LABEL: Record<string, string> = { need: "Needs", want: "Wants", saving: "Savings" };
const BUCKET_ORDER = ["need", "want", "saving"];

/**
 * Pick a category as a grid of tap targets grouped by bucket — no radio list.
 * The current category is preselected (recategorize reads as a change, not a
 * blank form), a search narrows long lists, and "make a rule" is one toggle.
 */
export function CategorizeSheet({ txn, categories, onSubmit, onClose, onLinkRefund, onUnlinkRefund }: {
  txn: Txn;
  categories: Category[];
  onSubmit: (body: { category_id: number; make_rule: boolean }) => void;
  onClose: () => void;
  onLinkRefund?: () => void;
  onUnlinkRefund?: () => void;
}) {
  const [catID, setCatID] = useState<number | null>(txn.CategoryID ?? null);
  const [makeRule, setMakeRule] = useState(false);
  const [query, setQuery] = useState("");

  const qc = useQueryClient();
  const projects = useQuery({ queryKey: ["projects", "active"], queryFn: () => getProjects(false) });

  const handleProjectChange = (value: string) => {
    const projectId = value === "" ? null : Number(value);
    void assignTxnProject(txn.ID, projectId)
      .then(() => {
        qc.invalidateQueries({ queryKey: ["transactions"] });
        qc.invalidateQueries({ queryKey: ["projects"] });
        qc.invalidateQueries({ queryKey: ["summary"] });
      })
      .catch(() => {});
  };

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matched = categories.filter((c) => c.IsActive && (!q || c.Name.toLowerCase().includes(q)));
    const byBucket = new Map<string, Category[]>();
    for (const c of matched) {
      const list = byBucket.get(c.Bucket) ?? [];
      list.push(c);
      byBucket.set(c.Bucket, list);
    }
    return [...byBucket.entries()].sort(
      ([a], [b]) => (BUCKET_ORDER.indexOf(a) + 1 || 99) - (BUCKET_ORDER.indexOf(b) + 1 || 99),
    );
  }, [categories, query]);

  return (
    <Dialog title="Categorize" onClose={onClose}>
      <p className="text-sm text-muted mb-3 truncate">
        {txn.MerchantRaw || "—"} · <Money fils={-(aedFils(txn) ?? txn.AmountFils)} />
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
          <Select inset value={txn.ProjectID ?? ""} onChange={(e) => handleProjectChange(e.target.value)}>
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
                  <button
                    key={c.ID}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => setCatID(c.ID)}
                    className={`min-h-11 px-3.5 rounded-lg text-sm font-medium inline-flex items-center gap-2 press transition-colors ${
                      selected ? "bg-accent text-accent-fg" : "bg-surface-2 text-fg hover:opacity-80"
                    }`}
                  >
                    <span
                      aria-hidden
                      className="w-2 h-2 rounded-full shrink-0"
                      style={{ background: selected ? "currentColor" : bucketColor(c.Bucket) }}
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

      <label className="flex items-center justify-between gap-3 my-4 text-sm">
        <span className="min-w-0">Make a rule for future “{txn.MerchantRaw || "—"}”</span>
        <Switch checked={makeRule} onChange={(e) => setMakeRule(e.target.checked)} />
      </label>

      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={catID === null} onClick={() => catID !== null && onSubmit({ category_id: catID, make_rule: makeRule })}>
          Save
        </Button>
      </div>
    </Dialog>
  );
}
