import { useMemo, useState } from "react";
import { X } from "lucide-react";
import { EMPTY_FILTERS, filtersActive, sourceLabel, type TxnFilters } from "../../lib/transactions";
import { SectionLabel } from "../ui/SectionLabel";
import { bucketColor } from "../../lib/insights";
import type { Category, Txn } from "../../api/types";

const BUCKET_OPTS = [
  { value: "need", label: "Needs" },
  { value: "want", label: "Wants" },
  { value: "saving", label: "Savings" },
];
const DIRECTION_OPTS = [
  { value: "debit", label: "Spending" },
  { value: "credit", label: "Income" },
];
const BUCKET_LABEL: Record<string, string> = { need: "Needs", want: "Wants", saving: "Savings" };
const DIRECTION_LABEL: Record<string, string> = { debit: "Spending", credit: "Income" };

/** A tap-to-toggle filter chip — the whole filter surface is these, no sheets. */
function Chip({ label, active, dot, onClick }: { label: string; active: boolean; dot?: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-md text-sm font-medium whitespace-nowrap press transition-colors ${
        active ? "bg-accent/10 text-accent" : "bg-surface-2 text-muted hover:text-fg"
      }`}
    >
      {dot && <span aria-hidden className="w-2 h-2 rounded-full shrink-0" style={{ background: dot }} />}
      {label}
    </button>
  );
}

/**
 * Inline, in-place filtering: bucket / type / category / source are all direct
 * toggle chips — no per-dimension bottom sheet. Selected filters surface as
 * removable tokens that stay visible whether or not the panel is open, so the
 * active scope is always legible at a glance.
 */
export function FilterBar({ filters, categories, txns, open, onChange }: {
  filters: TxnFilters;
  categories: Category[];
  txns: Txn[];
  open: boolean;
  onChange: (f: TxnFilters) => void;
}) {
  const [catQuery, setCatQuery] = useState("");

  const sources = useMemo(() => {
    const set = new Set<string>();
    for (const t of txns) if (t.Source) set.add(t.Source);
    return [...set].sort();
  }, [txns]);

  const activeCats = useMemo(
    () => categories.filter((c) => c.IsActive),
    [categories],
  );
  const catName = useMemo(() => new Map(categories.map((c) => [c.ID, c.Name])), [categories]);
  const shownCats = useMemo(() => {
    const q = catQuery.trim().toLowerCase();
    return q ? activeCats.filter((c) => c.Name.toLowerCase().includes(q)) : activeCats;
  }, [activeCats, catQuery]);

  const toggle = <T,>(list: T[], value: T): T[] =>
    list.includes(value) ? list.filter((v) => v !== value) : [...list, value];

  const active = filtersActive(filters);

  // Flat list of active selections, each with how to remove it, for the token row.
  const tokens = [
    ...filters.buckets.map((b) => ({ key: `b${b}`, label: BUCKET_LABEL[b] ?? b, remove: () => onChange({ ...filters, buckets: filters.buckets.filter((v) => v !== b) }) })),
    ...filters.directions.map((d) => ({ key: `d${d}`, label: DIRECTION_LABEL[d] ?? d, remove: () => onChange({ ...filters, directions: filters.directions.filter((v) => v !== d) }) })),
    ...filters.categoryIds.map((id) => ({ key: `c${id}`, label: catName.get(id) ?? `#${id}`, remove: () => onChange({ ...filters, categoryIds: filters.categoryIds.filter((v) => v !== id) }) })),
    ...filters.sources.map((s) => ({ key: `s${s}`, label: sourceLabel(s), remove: () => onChange({ ...filters, sources: filters.sources.filter((v) => v !== s) }) })),
  ];

  return (
    <div className="space-y-2">
      {active > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {tokens.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={t.remove}
              className="inline-flex items-center gap-1 pl-2.5 pr-1.5 py-1 rounded-full text-xs font-medium bg-accent/10 text-accent press"
              aria-label={`Remove ${t.label} filter`}
            >
              {t.label}
              <X size={13} aria-hidden />
            </button>
          ))}
          <button
            type="button"
            onClick={() => onChange(EMPTY_FILTERS)}
            className="text-xs font-medium text-muted hover:text-fg px-1.5 py-1 press"
          >
            Clear all
          </button>
        </div>
      )}

      {open && (
        <div className="rounded-[var(--radius-card)] border border-border p-3 space-y-4">
          <section>
            <SectionLabel className="mb-2">Bucket</SectionLabel>
            <div className="flex flex-wrap gap-2">
              {BUCKET_OPTS.map((o) => (
                <Chip
                  key={o.value}
                  label={o.label}
                  dot={bucketColor(o.value)}
                  active={filters.buckets.includes(o.value)}
                  onClick={() => onChange({ ...filters, buckets: toggle(filters.buckets, o.value) })}
                />
              ))}
            </div>
          </section>

          <section>
            <SectionLabel className="mb-2">Type</SectionLabel>
            <div className="flex flex-wrap gap-2">
              {DIRECTION_OPTS.map((o) => (
                <Chip
                  key={o.value}
                  label={o.label}
                  active={filters.directions.includes(o.value)}
                  onClick={() => onChange({ ...filters, directions: toggle(filters.directions, o.value) })}
                />
              ))}
            </div>
          </section>

          {activeCats.length > 0 && (
            <section>
              <SectionLabel className="mb-2">Category</SectionLabel>
              {activeCats.length > 8 && (
                <input
                  type="search"
                  enterKeyHint="search"
                  autoCorrect="off"
                  placeholder="Filter categories…"
                  value={catQuery}
                  onChange={(e) => setCatQuery(e.target.value)}
                  className="w-full min-h-11 mb-2 px-3 rounded-md border border-border bg-surface-2 text-base"
                />
              )}
              <div className="flex flex-wrap gap-2 max-h-44 overflow-y-auto overscroll-contain">
                {shownCats.map((c) => (
                  <Chip
                    key={c.ID}
                    label={c.Name}
                    dot={bucketColor(c.Bucket)}
                    active={filters.categoryIds.includes(c.ID)}
                    onClick={() => onChange({ ...filters, categoryIds: toggle(filters.categoryIds, c.ID) })}
                  />
                ))}
                {shownCats.length === 0 && <p className="text-sm text-muted py-1">No matching categories.</p>}
              </div>
            </section>
          )}

          {sources.length > 0 && (
            <section>
              <SectionLabel className="mb-2">Source</SectionLabel>
              <div className="flex flex-wrap gap-2">
                {sources.map((s) => (
                  <Chip
                    key={s}
                    label={sourceLabel(s)}
                    active={filters.sources.includes(s)}
                    onClick={() => onChange({ ...filters, sources: toggle(filters.sources, s) })}
                  />
                ))}
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
