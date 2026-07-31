# UI harness

A way to actually *use* the app — not render a component in jsdom, but drive
the real PWA in a real browser against the real Go API, then screenshot and
audit every screen.

Vitest covers component logic and Storybook covers components in isolation.
Neither catches the defects this harness exists for: an element pushed past a
390px viewport, a save button sitting under the bottom nav, a number input that
forces a `0` back in when you clear it. Those only appear in a laid-out,
interactive browser.

## Quick start

```bash
cd frontend
harness/stack.sh up          # scratch DB + seed data + Go API + vite (HMR)
node harness/shoot.mjs       # screenshot + audit every screen
```

Screens land in `harness/shots/` with a machine-readable
`harness/shots/report.phone.json`.

Nothing here touches production: the stack runs on ports **8099** (API) and
**5199** (UI) against a scratch database in `/tmp/ledger-ui-harness`. The real
`/var/lib/ledger/ledger.db` and port 8080 are never opened.

## The stack

| command | what it does |
| --- | --- |
| `harness/stack.sh up` | builds the binary if missing, seeds an empty DB, starts API + vite |
| `harness/stack.sh reset` | wipes and re-seeds the DB — use between review rounds |
| `harness/stack.sh rebuild` | rebuilds the Go binary (after backend changes) |
| `harness/stack.sh prod` | production `bun run build` + binary serving the embedded bundle |
| `harness/stack.sh status` / `down` / `logs` | lifecycle |

`vite.config.ts` proxies `/api` to `$LEDGER_API`, so the dev server has a live
backend and **frontend edits hot-reload** — a fix is visible in the browser
without any rebuild. Use `stack.sh prod` for the final check, since only that
path exercises minification, the service worker, and the embedded `dist`.

## Fixture data

`seed.mjs` writes through the HTTP API, so it stays honest about payload
shapes. It is deterministic (seeded PRNG) — the same seed produces the same
screenshots, so a visual diff only ever shows a real UI change.

It deliberately includes the cases that break layouts:

- a merchant name longer than any mobile viewport
- a seven-figure amount (`AED 9,999,999.99`) — the widest string the formatter emits
- a foreign-currency row, plus one in a currency with **no configured rate**
- an over-spent, under-assigned envelope (negative available)
- a project with no budget set, and a completed project
- eight rows in the review queue, plus ignored / transfer / split / noted rows

## Capturing screens

```bash
node harness/shoot.mjs --list                     # every screen id
node harness/shoot.mjs --screens plan,settings-budget
node harness/shoot.mjs --viewport small           # 320x568 stress width
node harness/shoot.mjs --scheme dark
node harness/shoot.mjs --json                     # report to stdout
```

The app scrolls an inner container, so a `fullPage` screenshot would only ever
show the first viewport. `shoot.mjs` detects the real scroller and captures
segments: `home.phone.0.png`, `home.phone.1.png`, …

Navigation is defined in `nav.mjs` as the literal taps a user performs — tabs,
the TopBar gear, drill-in rows. There is no URL routing to shortcut through, so
if a screen becomes unreachable in the UI, the harness fails to reach it too.
That failure is a finding, not a harness bug.

## The automated audit

`audit.mjs` runs inside the page and measures laid-out geometry, catching what
a screenshot hides:

- `page-h-overflow` / `element-past-viewport` — content crossing the viewport edge
- `control-obscured` — a control whose centre point hits a *different* element,
  i.e. it cannot be tapped
- `control-under-bottom-nav` — actions trapped beneath the fixed nav
- `content-clipped-unscrollable` — `overflow-hidden` over content taller than its box
- `tap-target-too-small` — below the documented 44px minimum
- `input-font-too-small` — under 16px, which makes iOS zoom on focus
- `text-clipped-no-ellipsis`, `control-without-accessible-name`, `img-without-alt`
- `bad-value-rendered` — a literal `NaN` / `undefined` / `[object Object]` on screen

Findings are geometric facts, not opinions. Judgement calls — hierarchy,
rhythm, copy, whether a screen looks finished — are for a human or a reviewing
agent looking at the screenshots.

Precision is the point. A checker that cries wolf gets ignored, so the audit
knows about four things it would otherwise report forever:

- `.sr-only` text, which is *supposed* to be a clipped 1px box
- `line-clamp` and the rolling-digit animation, which clip on purpose
- the overlay stack — screens cover each other, so only the top layer is
  audited, and the covered one produces a single "not inert" finding rather
  than one per buried control
- `data-dense-target`, which `IconButton size="sm"` sets to claim the 36px
  dense-row allowance `components/README.md` grants it

If you add a deliberate exception to a convention, teach the audit about it in
the same commit. Otherwise the next person learns to skip the output.

### Inline editors the crawl cannot reach — the category colour picker

`probe.mjs`'s opener crawl only follows controls that open a **Dialog**. An
inline editor — `CategoryManager`'s row edit state, which swaps a row for a
name field, three bucket dots and a 24-swatch colour grid — never registers as
one, so the crawl clicks it, sees no dialog, and moves on. Worse, the input
battery would be destructive there: the rename field commits on blur, so typing
`7` into it renames a fixture category and then finds no field left to type the
original back into.

So the picker gets its own pass at the end of a run, pinned to **320px**
whatever `--viewport` says, because 320 is the width the grid is sized against:
24 swatches at a 44px target is 1056px before gaps, and it either wraps to six
per row or it pushes the editor's other controls off-screen. It reports the
measured geometry (`24 swatches, rows 6+6+6+6, grid 262x168px at 29..291`), runs
the full `audit.mjs` over the open editor, and drops
`harness/shots/category-picker.small.png` for the judgement calls geometry
cannot make. It found the bucket dots sitting at 36px on its very first run —
the fourth sub-44px target in this codebase, invisible until something finally
opened a row's edit state.

Teeth, verified by breaking each subject and watching it fail:

| break | finding |
| --- | --- |
| swatch `w-11 h-11` → `w-9 h-9` | 24 × `picker-swatch-too-small` |
| grid `flex-wrap` → `flex-nowrap` | 18 × `picker-past-viewport` |
| drop the `data-color-picker` marker | `picker-missing` |

That last one matters most: without it the check would sample nothing and pass,
which is exactly how three earlier checks here stayed green over broken
subjects.

## Sheets and the hero number — `sheets.mjs`, `hero.mjs`

Two defects the screen recordings caught that every other tool called clean.

```bash
node harness/sheets.mjs      # sheet action rail vs. safe-area inset, background scroll lock
node harness/hero.mjs        # hero card consistency across a stale-cache repaint
```

`sheets.mjs` exists because **`env(safe-area-inset-bottom)` is 0 everywhere we
test.** A sticky `DialogFooter` was resolving `bottom: 0` against the panel's
*content* box, so the panel's own bottom padding rode the rail up over the last
row of content — by `inset - 16px`, which is exactly 0 in Chromium, WebKit
headless and every desktop browser, and 18px of a 44px button on an iPhone. It
simulates the inset by overriding `--sheet-inset-bottom` (the one value the
panel and the rail share) and asserts the rail stays flush and occludes nothing
at 0/16/34/48px. It also asserts the page is frozen behind an open sheet: a
`position: fixed` overlay's touch-scroll chains to the *root* scroller, not to
its DOM ancestor, so `<main>`'s `overscroll-contain` never sees the gesture.

`hero.mjs` replays a PWA relaunch: it stages a stale persisted react-query cache
in localStorage, ages it past `staleTime`, delays `/api/summary`, then samples
the hero card **on every animation frame** and asserts `budget − spent == left`
at each one. Sampling `style.transform` would be useless — React writes the
target there instantly, so a wheel looks settled while it is visibly rolling
somewhere else. Only the computed matrix says what is on screen. Before the fix
this reported 13 distinct card states including `24,526.25 of 25,000.00 · 3,581.55
left`; after it, 2.

Both take `BASE=http://127.0.0.1:8099` to run against `stack.sh prod`.

## What Chromium cannot tell you — `ios.mjs`

`shoot.mjs` and `probe.mjs` run headless Chromium with an emulated viewport.
Three things are simply absent there, and every one of them is load-bearing on
a real iPhone in standalone PWA mode:

1. **`env(safe-area-inset-*)` is 0.** Notch and home-indicator padding is
   present in the CSS but its effect is never exercised.
2. **There is no software keyboard**, so nothing is ever occluded by one.
3. **`dvh` tracks browser UI, not the keyboard.** On iOS the layout viewport
   does *not* shrink when the keyboard opens, so a `100dvh` bottom-anchored
   sheet stays pinned to the bottom of the display — underneath the keyboard.

That third one shipped a genuinely unusable Plan sheet: tapping the amount
field raised a keyboard over both the field and the Save button, with no
overflow to scroll them back into reach. The Chromium audit reported the screen
clean, because in Chromium the keyboard does not exist.

```bash
node harness/ios.mjs                 # WebKit, iPhone 14 Pro, keyboard geometry
node harness/ios.mjs --screens plan
```

It runs **WebKit** (the engine Safari uses), opens each sheet, focuses its first
input, and asserts that the focused field and the primary action are inside the
region a 336px keyboard leaves visible.

Two traps worth knowing when you extend this:

- **Do not set `reducedMotion: "reduce"` when testing animation.** The
  screenshot tools set it for stable captures, and it makes `Dialog` skip its
  slide entirely — which hides any bug in the slide itself.
- **Check which tree vite is serving** (`ls -l /proc/<vite-pid>/cwd`).
  `stack.sh` resolves the repo from its own location, so running it from the
  main checkout serves the main checkout — it is easy to "verify a fix" against
  a tree that does not contain it.

## Drag gestures — `gestures.mjs`

```bash
node harness/gestures.mjs                  # Chromium (default)
node harness/gestures.mjs --engine webkit  # real-pointer cases on the ship engine
```

Sheets and drill-in pages dismiss on a drag, and the *rules* — 110px or
550px/s down, a third of the width or 550px/s right, never the other way — are
pure functions in `lib/sheetDrag.ts` and `lib/edgeBack.ts` with unit tests. What
those tests cannot see is whether the rules are still **connected** to anything:
`drag`, `dragControls`, `dragElastic`, `onDragStart` and both `onDragEnd`
handlers could be deleted from `Dialog`/`SettingsPage` and every vitest file
would still pass. jsdom cannot drive a Framer drag — no layout to measure, no
frame clock behind the pointer stream — so this drives one in a real engine.

It also pins a bug only a real pointer produces: a drag that *starts* on the
sheet handle and *ends* off the panel makes the browser synthesise a `click` on
the nearest common ancestor of press and release — the overlay root, which
closes the sheet. So an upward pull dismissed, which is exactly what
`dragElastic: { top: 0 }` exists to prevent. `Dialog` disarms one root click per
drag, and the upward-drag plus both scrim-tap checks here are that guard's only
automated coverage.

Two input drivers, because neither can do both jobs:

- **Real input** (`page.mouse`) for everything about hit-testing, clicks and
  click synthesis — a script-dispatched event would never synthesise the click
  the regression above depends on.
- **In-page, frame-paced pointer events** for the flick. Playwright's bottleneck
  is the per-call protocol round-trip, so a `mouse.move({ steps })` burst reaches
  Framer at 200–900px/s depending on machine load — it cleared the 550px/s bar in
  about half of runs, and a check that flaky is worse than none. Dispatching one
  `pointermove` per animation frame puts the frame clock in charge instead.
  Framer does not check `isTrusted`, so PanSession, velocity, `onDragEnd` and the
  predicate all run exactly as they do for a finger.

That is also why it defaults to **Chromium**, unlike `ios.mjs`: headless WebKit
runs a ~50ms frame clock, and 60px over three 50ms frames is 400px/s — a slow
drag, whatever you dispatch. Under `--engine webkit` the flick reports `skip`
with the velocity it managed, rather than a green line that proves nothing.

Each check was verified to have teeth by breaking the thing it guards: dropping
the click disarm fails the upward-drag check, passing `0` for velocity fails the
flick check, and gutting `SettingsPage`'s `onDragEnd` fails the edge-swipe check.

`Dialog`'s drag region carries `data-sheet-handle` for the same reason
`DialogFooter` carries `data-dialog-footer`: it is otherwise a div identified
only by Tailwind classes, and the harness should not grab it by styling.

## Driving it yourself

`nav.mjs` exports the pieces for ad-hoc interaction scripts:

```js
import { chromium } from "playwright";
import { VIEWPORTS, screenById, settle } from "./nav.mjs";
import { audit } from "./audit.mjs";

const browser = await chromium.launch();
const page = await browser.newPage({ ...VIEWPORTS.phone });
await page.goto("http://127.0.0.1:5199");
await settle(page, 800);
await screenById("settings-budget").goto(page);

// e.g. reproduce the "clearing a number input forces a 0" class of bug
const field = page.locator('input[inputmode="numeric"]').first();
await field.fill("");
console.log("after clearing:", await field.inputValue()); // should be "", not "0"
```
