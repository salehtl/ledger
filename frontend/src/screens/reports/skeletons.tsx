// Purpose-built loading placeholders for the reports suite. Each mirrors its
// loaded component's real chrome — same spacing, same line boxes — so the
// pending → loaded swap never moves anything below it (charter §3: skeletons
// must reserve final dimensions). The shared list Skeleton is deliberately
// not used here: its 4px rows reserve a fraction of these surfaces' height.

function Pulse({ className = "" }: { className?: string }) {
  return <div className={`rounded-[var(--radius)] bg-surface-2 ${className}`} />;
}

/** Mirrors NetWorthChart: readout line, meta line, h-36 plot, axis, drill row. */
export function NetWorthSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading" className="animate-pulse">
      <div className="flex h-8 items-center justify-between gap-3">
        <Pulse className="h-6 w-36" />
        <Pulse className="h-3 w-24" />
      </div>
      <div className="mt-0.5 flex h-4 items-center">
        <Pulse className="h-3 w-56 max-w-full" />
      </div>
      <Pulse className="mt-3 h-36" />
      <div className="mt-1 h-4" />
      <div className="mt-2 flex min-h-11 items-center border-t border-border">
        <Pulse className="h-4 w-44" />
      </div>
    </div>
  );
}

/** Mirrors the computable AgeOfMoneyTile: headline row, the always-reserved
 *  h-8 sparkline strip, two explainer lines, inside the same bordered card. */
export function AgeOfMoneySkeleton() {
  return (
    <div
      aria-busy="true"
      aria-label="Loading"
      className="animate-pulse rounded-[var(--radius)] border border-border bg-surface p-4"
    >
      <div className="flex h-7 items-center justify-between gap-3">
        <Pulse className="h-5 w-20" />
        <Pulse className="h-3 w-24" />
      </div>
      <Pulse className="mt-2 h-8" />
      <div className="mt-2 space-y-2">
        <Pulse className="h-4 w-full" />
        <Pulse className="h-4 w-2/3" />
      </div>
    </div>
  );
}

/** Mirrors the loaded matrix at its typical fill: header row, an income block
 *  and a spending block of 37px rows (36px cells + hairline), a net row —
 *  capped at the same 60vh the loaded table scrolls inside. */
export function MatrixSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading" className="max-h-[60vh] overflow-hidden animate-pulse">
      <div className="flex h-[22px] items-center gap-6 px-3">
        <Pulse className="h-3 w-20" />
        <Pulse className="ml-auto h-3 w-12" />
        <Pulse className="h-3 w-12" />
        <Pulse className="h-3 w-12" />
      </div>
      {[2, 10].map((count, block) => (
        <div key={block}>
          <div className="flex h-[27px] items-end px-3 pb-1">
            <Pulse className="h-3 w-16" />
          </div>
          {Array.from({ length: count }).map((_, i) => (
            <div key={i} className="flex h-[37px] items-center justify-between border-b border-border px-3">
              <Pulse className="h-3 w-24" />
              <Pulse className="h-3 w-14" />
            </div>
          ))}
        </div>
      ))}
      <div className="flex h-9 items-center justify-between px-3">
        <Pulse className="h-3 w-10" />
        <Pulse className="h-3 w-14" />
      </div>
    </div>
  );
}

/** Mirrors TrendCompare: summary rows, legend, then twelve min-h-11 month
 *  rows each with the two stacked 5px compare bars. */
export function TrendsSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading" className="animate-pulse">
      <div className="flex h-6 items-center justify-between gap-3">
        <Pulse className="h-4 w-24" />
        <Pulse className="h-3 w-28" />
      </div>
      <div className="mt-0.5 flex h-4 items-center">
        <Pulse className="h-3 w-32" />
      </div>
      <div className="mt-3 flex h-4 items-center gap-4">
        <Pulse className="h-3 w-16" />
        <Pulse className="h-3 w-16" />
      </div>
      <ul className="mt-2 divide-y divide-border">
        {Array.from({ length: 12 }).map((_, i) => (
          <li key={i} className="flex min-h-11 items-center gap-3">
            <Pulse className="h-3 w-14 shrink-0" />
            <span className="flex-1 space-y-0.5">
              <Pulse className="h-[5px] w-full" />
              <Pulse className="h-[5px] w-full" />
            </span>
            <Pulse className="h-3 w-20 shrink-0" />
          </li>
        ))}
      </ul>
    </div>
  );
}
