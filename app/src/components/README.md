# UI catalogue — `app/src/components/`

This file is the counterpart of `frontend/src/components/README.md`, which the
v1 codebase treats as authoritative: *check it before building UI; update it in
the same commit whenever you add or change a shared component.* The same rule
applies here, and every later Phase 2 task that adds a shared component adds its
row below in the same commit.

It is deliberately short right now. Task 3 builds the shell; the components
arrive with the screens that need them (Tasks 14–27). What is written here is
the part that must be true **before** the first component exists — the
conventions — because retrofitting a 44 pt minimum across twenty screens is a
week and honouring it from the first screen is free.

---

## The conventions

### Tokens, not literals

**Every colour, space, radius, type size and duration comes from
`app/src/app/Theme.tsx`.** No component contains `#hex`, `marginTop: 13` or
`duration: 250`. v1 learned this twice: `lib/motion.ts` exists because durations
scattered through components drift into a UI where nothing shares a rhythm, and
its palette lives in one place because a second source of "what colour is a
debit" produced two.

`useTheme()` throws outside the provider rather than falling back to a default.
A silent default is how a screen ends up rendering in the wrong scheme and
nobody notices until a screenshot.

### 44 pt touch targets

`TOUCH_TARGET_MIN` in `Theme.tsx`. Anything a finger presses is at least 44 × 44
pt of *hit area* — `hitSlop` counts, visual size does not have to. v1's geometry
audit found sub-44 px controls that looked fine in a screenshot and were
unpressable in a hand, which is why this is measured rather than eyeballed.

If a control is deliberately smaller (a dense data row, a compact stepper), it
carries a marker prop and the audit is taught about it in the same commit. A
checker that cries wolf gets ignored.

### 16 pt minimum input font

`INPUT_FONT_MIN`, used by `type.input`. React Native does not have iOS Safari's
zoom-on-focus behaviour, so this is legibility rather than layout — but the two
front ends agreeing is worth more than the 1 pt saved.

### Numeric input is a string draft

**Never `Number(value)` on every keystroke.** `Number("") === 0`, so an input
the user clears springs back to `0` and cannot be emptied — the exact bug v1's
harness found by clearing every field on every screen and checking it stayed
clear. Hold the draft as a `string`, convert once on commit, and money converts
to `bigint` minor units, never `number`.

### Safe areas are read, not assumed

`react-native-safe-area-context`'s `useSafeAreaInsets()`, from inside the
provider in `Root.tsx`. A consumer above the provider silently reads zeros,
which on a notched device is a title under the status bar and a button under the
home indicator — and the failure is invisible on a simulator without a notch.

Bottom-anchored content adds `insets.bottom`; it does not hard-code 34.

### Motion

Durations come from `Theme.tsx`'s `motion`, and the ceiling is **300 ms** for
anything a user waits on. Reduced motion is honoured globally (v1's
`MotionConfig reducedMotion="user"`; the React Native equivalent is
`AccessibilityInfo.isReduceMotionEnabled`, wired when the first real animation
lands) — never re-implemented per component.

**Entrances for content visible on first paint are transform-only.** v1's rule
came from Framer's `LazyMotion` resolving features in an effect, which left
`opacity: 0` initial states invisible until a lazily-loaded chunk arrived.
Reanimated has no such window, so the rule is cheaper insurance here — but the
failure mode it prevents is *silent invisible content*, which is worth keeping.

### Lists are windowed, and the store is not read whole

`RowStore.all()` does not exist. `range()` is the only read path and
`eachRowChunk(250)` is the sanctioned full pass. A screen that renders a log
uses `FlatList`/`FlashList` over a windowed query — never an array of every row.
Phase 0's >500 MB freeze was partly one unguarded full pass.

---

## Components

| Component | Purpose | Use when | Do not use when |
|---|---|---|---|
| `screens/onboarding/NotInvitedView.tsx` | The closed beta's front door: explains the invite gate and takes a code. | The server answered `403 not_invited`. | Anywhere else — it is a state of the sign-in screen, not a route, so that a live ID token never travels through navigation params. |

`app/src/app/Theme.tsx`, `Root.tsx` and `Navigation.tsx` are the shell, not
shared components, and are documented in their own headers.

## Screens

| Screen | Status |
|---|---|
| `src/screens/onboarding/SignInScreen.tsx` | **The initial route.** Sign in with Apple and Google. Holds no policy — everything it renders is decided in `src/auth/` and tested under `bun test`. Task 14's step machine wraps it. |
| `src/screens/Shell.tsx` | **Temporary.** The shell smoke screen: reports whether the platform seam and the replay fold are live on the device. Task 14's onboarding replaces it. |

### Two conventions the sign-in screen establishes

**A dependency the build does not have is rendered, disabled, with the reason on
it.** The Google button and the "no server configured" banner are both that
shape. The alternatives are worse in both directions: an omitted control is a
missing feature nobody notices until App Review, and a live control over a
missing client id fails at the single moment a finger lands on it. Make the
absence loud, early, and visible at first paint.

**A live credential never goes into navigation params.** The `403 not_invited`
surface is a *state* of the sign-in screen rather than a pushed route,
specifically because the parameter it would need is the ID token. Keep
credentials in the reducer, where they stay in memory.
