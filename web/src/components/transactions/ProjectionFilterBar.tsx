import { useMemo, useState } from "react";
import { X } from "../ui/PixelIcon";
import { SectionLabel } from "../ui/SectionLabel";
import { Pressable } from "../ui/Pressable";
import { bucketColor } from "../../lib/insights";
import { DEFAULT_BUDGET_MAPPING } from "../../v2/sources/budget";
import {
  EMPTY_FILTERS,
  filtersActive,
  withFilterToggled,
  type TxnFacets,
  type TxnFilters,
  type TxnFlag,
} from "../../v2/sources/transactions";

/**
 * The filter strip, over what the projection actually contains.
 *
 * Same surface as v1's `FilterBar` — inline toggle chips, no per-dimension
 * sheet, selected values as removable tokens — with two differences that come
 * from the data rather than from taste:
 *
 *   - **the values are facets, not a category table.** v1 listed every active
 *     category from `/api/categories`; a v2 category is just the string on a
 *     transaction, so the chips are the distinct values actually present
 *     (`TxnSource.facets`), which includes `null` — "Uncategorized" — as a real
 *     selectable value rather than as the absence of one.
 *   - **there is no bucket dimension.** A bucket is a mapping applied at read
 *     time (`sources/budget.ts`), not a column, so filtering on one would mean
 *     re-deriving that mapping in SQL. Currency and the row flags take its
 *     place, and both are columns.
 */
const DIRECTION_OPTS = [
  { value: "debit" as const, label: "Spending" },
  { value: "credit" as const, label: "Income" },
];
const FLAG_OPTS: { value: TxnFlag; label: string }[] = [
  { value: "needs_review", label: "Needs review" },
  { value: "unparsed", label: "Couldn't read" },
  { value: "possible_duplicate", label: "Possible duplicate" },
  { value: "split", label: "Split" },
];
const DIRECTION_LABEL: Record<string, string> = { debit: "Spending", credit: "Income" };
const FLAG_LABEL: Record<string, string> = Object.fromEntries(FLAG_OPTS.map((o) => [o.value, o.label]));
const UNCATEGORIZED = "Uncategorized";

function dotFor(category: string | null): string | undefined {
  if (category === null) return undefined;
  const bucket = DEFAULT_BUDGET_MAPPING.categories[category.toLowerCase()];
  return bucket === undefined ? undefined : bucketColor(bucket);
}

/** A tap-to-toggle filter chip — the whole filter surface is these, no sheets. */
function Chip({ label, active, dot, onClick }: { label: string; active: boolean; dot?: string; onClick: () => void }) {
  return (
    <Pressable
      aria-pressed={active}
      onClick={onClick}
      // components/README.md sanctions 36px for these chips inside their dense
      // filter panel; the marker tells the UI audit this is the exception, not
      // an oversight.
      data-dense-target=""
      className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-[var(--radius)] text-sm font-medium whitespace-nowrap transition-colors ${
        active ? "bg-accent/10 text-fg" : "bg-surface-2 text-muted hover:text-fg"
      }`}
    >
      {dot && <span aria-hidden className="w-2 h-2 rounded-[var(--radius)] shrink-0" style={{ backgroundColor: dot }} />}
      {label}
    </Pressable>
  );
}

export function ProjectionFilterBar({ filters, facets, open, onChange }: {
  filters: TxnFilters;
  facets: TxnFacets;
  open: boolean;
  onChange: (f: TxnFilters) => void;
}) {
  const [catQuery, setCatQuery] = useState("");

  const shownCats = useMemo(() => {
    const q = catQuery.trim().toLowerCase();
    if (q === "") return facets.categories;
    return facets.categories.filter((c) => (c ?? UNCATEGORIZED).toLowerCase().includes(q));
  }, [facets.categories, catQuery]);

  const active = filtersActive(filters);

  // Flat list of active selections, each with how to remove it, for the token row.
  const tokens = [
    ...filters.directions.map((d) => ({ key: `d${d}`, label: DIRECTION_LABEL[d] ?? d, remove: () => onChange(withFilterToggled(filters, "directions", d)) })),
    ...filters.categories.map((c) => ({ key: `c${c ?? "∅"}`, label: c ?? UNCATEGORIZED, remove: () => onChange(withFilterToggled(filters, "categories", c)) })),
    ...filters.currencies.map((c) => ({ key: `u${c}`, label: c, remove: () => onChange(withFilterToggled(filters, "currencies", c)) })),
    ...filters.flags.map((f) => ({ key: `f${f}`, label: FLAG_LABEL[f] ?? f, remove: () => onChange(withFilterToggled(filters, "flags", f)) })),
  ];

  return (
    <div className="space-y-2">
      {active > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {tokens.map((t) => (
            <Pressable
              key={t.key}
              onClick={t.remove}
              data-dense-target=""
              className="inline-flex min-h-9 items-center gap-1 pl-2.5 pr-1.5 py-1 rounded-[var(--radius)] text-xs font-medium bg-accent/10 text-fg"
              aria-label={`Remove ${t.label} filter`}
            >
              {t.label}
              <X size={13} aria-hidden />
            </Pressable>
          ))}
          <Pressable
            // The period and the search box are not this panel's to clear —
            // they belong to the screen's scope and its input, and wiping them
            // from here would look like the list broke.
            onClick={() => onChange({ ...EMPTY_FILTERS, from: filters.from, to: filters.to, query: filters.query })}
            data-dense-target=""
            className="inline-flex min-h-9 items-center text-xs font-medium text-muted hover:text-fg px-2 py-1"
          >
            Clear all
          </Pressable>
        </div>
      )}

      {open && (
        <div className="rounded-[var(--radius)] border border-border p-3 space-y-4">
          <section>
            <SectionLabel className="mb-2">Type</SectionLabel>
            <div className="flex flex-wrap gap-2">
              {DIRECTION_OPTS.map((o) => (
                <Chip
                  key={o.value}
                  label={o.label}
                  active={filters.directions.includes(o.value)}
                  onClick={() => onChange(withFilterToggled(filters, "directions", o.value))}
                />
              ))}
            </div>
          </section>

          <section>
            <SectionLabel className="mb-2">State</SectionLabel>
            <div className="flex flex-wrap gap-2">
              {FLAG_OPTS.map((o) => (
                <Chip
                  key={o.value}
                  label={o.label}
                  active={filters.flags.includes(o.value)}
                  onClick={() => onChange(withFilterToggled(filters, "flags", o.value))}
                />
              ))}
            </div>
          </section>

          {facets.categories.length > 0 && (
            <section>
              <SectionLabel className="mb-2">Category</SectionLabel>
              {facets.categories.length > 8 && (
                <input
                  type="search"
                  enterKeyHint="search"
                  autoCorrect="off"
                  placeholder="Filter categories…"
                  value={catQuery}
                  onChange={(e) => setCatQuery(e.target.value)}
                  className="w-full min-h-11 mb-2 px-3 rounded-[var(--radius)] border border-border bg-surface-2 text-base"
                />
              )}
              <div className="flex flex-wrap gap-2 max-h-44 overflow-y-auto overscroll-contain">
                {shownCats.map((c) => (
                  <Chip
                    key={c ?? "∅"}
                    label={c ?? UNCATEGORIZED}
                    // The same category→bucket mapping the 50/30/20 read uses,
                    // so a chip's hue and Home's buckets cannot disagree. A
                    // category the mapping doesn't know gets no dot rather than
                    // a neutral one that reads as a colour it was assigned.
                    dot={dotFor(c)}
                    active={filters.categories.includes(c)}
                    onClick={() => onChange(withFilterToggled(filters, "categories", c))}
                  />
                ))}
                {shownCats.length === 0 && <p className="text-sm text-muted py-1">No matching categories.</p>}
              </div>
            </section>
          )}

          {facets.currencies.length > 1 && (
            <section>
              <SectionLabel className="mb-2">Currency</SectionLabel>
              <div className="flex flex-wrap gap-2">
                {facets.currencies.map((c) => (
                  <Chip
                    key={c}
                    label={c}
                    active={filters.currencies.includes(c)}
                    onClick={() => onChange(withFilterToggled(filters, "currencies", c))}
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
