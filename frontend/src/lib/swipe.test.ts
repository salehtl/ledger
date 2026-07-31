// frontend/src/lib/swipe.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  actionColor,
  onActionColor,
  DEFAULT_SWIPE_CONFIG,
  detectDirection,
  overlayProgress,
  previewDirection,
  commitDirection,
  COMMIT_PX,
  COMMIT_VELOCITY,
  FLICK_MIN_DISTANCE,
  quantizePreview,
  PREVIEW_STEPS,
  loadSwipeConfig,
  saveSwipeConfig,
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

describe("bucket colours", () => {
  // configurable *and* writable: setup.ts re-defines window.matchMedia in a
  // global beforeEach, and a non-configurable stub here silently poisons every
  // test file that runs after this one — which is how this showed up as an
  // order-dependent flake in an unrelated suite.
  const asTheme = (dark: boolean) =>
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: (q: string) => ({
        matches: dark && q.includes("dark"),
        media: q,
        addEventListener() {},
        removeEventListener() {},
      }),
    });

  const forEachBucket = () =>
    (["left", "right", "up", "down"] as const).map((d) => actionColor(DEFAULT_SWIPE_CONFIG[d]));

  it("tells the buckets apart", () => {
    // These used to be one literal ink for need/want/saving, which made three
    // of the four rails identical — the only thing left telling you what a
    // direction did was its label.
    const colors = forEachBucket();
    expect(new Set(colors).size).toBe(colors.length);
  });

  it("re-resolves against the active theme", () => {
    // The bug this replaces: a hardcoded #16161a documented as "mirrors
    // --color-fg". True in light; in dark --color-fg flips to #ecebe8 and the
    // literal did not, leaving every inactive rail at 1.02:1 on the dark
    // ground. Any static value fails this test.
    asTheme(false);
    const light = forEachBucket();
    asTheme(true);
    const dark = forEachBucket();
    light.forEach((c, i) => expect(dark[i]).not.toBe(c));
  });

  it("picks a label ink that is legible on every bucket fill", () => {
    // The active rail and the commit badge hardcoded white, which sat at ~3:1
    // on the lighter seeds. onActionColor chooses per fill.
    const channel = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    const lum = (hex: string) => {
      const [r, g, b] = [1, 3, 5].map((i) => channel(parseInt(hex.substr(i, 2), 16) / 255));
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const contrast = (a: string, b: string) => {
      const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
      return (hi + 0.05) / (lo + 0.05);
    };
    for (const dark of [false, true]) {
      asTheme(dark);
      for (const fill of forEachBucket()) {
        expect(contrast(onActionColor(fill), fill)).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});

describe("commitDirection", () => {
  it("commits along the dominant axis once past the distance threshold", () => {
    expect(commitDirection(COMMIT_PX + 1, 10, 0, 0)).toBe("right");
    expect(commitDirection(-(COMMIT_PX + 1), 10, 0, 0)).toBe("left");
    expect(commitDirection(10, -(COMMIT_PX + 1), 0, 0)).toBe("up");
    expect(commitDirection(10, COMMIT_PX + 1, 0, 0)).toBe("down");
  });

  // Travel is expressed against FLICK_MIN_DISTANCE rather than as a literal
  // 20px, so these state the relationship ("a flick just past the
  // intentionality floor commits") instead of a number that silently stops
  // meaning anything if the floor moves.
  it("commits a short flick on velocity alone", () => {
    expect(commitDirection(FLICK_MIN_DISTANCE + 1, 0, COMMIT_VELOCITY + 1, 0)).toBe("right");
    expect(commitDirection(0, -(FLICK_MIN_DISTANCE + 1), 0, -(COMMIT_VELOCITY + 1))).toBe("up");
  });

  it("ignores a fast twitch that never travelled far enough to be intentional", () => {
    // Framer's PanSession starts a drag at ~3px and reports info.velocity over
    // the last ~100ms, so a jittery tap easily clears COMMIT_VELOCITY on a few
    // pixels of travel — and it cannot fall back to the tap path either,
    // because onDragStart has already armed SwipeCard's `dragged` guard. Left
    // ungated, a 5px twitch opened the sort panel on a card the user never
    // meant to touch.
    expect(commitDirection(5, 3, 600, 0)).toBeNull();
    expect(commitDirection(FLICK_MIN_DISTANCE - 1, 0, COMMIT_VELOCITY + 1, 0)).toBeNull();
    expect(commitDirection(FLICK_MIN_DISTANCE, 0, COMMIT_VELOCITY + 1, 0)).toBe("right");
  });

  it("measures the floor per axis, so travel on one axis cannot license the other", () => {
    // 30px down and 5px sideways, thrown sideways fast: the hand went down.
    expect(commitDirection(5, 30, 600, 0)).toBeNull();
    expect(commitDirection(30, 5, 0, 600)).toBeNull();
  });

  it("ignores velocity pointing the opposite way to the travel", () => {
    // A card flung back toward centre is fast, but it is heading home.
    expect(commitDirection(-30, 0, 700, 0)).toBeNull();
    expect(commitDirection(0, 30, 0, -700)).toBeNull();
  });

  it("returns null below both thresholds", () => {
    expect(commitDirection(10, 10, 0, 0)).toBeNull();
  });

  it("picks the axis with the larger travel when both clear the threshold", () => {
    expect(commitDirection(COMMIT_PX + 50, COMMIT_PX + 1, 0, 0)).toBe("right");
    expect(commitDirection(COMMIT_PX + 1, COMMIT_PX + 50, 0, 0)).toBe("down");
  });
});

describe("quantizePreview", () => {
  it("keeps the ends exact", () => {
    expect(quantizePreview(0)).toBe(0);
    expect(quantizePreview(1)).toBe(1);
  });

  it("snaps to the nearest step", () => {
    expect(quantizePreview(0.04)).toBeCloseTo(0);
    expect(quantizePreview(0.06)).toBeCloseTo(0.1);
    expect(quantizePreview(0.44)).toBeCloseTo(0.4);
  });

  it("never moves a value by more than half a step", () => {
    for (let i = 0; i <= 1000; i++) {
      const p = i / 1000;
      expect(Math.abs(quantizePreview(p) - p)).toBeLessThanOrEqual(0.5 / PREVIEW_STEPS + 1e-9);
    }
  });

  it("collapses a whole drag into at most PREVIEW_STEPS + 1 distinct values", () => {
    // This is the point of the function, and the only part a reader could get
    // wrong: SwipeCard reports preview strength to SwipeDeck, which writes it
    // into React state, so one value per pointer frame meant ~60 SwipeDeck
    // renders a second (four EdgeRails, the wash, the progress bar and the
    // card, none memoized). A 200-frame drag must not produce 200 renders.
    const perFrame = Array.from({ length: 200 }, (_, i) => quantizePreview(i / 199));
    expect(new Set(perFrame).size).toBeLessThanOrEqual(PREVIEW_STEPS + 1);
  });
});
