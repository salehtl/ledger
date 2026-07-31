import { useMemo, useState, type KeyboardEvent } from "react";
import { m } from "motion/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Search, Trash2 } from "../components/ui/PixelIcon";
import { getJSON, postJSON, getCategoryUsage, deleteCategory } from "../api/client";
import type { Category } from "../api/types";
import { useToast } from "../components/Toast";
import { bucketColor } from "../lib/insights";
import { DUR, EASE_OUT } from "../lib/motion";
import { SettingsPage } from "./settings/SettingsPage";
import { Input } from "../components/ui/Field";
import { IconButton } from "../components/ui/IconButton";
import { Pressable } from "../components/ui/Pressable";
import { Skeleton } from "../components/Skeleton";
import { Card } from "../components/ui/Card";

/** Sections ARE the taxonomy: three spending buckets, then income, then
 *  excluded. Each section header carries its own add button, so a new
 *  category is born knowing its kind and bucket — nothing to ask. */
const SECTIONS = [
  { key: "need", label: "Needs", kind: "spending", bucket: "need" },
  { key: "want", label: "Wants", kind: "spending", bucket: "want" },
  { key: "saving", label: "Savings", kind: "spending", bucket: "saving" },
  { key: "income", label: "Income", kind: "income", bucket: "" },
  { key: "excluded", label: "Excluded", kind: "excluded", bucket: "" },
] as const;
type SectionDef = (typeof SECTIONS)[number];

const BUCKET_LABELS: Record<string, string> = { need: "Needs", want: "Wants", saving: "Savings" };

export function CategoryManager({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const { show } = useToast();
  const cats = useQuery({ queryKey: ["categories"], queryFn: () => getJSON<Category[]>("/api/categories") });
  const [query, setQuery] = useState("");
  const [addingIn, setAddingIn] = useState<string | null>(null);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["categories"] });
    qc.invalidateQueries({ queryKey: ["summary"] });
  };

  const create = async (section: SectionDef, name: string) => {
    try {
      await postJSON("/api/categories", { name, kind: section.kind, bucket: section.bucket });
      setAddingIn(null);
      invalidate();
      show({ message: `${name} added to ${section.label}`, tone: "success" });
    } catch (e) {
      const dup = e instanceof Error && e.message === "name exists";
      show({ message: dup ? "A category with that name already exists." : "Couldn't add category", tone: "error" });
    }
  };

  const sections = useMemo(() => {
    const q = query.trim().toLowerCase();
    return SECTIONS.map((s) => ({
      ...s,
      items: (cats.data ?? [])
        .filter((c) => c.Kind === s.kind && (s.kind !== "spending" || c.Bucket === s.bucket)
          && (!q || c.Name.toLowerCase().includes(q)))
        .sort((a, b) => a.Name.localeCompare(b.Name)),
    }));
  }, [cats.data, query]);
  const total = cats.data?.length ?? 0;
  const visible = sections.reduce((sum, s) => sum + s.items.length, 0);
  const searching = query.trim() !== "";

  return (
    <SettingsPage title="Categories" onClose={onClose}>
      <div>
        <p className="text-sm text-muted">Categories decide where transactions appear in budgets and insights. Tap a name to rename it; add with the + beside each group.</p>
        {cats.data && <p className="mt-1 text-xs text-muted tnum">{total} categor{total === 1 ? "y" : "ies"}</p>}
      </div>

      <Input icon={Search} type="search" aria-label="Search categories" placeholder="Search categories…" value={query} onChange={(e) => setQuery(e.target.value)} />

      {cats.isPending ? <Skeleton rows={6} /> : searching && visible === 0 ? (
        <p className="py-8 text-center text-sm text-muted">No categories match “{query.trim()}”.</p>
      ) : sections.map((s) => (
        // While searching, silent sections drop out entirely; otherwise every
        // section stays visible so its add button is always reachable.
        (searching && s.items.length === 0) ? null : (
        <section key={s.key} data-testid={`section-${s.key}`} className="flex flex-col gap-2" aria-labelledby={`category-${s.key}`}>
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              {s.kind === "spending" && (
                <span aria-hidden className="w-2 h-2 rounded-[var(--radius)] shrink-0" style={{ backgroundColor: bucketColor(s.bucket) }} />
              )}
              <p id={`category-${s.key}`} className="text-sm font-medium">{s.label}</p>
              <p className="text-xs text-muted tnum">{s.items.length}</p>
            </div>
            <IconButton label={`Add to ${s.label}`} size="sm" onClick={() => setAddingIn((cur) => (cur === s.key ? null : s.key))}>
              <Plus size={16} />
            </IconButton>
          </div>
          <Card className="!p-0 divide-y divide-border">
            {addingIn === s.key && (
              <NewCategoryRow section={s} onCreate={(name) => create(s, name)} onCancel={() => setAddingIn(null)} />
            )}
            {s.items.map((c) => <CategoryRow key={c.ID} cat={c} onChanged={invalidate} />)}
            {s.items.length === 0 && addingIn !== s.key && (
              <p className="px-3 py-3 text-sm text-muted">Nothing here yet.</p>
            )}
          </Card>
        </section>
        )
      ))}
    </SettingsPage>
  );
}

/** Inline birth row: appears at the top of its section, already knowing its
 *  kind and bucket. Enter (or blur with text) creates; Escape abandons. */
function NewCategoryRow({ section, onCreate, onCancel }: { section: SectionDef; onCreate: (name: string) => void; onCancel: () => void }) {
  const [name, setName] = useState("");

  const commit = () => {
    const trimmed = name.trim();
    if (trimmed) onCreate(trimmed);
    else onCancel();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") commit();
    if (e.key === "Escape") onCancel();
  };

  return (
    // Born in place, so it always plays: unlike the list stagger there is no
    // refetch case to guard against — this element only exists because the
    // user just asked for it. DUR.fast stands in for the retired `.row-in`'s
    // 150ms; every duration comes from lib/motion.ts, and 10ms is not worth a
    // token of its own.
    //
    // Transform-only, for the same reason as the two list staggers (see
    // Home.tsx). The window is narrower here — the user has already tapped
    // "+", so React is live — but `LazyMotion` resolves its features in an
    // effect, and a tap inside that window would otherwise leave an invisible
    // row with an `autoFocus`'d input inside it. Keyboard up, nothing to type
    // into.
    <m.div
      initial={{ y: 8 }}
      animate={{ y: 0 }}
      transition={{ duration: DUR.fast, ease: EASE_OUT }}
      className="px-3 py-2 flex items-center gap-2.5"
    >
      {section.kind === "spending" && (
        <span aria-hidden className="w-2 h-2 rounded-[var(--radius)] shrink-0" style={{ backgroundColor: bucketColor(section.bucket) }} />
      )}
      <Input
        aria-label={`New category in ${section.label}`}
        className="min-w-0 flex-1"
        autoFocus
        autoCapitalize="words"
        autoCorrect="off"
        placeholder={`New in ${section.label}…`}
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={commit}
      />
    </m.div>
  );
}

function CategoryRow({ cat, onChanged }: { cat: Category; onChanged: () => void }) {
  const qc = useQueryClient();
  const { show } = useToast();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(cat.Name);
  const usage = useQuery({ queryKey: ["category-usage", cat.ID], queryFn: () => getCategoryUsage(cat.ID) });
  const transactions = usage.data?.transactions ?? 0;
  const rules = usage.data?.rules ?? 0;
  const assignments = usage.data?.assignments ?? 0;
  const targets = usage.data?.targets ?? 0;
  // Mirrors the server's delete guard exactly (store.CategoryUsage.InUse) —
  // but only when the usage fetch actually succeeds: the `?? 0` fallbacks
  // above mean a failed/pending fetch reads as "nothing in use" and the
  // button enables optimistically. If that's wrong, the server 409s, `remove`
  // catches it, and `usage.refetch()` re-disables the button — the 409 is the
  // real backstop, this check is just the fast path that avoids the round trip.
  const inUse = transactions > 0 || rules > 0 || assignments > 0 || targets > 0;

  const put = async (body: { name: string; bucket: string }) =>
    postJSON(`/api/categories/${cat.ID}`, { ...body, kind: cat.Kind }, "PUT");

  const commitRename = async () => {
    const trimmed = draft.trim();
    setEditing(false);
    if (!trimmed || trimmed === cat.Name) { setDraft(cat.Name); return; }
    try {
      await put({ name: trimmed, bucket: cat.Bucket });
      onChanged();
      show({ message: `${trimmed} saved`, tone: "success" });
    } catch (e) {
      const dup = e instanceof Error && e.message === "name exists";
      show({ message: dup ? "A category with that name already exists." : "Couldn't rename category", tone: "error" });
      setDraft(cat.Name);
    }
  };

  const cancelEdit = () => {
    setDraft(cat.Name);
    setEditing(false);
  };

  const move = async (b: string) => {
    if (b === cat.Bucket) { setEditing(false); return; }
    const name = draft.trim() || cat.Name;
    setEditing(false);
    try {
      await put({ name, bucket: b });
      onChanged();
      show({ message: `Moved to ${BUCKET_LABELS[b] ?? b}`, tone: "success" });
    } catch { show({ message: "Couldn't move category", tone: "error" }); setDraft(cat.Name); }
  };

  // Undo re-creates rather than deferring the DELETE: the backend stays the
  // single source of truth the moment the row disappears, so a reload mid-toast
  // can never disagree with the screen. Nothing can dangle — delete is guarded
  // to categories with no transactions, rules, assignments or targets — so a
  // fresh row with the same name/kind/bucket is a faithful restore.
  const restore = async () => {
    try {
      await postJSON("/api/categories", { name: cat.Name, kind: cat.Kind, bucket: cat.Bucket });
      onChanged();
      show({ message: `${cat.Name} restored`, tone: "success" });
    } catch {
      show({ message: `Couldn't restore ${cat.Name}`, tone: "error" });
    }
  };

  const remove = async () => {
    if (inUse) return;
    try {
      await deleteCategory(cat.ID);
      qc.removeQueries({ queryKey: ["category-usage", cat.ID] });
      onChanged();
      show({
        message: `${cat.Name} deleted`,
        tone: "success",
        action: { label: "Undo", onAction: () => void restore() },
      });
    } catch {
      show({ message: "Couldn't delete — category is now in use", tone: "error" });
      usage.refetch();
    }
  };

  // Collapsed rows only speak when there's something to say — a column of
  // "unused" labels is noise; the delete guard carries the explanation. Every
  // blocking reason has to be able to name itself, or a row guarded solely by a
  // target shows a dead button with nothing explaining why. But the label shares
  // its row with the category name, and listing all four reasons at once
  // truncated "Groceries" to "G" — so the quiet cascade-only reasons speak only
  // when the loud ones aren't already explaining the same disabled button.
  const loud = [
    transactions > 0 && `${transactions} txn${transactions === 1 ? "" : "s"}`,
    rules > 0 && `${rules} rule${rules === 1 ? "" : "s"}`,
  ].filter(Boolean);
  const quiet = [
    assignments > 0 && `${assignments} assigned`,
    targets > 0 && "target",   // at most one per category
  ].filter(Boolean);
  const meta = !usage.isPending && inUse ? (loud.length ? loud : quiet).join(" · ") : "";

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") void commitRename();
    if (e.key === "Escape") cancelEdit();
  };

  return (
    <div className="min-h-12 px-3 py-2 flex items-center gap-2.5">
      {editing ? (
        <>
          <Input
            aria-label={`Rename ${cat.Name}`}
            className="min-w-0 flex-1"
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            onBlur={() => void commitRename()}
          />
          {cat.Kind === "spending" && (
            <div className="flex gap-1 shrink-0" role="group" aria-label={`Move ${cat.Name}`}>
              {(["need", "want", "saving"] as const).map((b) => (
                <Pressable
                  key={b}
                  aria-label={`Move to ${BUCKET_LABELS[b]}`}
                  aria-pressed={cat.Bucket === b}
                  // preventDefault keeps focus in the input so the tap doesn't
                  // race the blur-commit; the move PUT carries the draft name.
                  onPointerDown={(e) => e.preventDefault()}
                  onClick={() => void move(b)}
                  className={`w-9 h-9 rounded-[var(--radius)] inline-flex items-center justify-center border transition-colors ${
                    cat.Bucket === b ? "border-transparent bg-surface-2" : "border-border"
                  }`}
                >
                  <span aria-hidden className="w-2.5 h-2.5 rounded-[var(--radius)]" style={{ backgroundColor: bucketColor(b) }} />
                </Pressable>
              ))}
            </div>
          )}
        </>
      ) : (
        <>
          <Pressable
            aria-label={`Edit ${cat.Name}`}
            onClick={() => setEditing(true)}
            className="min-w-0 flex-1 min-h-11 text-left inline-flex items-center"
          >
            <span className="truncate font-medium text-fg">{cat.Name}</span>
          </Pressable>
          <span className="text-[11px] text-muted tnum shrink-0">{meta}</span>
          <IconButton label={inUse ? `${cat.Name} in use, can't delete` : `Delete ${cat.Name}`} size="sm" tone="danger" disabled={inUse} onClick={remove}>
            <Trash2 size={16} />
          </IconButton>
        </>
      )}
    </div>
  );
}
