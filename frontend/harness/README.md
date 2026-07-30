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
