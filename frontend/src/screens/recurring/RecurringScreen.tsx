import { useRef, useState } from "react";
import { AlertTriangle, Inbox, Plus } from "../../components/ui/PixelIcon";
import { EmptyState } from "../../components/EmptyState";
import { Fab } from "../../components/ui/Fab";
import { SectionLabel } from "../../components/ui/SectionLabel";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { Skeleton } from "../../components/Skeleton";
import { useToast } from "../../components/Toast";
import { formatFils } from "../../lib/money";
import { todayISO } from "../../lib/projectMath";
import { recentlyPaid, scheduleName, splitUpcoming, upcomingDebitTotal, type SchedulePayload } from "../../lib/recurring";
import { DetectedCards } from "./DetectedCards";
import { MatchedTxnsSheet } from "./MatchedTxnsSheet";
import { ScheduleForm } from "./ScheduleForm";
import { ScheduleList } from "./ScheduleList";
import { RecentlyPaidList, UpcomingFeed } from "./UpcomingFeed";
import {
  useCategories, useCreateSchedule, useDeleteSchedule, useSchedules,
  useScheduleAction, useTxnIndex, useUpcoming, useUpdateSchedule,
  type Schedule, type UpcomingItem,
} from "./api";

type WindowDays = "7" | "14" | "30";

/** How long a dismissal stays undoable before the write is sent. Matches the
 *  toast's own 5s auto-dismiss so "Undo" never outlives the ability to undo. */
const DISMISS_COMMIT_MS = 5000;

/**
 * Recurring money flow: detected proposals to triage, the upcoming bill feed
 * (missed + price-change aware), recently paid receipts, and the full
 * schedule inventory. Dismissals commit after an undo window — the API has no
 * "back to proposed" transition, so the honest undo is to not send the write
 * until the toast expires.
 */
export function RecurringScreen() {
  const schedules = useSchedules();
  const [windowDays, setWindowDays] = useState<WindowDays>("14");
  const upcoming = useUpcoming(Number(windowDays));
  const categories = useCategories();
  const txnIndex = useTxnIndex();
  const action = useScheduleAction();
  const create = useCreateSchedule();
  const update = useUpdateSchedule();
  const remove = useDeleteSchedule();
  const { show } = useToast();

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Schedule | null>(null);
  const [matches, setMatches] = useState<{ title: string; txnIds: number[] } | null>(null);
  // Dismissals pending their undo window: hidden from the list immediately,
  // written to the API only when the window closes.
  const [pendingDismiss, setPendingDismiss] = useState<ReadonlySet<number>>(new Set());
  const dismissTimers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const all = schedules.data ?? [];
  const proposals = all.filter((s) => s.status === "proposed" && !pendingDismiss.has(s.id));
  const tracked = all.filter((s) => s.status === "active" || s.status === "paused");
  const paid = recentlyPaid(all, todayISO());
  const upcomingItems = (upcoming.data?.items ?? []).filter((s) => !pendingDismiss.has(s.id));
  const { overdue, due } = splitUpcoming(upcomingItems);
  const activeCategories = (categories.data ?? []).filter((c) => c.IsActive && c.Kind !== "excluded");

  const confirmProposal = (s: Schedule) => {
    action.mutate({ id: s.id, action: "confirm" }, {
      onSuccess: () => show({ message: `Now tracking ${scheduleName(s)}`, tone: "success" }),
      onError: () => show({ message: "Couldn't confirm the schedule", tone: "error" }),
    });
  };

  const dismissProposal = (s: Schedule) => {
    setPendingDismiss((prev) => new Set(prev).add(s.id));
    const timer = setTimeout(() => {
      dismissTimers.current.delete(s.id);
      action.mutate({ id: s.id, action: "dismiss" }, {
        onSettled: () => setPendingDismiss((prev) => { const n = new Set(prev); n.delete(s.id); return n; }),
        onError: () => show({ message: `Couldn't dismiss ${scheduleName(s)}`, tone: "error" }),
      });
    }, DISMISS_COMMIT_MS);
    dismissTimers.current.set(s.id, timer);
    show({
      message: `Dismissed ${scheduleName(s)} — it won't be proposed again`,
      action: {
        label: "Undo",
        onAction: () => {
          const t = dismissTimers.current.get(s.id);
          if (t) { clearTimeout(t); dismissTimers.current.delete(s.id); }
          setPendingDismiss((prev) => { const n = new Set(prev); n.delete(s.id); return n; });
        },
      },
    });
  };

  const showProposalMatches = (s: Schedule) => {
    setMatches({ title: scheduleName(s), txnIds: s.provenance?.tx_ids ?? [] });
  };

  const showPaidMatch = (s: Schedule) => {
    setMatches({ title: scheduleName(s), txnIds: s.last_matched_tx_id != null ? [s.last_matched_tx_id] : [] });
  };

  const openUpcoming = (s: UpcomingItem) => setEditing(s);

  const submitForm = (payload: SchedulePayload) => {
    if (editing) {
      update.mutate({ id: editing.id, payload }, {
        onSuccess: () => { setEditing(null); show({ message: "Schedule saved", tone: "success" }); },
        onError: (e) => show({ message: e instanceof Error ? e.message : "Couldn't save the schedule", tone: "error" }),
      });
    } else {
      create.mutate(payload, {
        onSuccess: () => { setFormOpen(false); show({ message: "Schedule added", tone: "success" }); },
        onError: (e) => show({ message: e instanceof Error ? e.message : "Couldn't add the schedule", tone: "error" }),
      });
    }
  };

  const pauseToggle = () => {
    if (!editing) return;
    const resuming = editing.status === "paused";
    action.mutate({ id: editing.id, action: resuming ? "confirm" : "pause" }, {
      onSuccess: () => {
        setEditing(null);
        show({ message: resuming ? `Resumed ${scheduleName(editing)}` : `Paused ${scheduleName(editing)}`, tone: "success" });
      },
      onError: () => show({ message: "Couldn't update the schedule", tone: "error" }),
    });
  };

  const deleteEditing = () => {
    if (!editing) return;
    remove.mutate(editing.id, {
      onSuccess: () => { setEditing(null); show({ message: `Deleted ${scheduleName(editing)}`, tone: "success" }); },
      onError: () => show({ message: "Couldn't delete the schedule", tone: "error" }),
    });
  };

  if (schedules.isError || upcoming.isError) {
    return <EmptyState icon={AlertTriangle} title="Couldn't load recurring bills" hint="Check your connection and try again." />;
  }
  if (schedules.isPending || upcoming.isPending) {
    return <Skeleton rows={8} />;
  }

  const nothingYet = all.length === 0;

  return (
    <div className="space-y-6 pb-24">
      {proposals.length > 0 && (
        <section className="space-y-2">
          <SectionLabel as="h2" className="px-1">Detected · {proposals.length}</SectionLabel>
          <DetectedCards
            proposals={proposals}
            categories={categories.data ?? []}
            onConfirm={confirmProposal}
            onDismiss={dismissProposal}
            onShowMatches={showProposalMatches}
            busyId={action.isPending ? action.variables?.id : null}
          />
        </section>
      )}

      {nothingYet ? (
        <EmptyState
          icon={Inbox}
          title="No recurring bills yet"
          hint="Repeating charges are detected from confirmed history on their own. Add one manually for bills that never email."
        />
      ) : (
        <>
          <section className="space-y-2">
            <div className="flex items-baseline justify-between px-1">
              <SectionLabel as="h2">Upcoming</SectionLabel>
              {upcomingItems.length > 0 && (
                <span className="font-mono text-[10px] tracking-[0.04em] text-muted tnum">
                  {formatFils(upcomingDebitTotal(upcomingItems))} expected
                </span>
              )}
            </div>
            <SegmentedControl<WindowDays>
              fullWidth
              value={windowDays}
              onChange={setWindowDays}
              options={[
                { value: "7", label: "7 days" },
                { value: "14", label: "14 days" },
                { value: "30", label: "30 days" },
              ]}
            />
            <UpcomingFeed items={[...overdue, ...due]} onOpen={openUpcoming} />
          </section>

          {paid.length > 0 && (
            <section className="space-y-2">
              <SectionLabel as="h2" className="px-1">Recently paid</SectionLabel>
              <RecentlyPaidList schedules={paid} onOpenMatch={showPaidMatch} />
            </section>
          )}

          {tracked.length > 0 && (
            <section className="space-y-2">
              <SectionLabel as="h2" className="px-1">All schedules · {tracked.length}</SectionLabel>
              <ScheduleList schedules={tracked} onOpen={setEditing} />
            </section>
          )}
        </>
      )}

      <Fab icon={Plus} label="Add schedule" onClick={() => setFormOpen(true)} />

      {(formOpen || editing) && (
        <ScheduleForm
          key={editing?.id ?? "new"}
          initial={editing ?? undefined}
          categories={activeCategories}
          busy={create.isPending || update.isPending || remove.isPending || action.isPending}
          onSubmit={submitForm}
          onClose={() => { setFormOpen(false); setEditing(null); }}
          onPauseToggle={editing ? pauseToggle : undefined}
          onDelete={editing ? deleteEditing : undefined}
        />
      )}

      {matches && (
        <MatchedTxnsSheet
          title={matches.title}
          txnIds={matches.txnIds}
          txnsById={txnIndex.data}
          loading={txnIndex.isPending}
          onClose={() => setMatches(null)}
        />
      )}
    </div>
  );
}
