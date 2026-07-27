import { mix, seedOfColor, rgb, PALETTE_LIGHT, PALETTE_DARK } from "./palette";

describe("mix", () => {
  it("returns the first color at t=0 and the second at t=1", () => {
    expect(mix([0, 0, 0], [255, 255, 255], 0)).toEqual([0, 0, 0]);
    expect(mix([0, 0, 0], [255, 255, 255], 1)).toEqual([255, 255, 255]);
  });

  it("interpolates and rounds at the midpoint", () => {
    expect(mix([0, 0, 0], [255, 255, 255], 0.5)).toEqual([128, 128, 128]);
  });
});

const KEYS = ["azure", "amber", "lilac", "sage", "rose", "slate"] as const;

// OKLab chroma, the "is this actually a hue or just grey" measure. Mirrors what
// the palette validator computes; kept local so the test needs no dependency.
const srgb = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
function chroma([r8, g8, b8]: [number, number, number]): number {
  const [r, g, b] = [r8, g8, b8].map((v) => srgb(v / 255));
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return Math.hypot(a, bb);
}

describe("palette seeds", () => {
  it("defines every key in both themes", () => {
    for (const k of KEYS) {
      expect(PALETTE_LIGHT).toHaveProperty(k);
      expect(PALETTE_DARK).toHaveProperty(k);
    }
  });

  it("keeps every categorical hue above the chroma floor, so none reads as grey", () => {
    // Below ~0.10 a hue stops doing identity work. This is the check that
    // failed when the buckets were all set to ink and every chart came out the
    // same colour — the bug this palette exists to fix.
    for (const table of [PALETTE_LIGHT, PALETTE_DARK]) {
      for (const k of KEYS) {
        if (k === "slate") continue; // the neutral is grey on purpose
        expect(chroma(table[k].fill)).toBeGreaterThanOrEqual(0.1);
      }
    }
  });

  it("keeps the hues clearly less saturated than the vermilion accent", () => {
    // The whole point of a muted chart palette: #c93d26 (C ≈ 0.181) stays the
    // loudest thing on screen. Chart hues sit around two thirds of that.
    const ACCENT_CHROMA = 0.181;
    for (const table of [PALETTE_LIGHT, PALETTE_DARK]) {
      for (const k of KEYS) {
        expect(chroma(table[k].fill)).toBeLessThan(ACCENT_CHROMA * 0.85);
      }
    }
  });

  it("keeps the neutral neutral", () => {
    expect(chroma(PALETTE_LIGHT.slate.fill)).toBeLessThan(0.03);
    expect(chroma(PALETTE_DARK.slate.fill)).toBeLessThan(0.03);
  });

  it("darkens the line tint on light and lightens it on dark", () => {
    // On paper a lighter line would wash out; on the dark surface it must lift
    // off the background.
    const lum = ([r, g, b]: [number, number, number]) => r + g + b;
    expect(lum(PALETTE_LIGHT.azure.line)).toBeLessThan(lum(PALETTE_LIGHT.azure.fill));
    expect(lum(PALETTE_DARK.azure.line)).toBeGreaterThan(lum(PALETTE_DARK.azure.fill));
  });

  it("resolves seeds through the active theme", () => {
    // jsdom reports no dark preference, so the light table is active.
    expect(seedOfColor("azure").fill).toEqual(PALETTE_LIGHT.azure.fill);
  });
});

describe("rgb", () => {
  it("formats an rgba string with scale and alpha", () => {
    expect(rgb([10, 20, 30])).toBe("rgba(10,20,30,1)");
    expect(rgb([10, 20, 30], 1, 0.4)).toBe("rgba(10,20,30,0.4)");
  });
});
