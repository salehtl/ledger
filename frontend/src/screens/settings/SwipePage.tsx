import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { getJSON } from "../../api/client";
import type { Category } from "../../api/types";
import { Button } from "../../components/ui/Button";
import { Select } from "../../components/ui/Field";
import { SettingsPage } from "./SettingsPage";
import { SavedFlash, useSavedFlash } from "./SavedFlash";
import {
  loadSwipeConfig,
  saveSwipeConfig,
  buildDefaultConfig,
  type SwipeConfig,
  type EdgeKey,
  type EdgeGroup,
  type SlotKey,
} from "../../lib/swipe";

// Rows are shown edge-first; each edge is one fixed group.
const EDGE_ROWS: { edge: EdgeKey; arrow: string; label: string; group: EdgeGroup }[] = [
  { edge: "right", arrow: "→", label: "Need", group: "need" },
  { edge: "left", arrow: "←", label: "Want", group: "want" },
  { edge: "down", arrow: "↓", label: "Save", group: "saving" },
  { edge: "up", arrow: "↑", label: "Transfer / Income", group: "other" },
];

function groupCategories(categories: Category[], group: EdgeGroup): Category[] {
  return categories.filter((c) =>
    c.IsActive &&
    (group === "other"
      ? c.Kind === "income" || c.Kind === "excluded"
      : c.Kind === "spending" && c.Bucket === group),
  );
}

export function SwipePage({ onClose }: { onClose: () => void }) {
  const { saved, flash } = useSavedFlash();
  const cats = useQuery({ queryKey: ["categories"], queryFn: () => getJSON<Category[]>("/api/categories") });
  const categories = cats.data ?? [];
  // Seed once categories have loaded, so a fresh install (no saved config) gets
  // real default slots instead of empty "—". loadSwipeConfig still honors any
  // saved v2 config regardless of the categories passed.
  const [swipeCfg, setSwipeCfg] = useState<SwipeConfig | null>(null);
  useEffect(() => {
    if (swipeCfg === null && !cats.isPending) setSwipeCfg(loadSwipeConfig(cats.data ?? []));
  }, [swipeCfg, cats.isPending, cats.data]);

  const commit = (next: SwipeConfig) => {
    setSwipeCfg(next);
    saveSwipeConfig(next);
    flash();
  };

  const setSlot = (edge: EdgeKey, slot: SlotKey, id: number) => {
    if (!swipeCfg) return;
    const next: SwipeConfig = {
      ...swipeCfg,
      edges: {
        ...swipeCfg.edges,
        [edge]: { ...swipeCfg.edges[edge], [slot === "A" ? "slotA" : "slotB"]: id },
      },
    };
    commit(next);
  };

  return (
    <SettingsPage title="Swipe actions" onClose={onClose} headerRight={<SavedFlash saved={saved} />}>
      <div>
        <p className="text-xs text-muted mb-3">
          Two categories per edge, plus an "Other" swipe that opens the full list for that group.
        </p>
        {!swipeCfg ? (
          <p className="text-sm text-muted py-4">Loading…</p>
        ) : (
          <>
            <div className="space-y-3">
              {EDGE_ROWS.map(({ edge, arrow, label, group }) => {
                const opts = groupCategories(categories, group);
                const ec = swipeCfg.edges[edge];
                return (
                  <div key={edge} className="flex items-center gap-2">
                    <span className="w-9 h-9 grid place-items-center rounded-lg bg-surface-2 text-sm shrink-0" aria-hidden>{arrow}</span>
                    <span className="text-sm w-16 shrink-0">{label}</span>
                    <Select value={String(ec.slotA)} aria-label={`${label} slot A`} onChange={(e) => setSlot(edge, "A", Number(e.target.value))} className="flex-1 min-w-0">
                      <option value="0">—</option>
                      {opts.map((c) => <option key={c.ID} value={c.ID}>{c.Name}</option>)}
                    </Select>
                    <Select value={String(ec.slotB)} aria-label={`${label} slot B`} onChange={(e) => setSlot(edge, "B", Number(e.target.value))} className="flex-1 min-w-0">
                      <option value="0">—</option>
                      {opts.map((c) => <option key={c.ID} value={c.ID}>{c.Name}</option>)}
                    </Select>
                  </div>
                );
              })}
            </div>
            <Button variant="ghost" className="mt-3 text-sm" onClick={() => commit(buildDefaultConfig(categories))}>
              Reset to defaults
            </Button>
          </>
        )}
      </div>
    </SettingsPage>
  );
}
