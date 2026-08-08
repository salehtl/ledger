/**
 * The categories a user owns, in v2.
 *
 * # Why this is not `screens/CategoryManager.tsx`
 *
 * That screen is v1's, over `/api/categories` — `GET`, `POST`, `PUT`, `DELETE`
 * and a usage endpoint that guards deletion. `ledgerd` serves none of them, and
 * v2 has no delete at all: a category is retired by re-defining it with
 * `active: false`, so the money already filed under it stays readable and stays
 * in its bucket. The taxonomy is the same and deliberately so — the sections ARE
 * the taxonomy, and a category is born knowing its kind and bucket, which is why
 * nothing here asks for either.
 *
 * # What retiring says, and what it must not claim
 *
 * "Stop offering this." It does not remove anything: existing transactions keep
 * the name and keep counting where they always did, and the copy says that
 * rather than implying a delete this product does not have.
 *
 * # It authors `category_defined` and nothing else
 *
 * `sources/review.ts`'s `categorizeOps` remains the single author of
 * `txn_categorized`/`rule_added`. Re-filing transactions is the picker's job,
 * not this screen's.
 */

import { useCallback, useMemo, useState, type KeyboardEvent } from "react";

import { newEntityID } from "@ledger/client/net/client";
import type { CategoryDef } from "@ledger/client/replay/state";

import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { Input } from "../../components/ui/Field";
import { IconButton } from "../../components/ui/IconButton";
import { Plus } from "../../components/ui/PixelIcon";
import { Pressable } from "../../components/ui/Pressable";
import { SectionLabel } from "../../components/ui/SectionLabel";
import { bucketColor } from "../../lib/insights";
import { categoryDefinedOps, restoreCategoryOps, retireCategoryOps } from "../../v2/sources/categories";
import type { Writer } from "../../v2/writer";

/** Sections ARE the taxonomy — the same five v1 established. */
const SECTIONS = [
  { key: "need", label: "Needs", kind: "spending", bucket: "need" },
  { key: "want", label: "Wants", kind: "spending", bucket: "want" },
  { key: "saving", label: "Savings & debt", kind: "spending", bucket: "saving" },
  { key: "income", label: "Income", kind: "income", bucket: null },
  { key: "excluded", label: "Excluded", kind: "excluded", bucket: null },
] as const;

type Section = (typeof SECTIONS)[number];

export interface V2CategoriesPanelProps {
  /** Every definition the log holds, retired ones included. */
  defs: readonly CategoryDef[];
  /** Appends. `null` renders the list read-only rather than a control that drops answers. */
  writer: Writer | null;
  /** Called after ops are queued, so the caller can invalidate its queries. */
  onAuthored?: () => void;
  /** Test seam. */
  newID?: () => string;
}

export function V2CategoriesPanel({ defs, writer, onAuthored, newID = newEntityID }: V2CategoriesPanelProps) {
  const [addingIn, setAddingIn] = useState<string | null>(null);

  const append = useCallback(
    (specs: readonly { type: string; payload: unknown }[]): void => {
      if (writer === null) return;
      writer.enqueueMany(specs);
      onAuthored?.();
      // Not awaited: the ops are durable the moment they are queued, and a
      // screen that stalled on the network would be unusable offline.
      writer.flush().catch(() => {});
    },
    [writer, onAuthored],
  );

  const define = useCallback(
    (section: Section, name: string): void => {
      append(
        categoryDefinedOps({
          id: newID(),
          name,
          kind: section.kind,
          bucket: section.bucket,
          color: null,
          active: true,
        }),
      );
      setAddingIn(null);
    },
    [append, newID],
  );

  const sections = useMemo(
    () =>
      SECTIONS.map((s) => ({
        ...s,
        items: defs.filter((c) => c.active && c.kind === s.kind && (s.kind !== "spending" || c.bucket === s.bucket)),
      })),
    [defs],
  );
  const retired = useMemo(() => defs.filter((c) => !c.active), [defs]);

  return (
    <div className="space-y-5">
      <p className="text-sm leading-relaxed text-muted">
        Categories decide which bucket a transaction counts in. Add one with the + beside a group; the group it is
        in is the bucket it counts in.
      </p>

      {sections.map((s) => (
        <section key={s.key} data-testid={`v2-category-section-${s.key}`} className="space-y-2">
          <div className="flex items-center justify-between gap-2 px-1">
            <div className="flex min-w-0 items-center gap-2">
              {s.kind === "spending" && (
                <span aria-hidden className="h-2 w-2 shrink-0 rounded-[var(--radius)]" style={{ backgroundColor: bucketColor(s.bucket) }} />
              )}
              <SectionLabel as="h3">{s.label}</SectionLabel>
              <span className="text-xs text-muted tnum">{s.items.length}</span>
            </div>
            {writer !== null && (
              <IconButton
                label={`Add to ${s.label}`}
                size="sm"
                onClick={() => setAddingIn((cur) => (cur === s.key ? null : s.key))}
              >
                <Plus size={16} />
              </IconButton>
            )}
          </div>
          <Card className="!p-0 divide-y divide-border">
            {addingIn === s.key && (
              <NewCategoryRow section={s} onDefine={(name) => define(s, name)} onCancel={() => setAddingIn(null)} />
            )}
            {s.items.map((c) => (
              <div key={c.id} className="flex min-h-12 items-center gap-2.5 px-3 py-2">
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{c.name}</span>
                <Button variant="ghost" onClick={() => append(retireCategoryOps(c))}>
                  Retire
                </Button>
              </div>
            ))}
            {s.items.length === 0 && addingIn !== s.key && (
              <p className="px-3 py-3 text-sm text-muted">Nothing here yet.</p>
            )}
          </Card>
        </section>
      ))}

      {retired.length > 0 && (
        <section data-testid="v2-category-section-retired" className="space-y-2">
          <SectionLabel as="h3" className="px-1">Retired</SectionLabel>
          <Card className="!p-0 divide-y divide-border">
            {retired.map((c) => (
              <div key={c.id} className="flex min-h-12 items-center gap-2.5 px-3 py-2">
                <span className="min-w-0 flex-1 truncate text-sm text-muted">{c.name}</span>
                {writer !== null && (
                  <Button variant="ghost" onClick={() => append(restoreCategoryOps(c))}>
                    Bring back
                  </Button>
                )}
              </div>
            ))}
          </Card>
          {/* The honest limit of what retiring did. It is not a delete, and a
              sentence implying one would be a claim the log cannot back. */}
          <p className="px-1 text-xs text-muted">
            Retired categories are no longer offered when you file a transaction. Nothing already filed under one
            changes — it keeps the name and keeps counting in the same bucket.
          </p>
        </section>
      )}
    </div>
  );
}

/** Inline birth row: it already knows its kind and bucket, so it asks only for a name. */
function NewCategoryRow({
  section,
  onDefine,
  onCancel,
}: {
  section: Section;
  onDefine: (name: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const commit = (): void => {
    const trimmed = name.trim();
    if (trimmed === "") onCancel();
    else onDefine(trimmed);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === "Enter") commit();
    if (e.key === "Escape") onCancel();
  };
  return (
    <div className="flex items-center gap-2.5 px-3 py-2">
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
      />
      <Pressable aria-label={`Add ${name.trim() || "category"}`} className="min-h-11 px-2 text-sm font-medium" onClick={commit}>
        Add
      </Pressable>
    </div>
  );
}
