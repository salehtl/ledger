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
| `screens/onboarding/OnboardingShell.tsx` | Routes the onboarding step derived from `lib/onboarding.ts`, and holds the two stop states. | The one route between sign-in and the product. | As a place to put a step's content — register it in `screens` instead, so the shell keeps holding no product logic. |
| `screens/onboarding/HomeCurrencyScreen.tsx` | The one-shot, irreversible home-currency picker. | Onboarding, once. | Ever again. It refuses when the log already carries a currency, and Settings must never offer it (§3.7). |
| `components/HaltBanner.tsx` | The non-dismissable wall spec §3.4 requires: sync has stopped and the app is not usable until it is fixed. | `surface().halt` is non-null. Render it **instead of** the navigator, at the root. | An unreadable blob (that is a dismissable banner, §3.3:74), or anything a user may continue past. There is no `onDismiss` prop, on purpose. |
| `screens/settings/IntegrityScreen.tsx` | Everything the checker found that is not a wall: grouped notices with counts, the set-aside count, and a record of any halt. | Settings → Integrity, badged with `surface().badge`. | As a modal, or as a substitute for the halt — a notice list is never a stop, and a stop is never a row. |
| `components/AddressCard.tsx` | The inbound address: the string at 20 pt monospace, a full-width copy target, a QR, and the predecessor's grace deadline when the server sent one. | Anywhere the address is shown — onboarding's address step and Settings → Inbound address both use exactly this. | To show an address you assembled yourself. It renders an `AddressRecord` from `lib/address.ts` and nothing else, so what the eye reads and what the clipboard holds cannot differ. |

`app/src/app/Theme.tsx`, `Root.tsx` and `Navigation.tsx` are the shell, not
shared components, and are documented in their own headers.

## Screens

| Screen | Status |
|---|---|
| `src/screens/onboarding/SignInScreen.tsx` | **The initial route.** Sign in with Apple and Google. Holds no policy — everything it renders is decided in `src/auth/` and tested under `bun test`. Hands off to `OnboardingShell` with the account id, or `null` for a session already on the device. |
| `src/screens/onboarding/OnboardingShell.tsx` | **The route after sign-in.** One screen, not a stack: the step is derived from facts by `lib/onboarding.ts`, so a cold launch resumes with nothing to restore. `bank`, `address` and `verification` are filled by `Navigation.tsx`; `forwarding` is still a placeholder because its instructions must come from Task 2's measured Gmail record, which does not exist. |
| `src/screens/onboarding/AddressScreen.tsx` | The inbound-address step. Performs `GET /api/v1/address` itself — the endpoint mints on first read — and advances only on a press, never on arrival. |
| `src/screens/onboarding/VerificationScreen.tsx` | Google's held confirmation code and the first real bank email, both read out of the quarantine lane. Advances on a **transaction in the log**, never on a 200 from confirm. |
| `src/screens/settings/RotateAddressScreen.tsx` | Settings → Inbound address: the address again (the onboarding step is skipped on later launches), plus the three-factor rotation and every consequence §3.2 names. |
| `src/screens/onboarding/HomeCurrencyScreen.tsx` | The home-currency picker. Two-step, acknowledged, and irreversible. |
| `src/screens/Shell.tsx` | **Temporary.** The shell smoke screen: reports whether the platform seam and the replay fold are live on the device. Task 18's transactions list replaces it. |

### The invariant surfaces hold no policy

`HaltBanner` and `IntegrityScreen` take `Halt` and `Surface` from
`client/src/invariants/surface.ts` and render them. Which findings halt, which
one is shown when several fire, what each says, what is routine and what the
badge counts are all decided there and tested under `bun test` — because they
are decisions about *correctness*, not about layout, and Phase 1 records the
cost of getting one of them wrong: `I11_roster_checkpoint`'s benign "this device
hasn't been vouched for yet" and its adversarial "the server is withholding data
another of your devices has already seen" were once one message, and that
collapse laundered a withholding attack into a notice.

So neither component switches on an invariant id, and neither builds a sentence.
A screen that re-derived its own wording would reopen the hole one layer up —
which is why `HaltBanner.rn-test.tsx` asserts that **no invariant id or
condition name reaches the glass** before the details are expanded.

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

### Three conventions the onboarding shell adds

**A step is derived from facts, never stored as a number.** `lib/onboarding.ts`
walks a milestone table and returns the longest unbroken prefix; the screens are
a `switch` over the answer. A persisted cursor can disagree with reality, and
the dangerous direction is a device that thinks it has not set a home currency
when the log says it has — which is a permanent `home_currency_reset` anomaly.
Anything with a resumable multi-step flow follows this shape.

**An irreversible action is armed, echoed and acknowledged — before the tap.**
The consequence is on screen at first paint, the choice is echoed back on a
second surface, and the confirm control is inert until an explicit
acknowledgement. A confirmation that arrives after the action is a receipt, and
a toast is not a warning. `HomeCurrencyScreen` is the reference.

**A step another task owns is a named slot, not a stub screen.** The shell
renders a placeholder saying why it is empty, and a placeholder may advance
the flow only over a **device-local** fact — never over one the server or the
log produces, which nothing on the device may stand in for.

### Three conventions the address and verification screens add

**A screen that produces server truth performs the read itself.** The address
step was blocked not by the state machine — the `address_issued` milestone has
existed since Task 14 — but because the only fetch lived in `bootstrap`, which
runs before there is a session. Anything whose milestone is server truth needs a
path to that truth from the step itself, or the step is a dead end on exactly
the launch where it matters.

**Arriving is not the same as being ready.** `AddressScreen` does not report the
address the instant it loads: the milestone is satisfied the moment
`inboundAddress` is non-null, so reporting on arrival renders the screen for one
frame and hands the user nothing. The press is the event.

**A milestone the log owns is re-read from the log, not inferred from a 200.**
`VerificationScreen` calls `firstMailAt()` after a confirmation and advances only
if the fold answers with a timestamp. A `POST /api/v1/quarantine/confirm` that
re-ingested nothing is a successful request and not a completed step.

### Reading untrusted content on the glass

Onboarding necessarily renders part of a **quarantined** message (plan Decision
7: Gmail's confirmation is signed by `google.com`, a forwarder domain, so it is
held forever by design). The rules that keeps safe, all in
`lib/verificationCode.ts`:

- patterns over that content are **literal-anchored, with no unbounded
  quantifier**, and adjacent classes are disjoint so a match is deterministic
  rather than merely bounded;
- the scan covers **at most the first 8192 characters**, with a wall-clock
  tripwire that stops it rather than merely reporting;
- anything offered as an *action* has its meaning fixed by the pattern — the
  code is nine digits, and the link's scheme, host and path prefix are literals,
  so a surfaced link can only point at `mail-settings.google.com`;
- the raw body may be shown as a fallback, capped and explicitly labelled
  untrusted, through `<Text>`, which interprets no markup;
- a **trust decision** is never made from message content: the bank half renders
  `trustBasis(item)` — the verified signing domain, or a prominent
  unauthenticated state — and the API deliberately does not even send the
  subject.
