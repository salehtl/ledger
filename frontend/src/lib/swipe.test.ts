// frontend/src/lib/swipe.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  detectDirection,
  overlayProgress,
  previewDirection,
  loadSwipeConfig,
  saveSwipeConfig,
  DEFAULT_SWIPE_CONFIG,
  SWIPE_THRESHOLD,
} from './swipe'

describe('detectDirection', () => {
  it('returns null when both axes are below threshold', () => {
    expect(detectDirection(30, 20, SWIPE_THRESHOLD)).toBeNull()
  })
  it('detects left when dx is negative dominant', () => {
    expect(detectDirection(-100, 10, SWIPE_THRESHOLD)).toBe('left')
  })
  it('detects right when dx is positive dominant', () => {
    expect(detectDirection(100, 10, SWIPE_THRESHOLD)).toBe('right')
  })
  it('detects up when dy is negative dominant', () => {
    expect(detectDirection(10, -100, SWIPE_THRESHOLD)).toBe('up')
  })
  it('detects down when dy is positive dominant', () => {
    expect(detectDirection(10, 100, SWIPE_THRESHOLD)).toBe('down')
  })
  it('uses the larger axis when both exceed threshold', () => {
    expect(detectDirection(-200, 90, SWIPE_THRESHOLD)).toBe('left')
  })
  it('returns null when exactly at threshold on one axis only', () => {
    expect(detectDirection(-79, 0, SWIPE_THRESHOLD)).toBeNull()
  })
})

describe('overlayProgress', () => {
  it('returns 0 when no drag', () => {
    expect(overlayProgress(0, 0)).toBe(0)
  })
  it('returns 1 when drag exceeds threshold', () => {
    expect(overlayProgress(-200, 0)).toBe(1)
  })
  it('returns fractional value for partial drag', () => {
    const p = overlayProgress(-40, 0)
    expect(p).toBeGreaterThan(0)
    expect(p).toBeLessThan(1)
  })
})

describe('previewDirection', () => {
  it('returns direction at lower threshold (20px)', () => {
    expect(previewDirection(-30, 0)).toBe('left')
    expect(previewDirection(25, 0)).toBe('right')
  })
  it('returns null below 20px', () => {
    expect(previewDirection(-10, 5)).toBeNull()
  })
})

describe('loadSwipeConfig / saveSwipeConfig', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => localStorage.clear())

  it('returns DEFAULT_SWIPE_CONFIG when localStorage is empty', () => {
    const cfg = loadSwipeConfig()
    expect(cfg.left.bucket).toBe('want')
    expect(cfg.right.bucket).toBe('need')
    expect(cfg.down.bucket).toBe('saving')
    expect(cfg.up.statusOverride).toBe('transfer')
  })

  it('round-trips a custom config', () => {
    const custom = { ...DEFAULT_SWIPE_CONFIG, left: { ...DEFAULT_SWIPE_CONFIG.right } }
    saveSwipeConfig(custom)
    expect(loadSwipeConfig().left.bucket).toBe('need')
  })
})
