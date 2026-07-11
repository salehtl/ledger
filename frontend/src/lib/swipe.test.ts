import { describe, it, expect, beforeEach } from 'vitest'
import {
  resolveEdge,
  resolveZone,
  previewZone,
  buildDefaultConfig,
  loadSwipeConfig,
  saveSwipeConfig,
  SWIPE_THRESHOLD,
  SLIVER_HALF_ANGLE,
  type SwipeConfig,
} from './swipe'

type Cat = { ID: number; Kind: string; Bucket: string; IsActive: boolean }

const CATS: Cat[] = [
  { ID: 1, Kind: 'spending', Bucket: 'need', IsActive: true },   // Groceries
  { ID: 2, Kind: 'spending', Bucket: 'need', IsActive: true },   // Transport
  { ID: 3, Kind: 'spending', Bucket: 'want', IsActive: true },   // Dining
  { ID: 4, Kind: 'spending', Bucket: 'want', IsActive: true },   // Shopping
  { ID: 5, Kind: 'spending', Bucket: 'saving', IsActive: true }, // Savings
  { ID: 6, Kind: 'spending', Bucket: 'saving', IsActive: true }, // Invest
  { ID: 7, Kind: 'excluded', Bucket: '', IsActive: true },       // Transfers
  { ID: 8, Kind: 'income', Bucket: '', IsActive: true },         // Salary
  { ID: 9, Kind: 'spending', Bucket: 'need', IsActive: false },  // inactive, ignored
]

// A drag vector of the given angle (degrees, +y down) at fixed magnitude.
function vec(angleDeg: number, mag = 120): [number, number] {
  const r = (angleDeg * Math.PI) / 180
  return [Math.cos(r) * mag, Math.sin(r) * mag]
}

describe('resolveEdge', () => {
  it('maps cardinal-ish angles to edges', () => {
    expect(resolveEdge(...vec(0))).toBe('right')
    expect(resolveEdge(...vec(90))).toBe('down')
    expect(resolveEdge(...vec(180))).toBe('left')
    expect(resolveEdge(...vec(-90))).toBe('up')
  })
})

describe('resolveZone', () => {
  const cfg = buildDefaultConfig(CATS)

  it('returns null below threshold', () => {
    expect(resolveZone(10, 10, cfg)).toBeNull()
  })

  it('right edge, angled up = slot A (top Need cat)', () => {
    const z = resolveZone(...vec(-30), cfg)
    expect(z).toEqual({ kind: 'category', edge: 'right', slot: 'A', categoryId: 1 })
  })

  it('right edge, angled down = slot B (2nd Need cat)', () => {
    const z = resolveZone(...vec(30), cfg)
    expect(z).toEqual({ kind: 'category', edge: 'right', slot: 'B', categoryId: 2 })
  })

  it('straight into an edge (within sliver) = other', () => {
    const z = resolveZone(...vec(0), cfg)
    expect(z).toEqual({ kind: 'other', edge: 'right', group: 'need' })
  })

  it('sliver boundary is inclusive of dev <= SLIVER_HALF_ANGLE', () => {
    expect(resolveZone(...vec(SLIVER_HALF_ANGLE - 1), cfg)?.kind).toBe('other')
    expect(resolveZone(...vec(SLIVER_HALF_ANGLE + 1), cfg)?.kind).toBe('category')
  })

  it('down edge, angled left = slot A; right = slot B', () => {
    expect(resolveZone(...vec(120), cfg)).toMatchObject({ edge: 'down', slot: 'A', categoryId: 5 })
    expect(resolveZone(...vec(60), cfg)).toMatchObject({ edge: 'down', slot: 'B', categoryId: 6 })
  })

  it('up edge maps to income/excluded slots', () => {
    expect(resolveZone(...vec(-120), cfg)).toMatchObject({ edge: 'up', slot: 'A' })
    expect(resolveZone(...vec(-60), cfg)).toMatchObject({ edge: 'up', slot: 'B' })
  })

  it('falls back to other when the slot has no category', () => {
    const sparse = buildDefaultConfig([{ ID: 1, Kind: 'spending', Bucket: 'need', IsActive: true }])
    // Need slot B is empty → an angled-down right swipe becomes other
    expect(resolveZone(...vec(30), sparse)).toEqual({ kind: 'other', edge: 'right', group: 'need' })
  })
})

describe('previewZone', () => {
  const cfg = buildDefaultConfig(CATS)
  it('uses a lower (20px) threshold', () => {
    expect(previewZone(...vec(-30, 30), cfg)?.kind).toBe('category')
    expect(previewZone(...vec(-30, 10), cfg)).toBeNull()
  })
})

describe('buildDefaultConfig', () => {
  it('seeds slots from each group in ID order', () => {
    const cfg = buildDefaultConfig(CATS)
    expect(cfg.edges.right).toEqual({ group: 'need', slotA: 1, slotB: 2 })
    expect(cfg.edges.left).toEqual({ group: 'want', slotA: 3, slotB: 4 })
    expect(cfg.edges.down).toEqual({ group: 'saving', slotA: 5, slotB: 6 })
    expect(cfg.edges.up).toEqual({ group: 'other', slotA: 7, slotB: 8 })
  })

  it('ignores inactive categories', () => {
    const cfg = buildDefaultConfig(CATS)
    expect(cfg.edges.right.slotB).toBe(2) // not 9 (inactive)
  })

  it('leaves slot B empty when a group has one category, 0/0 when none', () => {
    const cfg = buildDefaultConfig([{ ID: 5, Kind: 'spending', Bucket: 'saving', IsActive: true }])
    expect(cfg.edges.down).toEqual({ group: 'saving', slotA: 5, slotB: 0 })
    expect(cfg.edges.right).toEqual({ group: 'need', slotA: 0, slotB: 0 })
  })
})

describe('loadSwipeConfig migration', () => {
  beforeEach(() => localStorage.clear())

  it('discards a v1 blob and rebuilds defaults', () => {
    localStorage.setItem('ledger-swipe-config', JSON.stringify({ left: { bucket: 'want' } }))
    const cfg = loadSwipeConfig(CATS)
    expect(cfg.version).toBe(2)
    expect(cfg.edges.right.slotA).toBe(1)
  })

  it('round-trips a saved v2 config', () => {
    const cfg = buildDefaultConfig(CATS)
    cfg.edges.right.slotA = 2
    saveSwipeConfig(cfg)
    expect(loadSwipeConfig(CATS).edges.right.slotA).toBe(2)
  })

  it('falls back to defaults on corrupt data', () => {
    localStorage.setItem('ledger-swipe-config', '{ not json')
    expect(loadSwipeConfig(CATS).version).toBe(2)
  })
})

describe('constants', () => {
  it('keeps the 80px commit threshold', () => {
    expect(SWIPE_THRESHOLD).toBe(80)
  })
})
