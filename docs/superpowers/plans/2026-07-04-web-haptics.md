# Web haptics

Tactile feedback on key interactions in the PWA: button taps, transaction
categorization, and pull-to-refresh. Device-local, off-by-a-toggle, and built
to survive iOS's constraints without a new dependency.

## Motivation

The app is used almost exclusively as an installed PWA on iPhone. Physical
feedback makes swipe-categorizing a stack of transactions feel like a native
gesture instead of a web page, and confirms taps without a visual change.

## Mechanism (why not the npm package)

`web-haptics` (v0.0.6) is a thin wrapper over two primitives:

1. `navigator.vibrate(pattern)` — works on Android/Chrome, **absent on iOS
   Safari**.
2. iOS fallback: a hidden `<label><input type="checkbox" switch></label>` that,
   when `.click()`-ed, produces the system selection tick (iOS 17.4+).

We implement these two primitives directly in a pure `lib/haptics.ts` helper —
matching the codebase convention (`lib/fontScale.ts`) of framework-free,
unit-tested device-local helpers — rather than taking a 0.0.x dependency.

### The synchronous-gesture constraint

The iOS switch trick only fires when `.click()` runs **inside an active user
gesture** (a real `click`/`touchend` handler) and **before any `await`**. Every
call site must call `haptics.fire()` synchronously at the top of its handler,
before network calls. This is a hard requirement, not a nicety, and is called
out at each touchpoint below.

## Module: `frontend/src/lib/haptics.ts`

Pure, framework-free, with co-located `haptics.test.ts`.

```ts
type Haptic = "selection" | "light" | "success" | "warning";
```

Per-kind vibration patterns (ms), used when `navigator.vibrate` exists:

| kind        | pattern        | used for                        |
| ----------- | -------------- | ------------------------------- |
| `selection` | `10`           | button / nav / control taps     |
| `light`     | `15`           | reserved (threshold ticks etc.) |
| `success`   | `[12, 40, 20]` | swipe commit, refresh trigger   |
| `warning`   | `[20, 60, 20]` | reserved (destructive confirms) |

API:

- `fire(kind: Haptic): void` — no-op when disabled or unsupported. If
  `navigator.vibrate` exists, call it with the kind's pattern. Otherwise lazily
  create (once) a hidden switch element on `<body>` and `.click()` it.
- `isHapticsEnabled(): boolean`
- `setHapticsEnabled(on: boolean): void` — updates the in-module flag and
  persists to `localStorage["ledger-haptics"]`.
- `loadHapticsEnabled(): boolean` — hydrate the flag from storage; called once
  at boot. Default **on** (missing key ⇒ enabled).

State model mirrors `fontScale.ts`: a module-level `enabled` var, hydrated at
boot, mutated by the setter. All storage access wrapped in try/catch (private
mode / SSR safe). `fire()` guards on `typeof navigator` / `typeof document` so
it never throws under jsdom.

### Tests (`haptics.test.ts`)

- disabled ⇒ `navigator.vibrate` never called
- each kind maps to its documented pattern (mock `navigator.vibrate`)
- `setHapticsEnabled(false)` then `fire()` ⇒ no-op; round-trips through
  localStorage
- no `navigator.vibrate` and no DOM ⇒ `fire()` does not throw

## Touchpoints

Fire synchronously at the top of each handler (before any `await`):

| Event                         | File / handler                                              | kind        |
| ----------------------------- | ---------------------------------------------------------- | ----------- |
| Any enabled button tap        | `ui/Button.tsx` — wrap `onClick`                           | `selection` |
| FAB tap                       | `ui/Fab.tsx` — wrap `onClick`                             | `selection` |
| Bottom-nav tab switch         | `ui/BottomNav.tsx` — in `onNavigate` click               | `selection` |
| Segmented control select      | `ui/SegmentedControl.tsx` — in `onChange` click          | `selection` |
| Pill select                   | `ui/Pill.tsx`                                             | `selection` |
| Swipe commit (categorize)     | `swipe/SwipeDeck.tsx` `handleDirectionCommit`            | `success`   |
| Category picked in panel      | `swipe/SwipeDeck.tsx` `handleCategorySelect` (before await) | `selection` |
| Pull-to-refresh release fires | `hooks/usePullToRefresh.ts` `onEnd`, in `shouldTrigger` branch | `success` |

Design notes:

- **Button stays dumb.** Fire inside the wrapped `onClick`; a `disabled` button
  never fires its handler, so it stays silent with no extra guard.
- **No double-fire.** A `Button` used as the FAB/nav internals is not nested;
  each control fires exactly once per interaction.
- **Not everywhere.** List rows, dialog dismiss, and generic surfaces stay
  silent — scope is "key controls," not "every element."

## Settings toggle

- A **Haptics** on/off row on the Settings hub (`screens/settings/SettingsHub.tsx`)
  using the existing `ui/Switch.tsx`. Single boolean ⇒ inline row, not a
  sub-page (unlike text size).
- Reads `isHapticsEnabled()`, writes `setHapticsEnabled()`.
- Optionally `fire("selection")` when toggled **on**, as immediate confirmation.

## Boot wiring

`main.tsx` already runs `applyFontScale(loadFontScale())`. Add
`loadHapticsEnabled()` next to it so the module flag is hydrated from
localStorage before first paint.

## Out of scope

- No dependency on the `web-haptics` npm package.
- No server-side / synced setting — device-local only, like text size.
- No haptics on list rows, dialogs, or non-key surfaces.
- No custom intensity API beyond the four named kinds.

## Verification

- `bunx vitest run src/lib/haptics.test.ts` green.
- `bun run test` full suite green (touchpoint components still render/behave).
- Manual: on an iPhone PWA build, confirm a tap/swipe/refresh tick, and that the
  Settings toggle silences them.
- Rebuild embedded `internal/web/dist` before finishing the branch.
