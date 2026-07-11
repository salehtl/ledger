import { useMemo } from 'react'
import { type SwipeConfig, type PreviewState, type EdgeKey, CONSOLE_COLOR } from '../../lib/swipe'
import { computeFacets, type CardRect } from '../../lib/facets'

interface Props {
  w: number
  h: number
  card: CardRect
  band: number
  config: SwipeConfig
  catName: (id: number) => string
  preview: PreviewState | null
}

const BASE_FACET = 0.06
const BASE_OTHER = 0.12

export function SwipeConsole({ w, h, card, band, config, catName, preview }: Props) {
  const facets = useMemo(() => computeFacets(w, h, card, band), [w, h, card, band])

  const halfOpacity = (edge: EdgeKey, slot: string) => {
    if (preview?.kind === 'category' && preview.edge === edge && preview.slot === slot) return 0.14 + 0.52 * preview.fill
    return BASE_FACET
  }
  const otherOpacity = (edge: EdgeKey) => {
    if (preview?.edge === edge && preview.kind === 'other') return 0.18 + 0.44 * preview.fill
    if (preview?.edge === edge && preview.kind === 'category') return 0.2 // path travelled through
    return BASE_OTHER
  }
  const slotLabel = (edge: EdgeKey, slot: 'A' | 'B') => {
    const id = slot === 'A' ? config.edges[edge].slotA : config.edges[edge].slotB
    return id ? catName(id) : '—'
  }

  return (
    <svg viewBox={`0 0 ${w} ${h}`} width={w} height={h} className="absolute inset-0 pointer-events-none" aria-hidden>
      <rect x={0} y={0} width={w} height={h} fill="#151A21" />
      {facets.halves.map(half => {
        const lit = preview?.kind === 'category' && preview.edge === half.edge && preview.slot === half.slot
        return (
          <g key={`${half.edge}-${half.slot}`}>
            <polygon points={half.points} fill={FACET_COLOR(config, half.edge)} fillOpacity={halfOpacity(half.edge, half.slot)}
              style={{ transition: 'fill-opacity 90ms linear' }} />
            <text x={half.lx} y={half.ly} transform={half.rot ? `rotate(${half.rot} ${half.lx} ${half.ly})` : undefined}
              textAnchor="middle" dominantBaseline="middle"
              fill={FACET_COLOR(config, half.edge)} fillOpacity={lit ? 1 : 0.62}
              style={{ fontSize: lit ? 13 : 10.5, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', transition: 'font-size 120ms, fill-opacity 90ms' }}>
              {slotLabel(half.edge, half.slot)}
            </text>
          </g>
        )
      })}
      {facets.others.map(o => (
        <g key={o.edge}>
          <polygon points={o.points} fill={FACET_COLOR(config, o.edge)} fillOpacity={otherOpacity(o.edge)}
            style={{ transition: 'fill-opacity 90ms linear' }} />
          <text x={o.lx} y={o.ly} transform={o.rot ? `rotate(${o.rot} ${o.lx} ${o.ly})` : undefined}
            textAnchor="middle" dominantBaseline="middle"
            fill={FACET_COLOR(config, o.edge)} fillOpacity={preview?.edge === o.edge && preview.kind === 'other' ? 0.95 : 0.45}
            style={{ fontSize: 9, fontWeight: 600, letterSpacing: '0.2em', textTransform: 'uppercase' }}>
            Other…
          </text>
        </g>
      ))}
    </svg>
  )
}

/** Console glow color for an edge, from its configured group. */
function FACET_COLOR(config: SwipeConfig, edge: EdgeKey): string {
  return CONSOLE_COLOR[config.edges[edge].group]
}
