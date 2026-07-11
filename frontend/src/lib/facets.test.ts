import { describe, it, expect } from 'vitest'
import { centeredCard, computeFacets } from './facets'

describe('centeredCard', () => {
  it('centers the card in the arena', () => {
    expect(centeredCard(400, 600, 160, 240)).toEqual({ x0: 120, y0: 180, x1: 280, y1: 420 })
  })
})

describe('computeFacets', () => {
  const card = centeredCard(400, 600, 160, 240) // margins: x 120, y 180
  const f = computeFacets(400, 600, card, 40)

  it('produces 8 category halves and 4 Other slices', () => {
    expect(f.halves).toHaveLength(8)
    expect(f.others).toHaveLength(4)
    const keys = f.halves.map(h => `${h.edge}-${h.slot}`).sort()
    expect(keys).toEqual(['down-A', 'down-B', 'left-A', 'left-B', 'right-A', 'right-B', 'up-A', 'up-B'])
  })
  it('each half reaches a screen corner (corner-to-corner facets)', () => {
    // up-A spans from screen corner (0,0) to the card
    const upA = f.halves.find(h => h.edge === 'up' && h.slot === 'A')!
    expect(upA.points.startsWith('0.0,0.0')).toBe(true)
  })
  it('the up Other slice is a shallow band above the card (depth = band)', () => {
    const up = f.others.find(o => o.edge === 'up')!
    const ys = up.points.split(' ').map(p => Number(p.split(',')[1]))
    // inner edge at card top (y=180), outer edge at y0-band (140)
    expect(Math.max(...ys)).toBeCloseTo(180, 0)
    expect(Math.min(...ys)).toBeCloseTo(140, 0)
  })
  it('legend anchors sit inside the arena', () => {
    for (const h of [...f.halves, ...f.others]) {
      expect(h.lx).toBeGreaterThanOrEqual(0); expect(h.lx).toBeLessThanOrEqual(400)
      expect(h.ly).toBeGreaterThanOrEqual(0); expect(h.ly).toBeLessThanOrEqual(600)
    }
  })
})
