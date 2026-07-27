"use client"

import { useEffect, useState } from "react"
import { useCommonChart } from "./common-context"
import { cn } from "./lib"
import { rgb } from "./palette"

export type TooltipVariant = "default" | "frosted-glass"

const VARIANT: Record<TooltipVariant, string> = {
  default: "bg-popover",
  "frosted-glass": "bg-popover/70 backdrop-blur-sm",
}

// FORKED: upstream animated this with `motion` (framer-motion) — 128KB of JS,
// precached by the service worker, for one tooltip. The same shape in CSS: fade
// in/out on `opacity`, glide between points on `left`/`top`, both on the app's
// `--ease-out` token. `.dither-tooltip` carries the reduced-motion opt-out (see
// styles/app.css — inline styles can't hold a media query).
const FADE_MS = 160
const GLIDE_MS = 190
const FADE = `opacity ${FADE_MS}ms var(--ease-out)`
const GLIDE = `left ${GLIDE_MS}ms var(--ease-out), top ${GLIDE_MS}ms var(--ease-out)`

/**
 * Floating hover tooltip. Reads the shared common context so it works in every
 * chart family. It glides between points and fades in/out (instead of snapping),
 * and dims unselected series/slices.
 */
export function Tooltip({
  labelKey,
  valueFormatter,
  variant = "default",
}: {
  labelKey?: string
  valueFormatter?: (value: number, name: string) => string
  variant?: TooltipVariant
}) {
  const chart = useCommonChart()
  const show = chart.ready && chart.hoverIndex != null

  // Retain the last hovered index so the card keeps its content while fading
  // out — adjust-state-during-render (no refs in render).
  const [lastIndex, setLastIndex] = useState(0)
  if (chart.hoverIndex != null && chart.hoverIndex !== lastIndex) {
    setLastIndex(chart.hoverIndex)
  }
  const index = chart.hoverIndex ?? lastIndex

  // Same trick for the position: on hover-out the context reports a parked
  // fallback (`tooltipTop` collapses to its floor), which would jerk the card
  // sideways mid-fade. Freeze the last hovered coordinates so the exit is a
  // pure fade, which is what the framer version did.
  const [pos, setPos] = useState({
    left: chart.tooltipLeft,
    top: chart.tooltipTop,
  })
  if (show && (pos.left !== chart.tooltipLeft || pos.top !== chart.tooltipTop)) {
    setPos({ left: chart.tooltipLeft, top: chart.tooltipTop })
  }

  const heading = chart.heading(index, labelKey)
  const items = chart.itemsAt(index)
  const visible = show && items.length > 0

  // Presence, in place of <AnimatePresence>: mount on show, stay mounted for
  // the exit fade, then unmount. Staying mounted permanently would leave a copy
  // of every hovered label sitting in the DOM.
  const [present, setPresent] = useState(false)
  // Armed one *painted* frame after mount. Until then the card carries no
  // transition-driving state change, so it lands at its first position and at
  // opacity 0 without animating there; arming is what fades it in and what lets
  // subsequent hovers glide. Without the gate the entrance would fly in from
  // wherever the previous hover left the card. Two rAFs guarantee a paint
  // between mount and arm.
  const [armed, setArmed] = useState(false)

  useEffect(() => {
    if (visible) {
      setPresent(true)
      return
    }
    setArmed(false)
    const t = setTimeout(() => setPresent(false), FADE_MS)
    return () => clearTimeout(t)
  }, [visible])

  useEffect(() => {
    if (!(present && visible)) return
    let inner = 0
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => setArmed(true))
    })
    return () => {
      cancelAnimationFrame(outer)
      cancelAnimationFrame(inner)
    }
  }, [present, visible])

  if (!present) return null

  return (
    <div
      className={cn(
        "dither-tooltip pointer-events-none absolute z-10 rounded-[var(--radius)] border px-2 py-1 shadow-sm",
        VARIANT[variant]
      )}
      style={{
        left: pos.left,
        top: pos.top,
        transform: "translate(-50%, -115%)",
        opacity: armed && visible ? 1 : 0,
        transition: armed ? `${FADE}, ${GLIDE}` : FADE,
      }}
    >
      {heading && (
        <div className="mb-0.5 font-mono text-[10px] text-muted-foreground">
          {heading}
        </div>
      )}
      <div className="flex flex-col gap-0.5">
        {items.map((item) => (
          <div
            key={item.name}
            className="flex items-center gap-1.5 font-mono text-[11px] text-popover-foreground tabular-nums"
            style={{ opacity: item.dimmed ? 0.4 : 1 }}
          >
            <span
              className="size-2 rounded-[var(--radius)]"
              style={{ backgroundColor: rgb(item.seed.fill) }}
            />
            <span className="text-muted-foreground">{item.label}</span>
            <span className="ml-auto pl-2 text-foreground">
              {valueFormatter
                ? valueFormatter(item.value, item.name)
                : item.value.toLocaleString()}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

Tooltip.chartLayer = "dom" as const
