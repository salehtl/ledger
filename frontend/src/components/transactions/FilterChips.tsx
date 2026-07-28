import { useMemo, useState } from "react";
import { ChevronDown, X } from "../ui/PixelIcon";
import { Dialog, DialogFooter } from "../ui/Dialog";
import { Button } from "../ui/Button";
import { EMPTY_FILTERS, filtersActive, sourceLabel, type TxnFilters } from "../../lib/transactions";
import type { Category, Txn } from "../../api/types";

type Dim = "bucket" | "category" | "direction" | "source";

const BUCKET_OPTS = [
  { value: "need", label: "Needs" },
  { value: "want", label: "Wants" },
  { value: "saving", label: "Savings" },
];
const DIRECTION_OPTS = [
  { value: "debit", label: "Spending" },
  { value: "credit", label: "Income" },
];

interface DimConfig {
  key: Dim;
  label: string;
  options: { value: string; label: string }[];
  selected: string[];
  onChange: (next: string[]) => void;
}

export function FilterChips({ filters, categories, txns, onChange }: {
  filters: TxnFilters;
  categories: Category[];
  txns: Txn[];
  onChange: (f: TxnFilters) => void;
}) {
  const [open, setOpen] = useState<Dim | null>(null);

  const sources = useMemo(() => {
    const set = new Set<string>();
    for (const t of txns) if (t.Source) set.add(t.Source);
    return [...set].sort();
  }, [txns]);

  const dims: DimConfig[] = [
    {
      key: "bucket", label: "Bucket", options: BUCKET_OPTS,
      selected: filters.buckets,
      onChange: (next) => onChange({ ...filters, buckets: next }),
    },
    {
      key: "category", label: "Category",
      options: categories.filter((c) => c.IsActive).map((c) => ({ value: String(c.ID), label: c.Name })),
      selected: filters.categoryIds.map(String),
      onChange: (next) => onChange({ ...filters, categoryIds: next.map(Number) }),
    },
    {
      key: "direction", label: "Direction", options: DIRECTION_OPTS,
      selected: filters.directions,
      onChange: (next) => onChange({ ...filters, directions: next }),
    },
    {
      key: "source", label: "Source",
      options: sources.map((s) => ({ value: s, label: sourceLabel(s) })),
      selected: filters.sources,
      onChange: (next) => onChange({ ...filters, sources: next }),
    },
  ];

  const current = dims.find((d) => d.key === open) ?? null;
  const active = filtersActive(filters);

  const toggle = (dim: DimConfig, value: string) => {
    const next = dim.selected.includes(value)
      ? dim.selected.filter((v) => v !== value)
      : [...dim.selected, value];
    dim.onChange(next);
  };

  return (
    <div className="flex items-center gap-2 overflow-x-auto pb-1 -mx-1 px-1">
      {dims.map((d) => {
        const count = d.selected.length;
        return (
          <button
            key={d.key}
            onClick={() => setOpen(d.key)}
            aria-expanded={open === d.key}
            className={`flex items-center gap-1 px-3.5 py-2 rounded-[var(--radius)] text-sm font-medium whitespace-nowrap transition-colors press ${
              count > 0 ? "bg-accent/10 text-fg" : "bg-surface-2 text-muted"
            }`}
          >
            {d.label}{count > 0 ? ` · ${count}` : ""}
            <ChevronDown size={14} aria-hidden />
          </button>
        );
      })}

      {active > 0 && (
        <button
          onClick={() => onChange(EMPTY_FILTERS)}
          className="flex items-center gap-1 px-3.5 py-2 rounded-[var(--radius)] text-sm font-medium text-muted whitespace-nowrap press hover:text-fg"
        >
          <X size={14} aria-hidden /> Clear
        </button>
      )}

      {current && (
        <Dialog title={current.label} onClose={() => setOpen(null)}>
          {current.options.length === 0 ? (
            <p className="text-sm text-muted py-2">No options available.</p>
          ) : (
            <ul className="space-y-1">
              {current.options.map((o) => (
                <li key={o.value}>
                  <label className="flex items-center gap-3 px-2 py-3 rounded-[var(--radius)] hover:bg-surface-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={current.selected.includes(o.value)}
                      onChange={() => toggle(current, o.value)}
                      className="h-5 w-5 accent-accent"
                    />
                    <span className="text-sm">{o.label}</span>
                  </label>
                </li>
              ))}
            </ul>
          )}
          <DialogFooter className="justify-between">
            <Button variant="ghost" onClick={() => current.onChange([])} disabled={current.selected.length === 0}>
              Clear
            </Button>
            <Button variant="primary" onClick={() => setOpen(null)}>Done</Button>
          </DialogFooter>
        </Dialog>
      )}
    </div>
  );
}
