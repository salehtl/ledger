// frontend/src/lib/facets.ts
import type { EdgeKey, SlotKey } from './swipe'

export interface CardRect { x0: number; y0: number; x1: number; y1: number }
export interface FacetHalf { edge: EdgeKey; slot: SlotKey; points: string; lx: number; ly: number; rot: number }
export interface OtherSlice { edge: EdgeKey; points: string; lx: number; ly: number; rot: number }
export interface Facets { halves: FacetHalf[]; others: OtherSlice[] }

type Pt = [number, number]
const poly = (pts: Pt[]) => pts.map(p => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ')
const cen = (pts: Pt[]): Pt => {
  let sx = 0, sy = 0
  for (const p of pts) { sx += p[0]; sy += p[1] }
  return [sx / pts.length, sy / pts.length]
}

export function centeredCard(w: number, h: number, cw: number, ch: number): CardRect {
  const x0 = (w - cw) / 2, y0 = (h - ch) / 2
  return { x0, y0, x1: x0 + cw, y1: y0 + ch }
}

/**
 * Corner-to-corner mitered facets. Each edge is a trapezoid from the card edge
 * out to the arena corners, split down its cardinal centerline into two
 * category halves. The Other slice is a shallow trapezoid hugging the card whose
 * outer edge follows the same miter slant (depth = band).
 */
export function computeFacets(w: number, h: number, card: CardRect, band: number): Facets {
  const { x0, y0, x1, y1 } = card
  const cx = w / 2, cy = h / 2
  const A: Pt = [0, 0], B: Pt = [w, 0], C: Pt = [w, h], Dc: Pt = [0, h]
  const cTL: Pt = [x0, y0], cTR: Pt = [x1, y0], cBR: Pt = [x1, y1], cBL: Pt = [x0, y1]

  const halfPts: Record<string, Pt[]> = {
    'up-A': [A, [cx, 0], [cx, y0], cTL],       'up-B': [[cx, 0], B, cTR, [cx, y0]],
    'right-A': [B, [w, cy], [x1, cy], cTR],     'right-B': [[w, cy], C, cBR, [x1, cy]],
    'down-A': [Dc, [cx, h], [cx, y1], cBL],     'down-B': [[cx, h], C, cBR, [cx, y1]],
    'left-A': [A, [0, cy], [x0, cy], cTL],       'left-B': [[0, cy], Dc, cBL, [x0, cy]],
  }
  // Legend anchor + rotation per half (left/right rotate to run along the wall).
  const halfLabel: Record<string, { at: Pt; rot: number }> = {
    'up-A': { at: cen(halfPts['up-A']), rot: 0 },    'up-B': { at: cen(halfPts['up-B']), rot: 0 },
    'down-A': { at: cen(halfPts['down-A']), rot: 0 }, 'down-B': { at: cen(halfPts['down-B']), rot: 0 },
    'right-A': { at: [(w + x1) / 2, (y0 + cy) / 2], rot: 90 }, 'right-B': { at: [(w + x1) / 2, (cy + y1) / 2], rot: 90 },
    'left-A': { at: [x0 / 2, (y0 + cy) / 2], rot: -90 },        'left-B': { at: [x0 / 2, (cy + y1) / 2], rot: -90 },
  }
  const halves: FacetHalf[] = (Object.keys(halfPts) as string[]).map(k => {
    const [edge, slot] = k.split('-') as [EdgeKey, SlotKey]
    const { at, rot } = halfLabel[k]
    return { edge, slot, points: poly(halfPts[k]), lx: at[0], ly: at[1], rot }
  })

  const sT = band / y0, sB = band / (h - y1), sL = band / x0, sR = band / (w - x1)
  const otherPts: Record<EdgeKey, Pt[]> = {
    up: [[x0, y0], [x1, y0], [x1 + (w - x1) * sT, y0 - band], [x0 - x0 * sT, y0 - band]],
    down: [[x0, y1], [x1, y1], [x1 + (w - x1) * sB, y1 + band], [x0 - x0 * sB, y1 + band]],
    left: [[x0, y0], [x0, y1], [x0 - band, y1 + (h - y1) * sL], [x0 - band, y0 - y0 * sL]],
    right: [[x1, y0], [x1, y1], [x1 + band, y1 + (h - y1) * sR], [x1 + band, y0 - y0 * sR]],
  }
  const otherLabel: Record<EdgeKey, { at: Pt; rot: number }> = {
    up: { at: [cx, y0 - band / 2], rot: 0 },
    down: { at: [cx, y1 + band / 2], rot: 0 },
    left: { at: [x0 - band / 2, cy], rot: -90 },
    right: { at: [x1 + band / 2, cy], rot: 90 },
  }
  const others: OtherSlice[] = (['up', 'down', 'left', 'right'] as EdgeKey[]).map(edge => ({
    edge, points: poly(otherPts[edge]), lx: otherLabel[edge].at[0], ly: otherLabel[edge].at[1], rot: otherLabel[edge].rot,
  }))

  return { halves, others }
}
