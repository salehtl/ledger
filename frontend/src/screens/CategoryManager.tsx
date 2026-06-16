import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Loader2, Trash2 } from "lucide-react";
import { getJSON, postJSON, getCategoryUsage, deleteCategory } from "../api/client";
import type { Category } from "../api/types";
import { useToast } from "../components/Toast";

const BUCKETS = ["need", "want", "saving"] as const;
const KINDS = ["spending", "income", "excluded"] as const;
const KIND_LABELS: Record<string, string> = { spending: "Spending", income: "Income", excluded: "Excluded" };

export function CategoryManager({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const { show } = useToast();
  const cats = useQuery({ queryKey: ["categories"], queryFn: () => getJSON<Category[]>("/api/categories") });

  const [name, setName] = useState("");
  const [kind, setKind] = useState<(typeof KINDS)[number]>("spending");
  const [bucket, setBucket] = useState<(typeof BUCKETS)[number]>("need");

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["categories"] });
    qc.invalidateQueries({ queryKey: ["summary"] });
  };

  const add = async () => {
    if (!name.trim()) return;
    try {
      await postJSON("/api/categories", { name: name.trim(), kind, bucket: kind === "spending" ? bucket : "" });
      setName("");
      invalidate();
    } catch (e) {
      const dup = e instanceof Error && e.message === "name exists";
      show({ message: dup ? "A category with that name already exists." : "Couldn't add category", tone: "error" });
    }
  };

  const grouped = KINDS.map((k) => ({ kind: k, items: (cats.data ?? []).filter((c) => c.Kind === k) }));

  return (
    <div className="fixed inset-0 z-40 bg-bg flex flex-col">
      <header className="flex items-center gap-3 px-4 pt-4 pb-3 border-b border-border">
        <button onClick={onClose} className="p-2 -ml-2 rounded-xl hover:bg-bg text-muted" aria-label="Close category manager">
          <ArrowLeft size={20} />
        </button>
        <h1 className="text-lg font-semibold text-fg">Categories</h1>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-6 max-w-screen-sm w-full mx-auto">
        <div className="space-y-2">
          <p className="text-sm font-medium">Add category</p>
          <input
            aria-label="New category name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name"
            className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-sm"
          />
          <div className="flex gap-2">
            <select
              aria-label="New category kind"
              value={kind}
              onChange={(e) => setKind(e.target.value as (typeof KINDS)[number])}
              className="flex-1 border border-border rounded-lg px-2 py-2 text-sm bg-surface"
            >
              {KINDS.map((k) => <option key={k} value={k}>{KIND_LABELS[k]}</option>)}
            </select>
            {kind === "spending" && (
              <select
                aria-label="New category bucket"
                value={bucket}
                onChange={(e) => setBucket(e.target.value as (typeof BUCKETS)[number])}
                className="flex-1 border border-border rounded-lg px-2 py-2 text-sm bg-surface"
              >
                {BUCKETS.map((b) => <option key={b} value={b}>{b}</option>)}
              </select>
            )}
          </div>
          <button onClick={add} className="w-full py-2 rounded-lg bg-accent text-white text-sm font-medium">Add</button>
        </div>

        {cats.isPending ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 size={36} className="animate-spin text-muted" />
          </div>
        ) : (
          grouped.filter((g) => g.items.length > 0).map((g) => (
            <div key={g.kind} className="space-y-2">
              <p className="text-sm font-medium">{KIND_LABELS[g.kind]}</p>
              {g.items.map((c) => <CategoryRow key={c.ID} cat={c} onChanged={invalidate} />)}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function CategoryRow({ cat, onChanged }: { cat: Category; onChanged: () => void }) {
  const qc = useQueryClient();
  const { show } = useToast();
  const [draftName, setDraftName] = useState(cat.Name);
  const usage = useQuery({ queryKey: ["category-usage", cat.ID], queryFn: () => getCategoryUsage(cat.ID) });
  const inUse = (usage.data?.transactions ?? 0) > 0 || (usage.data?.rules ?? 0) > 0;

  const rename = async (next: string) => {
    const trimmed = next.trim();
    if (!trimmed || trimmed === cat.Name) return;
    try {
      await postJSON(`/api/categories/${cat.ID}`, { name: trimmed, kind: cat.Kind, bucket: cat.Bucket }, "PUT");
      onChanged();
    } catch (e) {
      const dup = e instanceof Error && e.message === "name exists";
      show({ message: dup ? "A category with that name already exists." : "Couldn't rename category", tone: "error" });
      setDraftName(cat.Name);
    }
  };

  const reBucket = async (b: string) => {
    try {
      await postJSON(`/api/categories/${cat.ID}`, { name: cat.Name, kind: cat.Kind, bucket: b }, "PUT");
      onChanged();
    } catch {
      show({ message: "Couldn't move category", tone: "error" });
    }
  };

  const remove = async () => {
    if (inUse) return;
    try {
      await deleteCategory(cat.ID);
      qc.removeQueries({ queryKey: ["category-usage", cat.ID] });
      onChanged();
    } catch {
      show({ message: "Couldn't delete — category is now in use", tone: "error" });
      usage.refetch();
    }
  };

  return (
    <div className="flex items-center justify-between gap-2">
      <input
        aria-label={`Rename ${cat.Name}`}
        value={draftName}
        onChange={(e) => setDraftName(e.target.value)}
        onBlur={() => rename(draftName)}
        className="min-w-0 flex-1 px-2 py-1 rounded-lg border border-border bg-surface text-sm"
      />
      {cat.Kind === "spending" && (
        <select
          aria-label={`Bucket for ${cat.Name}`}
          value={cat.Bucket}
          onChange={(e) => reBucket(e.target.value)}
          className="border border-border rounded-lg px-2 py-1 text-sm bg-surface"
        >
          {BUCKETS.map((b) => <option key={b} value={b}>{b}</option>)}
        </select>
      )}
      <button
        aria-label={inUse ? `${cat.Name} in use, can't delete` : `Delete ${cat.Name}`}
        disabled={inUse}
        onClick={remove}
        className="text-muted hover:text-bad disabled:opacity-30 disabled:cursor-not-allowed"
      >
        <Trash2 size={16} />
      </button>
    </div>
  );
}
