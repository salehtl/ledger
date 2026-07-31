import { useState } from "react";
import { EmptyState } from "../../components/EmptyState";
import { Money } from "../../components/Money";
import { Skeleton } from "../../components/Skeleton";
import { Card } from "../../components/ui/Card";
import { SectionLabel } from "../../components/ui/SectionLabel";
import { AlertTriangle, Inbox } from "../../components/ui/PixelIcon";
import { useToast } from "../../components/Toast";
import { BUCKET_LABEL, bucketColor } from "../../lib/insights";
import { insightsFocus, type Scope } from "../../lib/scope";
import {
  autoAssignMessage,
  claimsByCategory,
  groupByBucket,
  monthProgress,
  monthTitle,
  undoAssignments,
  type CategoryClaim,
  type Envelope,
} from "../../lib/envelope";
import { assignEnvelopesOnce } from "../../api/client";
import { useAutoAssign, useCategories, useEnvelopes, useUpcoming, writeSummary } from "../../api/hooks";
import { useQueryClient } from "@tanstack/react-query";
import { ReadyToAssignBanner } from "./ReadyToAssignBanner";
import { EnvelopeRow } from "./EnvelopeRow";
import { AssignSheet } from "./AssignSheet";
import { MoveMoneySheet } from "./MoveMoneySheet";
import { TargetSheet } from "./TargetSheet";

type SheetState =
  | { kind: "assign"; categoryId: number }
  | { kind: "move"; toId: number }
  | { kind: "target"; categoryId: number }
  | null;

/**
 * The Plan screen: the month's envelope decision surface. Ready-to-Assign on
 * top, then every spending category grouped under its 50/30/20 bucket. Rows
 * with money or a target get the full envelope treatment; the rest ride the
 * jar math untouched — depth is opt-in, not a wall.
 */
export function PlanScreen({ scope }: { scope: Scope }) {
  const focus = insightsFocus(scope);
  const month = focus.period;
  const envelopes = useEnvelopes(month);
  // The envelope wire shape carries no colour of its own (it's keyed off
  // category_id, not the category row) — the assign sheet's dot needs the
  // category's own stored colour, so the inventory is fetched here and
  // looked up by id below, purely for that one dot.
  const categories = useCategories();
  const upcoming = useUpcoming();
  const autoAssign = useAutoAssign(month);
  const qc = useQueryClient();
  const toast = useToast();
  const [sheet, setSheet] = useState<SheetState>(null);

  // isPending, not isLoading: the persisted-cache provider leaves restoring
  // queries pending-but-not-fetching, where isLoading lies (false, no data).
  if (envelopes.isPending) return <Skeleton rows={8} />;
  if (envelopes.isError) {
    return <EmptyState icon={AlertTriangle} title="Couldn't load your plan" hint="Check your connection and try again." />;
  }

  const s = envelopes.data;
  const groups = groupByBucket(s.envelopes);
  const pace = monthProgress(month);
  // Upcoming-bill claims are anchored to today; on any other month they'd
  // contradict the month being shown, so they only render on the current one
  // (the same months the pace marker exists for).
  const claims = pace !== undefined ? claimsByCategory(upcoming.data?.items ?? []) : new Map<number, CategoryClaim>();

  const byId = (id: number): Envelope | undefined => s.envelopes.find((e) => e.category_id === id);
  const sheetEnvelope =
    sheet && sheet.kind !== "move" ? byId(sheet.categoryId) : sheet ? byId(sheet.toId) : undefined;
  // One lookup, shared by every row's dot and the assign sheet's dot — built
  // fresh each render from the category inventory, which reacts (query-cache)
  // to picker changes without this screen needing to know about the picker.
  const colorById = new Map(categories.data?.map((c) => [c.ID, c.Color] as const) ?? []);
  const sheetColor = sheetEnvelope && colorById.get(sheetEnvelope.category_id);

  const runAutoAssign = () => {
    autoAssign.mutate(undefined, {
      onSuccess: (res) => {
        const undo = undoAssignments(res.allocations, res.summary);
        toast.show({
          message: autoAssignMessage(res.allocations),
          action:
            undo.length > 0
              ? {
                  label: "Undo",
                  // Plain call, not the mutation hook: the toast outlives this
                  // screen, and an unmounted hook drops its callbacks — the
                  // undo would neither write the cache nor report failure.
                  onAction: () =>
                    assignEnvelopesOnce(month, undo)
                      .then((summary) => writeSummary(qc, summary))
                      .catch(() => toast.show({ message: "Couldn't undo", tone: "error" })),
                }
              : undefined,
        });
      },
      onError: (err) => toast.show({ message: `Couldn't auto-assign — ${err.message}`, tone: "error" }),
    });
  };

  if (s.envelopes.length === 0) {
    return (
      <EmptyState
        icon={Inbox}
        title="No envelopes yet"
        hint="Add spending categories in Settings and they show up here, ready to fund."
      />
    );
  }

  return (
    <div className="space-y-4">
      <ReadyToAssignBanner summary={s} onAutoAssign={runAutoAssign} autoAssignPending={autoAssign.isPending} />

      {focus.note !== "" && (
        <p className="px-1 font-mono text-[10px] tracking-[0.04em] text-muted">
          Showing {monthTitle(month)} — {focus.note}
        </p>
      )}

      {pace !== undefined && upcoming.isError && (
        <p className="px-1 font-mono text-[10px] tracking-[0.04em] text-muted">
          Upcoming bills unavailable — claim hints hidden.
        </p>
      )}

      {groups.map((g) => (
        <section key={g.bucket} className="space-y-2">
          <div className="flex items-baseline justify-between px-1">
            <SectionLabel as="h2" className="flex items-center gap-2">
              <span aria-hidden className="inline-block w-2.5 h-2.5 rounded-[var(--radius)]" style={{ background: bucketColor(g.bucket) }} />
              {BUCKET_LABEL[g.bucket] ?? g.bucket}
            </SectionLabel>
            <span className="font-mono text-[10px] tracking-[0.04em] text-muted tnum">
              available <Money fils={g.available_fils} />
            </span>
          </div>
          <Card className="!p-0">
            <div className="divide-y divide-border">
              {g.envelopes.map((e) => (
                <EnvelopeRow
                  key={e.category_id}
                  envelope={e}
                  claim={claims.get(e.category_id)}
                  pace={pace}
                  color={colorById.get(e.category_id)}
                  onOpen={(env) => setSheet({ kind: "assign", categoryId: env.category_id })}
                />
              ))}
            </div>
          </Card>
        </section>
      ))}

      {sheet?.kind === "assign" && sheetEnvelope && (
        <AssignSheet
          envelope={sheetEnvelope}
          claim={claims.get(sheetEnvelope.category_id)}
          month={month}
          canMoveIn={s.envelopes.some((e) => e.category_id !== sheetEnvelope.category_id && e.available_fils > 0)}
          color={sheetColor}
          onClose={() => setSheet(null)}
          onMoveMoney={() => setSheet({ kind: "move", toId: sheetEnvelope.category_id })}
          onEditTarget={() => setSheet({ kind: "target", categoryId: sheetEnvelope.category_id })}
        />
      )}
      {sheet?.kind === "move" && sheetEnvelope && (
        <MoveMoneySheet
          envelopes={s.envelopes}
          toId={sheetEnvelope.category_id}
          claim={claims.get(sheetEnvelope.category_id)}
          month={month}
          onClose={() => setSheet(null)}
        />
      )}
      {sheet?.kind === "target" && sheetEnvelope && (
        <TargetSheet envelope={sheetEnvelope} month={month} onClose={() => setSheet(null)} />
      )}
    </div>
  );
}
