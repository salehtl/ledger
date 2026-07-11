import { describe, it, expect, beforeEach } from 'vitest'
import {
  resolveEdge, resolveZone, previewState, buildDefaultConfig, loadSwipeConfig,
  saveSwipeConfig, OTHER_MIN, CATEGORY_MIN,
} from './swipe'

type Cat = { ID: number; Kind: string; Bucket: string; IsActive: boolean }
const CATS: Cat[] = [
  { ID: 1, Kind: 'spending', Bucket: 'need', IsActive: true },
  { ID: 2, Kind: 'spending', Bucket: 'need', IsActive: true },
  { ID: 3, Kind: 'spending', Bucket: 'want', IsActive: true },
  { ID: 4, Kind: 'spending', Bucket: 'want', IsActive: true },
  { ID: 5, Kind: 'spending', Bucket: 'saving', IsActive: true },
  { ID: 6, Kind: 'spending', Bucket: 'saving', IsActive: true },
  { ID: 7, Kind: 'excluded', Bucket: '', IsActive: true },
  { ID: 8, Kind: 'income', Bucket: '', IsActive: true },
]
// unit vector at angle (deg, +y down) scaled to a distance
function at(angleDeg: number, dist: number): [number, number] {
  const r = (angleDeg * Math.PI) / 180
  return [Math.cos(r) * dist, Math.sin(r) * dist]
}
const cfg = buildDefaultConfig(CATS)

describe('resolveEdge', () => {
  it('maps angles to edges', () => {
    expect(resolveEdge(...at(0, 100))).toBe('right')
    expect(resolveEdge(...at(90, 100))).toBe('down')
    expect(resolveEdge(...at(180, 100))).toBe('left')
    expect(resolveEdge(...at(-90, 100))).toBe('up')
  })
})

describe('resolveZone (depth)', () => {
  it('cancels below OTHER_MIN', () => {
    expect(resolveZone(...at(0, OTHER_MIN - 5), cfg)).toBeNull()
  })
  it('a short push (below CATEGORY_MIN) is Other for the aimed bucket, any angle', () => {
    const mid = (OTHER_MIN + CATEGORY_MIN) / 2
    expect(resolveZone(...at(-20, mid), cfg)).toEqual({ kind: 'other', edge: 'right', group: 'need' })
    expect(resolveZone(...at(20, mid), cfg)).toEqual({ kind: 'other', edge: 'right', group: 'need' })
    expect(resolveZone(...at(90, mid), cfg)).toEqual({ kind: 'other', edge: 'down', group: 'saving' })
  })
  it('a long push commits the angle-selected slot', () => {
    const far = CATEGORY_MIN + 20
    expect(resolveZone(...at(-20, far), cfg)).toEqual({ kind: 'category', edge: 'right', slot: 'A', categoryId: 1 })
    expect(resolveZone(...at(20, far), cfg)).toEqual({ kind: 'category', edge: 'right', slot: 'B', categoryId: 2 })
    expect(resolveZone(...at(120, far), cfg)).toMatchObject({ edge: 'down', slot: 'A', categoryId: 5 })
  })
  it('a long push into an empty slot falls back to Other', () => {
    const sparse = buildDefaultConfig([{ ID: 1, Kind: 'spending', Bucket: 'need', IsActive: true }])
    expect(resolveZone(...at(20, CATEGORY_MIN + 20), sparse)).toEqual({ kind: 'other', edge: 'right', group: 'need' })
  })
})

describe('previewState', () => {
  it('reports the Other band with a 0..1 fill', () => {
    const s = previewState(...at(0, OTHER_MIN + 1), cfg)
    expect(s).toMatchObject({ edge: 'right', kind: 'other', group: 'need' })
    expect(s!.fill).toBeGreaterThanOrEqual(0)
    expect(s!.fill).toBeLessThan(0.2)
  })
  it('reports the category slot once past CATEGORY_MIN', () => {
    const s = previewState(...at(-20, CATEGORY_MIN + CAT_FULL_HALF()), cfg)
    expect(s).toMatchObject({ edge: 'right', kind: 'category', slot: 'A', categoryId: 1 })
    expect(s!.fill).toBeGreaterThan(0.3)
  })
  it('is null below OTHER_MIN', () => {
    expect(previewState(2, 2, cfg)).toBeNull()
  })
})
function CAT_FULL_HALF() { return 45 }

describe('config load/save (unchanged behavior)', () => {
  beforeEach(() => localStorage.clear())
  it('seeds slots from categories', () => {
    expect(cfg.edges.right).toEqual({ group: 'need', slotA: 1, slotB: 2 })
    expect(cfg.edges.up).toEqual({ group: 'other', slotA: 7, slotB: 8 })
  })
  it('round-trips a saved v2 config', () => {
    const c = buildDefaultConfig(CATS); c.edges.right.slotA = 2
    saveSwipeConfig(c)
    expect(loadSwipeConfig(CATS).edges.right.slotA).toBe(2)
  })
  it('discards a v1 blob', () => {
    localStorage.setItem('ledger-swipe-config', JSON.stringify({ left: { bucket: 'want' } }))
    expect(loadSwipeConfig(CATS).version).toBe(2)
  })
})
