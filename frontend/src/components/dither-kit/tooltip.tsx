"use client"

import { useState } from "react"
import { AnimatePresence, m } from "motion/react"
import { useCommonChart } from "./common-context"
import { cn } from "./lib"
import { rgb } from "./palette"
import { DUR, EASE_OUT } from "../../lib/motion"

export type TooltipVariant = "default" | "frosted-glass"

const VARIANT: Record<TooltipVariant, string> = {
  default: "bg-popover",
  "frosted-glass": "bg-popover/70 backdrop-blur-sm",
}

// FORKED: upstream animated this with framer-motion and this file was once
// forked *away* from it over bundle size. The dependency is now present and
// code-split behind LazyMotion, so the hand-rolled presence machinery (two
// nested rAFs, an `armed` gate, a fade timeout, and a frozen-position
// workaround for the parked hover-out coordinates) has been deleted in
// favour of AnimatePresence, which handles all four cases natively.

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

  const heading = chart.heading(index, labelKey)
  const items = chart.itemsAt(index)
  const visible = show && items.length > 0

  return (
    <AnimatePresence>
      {visible && (
        <m.div
          className={cn(
            "dither-tooltip pointer-events-none absolute z-10 rounded-[var(--radius)] border px-2 py-1 shadow-sm",
            VARIANT[variant]
          )}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1, left: chart.tooltipLeft, top: chart.tooltipTop }}
          exit={{ opacity: 0 }}
          transition={{
            opacity: { duration: DUR.fast, ease: EASE_OUT },
            // Slightly longer than the fade, deliberately: the card should
            // finish arriving after it has finished appearing.
            left: { duration: 0.19, ease: EASE_OUT },
            top: { duration: 0.19, ease: EASE_OUT },
          }}
          style={{ transform: "translate(-50%, -115%)" }}
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
        </m.div>
      )}
    </AnimatePresence>
  )
}

Tooltip.chartLayer = "dom" as const
