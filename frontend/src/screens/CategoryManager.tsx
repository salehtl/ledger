import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Search, Trash2, X } from "../components/ui/PixelIcon";
import { getJSON, postJSON, getCategoryUsage, deleteCategory } from "../api/client";
import type { Category } from "../api/types";
import { useToast } from "../components/Toast";
import { bucketColor } from "../lib/insights";
import { SettingsPage } from "./settings/SettingsPage";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Field";
import { IconButton } from "../components/ui/IconButton";
import { SegmentedControl } from "../components/ui/SegmentedControl";
import { Skeleton } from "../components/Skeleton";
import { Card } from "../components/ui/Card";
import { SectionLabel } from "../components/ui/SectionLabel";

const BUCKETS = ["need", "want", "saving"] as const;
const KINDS = ["spending", "income", "excluded"] as const;
const KIND_LABELS: Record<string, string> = { spending: "Spending", income: "Income", excluded: "Excluded" };
const BUCKET_LABELS: Record<string, string> = { need: "Needs", want: "Wants", saving: "Savings" };
const KIND_HINTS: Record<string, string> = {
  spending: "Counts toward a monthly budget bucket.",
  income: "Money received, such as salary or freelance work.",
  excluded: "Movements that should not count as spending, such as transfers.",
};
const BUCKET_ORDER: Record<string, number> = { need: 0, want: 1, saving: 2 };

/** Dot-chip bucket picker — the same colored-dot language the categorize
 *  sheet and insights speak, so a bucket reads as a hue, not a dropdown. */
function BucketChips({ value, onPick, disabled }: { value: string; onPick: (b: string) => void; disabled?: boolean }) {
  return (
    <div className="flex gap-2" role="group" aria-label="Budget bucket">
      {BUCKETS.map((b) => {
        const selected = value === b;
        return (
          <button
            key={b}
            type="button"
            disabled={disabled}
            aria-pressed={selected}
            onClick={() => onPick(b)}
            className={`min-h-11 px-3.5 rounded-[var(--radius)] text-sm font-medium inline-flex items-center gap-2 press border transition-colors ${
              selected ? "border-transparent text-fg bg-surface-2" : "border-border text-muted hover:text-fg"
            }`}
          >
            <span aria-hidden className="w-2 h-2 rounded-[var(--radius)] shrink-0" style={{ backgroundColor: bucketColor(b) }} />
            {BUCKET_LABELS[b]}
          </button>
        );
      })}
    </div>
  );
}

export function CategoryManager({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const { show } = useToast();
  const cats = useQuery({ queryKey: ["categories"], queryFn: () => getJSON<Category[]>("/api/categories") });
  const [name, setName] = useState("");
  const [kind, setKind] = useState<(typeof KINDS)[number]>("spending");
  const [bucket, setBucket] = useState<(typeof BUCKETS)[number]>("need");
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState(false);
  const [openID, setOpenID] = useState<number | null>(null);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["categories"] });
    qc.invalidateQueries({ queryKey: ["summary"] });
  };

  const add = async () => {
    if (!name.trim()) return;
    try {
      await postJSON("/api/categories", { name: name.trim(), kind, bucket: kind === "spending" ? bucket : "" });
      setName("");
      setAdding(false);
      invalidate();
      show({ message: "Category added", tone: "success" });
    } catch (e) {
      const dup = e instanceof Error && e.message === "name exists";
      show({ message: dup ? "A category with that name already exists." : "Couldn't add category", tone: "error" });
    }
  };

  const grouped = useMemo(() => {
    const q = query.trim().toLowerCase();
    return KINDS.map((k) => ({
      kind: k,
      items: (cats.data ?? [])
        .filter((c) => c.Kind === k && (!q || c.Name.toLowerCase().includes(q)))
        // Spending sorts need -> want -> saving so the dots read as bands.
        .sort((a, b) => (BUCKET_ORDER[a.Bucket] ?? 0) - (BUCKET_ORDER[b.Bucket] ?? 0) || a.Name.localeCompare(b.Name)),
    }));
  }, [cats.data, query]);
  const total = cats.data?.length ?? 0;
  const visible = grouped.reduce((sum, group) => sum + group.items.length, 0);

  return (
    <SettingsPage title="Categories" onClose={onClose}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm text-muted">Categories decide where transactions appear in budgets and insights. Tap one to edit it.</p>
          {cats.data && <p className="mt-1 text-xs text-muted tnum">{total} categor{total === 1 ? "y" : "ies"}</p>}
        </div>
        <Button variant={adding ? "ghost" : "primary"} onClick={() => setAdding((open) => !open)}>
          {adding ? <X size={16} aria-hidden /> : <Plus size={16} aria-hidden />}
          {adding ? "Cancel" : "New"}
        </Button>
      </div>

      {adding && (
        <Card className="!p-0"><div className="p-4 flex flex-col gap-3" data-testid="new-category-form">
          <div>
            <p className="font-medium">New category</p>
            <p className="text-xs text-muted">{KIND_HINTS[kind]}</p>
          </div>
          <SegmentedControl
            fullWidth
            value={kind}
            onChange={setKind}
            options={KINDS.map((k) => ({ value: k, label: KIND_LABELS[k] }))}
          />
          <label className="flex flex-col gap-1.5">
            <SectionLabel as="span">Name</SectionLabel>
            <Input aria-label="New category name" autoFocus autoCapitalize="words" autoCorrect="off" value={name}
              onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void add(); }} placeholder="e.g. Pet care" />
          </label>
          {kind === "spending" && (
            <div className="flex flex-col gap-1.5">
              <SectionLabel as="span">Budget bucket</SectionLabel>
              <BucketChips value={bucket} onPick={(b) => setBucket(b as (typeof BUCKETS)[number])} />
            </div>
          )}
          <Button variant="primary" className="w-full" disabled={!name.trim()} onClick={add}>Create category</Button>
        </div></Card>
      )}

      <Input icon={Search} type="search" aria-label="Search categories" placeholder="Search categories…" value={query} onChange={(e) => setQuery(e.target.value)} />

      {cats.isPending ? <Skeleton rows={6} /> : visible === 0 ? (
        <p className="py-8 text-center text-sm text-muted">No categories match “{query.trim()}”.</p>
      ) : grouped.filter((g) => g.items.length > 0).map((g) => (
        <section key={g.kind} className="flex flex-col gap-2" aria-labelledby={`category-${g.kind}`}>
          <div className="flex items-baseline justify-between gap-2">
            <p id={`category-${g.kind}`} className="text-sm font-medium">{KIND_LABELS[g.kind]}</p>
            <p className="text-xs text-muted tnum">{g.items.length}</p>
          </div>
          <Card className="!p-0 divide-y divide-border">
            {g.items.map((c) => (
              <CategoryRow key={c.ID} cat={c} open={openID === c.ID}
                onToggle={() => setOpenID((cur) => (cur === c.ID ? null : c.ID))} onChanged={invalidate} />
            ))}
          </Card>
        </section>
      ))}
    </SettingsPage>
  );
}

function CategoryRow({ cat, open, onToggle, onChanged }: { cat: Category; open: boolean; onToggle: () => void; onChanged: () => void }) {
  const qc = useQueryClient();
  const { show } = useToast();
  const [draftName, setDraftName] = useState(cat.Name);
  const usage = useQuery({ queryKey: ["category-usage", cat.ID], queryFn: () => getCategoryUsage(cat.ID) });
  const transactions = usage.data?.transactions ?? 0;
  const rules = usage.data?.rules ?? 0;
  const inUse = transactions > 0 || rules > 0;
  const dirty = draftName.trim() !== "" && draftName.trim() !== cat.Name;

  const save = async (body: { name: string; bucket: string }) => {
    await postJSON(`/api/categories/${cat.ID}`, { ...body, kind: cat.Kind }, "PUT");
    onChanged();
  };

  const rename = async () => {
    if (!dirty) return;
    const trimmed = draftName.trim();
    try {
      await save({ name: trimmed, bucket: cat.Bucket });
      show({ message: `${trimmed} saved`, tone: "success" });
    } catch (e) {
      const dup = e instanceof Error && e.message === "name exists";
      show({ message: dup ? "A category with that name already exists." : "Couldn't rename category", tone: "error" });
      setDraftName(cat.Name);
    }
  };

  const reBucket = async (b: string) => {
    if (b === cat.Bucket) return;
    try {
      await save({ name: cat.Name, bucket: b });
      show({ message: `Moved to ${BUCKET_LABELS[b] ?? b}`, tone: "success" });
    } catch { show({ message: "Couldn't move category", tone: "error" }); }
  };

  const remove = async () => {
    if (inUse) return;
    try {
      await deleteCategory(cat.ID);
      qc.removeQueries({ queryKey: ["category-usage", cat.ID] });
      onChanged();
      show({ message: `${cat.Name} deleted`, tone: "success" });
    } catch {
      show({ message: "Couldn't delete — category is now in use", tone: "error" });
      usage.refetch();
    }
  };

  // Collapsed rows only speak when there's something to say — a column of
  // "unused" labels is noise; deletability is explained in the editor.
  const meta = !usage.isPending && inUse
    ? `${transactions} txn${transactions === 1 ? "" : "s"}${rules > 0 ? ` · ${rules} rule${rules === 1 ? "" : "s"}` : ""}`
    : "";

  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        aria-label={`Edit ${cat.Name}`}
        onClick={onToggle}
        className="w-full min-h-12 px-3 py-3 flex items-center gap-2.5 text-left press hover:bg-surface-2 transition-colors"
      >
        {cat.Kind === "spending" && (
          <span aria-hidden className="w-2 h-2 rounded-[var(--radius)] shrink-0" style={{ backgroundColor: bucketColor(cat.Bucket) }} />
        )}
        <span className="min-w-0 flex-1 truncate font-medium text-fg">{cat.Name}</span>
        <span className="text-[11px] text-muted tnum shrink-0">{meta}</span>
      </button>

      {open && (
        <div className="px-3 pb-3 flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <Input aria-label={`Rename ${cat.Name}`} className="min-w-0 flex-1" value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void rename(); }} />
            <Button variant="primary" aria-label="Save name" disabled={!dirty} onClick={rename}>Save</Button>
          </div>
          {cat.Kind === "spending" && <BucketChips value={cat.Bucket} onPick={reBucket} />}
          <div className="flex items-center justify-between gap-2">
            <p className="text-[11px] text-muted tnum">
              {usage.isPending ? "Checking usage…" : inUse
                ? `Used by ${transactions} transaction${transactions === 1 ? "" : "s"} and ${rules} rule${rules === 1 ? "" : "s"} — reassign them before deleting.`
                : "Not used by any transaction or rule."}
            </p>
            <IconButton label={inUse ? `${cat.Name} in use, can't delete` : `Delete ${cat.Name}`} size="sm" tone="danger" disabled={inUse} onClick={remove}>
              <Trash2 size={16} />
            </IconButton>
          </div>
        </div>
      )}
    </div>
  );
}
