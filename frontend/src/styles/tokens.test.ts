import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { PALETTE_LIGHT, PALETTE_DARK, type DitherColor } from "../components/dither-kit/palette";
import { PALETTE_NAMES } from "../lib/paletteColor";

// Vitest runs from the frontend root; resolve against cwd rather than
// import.meta.url, which the transform rewrites.
const css = readFileSync(resolve(process.cwd(), "src/styles/app.css"), "utf8");

// The dark overrides live in their own block; split so a light lookup can't
// accidentally match a dark declaration or vice versa.
const darkAt = css.indexOf("prefers-color-scheme: dark");
const LIGHT_CSS = css.slice(0, darkAt);
const DARK_CSS = css.slice(darkAt);

const declared = (block: string, token: string): string | null => {
  const m = block.match(new RegExp(`--color-${token}\\s*:\\s*([^;]+);`));
  return m ? m[1].trim() : null;
};
const hex = ([r, g, b]: [number, number, number]) =>
  `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;

describe("palette tokens", () => {
  // app.css and palette.ts necessarily hold the same values — the canvas paints
  // raw RGB and cannot read a custom property, everything else wants a var that
  // follows the cascade. Nothing but this test stops them drifting.
  it("declares every palette hue in both themes", () => {
    for (const name of PALETTE_NAMES) {
      expect(declared(LIGHT_CSS, name), `light --color-${name}`).not.toBeNull();
      expect(declared(DARK_CSS, name), `dark --color-${name}`).not.toBeNull();
    }
  });

  it("matches the canvas seeds exactly", () => {
    for (const name of PALETTE_NAMES) {
      expect(declared(LIGHT_CSS, name), `light --color-${name}`)
        .toBe(hex(PALETTE_LIGHT[name as DitherColor].fill));
      expect(declared(DARK_CSS, name), `dark --color-${name}`)
        .toBe(hex(PALETTE_DARK[name as DitherColor].fill));
    }
  });

  it("aliases the buckets onto palette hues rather than repeating a value", () => {
    // A bucket and a project painted "amber" must be the same amber. The only
    // way to guarantee that is for the bucket not to hold a value.
    expect(declared(LIGHT_CSS, "need")).toBe("var(--color-amber)");
    expect(declared(LIGHT_CSS, "want")).toBe("var(--color-lilac)");
    expect(declared(LIGHT_CSS, "save")).toBe("var(--color-sage)");
    expect(declared(LIGHT_CSS, "transfer")).toBe("var(--color-azure)");
  });

  it("does not re-declare the bucket aliases in the dark block", () => {
    // They inherit — only the palette values change per theme. Re-declaring
    // them is how they went stale last time: the dark block overrode the
    // alias with a literal and the buckets went flat.
    for (const b of ["need", "want", "save", "transfer"]) {
      expect(declared(DARK_CSS, b), `dark --color-${b} should not exist`).toBeNull();
    }
  });
});

describe("built output", () => {
  // The source test above passed while the *shipped* CSS was missing the light
  // value for `rose` and all six deep steps: they live only in runtime
  // `var()` strings, so Tailwind tree-shook them out of @theme and those marks
  // rendered as nothing on paper. Asserting on source could never catch that.
  const distDir = resolve(process.cwd(), "../internal/web/dist/assets");
  const builtCss = () => {
    const dir = readdirSync(distDir).filter((f) => f.endsWith(".css"));
    return dir.map((f) => readFileSync(resolve(distDir, f), "utf8")).join("\n");
  };

  // The Framer migration's bundle budget, and a trap that already sprang once.
  // `MotionProvider` loads `domMax` through a thunk, which *looks* like it
  // code-splits; it only actually splits because the thunk points at
  // `app/motionFeatures.ts` rather than at `motion/react` directly (that file
  // explains why). Point it back at the barrel and the entry chunk silently
  // gains ~110KB — no error, no failing test, nothing visible until someone
  // loads the app on mobile data. Assert the shape of the output instead.
  it("keeps the entry chunk inside the motion budget, with the feature bundle split out", () => {
    const js = readdirSync(distDir).filter((f) => f.endsWith(".js"));
    const entry = js.find((f) => f.startsWith("index-"));
    expect(entry, "no index-*.js in the built assets — is the dist stale?").toBeDefined();
    const bytes = readFileSync(resolve(distDir, entry!)).byteLength;
    expect(bytes, `entry chunk is ${bytes} bytes`).toBeLessThanOrEqual(760_000);
    expect(
      js.some((f) => f.startsWith("motionFeatures-")),
      "domMax is not in its own chunk — the LazyMotion thunk has been inlined back into the entry",
    ).toBe(true);
  });

  it("ships every palette token, in both themes", () => {
    const css = builtCss();
    for (const name of PALETTE_NAMES) {
      // Two declarations each: one per theme block.
      const hits = css.match(new RegExp(`--color-${name}\\s*:`, "g")) ?? [];
      expect(hits.length, `--color-${name} in built CSS`).toBeGreaterThanOrEqual(2);
    }
  });

  // A convention with no checker rots. The Framer migration decided against
  // adding an app-level "gate hover behind a real pointer" utility on the
  // grounds that Tailwind v4 already compiles `hover:` to
  // `@media (hover: hover) { &:hover { … } }`, so a tap on iOS (which reports
  // `hover: none`) can never leave a hover state stuck. That reasoning is only
  // as good as the build actually behaving that way — a Tailwind downgrade, a
  // config change, or a hand-written `:hover` in app.css would silently
  // reintroduce sticky hover on touch, and no unit test rendering a component
  // in jsdom would ever see it. Assert it against the shipped stylesheet.
  it("gates every hover style behind a real pointer", () => {
    const css = builtCss();
    const outside: string[] = [];
    // Walk the block structure, tracking whether the current nesting is inside
    // a hover media query. `@media …{` consumes its own brace so the stack
    // stays aligned with plain `{`/`}`.
    const stack: boolean[] = [];
    for (const m of css.matchAll(/@media[^{]*\{|\{|\}|:hover/g)) {
      if (m[0] === ":hover") {
        if (!stack.some(Boolean)) outside.push(css.slice(Math.max(0, m.index - 60), m.index + 6));
      } else if (m[0] === "}") stack.pop();
      else stack.push(/\(\s*hover\s*:\s*hover\s*\)/.test(m[0]));
    }
    expect(outside, "these :hover rules are not inside an @media (hover: hover)").toEqual([]);
  });

  it("has no hand-written :hover in app.css source", () => {
    // Tailwind's variant is generated at build time; anything literal in the
    // source bypasses the gating the test above relies on.
    const src = readFileSync(resolve(process.cwd(), "src/styles/app.css"), "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, ""); // comments discuss :hover on purpose
    expect(code).not.toMatch(/:hover/);
  });

  it("keeps the palette out of @theme so it cannot be tree-shaken", () => {
    // Structural, not incidental: inside @theme these survive only while
    // something references them at build time.
    const src = readFileSync(resolve(process.cwd(), "src/styles/app.css"), "utf8");
    const themeBlock = src.slice(src.indexOf("@theme"), src.indexOf("\n}", src.indexOf("@theme")));
    for (const name of PALETTE_NAMES) {
      expect(themeBlock.includes(`--color-${name}:`), `--color-${name} must not be in @theme`).toBe(false);
    }
  });
});

describe("bucket contrast", () => {
  const channel = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const lum = (h: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => channel(parseInt(h.substr(i, 2), 16) / 255));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrast = (a: string, b: string) => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };

  it("keeps the over-pace ink legible on paper, on the dark ground, and on the bar track", () => {
    // ProgressBar's middle stop. A bar fill is a non-text graphic → 3:1 floor,
    // and it must clear it against the track it is printed on, not just the
    // page. The under/exceeded stops alias --color-fg/--color-bad, which the
    // rest of the design already holds to that bar.
    const grounds: [string, string[]][] = [
      [declared(LIGHT_CSS, "pace-over")!, ["#f2f1ef", "#e3e2de"]],
      [declared(DARK_CSS, "pace-over")!, ["#141416", "#232326"]],
    ];
    for (const [ink, ons] of grounds) {
      for (const ground of ons) {
        expect(contrast(ink, ground), `${ink} on ${ground}`).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it("keeps the over-pace ink distinct from the spot ink it sits next to", () => {
    // Amber and vermilion are the bar's two warm states; if they read as the
    // same signal the ramp has only two stops, not three.
    expect(contrast(declared(LIGHT_CSS, "pace-over")!, "#b8331d")).toBeGreaterThanOrEqual(1.3);
    expect(contrast(declared(DARK_CSS, "pace-over")!, "#f0866f")).toBeGreaterThanOrEqual(1.3);
  });

  it("keeps every bucket hue legible on its own ground", () => {
    // The check that would have caught the swipe rails sitting at 1.02:1 in
    // dark: a bucket mark is a non-text graphic, so 3:1 is the floor.
    const grounds: [Record<DitherColor, { fill: [number, number, number] }>, string][] = [
      [PALETTE_LIGHT, "#f2f1ef"],
      [PALETTE_DARK, "#141416"],
    ];
    for (const [table, ground] of grounds) {
      for (const name of ["amber", "lilac", "sage", "azure"] as DitherColor[]) {
        expect(contrast(hex(table[name].fill), ground), `${name} on ${ground}`)
          .toBeGreaterThanOrEqual(3);
      }
    }
  });
});
