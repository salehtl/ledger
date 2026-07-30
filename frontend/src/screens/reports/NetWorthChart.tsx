import { useEffect, useRef, useState } from "react";
import { Money } from "../../components/Money";
import { SCRUB_SURFACE } from "../../components/charts/scrubSurface";
import { scrubIntent } from "../../lib/chartScrub";
import { formatFils } from "../../lib/money";
import {
  areaPolygon,
  axisIndices,
  linePoints,
  monthColumn,
  nearestIndex,
  pctLabel,
  polylinePoints,
  type NetWorthPoint,
} from "../../lib/reports";

/** "May ’26" for a "YYYY-MM" month. */
function monthYear(month: string): string {
  const c = monthColumn(month);
  return `${c.mon} ${c.yr}`;
}

/**
 * The net-worth line: month-end balances across budget + tracking accounts,
 * drawn as an ink polyline over a dithered area fill (the DOM `.dither-mask`
 * texture — same dot grid as every other chart surface). Dragging across the
 * chart scrubs the selected month (axis-locked so vertical drags still scroll
 * the page); a tap selects the nearest month. The readout above and the
 * transactions row below always describe the selected month, so the figure on
 * screen is never ambiguous about "as of when".
 *
 * Pure geometry lives in lib/reports.ts (linePoints/areaPolygon/nearestIndex);
 * this component is layout + gesture wiring only. No entrance animation:
 * reports are a read surface, and a chart you consult often earns none (P18).
 */
export function NetWorthChart({ points, onDrillMonth }: {
  points: NetWorthPoint[];
  /** Open the transactions behind a month. */
  onDrillMonth?: (month: string) => void;
}) {
  const n = points.length;
  const [sel, setSel] = useState<number | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const touchRef = useRef<{ x: number; y: number; claimed: boolean } | null>(null);

  const selectAtClientX = (clientX: number) => {
    const el = boxRef.current;
    if (!el || n === 0) return;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0) return;
    setSel(nearestIndex((clientX - rect.left) / rect.width, n));
  };
  const selectRef = useRef(selectAtClientX);
  selectRef.current = selectAtClientX;

  // Touch scrub with the app-wide axis lock: judge nothing inside the slop
  // zone, claim clearly-horizontal drags (preventDefault holds the page
  // still), reject vertical ones so scrolling and pull-to-refresh keep
  // working. Native non-passive listeners because claiming requires
  // preventDefault() — the same wiring dither-kit's charts use.
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const start = (e: TouchEvent) => {
      const t = e.touches[0];
      touchRef.current = { x: t.clientX, y: t.clientY, claimed: false };
    };
    const move = (e: TouchEvent) => {
      const st = touchRef.current;
      if (!st) return;
      const t = e.touches[0];
      if (!st.claimed) {
        const intent = scrubIntent(t.clientX - st.x, t.clientY - st.y);
        if (intent === "reject") { touchRef.current = null; return; }
        if (intent !== "claim") return;
        st.claimed = true;
      }
      if (e.cancelable) e.preventDefault();
      selectRef.current(t.clientX);
    };
    const end = () => { touchRef.current = null; };
    el.addEventListener("touchstart", start, { passive: true });
    el.addEventListener("touchmove", move, { passive: false });
    el.addEventListener("touchend", end);
    el.addEventListener("touchcancel", end);
    return () => {
      el.removeEventListener("touchstart", start);
      el.removeEventListener("touchmove", move);
      el.removeEventListener("touchend", end);
      el.removeEventListener("touchcancel", end);
    };
  }, []);

  if (n === 0) return null;

  const values = points.map((p) => p.networth_fils);
  const pts = linePoints(values);
  const idx = sel === null ? n - 1 : Math.min(sel, n - 1);
  const p = points[idx];
  const prev = idx > 0 ? points[idx - 1] : null;
  const delta = prev === null ? null : p.networth_fils - prev.networth_fils;
  const deltaPct =
    prev === null || prev.networth_fils === 0
      ? null
      : (p.networth_fils - prev.networth_fils) / Math.abs(prev.networth_fils);
  const marker = pts[idx];

  return (
    <div style={SCRUB_SURFACE}>
      <div className="flex items-baseline justify-between gap-3">
        <span className="tnum text-2xl font-semibold tracking-[-0.02em]">
          <Money fils={p.networth_fils} />
        </span>
        <span className="font-mono text-[10px] tracking-[0.04em] text-muted shrink-0">
          as of {monthYear(p.month)}
        </span>
      </div>
      <p className="mt-0.5 font-mono text-[10px] tracking-[0.04em] text-muted tnum">
        {delta === null ? "first month on record" : (
          <>
            {delta === 0 ? "unchanged" : `${delta > 0 ? "+" : "−"}${formatFils(Math.abs(delta))}`}
            {deltaPct !== null && ` (${pctLabel(deltaPct)})`} vs {monthYear(points[idx - 1].month)}
          </>
        )}
        {" · "}budget {formatFils(p.budget_fils)} · tracking {formatFils(p.tracking_fils)}
      </p>

      <div
        ref={boxRef}
        role="img"
        aria-label={`Net worth over ${n} months, ${monthYear(points[0].month)} to ${monthYear(points[n - 1].month)}, currently ${formatFils(points[n - 1].networth_fils)}`}
        className="relative mt-3 h-36 cursor-crosshair"
        onClick={(e) => selectAtClientX(e.clientX)}
        onPointerMove={(e) => {
          if (e.pointerType !== "touch" && e.buttons === 1) selectAtClientX(e.clientX);
        }}
      >
        {/* Area under the line: the app's one dot texture, in low-emphasis ink. */}
        <div
          aria-hidden
          className="absolute inset-0 dither-mask opacity-60"
          style={{ background: "var(--color-muted)", clipPath: areaPolygon(pts) }}
        />
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute inset-0 h-full w-full" aria-hidden>
          <polyline
            points={polylinePoints(pts)}
            fill="none"
            stroke="var(--color-fg)"
            strokeWidth={1.5}
            vectorEffect="non-scaling-stroke"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        </svg>
        {/* Selected-month marker: hairline + ink dot. */}
        <div aria-hidden className="absolute top-0 bottom-0 w-px bg-border" style={{ left: `${marker.x}%` }} />
        <div
          aria-hidden
          data-testid="networth-marker"
          className="absolute h-1.5 w-1.5 rounded-[var(--radius)] bg-fg"
          style={{ left: `${marker.x}%`, top: `${marker.y}%`, transform: "translate(-50%, -50%)" }}
        />
      </div>

      <div className="relative mt-1 h-4" aria-hidden>
        {axisIndices(n).map((i) => (
          <span
            key={i}
            className="absolute font-mono text-[10px] tracking-[0.04em] text-muted whitespace-nowrap"
            style={{
              left: `${pts[i].x}%`,
              transform: i === 0 ? "none" : i === n - 1 ? "translateX(-100%)" : "translateX(-50%)",
            }}
          >
            {monthYear(points[i].month)}
          </span>
        ))}
      </div>

      {onDrillMonth && (
        <button
          type="button"
          onClick={() => onDrillMonth(p.month)}
          className="mt-2 flex min-h-11 w-full items-center justify-between border-t border-border text-sm font-medium press"
        >
          <span>Transactions in {monthYear(p.month)}</span>
          <span aria-hidden className="text-muted">›</span>
        </button>
      )}
    </div>
  );
}
