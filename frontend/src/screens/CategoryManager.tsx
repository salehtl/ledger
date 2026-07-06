import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { getJSON, postJSON, getCategoryUsage, deleteCategory } from "../api/client";
import type { Category } from "../api/types";
import { useToast } from "../components/Toast";
import { SettingsPage } from "./settings/SettingsPage";
import { Button } from "../components/ui/Button";
import { Input, Select } from "../components/ui/Field";
import { IconButton } from "../components/ui/IconButton";
import { Skeleton } from "../components/Skeleton";

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
    <SettingsPage title="Categories" onClose={onClose}>
      <div className="space-y-2">
        <p className="text-sm font-medium">Add category</p>
        <Input
          aria-label="New category name"
          autoCapitalize="words"
          autoCorrect="off"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Name"
        />
        <div className="flex gap-2">
          <Select
            aria-label="New category kind"
            className="flex-1"
            value={kind}
            onChange={(e) => setKind(e.target.value as (typeof KINDS)[number])}
          >
            {KINDS.map((k) => <option key={k} value={k}>{KIND_LABELS[k]}</option>)}
          </Select>
          {kind === "spending" && (
            <Select
              aria-label="New category bucket"
              className="flex-1"
              value={bucket}
              onChange={(e) => setBucket(e.target.value as (typeof BUCKETS)[number])}
            >
              {BUCKETS.map((b) => <option key={b} value={b}>{b}</option>)}
            </Select>
          )}
        </div>
        <Button variant="primary" className="w-full" onClick={add}>Add</Button>
      </div>

      {cats.isPending ? (
        <Skeleton rows={6} />
      ) : (
        grouped.filter((g) => g.items.length > 0).map((g) => (
          <div key={g.kind} className="space-y-2">
            <p className="text-sm font-medium">{KIND_LABELS[g.kind]}</p>
            {g.items.map((c) => <CategoryRow key={c.ID} cat={c} onChanged={invalidate} />)}
          </div>
        ))
      )}
    </SettingsPage>
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
      <Input
        aria-label={`Rename ${cat.Name}`}
        className="min-w-0 flex-1"
        value={draftName}
        onChange={(e) => setDraftName(e.target.value)}
        onBlur={() => rename(draftName)}
      />
      {cat.Kind === "spending" && (
        <Select
          aria-label={`Bucket for ${cat.Name}`}
          className="!w-auto"
          value={cat.Bucket}
          onChange={(e) => reBucket(e.target.value)}
        >
          {BUCKETS.map((b) => <option key={b} value={b}>{b}</option>)}
        </Select>
      )}
      <IconButton
        label={inUse ? `${cat.Name} in use, can't delete` : `Delete ${cat.Name}`}
        size="sm"
        tone="danger"
        disabled={inUse}
        onClick={remove}
      >
        <Trash2 size={16} />
      </IconButton>
    </div>
  );
}
