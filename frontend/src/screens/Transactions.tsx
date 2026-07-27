// frontend/src/screens/Transactions.tsx
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getJSON, getProjects, postJSON } from "../api/client";
import type { Category, Txn } from "../api/types";
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
import { FilterBar } from "../components/transactions/FilterBar";
import { useToast } from "../components/Toast";
import { txnTotals, applyTxnFilters, filtersActive, exportUrl, exportFilename, EMPTY_FILTERS, type TxnFilters, type ManualTxnPayload } from "../lib/transactions";
import { searchTxns } from "../lib/analysis";
import { formatFils } from "../lib/money";
import { AlertTriangle, ListOrdered, Search, Plus, Download, SlidersHorizontal, Tag, Archive, ArchiveRestore } from "lucide-react";
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
  const [linkTxn, setLinkTxn] = useState<Txn | null>(null);
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

  const rows = useMemo(() => {
    const filtered = applyTxnFilters(q.data ?? [], filters);
    return searchTxns(filtered, search);
  }, [q.data, search, filters]);
  const totals = useMemo(() => txnTotals(rows), [rows]);
  const firstReveal = useFirstReveal(rows.length > 0);
  const activeFilters = filtersActive(filters);

  // Attention count for the Review segment — meaningful only when the loaded set
  // spans all statuses ("all") or already is the review set.
  const reviewBadge = status === "" || status === "needs_review"
    ? (q.data ?? []).filter((t) => t.Status === "needs_review").length
    : undefined;

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
    <div className="space-y-3">
      <SegmentedControl
        fullWidth
        value={filter}
        onChange={setFilter}
        options={FILTERS.map((f) => (f.value === "needs_review" ? { ...f, badge: reviewBadge } : f))}
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
        <button
          type="button"
          onClick={() => { fire("selection"); setFilterOpen((o) => !o); }}
          aria-expanded={filterOpen}
          aria-label="Filters"
          className={`shrink-0 min-h-11 min-w-11 px-3 inline-flex items-center justify-center gap-1.5 rounded-md border press ${
            activeFilters > 0 ? "border-accent/30 bg-accent/10 text-fg" : "border-border bg-surface text-muted"
          }`}
        >
          <SlidersHorizontal size={16} aria-hidden />
          {activeFilters > 0 && <span className="tnum text-xs font-semibold">{activeFilters}</span>}
        </button>
        <button
          type="button"
          onClick={() => { fire("selection"); void exportCsv(); }}
          disabled={exporting}
          aria-label="Export CSV"
          title="Export CSV — current status, period and search"
          className="shrink-0 min-h-11 min-w-11 inline-flex items-center justify-center rounded-md border border-border bg-surface text-muted press disabled:opacity-50"
        >
          <Download size={16} aria-hidden />
        </button>
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
              {rows.map((t) => {
                const archived = t.Status === "archived";
                const lead: SwipeActionSpec = archived
                  ? { label: "Restore", icon: <ArchiveRestore size={18} aria-hidden />, color: "var(--color-accent)", fg: "var(--color-accent-fg)" }
                  : { label: "Categorize", icon: <Tag size={18} aria-hidden />, color: "var(--color-accent)", fg: "var(--color-accent-fg)" };
                const trail: SwipeActionSpec | undefined = archived
                  ? undefined
                  : { label: "Archive", icon: <Archive size={18} aria-hidden />, color: "#64748b", fg: "#ffffff" };
                const onCommit = (action: "lead" | "trail") => {
                  if (action === "lead") {
                    if (archived) void restoreTxn(t);
                    else setCategorizeTxn(t);
                  } else {
                    void archiveTxn(t);
                  }
                };
                return (
                  <li key={t.ID} className={firstReveal ? "stagger-item" : undefined}>
                    <SwipeableRow lead={lead} trail={trail} onCommit={onCommit}>
                      <div className="px-4">
                        <TransactionRow txn={t} onOpen={setDetail} projectsById={projectsById} />
                      </div>
                    </SwipeableRow>
                  </li>
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
          onCategorize={() => { const t = detail; setDetail(null); setCategorizeTxn(t); }}
          onStatus={(s) => { const t = detail; setDetail(null); void setStatus(t, s); }}
          onArchive={() => { const t = detail; setDetail(null); void archiveTxn(t); }}
          onRestore={() => { const t = detail; setDetail(null); void restoreTxn(t); }}
          onLinkRefund={() => { setLinkTxn(detail); setDetail(null); }}
          onUnlinkRefund={() => { const t = detail; setDetail(null); void unlinkRefund(t); }}
        />
      )}

      {categorizeTxn && cats.data && (
        <CategorizeSheet
          txn={categorizeTxn}
          categories={cats.data}
          onSubmit={async (body) => { if (await categorize(categorizeTxn, body)) setCategorizeTxn(null); }}
          onClose={() => setCategorizeTxn(null)}
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
