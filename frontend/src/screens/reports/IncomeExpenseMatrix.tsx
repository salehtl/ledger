import { Fragment, useMemo } from "react";
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
} from "@tanstack/react-table";
import { Money } from "../../components/Money";
import { EmptyState } from "../../components/EmptyState";
import { Inbox } from "../../components/ui/PixelIcon";
import { formatFils } from "../../lib/money";
import {
  monthYear,
  netTotals,
  type IncomeExpenseResponse,
  type IncomeExpenseRow,
} from "../../lib/reports";

const col = createColumnHelper<IncomeExpenseRow>();

/**
 * The income-v-expense matrix: category rows × months, income block first,
 * then spending, a net row at the bottom, and average/total columns at the
 * far end. Built on TanStack Table, scrolled inside its own two-axis
 * `overflow-auto` container capped at 60vh — the page never scrolls
 * horizontally; the category column stays sticky through horizontal scroll
 * and the month header row stays sticky through vertical scroll, so a
 * mid-table position never loses its row labels or its month context.
 *
 * Months are displayed newest-first so the mobile viewport opens on the
 * months that matter; the header row names every column, so the order is
 * never a puzzle. Every money cell drills to the exact transactions behind
 * it (cell = category × month, name/total = category across the window,
 * net row = the whole month).
 */
export function IncomeExpenseMatrix({ data, onDrillCell, onDrillRow, onDrillMonth }: {
  data: IncomeExpenseResponse;
  onDrillCell: (row: IncomeExpenseRow, month: string) => void;
  onDrillRow: (row: IncomeExpenseRow) => void;
  onDrillMonth: (month: string) => void;
}) {
  // Newest month adjacent to the sticky name column.
  const monthsDesc = useMemo(() => [...data.months].reverse(), [data.months]);

  const columns = useMemo<ColumnDef<IncomeExpenseRow, unknown>[]>(() => [
    col.display({
      id: "name",
      header: "Category",
      cell: ({ row }) => (
        <button
          type="button"
          onClick={() => onDrillRow(row.original)}
          aria-label={`All ${row.original.name} transactions in this window`}
          className="flex min-h-9 w-full items-center px-3 text-left font-mono text-xs tracking-[0.02em] press"
        >
          <span className="truncate">{row.original.name}</span>
        </button>
      ),
    }),
    ...monthsDesc.map((m) => {
      const mi = data.months.indexOf(m);
      return col.display({
        id: `m:${m}`,
        header: m,
        cell: ({ row }: { row: { original: IncomeExpenseRow } }) => (
          <CellButton
            fils={row.original.by_month_fils[mi] ?? 0}
            label={`${row.original.name}, ${monthYear(m)}`}
            onClick={() => onDrillCell(row.original, m)}
          />
        ),
      });
    }),
    col.display({
      id: "avg",
      header: "Avg/mo",
      cell: ({ row }) => (
        <span className="flex min-h-9 items-center justify-end px-3 tnum text-xs text-muted">
          {formatFils(row.original.avg_fils)}
        </span>
      ),
    }),
    col.display({
      id: "total",
      header: "Total",
      cell: ({ row }) => (
        <CellButton
          fils={row.original.total_fils}
          label={`All ${row.original.name} transactions in this window`}
          onClick={() => onDrillRow(row.original)}
          emphasis
        />
      ),
    }),
  ], [data.months, monthsDesc, onDrillCell, onDrillRow]);

  const table = useReactTable({
    data: data.rows,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getRowId: (r) => String(r.category_id),
  });

  if (data.rows.length === 0) {
    return <EmptyState icon={Inbox} title="Nothing to compare yet" hint="Confirmed transactions fill this matrix in, month by month." />;
  }

  const rows = table.getRowModel().rows;
  const net = netTotals(data.net_by_month_fils);

  return (
    <div className="max-h-[60vh] overflow-auto" data-testid="matrix-scroll">
      <table className="w-max min-w-full border-separate border-spacing-0">
        <thead>
          <tr>
            {table.getFlatHeaders().map((h) => {
              const isName = h.column.id === "name";
              const isMonth = h.column.id.startsWith("m:");
              return (
                <th
                  key={h.id}
                  scope="col"
                  className={`sticky top-0 border-b border-border bg-surface pb-1.5 font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-muted ${
                    isName
                      ? "left-0 z-30 px-3 text-left after:absolute after:inset-y-0 after:right-0 after:w-px after:bg-border"
                      : "z-20 px-3 text-right"
                  } ${h.column.id === "avg" ? "border-l border-border" : ""}`}
                >
                  {isMonth
                    ? monthYear(h.column.id.slice(2))
                    : flexRender(h.column.columnDef.header, h.getContext())}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => {
            const kindStarts = i === 0 || rows[i - 1].original.kind !== row.original.kind;
            return (
              <Fragment key={row.id}>
                {kindStarts && (
                  <tr>
                    <td
                      colSpan={columns.length}
                      className="sticky left-0 border-b border-border bg-surface px-3 pb-1 pt-3 font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-muted"
                    >
                      {row.original.kind === "income" ? "Income" : "Spending"}
                    </td>
                  </tr>
                )}
                <tr>
                  {row.getVisibleCells().map((cell) => {
                    const isName = cell.column.id === "name";
                    return (
                      <td
                        key={cell.id}
                        className={`border-b border-border p-0 ${
                          isName
                            ? "sticky left-0 z-10 bg-surface after:absolute after:inset-y-0 after:right-0 after:w-px after:bg-border"
                            : ""
                        } ${cell.column.id === "avg" ? "border-l border-border" : ""}`}
                      >
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </td>
                    );
                  })}
                </tr>
              </Fragment>
            );
          })}
        </tbody>
        <tfoot>
          <tr>
            <td className="sticky left-0 z-10 bg-surface px-3 font-mono text-xs font-medium tracking-[0.02em] after:absolute after:inset-y-0 after:right-0 after:w-px after:bg-border">
              Net
            </td>
            {monthsDesc.map((m) => {
              const mi = data.months.indexOf(m);
              return (
                <td key={m} className="p-0">
                  <CellButton
                    fils={data.net_by_month_fils[mi] ?? 0}
                    label={`Net for ${monthYear(m)}`}
                    onClick={() => onDrillMonth(m)}
                    emphasis
                  />
                </td>
              );
            })}
            <td className="border-l border-border px-3 text-right">
              <span className="flex min-h-9 items-center justify-end tnum text-xs text-muted">{formatFils(net.avg)}</span>
            </td>
            <td className="p-0">
              <span className={`flex min-h-9 items-center justify-end px-3 tnum text-xs font-medium ${net.total < 0 ? "text-bad" : ""}`}>
                {formatFils(net.total)}
              </span>
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

/** One drillable money cell — 36px min target (dense stacked table rows). */
function CellButton({ fils, label, onClick, emphasis = false }: {
  fils: number;
  label: string;
  onClick: () => void;
  emphasis?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`${label}: ${formatFils(fils)}`}
      className={`flex min-h-9 w-full items-center justify-end px-3 text-right press ${emphasis ? "font-medium" : ""}`}
    >
      <span className="tnum text-xs">
        <Money fils={fils} />
      </span>
    </button>
  );
}
