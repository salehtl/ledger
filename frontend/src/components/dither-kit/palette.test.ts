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

describe("palette seeds", () => {
  it("carries the app's light tokens as fills", () => {
    expect(PALETTE_LIGHT.blue.fill).toEqual([22, 22, 26]);    // --color-need (ink)
    expect(PALETTE_LIGHT.purple.fill).toEqual([22, 22, 26]);  // --color-want (ink)
    expect(PALETTE_LIGHT.green.fill).toEqual([22, 22, 26]);   // --color-save (ink)
  });

  it("carries the app's dark tokens as fills", () => {
    expect(PALETTE_DARK.blue.fill).toEqual([236, 235, 232]);
    expect(PALETTE_DARK.green.fill).toEqual([236, 235, 232]);
  });

  it("defines all seven keys in both themes", () => {
    const keys = ["green", "blue", "purple", "pink", "orange", "red", "grey"];
    for (const k of keys) {
      expect(PALETTE_LIGHT).toHaveProperty(k);
      expect(PALETTE_DARK).toHaveProperty(k);
    }
  });

  it("darkens the line tint on light and lightens it on dark", () => {
    // On the warm off-white surface a lighter line would wash out; on the dark
    // surface it must lift off the background.
    const lum = ([r, g, b]: [number, number, number]) => r + g + b;
    expect(lum(PALETTE_LIGHT.blue.line)).toBeLessThan(lum(PALETTE_LIGHT.blue.fill));
    expect(lum(PALETTE_DARK.blue.line)).toBeGreaterThan(lum(PALETTE_DARK.blue.fill));
  });

  it("resolves seeds through the active theme", () => {
    // jsdom reports no dark preference, so the light table is active.
    expect(seedOfColor("blue").fill).toEqual(PALETTE_LIGHT.blue.fill);
  });
});

describe("rgb", () => {
  it("formats an rgba string with scale and alpha", () => {
    expect(rgb([10, 20, 30])).toBe("rgba(10,20,30,1)");
    expect(rgb([10, 20, 30], 1, 0.4)).toBe("rgba(10,20,30,0.4)");
  });
});
