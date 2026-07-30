// frontend/src/screens/Transactions.tsx
import { useEffect, useMemo, useState } from "react";
import { m } from "motion/react";
import { useQuery } from "@tanstack/react-query";
import { getJSON, getProjects, postJSON } from "../api/client";
import type { Category, Txn } from "../api/types";
import { categoryInfoById, displayMerchant, splitsToBody, type SplitLineBody, type TxnDepth } from "../lib/txSplit";
import { SplitSheet } from "../components/transactions/SplitSheet";
import { RenameMerchantSheet } from "../components/transactions/RenameMerchantSheet";
import { EmailPreviewSheet } from "../components/transactions/EmailPreviewSheet";
import { useRules, useSaveSplits } from "../api/hooks";
import { SegmentedControl } from "../components/ui/SegmentedControl";
import { Card } from "../components/ui/Card";
import { Input } from "../components/ui/Field";
import { Skeleton } from "../components/Skeleton";
import { EmptyState } from "../components/EmptyState";
import { TransactionRow } from "../components/transactions/TransactionRow";
import { SwipeableRow, type SwipeActionSpec } from "../components/transactions/SwipeableRow";
import { CategorizeSheet } from "../components/transactions/CategorizeSheet";
import { TransactionDetailSheet } from "../components/transactions/TransactionDetailSheet";
import { LinkRefundSheet } from "../components/transactions/LinkRefundSheet";
import { AddTransactionSheet } from "../components/transactions/AddTransactionSheet";
import { Fab } from "../components/ui/Fab";
import { Pressable } from "../components/ui/Pressable";
import { FilterBar } from "../components/transactions/FilterBar";
import { useToast } from "../components/Toast";
import { txnTotals, applyTxnFilters, filtersActive, exportUrl, exportFilename, EMPTY_FILTERS, type TxnFilters, type ManualTxnPayload } from "../lib/transactions";
import { searchTxns } from "../lib/analysis";
import { formatFils } from "../lib/money";
import { DUR, EASE_OUT } from "../lib/motion";
import { AlertTriangle, ListOrdered, Search, Plus, Download, SlidersHorizontal, Tag, Archive, ArchiveRestore } from "../components/ui/PixelIcon";
import { useTxnActions } from "../hooks/useTxnActions";
import { useFirstReveal } from "../hooks/useFirstReveal";
import { fire } from "../lib/feedback";

type Filter = "all" | "needs_review" | "confirmed" | "archived";
const FILTERS = [
  { value: "all" as const, label: "All" },
  { value: "needs_review" as const, label: "Review" },
  { value: "confirmed" as const, label: "Confirmed" },
  { value: "archived" as const, label: "Archived" },
];

export function Transactions({ from, to }: { from?: string; to?: string }) {
  const { show } = useToast();
  const { invalidate, setStatus, archiveTxn, restoreTxn, categorize, unlinkRefund } = useTxnActions();
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState<TxnFilters>(EMPTY_FILTERS);
  const [filterOpen, setFilterOpen] = useState(false);
  const [detail, setDetail] = useState<Txn | null>(null);
  const [categorizeTxn, setCategorizeTxn] = useState<Txn | null>(null);
  const [categorizeAsTransfer, setCategorizeAsTransfer] = useState(false);
  const [linkTxn, setLinkTxn] = useState<Txn | null>(null);
  const [splitTxn, setSplitTxn] = useState<TxnDepth | null>(null);
  const [renameTxn, setRenameTxn] = useState<TxnDepth | null>(null);
  const [emailTxn, setEmailTxn] = useState<Txn | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [exporting, setExporting] = useState(false);

  const status = filter === "all" ? "" : filter;
  const q = useQuery({
    queryKey: ["transactions", status, from ?? "", to ?? ""],
    queryFn: () => {
      const params = new URLSearchParams();
      if (status) params.set("status", status);
      if (from) params.set("from", from);
      if (to) params.set("to", to);
      const qs = params.toString();
      return getJSON<Txn[]>(qs ? `/api/transactions?${qs}` : "/api/transactions");
    },
  });
  const cats = useQuery({ queryKey: ["categories"], queryFn: () => getJSON<Category[]>("/api/categories") });
  const projects = useQuery({ queryKey: ["projects", "active"], queryFn: () => getProjects(false) });
  const projectsById = useMemo(
    () => Object.fromEntries((projects.data ?? []).map((p) => [p.id, { name: p.name, color: p.color }])),
    [projects.data],
  );
  const splitCats = useMemo(() => categoryInfoById(cats.data ?? []), [cats.data]);

  // Rules load lazily, only once a rename sheet is requested.
  const rules = useRules(!!renameTxn);
  useEffect(() => {
    if (renameTxn && rules.isError) {
      setRenameTxn(null);
      show({ message: "Couldn't load merchant rules", tone: "error" });
    }
  }, [renameTxn, rules.isError, show]);

  const splitsMutation = useSaveSplits();
  // Saving a split set. Un-splitting is the one destructive direction (line
  // amounts and notes are gone), so it gets an undo that also restores a
  // confirmed parent's status (un-split parks it in review by contract).
  const saveSplits = async (t: TxnDepth, body: SplitLineBody[]) => {
    const prev = t.Splits ?? [];
    const name = displayMerchant(t) || "transaction";
    try {
      await splitsMutation.mutateAsync({ txnId: t.ID, splits: body });
      setSplitTxn(null);
      if (body.length === 0) {
        show({
          message: `Removed split — ${name} is back in review`,
          action: {
            label: "Undo",
            onAction: () => {
              void splitsMutation.mutateAsync({ txnId: t.ID, splits: splitsToBody(prev) })
                .then(async () => {
                  if (t.Status === "confirmed") {
                    await postJSON(`/api/transactions/${t.ID}/status`, { status: "confirmed" });
                  }
                  invalidate();
                })
                .catch(() => show({ message: "Couldn't undo", tone: "error" }));
            },
          },
        });
      } else {
        show({ message: `Split ${name} across ${body.length} categor${body.length === 1 ? "y" : "ies"}`, tone: "success" });
      }
    } catch (e) {
      show({ message: `Couldn't save the split — ${(e as Error).message}`, tone: "error" });
    }
  };

  const rows = useMemo(() => {
    const filtered = applyTxnFilters(q.data ?? [], filters);
    return searchTxns(filtered, search);
  }, [q.data, search, filters]);
  const totals = useMemo(() => txnTotals(rows), [rows]);
  const firstReveal = useFirstReveal(rows.length > 0);
  const activeFilters = filtersActive(filters);

  const createTxn = async (payload: ManualTxnPayload) => {
    try {
      await postJSON("/api/transactions", payload);
      setAddOpen(false);
      invalidate();
      show({ message: "Transaction added", tone: "success" });
    } catch { show({ message: "Couldn't add transaction", tone: "error" }); }
  };

  // Export as a shared file where the platform supports it (an iOS PWA has no
  // working <a download>), else fall back to a blob download for desktop.
  const exportCsv = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const res = await fetch(exportUrl({ status, from, to, q: search }));
      if (!res.ok) throw new Error("export failed");
      const blob = await res.blob();
      const filename = exportFilename(new Date());
      const file = new File([blob], filename, { type: "text/csv" });
      const nav = navigator as Navigator & { canShare?: (data: unknown) => boolean };
      if (nav.canShare?.({ files: [file] }) && nav.share) {
        try {
          await nav.share({ files: [file], title: filename });
        } catch (e) {
          if ((e as DOMException)?.name !== "AbortError") throw e;
        }
      } else {
        const href = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = href;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(href), 1000);
      }
    } catch {
      show({ message: "Couldn't export CSV", tone: "error" });
    } finally {
      setExporting(false);
    }
  };

  return (
    // pb-24 clears the Add-transaction FAB. It is an opaque 56px plate pinned
    // above the nav, so without a terminus the last rows scroll under it and
    // their amounts — the right-hand column it sits over — are unreadable.
    <div className="space-y-3 pb-24">
      <SegmentedControl
        fullWidth
        value={filter}
        onChange={setFilter}
        // No count badge here: BottomNav already carries the needs-review
        // number permanently, and inside an equal-width four-segment control
        // the badge squeezed this label down to "Revi…".
        options={FILTERS}
      />

      <div className="flex items-center gap-2">
        <div className="flex-1 min-w-0">
          <Input
            icon={Search}
            type="search"
            enterKeyHint="search"
            autoCorrect="off"
            placeholder="Search merchant…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <Pressable
          onClick={() => { fire("selection"); setFilterOpen((o) => !o); }}
          aria-expanded={filterOpen}
          aria-label="Filters"
          className={`shrink-0 min-h-11 min-w-11 px-3 inline-flex items-center justify-center gap-1.5 rounded-[var(--radius)] border ${
            activeFilters > 0 ? "border-accent/30 bg-accent/10 text-fg" : "border-border bg-surface text-muted"
          }`}
        >
          <SlidersHorizontal size={16} aria-hidden />
          {activeFilters > 0 && <span className="tnum text-xs font-semibold">{activeFilters}</span>}
        </Pressable>
        <Pressable
          onClick={() => { fire("selection"); void exportCsv(); }}
          disabled={exporting}
          aria-label="Export CSV"
          title="Export CSV — current status, period and search"
          className="shrink-0 min-h-11 min-w-11 inline-flex items-center justify-center rounded-[var(--radius)] border border-border bg-surface text-muted disabled:opacity-50"
        >
          <Download size={16} aria-hidden />
        </Pressable>
      </div>

      {(activeFilters > 0 || filterOpen) && (
        <FilterBar filters={filters} categories={cats.data ?? []} txns={q.data ?? []} open={filterOpen} onChange={setFilters} />
      )}

      {q.isError ? (
        <EmptyState icon={AlertTriangle} title="Couldn't load transactions" hint="Check your connection and try again." />
      ) : q.isPending ? (
        <Skeleton rows={8} />
      ) : rows.length === 0 ? (
        <EmptyState icon={ListOrdered} title="No transactions" hint="Try a different period, filter, or search." />
      ) : (
        <>
          <div className="flex items-center justify-between px-1">
            <p className="text-sm text-muted">{rows.length} transaction{rows.length === 1 ? "" : "s"}</p>
            {totals.spentFils > 0 && (
              <p className="text-sm text-muted tnum">{formatFils(totals.spentFils)} spent</p>
            )}
          </div>
          <Card className="!p-0 overflow-hidden">
            <ul className="divide-y divide-border">
              {rows.map((t, i) => {
                const archived = t.Status === "archived";
                // Categorizing a split parent is server-refused (409) — the
                // swipe's lead action edits the split instead.
                const split = ((t as TxnDepth).Splits?.length ?? 0) > 0;
                const lead: SwipeActionSpec = archived
                  ? { label: "Restore", icon: <ArchiveRestore size={18} aria-hidden />, color: "var(--color-accent)", fg: "var(--color-accent-fg)" }
                  : { label: split ? "Edit split" : "Categorize", icon: <Tag size={18} aria-hidden />, color: "var(--color-accent)", fg: "var(--color-accent-fg)" };
                const trail: SwipeActionSpec | undefined = archived
                  ? undefined
                  // #5e5e63 mirrors --color-muted: SwipeableRow's inline style needs a
                  // literal hex (see lib/swipe.ts's BUCKET_COLOR comment), not a var().
                  : { label: "Archive", icon: <Archive size={18} aria-hidden />, color: "#5e5e63", fg: "#ffffff" };
                const onCommit = (action: "lead" | "trail") => {
                  if (action === "lead") {
                    if (archived) void restoreTxn(t);
                    else if (split) setSplitTxn(t as TxnDepth);
                    else setCategorizeTxn(t);
                  } else {
                    void archiveTxn(t);
                  }
                };
                return (
                  <m.li
                    key={t.ID}
                    // See Home.tsx's recent list for the full reasoning:
                    // `initial={false}` on a refetch is what keeps this
                    // one-shot, and the 0.24s ceiling reproduces the retired
                    // `.stagger-item:nth-child(n+7)` cap — which matters far
                    // more here, where the list runs to hundreds of rows.
                    initial={firstReveal ? { opacity: 0, y: 8 } : false}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: DUR.sheet, ease: EASE_OUT, delay: Math.min(i * 0.04, 0.24) }}
                  >
                    <SwipeableRow lead={lead} trail={trail} onCommit={onCommit}>
                      <div className="px-4">
                        <TransactionRow txn={t} onOpen={setDetail} projectsById={projectsById} splitCategories={splitCats} />
                      </div>
                    </SwipeableRow>
                  </m.li>
                );
              })}
            </ul>
          </Card>
        </>
      )}

      {detail && (
        <TransactionDetailSheet
          txn={detail}
          onClose={() => setDetail(null)}
          onCategorize={() => { const t = detail; setDetail(null); setCategorizeAsTransfer(false); setCategorizeTxn(t); }}
          onTransfer={() => { const t = detail; setDetail(null); setCategorizeAsTransfer(true); setCategorizeTxn(t); }}
          onStatus={(s) => { const t = detail; setDetail(null); void setStatus(t, s); }}
          onArchive={() => { const t = detail; setDetail(null); void archiveTxn(t); }}
          onRestore={() => { const t = detail; setDetail(null); void restoreTxn(t); }}
          onLinkRefund={() => { setLinkTxn(detail); setDetail(null); }}
          onUnlinkRefund={() => { const t = detail; setDetail(null); void unlinkRefund(t); }}
          onSplit={() => { const t = detail as TxnDepth; setDetail(null); setSplitTxn(t); }}
          onRename={() => { const t = detail as TxnDepth; setDetail(null); setRenameTxn(t); }}
          onViewEmail={() => { const t = detail; setDetail(null); setEmailTxn(t); }}
        />
      )}

      {splitTxn && cats.data && (
        <SplitSheet
          txn={splitTxn}
          categories={cats.data}
          onSubmit={(body) => saveSplits(splitTxn, body)}
          onClose={() => setSplitTxn(null)}
        />
      )}

      {renameTxn && rules.data && (
        <RenameMerchantSheet
          txn={renameTxn}
          rules={rules.data}
          txns={q.data ?? []}
          onClose={() => setRenameTxn(null)}
          onSaved={(name) => {
            setRenameTxn(null);
            show({ message: name ? `Shown as “${name}” from now on` : "Merchant name cleared", tone: "success" });
          }}
        />
      )}

      {emailTxn && <EmailPreviewSheet txn={emailTxn} onClose={() => setEmailTxn(null)} />}

      {categorizeTxn && cats.data && (
        <CategorizeSheet
          txn={categorizeTxn}
          categories={categorizeAsTransfer ? cats.data.filter((c) => c.Kind === "excluded") : cats.data}
          title={categorizeAsTransfer ? "Classify transfer" : "Categorize"}
          onSubmit={async (body) => {
            if (!await categorize(categorizeTxn, body)) return;
            if (categorizeAsTransfer) await setStatus(categorizeTxn, "transfer");
            setCategorizeTxn(null);
            setCategorizeAsTransfer(false);
          }}
          onClose={() => { setCategorizeTxn(null); setCategorizeAsTransfer(false); }}
          onLinkRefund={() => { setLinkTxn(categorizeTxn); setCategorizeTxn(null); }}
          onUnlinkRefund={() => { const t = categorizeTxn; setCategorizeTxn(null); void unlinkRefund(t); }}
        />
      )}

      {linkTxn && (
        <LinkRefundSheet
          txn={linkTxn}
          onLinked={() => {
            setLinkTxn(null);
            invalidate();
            show({ message: "Refund linked", tone: "success" });
          }}
          onClose={() => setLinkTxn(null)}
        />
      )}

      <Fab icon={Plus} label="Add transaction" onClick={() => setAddOpen(true)} />

      {addOpen && (
        <AddTransactionSheet categories={cats.data ?? []} onSubmit={createTxn} onClose={() => setAddOpen(false)} />
      )}
    </div>
  );
}
