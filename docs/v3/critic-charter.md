# Ledger v3 — Critic Charter

This is the single standard every UX/visual critic agent judges ledger v3 work against.
Ledger is a numbers-dense, single-user, mobile-first finance PWA. Every judgment call in
this charter is resolved in favor of that context: glanceable numbers, crisp motion, zero
ceremony on the daily path.

**Precedence:** Section 1 (aesthetic direction) is binding and overrides everything else on
visual matters. Section 2 principles govern everything the aesthetic direction does not
decide. Section 3 instant-fail violations trump both — they reject work regardless of any
other merit. Where the upstream sources (Apple HIG, Emil Kowalski, NNGroup) conflicted,
the resolution is written into the principle itself; critics apply the resolution, not the
original sources.

---

## 1. Aesthetic direction (binding)

**Concept: a two-colour press.** Paper, ink, one vermilion spot ink. Hue carries identity,
texture carries state, red is rationed. Every rule below is BINDING and ends with a
PASS/FAIL test. A violation here is a visual-axis failure no matter how good the UX is.

### 1.1 Color tokens (light / dark)

All colour lives in CSS custom properties in `styles/app.css`; dark theme is an automatic
`@media (prefers-color-scheme: dark)` override of the same vars — no markup changes, no
theme toggle.

| Token | Light | Dark | Role |
|---|---|---|---|
| `--color-bg` / `--color-surface` | `#f2f1ef` | `#141416` | paper — bg and surface are the SAME value; there is no tonal ladder |
| `--color-surface-2` | `#e3e2de` | `#232326` | progress/dither track backing ONLY |
| `--color-border` | `#d6d5d1` | `#2b2b2f` | hairline rule — the separation mechanism |
| `--color-fg` | `#16161a` | `#ecebe8` | ink |
| `--color-muted` | `#5e5e63` | `#8b8b8f` | ink, low emphasis |
| `--color-accent` | `#c93d26` | `#c93d26` | the spot ink, FILL register only, always with `--color-accent-fg: #ffffff` on top |
| `--color-bad` | `#b8331d` | `#f0866f` | spot ink TEXT register (negative money, `text-bad` verdicts) |
| `--color-hero` / `--color-hero-fg` | ink / paper | paper / ink | the hero panel prints inverted, in ink — never in the spot |
| `--color-good` / `--color-warn` | `#16161a` | `#ecebe8` | byte-identical to fg: warnings are emphasised by full-strength ink + label wording, never a hue |

Binding rules:

- **Tokens only.** Any raw hex in component code = FAIL. Sole exceptions:
  `ProjectForm`'s `COLOR_PRESETS` user data; `SwipeableRow`'s inline-style literal
  mirroring `--color-muted`.
- **The spot ink has three registers and they never swap.** `--color-accent` used as text
  colour (either theme) = FAIL. `--color-bad` used as a fill behind text = FAIL (one
  non-text exception: `--color-pace-exceeded` on a dotted bar).
- **Red is rationed.** Full-opacity vermilion appears in exactly five contexts: primary
  action, create plate (Fab), active-tab tick, review badge, alert-severity feedback
  (error toast, hero over-budget badge). A sixth full-opacity `bg-accent` use = FAIL.
  Two `attention` pills in one row = FAIL.
- **Separation is a 1px `--color-border` hairline, never a shadow.** Elevation exists on
  the Dialog sheet only (`.shadow-1`, the app's one shadow token). A new shadowed
  surface = FAIL.
- **No new hues.** Warning/status states expressed with a colour outside the token set = FAIL.

### 1.2 Categorical palette (charts, buckets, projects)

Six hues × two lightness steps, separate light/dark tables (`dither-kit/palette.ts` seeds
mirror the `:root` vars; a test asserts agreement): azure `#1660a0`, amber `#b5771e`,
lilac `#7556a5`, sage `#409457`, rose `#c5646e`, slate `#76767e` (+ `-deep` steps; dark
table re-stepped, deep steps go *lighter* on dark). All at OKLCH C ≈ .124 — about
two-thirds the accent's chroma, so charts read muted next to the one spot colour.

- **Buckets alias, never repeat:** need = amber, want = lilac, save = sage,
  transfer = azure. A bucket holding its own hex = FAIL.
- **Second steps separate on lightness** (the axis that survives red-green colour
  blindness); adjacent chart series alternate cool/warm groups. A new palette entry
  separated only by chroma/hue = FAIL.
- **Projects store a palette *name*, never a hex** (resolved via `projectColor()` so theme
  follows). Storing a hex = FAIL.
- **Colour is never the sole carrier:** every mark has its name in visible text beside it;
  marks are `aria-hidden`. Colour-only identity = FAIL.
- **Form disambiguates at equal hue:** project mark = hatched hairline ring/square,
  bucket mark = solid fill dot.

### 1.3 Typography

Geist Sans + Geist Mono, and the split is doctrinal: **Sans takes only what a person reads
as a sentence** (prose, merchant names, screen titles, buttons); **Mono takes everything
else** — every figure, date, category label, count, eyebrow, chart axis, nav label. Mono
pushed far past "figures" is what makes the app feel ledger-like. `.tnum` = mono + tabular
figures on all money/counts.

| Role | Face | Size | Weight | Tracking |
|---|---|---|---|---|
| Hero amount (Home only) | Mono | 44px | 600 | -0.02em |
| Screen title | Sans | 16px | 600 | -0.015em |
| Row primary | Sans | 14px | 500 | -0.01em |
| Row meta | Mono | 10px | 400 | 0.04em |
| Eyebrow / label | Mono | 10px | 500 | 0.14em, uppercase |
| Nav label | Mono | 8px | 500 | 0.10em, uppercase |
| Button | Sans | 13–14px | 500 | normal |

- The 44px hero is NOT a scale step — it is the one live number on Home. Deriving other
  "big number" treatments from it = FAIL.
- Named tracking exceptions (keep, don't multiply): swipe-deck eyebrows 0.18em; TopBar
  period stepper 0.12em.
- A figure/date/label set in Sans, or prose set in Mono = FAIL. Money formatted outside
  `<Money>`/`.tnum` = FAIL.

### 1.4 Dither texture

- `.dither-mask` (2px-pitch radial dot mask, two alpha tiers) is **the app's one
  definition of "dotted"** — shared by `ProgressBar` and `DitherFill`. A second
  mask/texture definition = FAIL.
- **Texture is state, not identity:** dotted = under budget, solid = at/over
  (`pct >= 1.0`, same threshold everywhere). Per-bucket dot density = FAIL.
- Charts (`TrendBars`/`FlowBars`) are ordered-dither canvas via vendored dither-kit
  (vertical bars only); horizontal bars are CSS-masked DOM (`DitherFill`). Canvas
  consumers use `palette.ts` RGB seeds + `useDitherTheme()`; DOM consumers use
  `var(--color-…)` — mixing the two paths = FAIL.
- `ProgressBar`'s ink travels the pace ramp: ink → `#c0641a` amber-orange past pace →
  `--color-bad` past budget — the *single* sanctioned "over is a hue" exception (three
  states, texture has two). Hardcoding ramp hues at call sites, or giving the bar a
  bucket hue (identity), = FAIL. On the hero panel the ramp is texture only (`onAccent`).

### 1.5 Spacing, radius, shape

- **`--radius: 2px`, one sharp radius, everywhere** — including former circles (dots,
  knobs, badges). Any `rounded-full`/`rounded-lg`/`rounded-md`/arbitrary `rounded-[Npx]`
  = FAIL; every radius call site is `rounded-[var(--radius)]`.
- 16px content margins; cards are `bg-surface border border-border p-4`; list-card idiom
  is `!p-0` + inner `divide-y divide-border`. Nothing floats — the Fab is a flush square
  vermilion **plate**, deliberately unelevated. An elevated/floating Fab = FAIL.
- Icons: pixelarticons only (24px viewBox, 12px effective grid), sizes in multiples of 12
  for new work, `currentColor` only, `aria-hidden` by default. Lucide, emoji-as-icon, or
  hardcoded fills = FAIL.

### 1.6 Motion

Tokens: `--ease-out: cubic-bezier(0.23,1,0.32,1)` (enter/exit),
`--ease-in-out: cubic-bezier(0.77,0,0.175,1)` (on-screen movement),
`--ease-drawer: cubic-bezier(0.32,0.72,0,1)` (sheets), `--dur-press: 140ms`.

- Built-in CSS easings (`ease`, `ease-out`, `ease-in`, `linear` on movement) = FAIL; use
  the tokens.
- `.press` (scale 0.97 on `:active`) on every tappable element; hover-only affordances = FAIL.
- First-mount list stagger only (≤80ms steps, capped at 7, never on refetch);
  `RollingNumber` odometer for the one hero number only (rolling rows of amounts = FAIL).
- **Nothing rotates.** `PixelSpinner` travels brightness round an 8-block ring in
  `steps(8)` at 800ms; `animate-spin` or a rotating glyph = FAIL.
- Every animation has a `prefers-reduced-motion` treatment that removes *movement* but
  keeps comprehension (fades stay; spinner slows, doesn't stop). Missing reduced-motion
  handling = FAIL.

### 1.7 Component conventions

- Touch targets ≥44px (`min-h-11`); 36px only inside dense stacked rows. Smaller = FAIL.
- Form controls ≥16px font (iOS zoom guard); `text-sm` on an input = FAIL.
- Overlays: every sheet/modal is `Dialog` (the one elevated surface); full-screen
  drill-ins are `SettingsPage`. Hand-rolled `fixed inset-0` = FAIL.
- One primary Button and max one Fab per screen; screens never render their own h1
  outside TopBar.
- Loading: `Skeleton` for list-shaped loads, `PixelSpinner` otherwise; component logic
  beyond trivial extracts to a pure tested `lib/` function.
- Money is int64 fils rendered through `<Money>`; negative prints `.money-neg`
  (`--color-bad`), zero prints muted.

### 1.8 Tone & voice

Calm, lowercase-confidence, sentence case, no exclamation marks, no emoji. Verdicts are
terse labels ("On track", "Over pace", "Over budget"); amounts speak plainly ("1,180
left", "320 over"); errors are apologetic-practical with a next step ("Couldn't load
transactions" / "Check your connection and try again."); empty states state fact +
expectation ("No recent activity" / "New transactions will appear here."). Meaning lives
in the **label**, never in a colour alone. Title Case headings, exclamation marks,
alarmist copy, or emoji in UI text = FAIL.

---

## 2. Principles

One deduplicated list, numbered continuously (cite as **P1**, **P2**, …). Sources: Apple
HIG design canon, Emil Kowalski, NNGroup. Where sources conflicted, the resolution below
is final and favors a numbers-dense single-user mobile finance app.

### Clarity & hierarchy

**P1. Data freshness is non-negotiable.** Every screen showing money answers "as of
when?" — visible sync/freshness state, skeletons during fetch, an explicit degraded state
when ingest fails.
*PASS:* the user can always tell whether numbers are current, syncing, stale, or failed.
*FAIL:* a balance renders with no way to tell if it includes this morning's transactions;
spinners with no context; stale numbers presented as current.

**P2. Glanceable, not exploratory.** The home screen is consumed in ~5 seconds using
preattentive attributes (position, length — never angle, area, or color-only encoding).
*PASS:* within 5 seconds a viewer states: over/under budget, by how much, in which scope;
the single most important number is the most salient element.
*FAIL:* the key status requires reading multiple tiles, decoding a legend, or scrolling.

**P3. One screen, one most-important number.** Every extra figure competes with the
relevant ones; secondary data defers to a tap.
*PASS:* each visible number survives "what decision does this change?"
*FAIL:* more than ~7 unrelated figures at equal weight; gridlines, borders, redundant
labels, or icons that encode nothing.

**P4. Hierarchy by weight + size + leading as a set; layout in rem.** Large text gets
negative tracking and tight leading (~1.05–1.2); body sits near 0 tracking with ~1.5
leading; spacing scales with text.
*PASS:* the most important number on screen is unambiguous at a glance; bumping root font
~130% neither clips nor overlaps.
*FAIL:* hierarchy by size alone at uniform weight; one letter-spacing value across all
sizes; a display-size number with body line-height; fixed-px containers that break under
text scaling. (Concrete type values: §1.3 governs.)

**P5. Wayfinding with specific labels and persistent navigation.** Every screen answers
"Where am I? Where can I go? How do I get out?"; primary nav is a persistent bottom bar
(≤5 destinations) with the active tab unambiguous; labels are task nouns the user would
say ("Budget", "Review"), never system vocabulary ("Ingest", "Unparsed").
*PASS:* from any screen the user can name their location and reach any top-level
destination in one tap; every modal/sheet has a visible dismiss.
*FAIL:* a screen without title or active-tab indication; a trapped flow; icon-only nav
for non-universal concepts; two tabs whose difference the user can't articulate.

**P6. Recognition over recall.** Show options and context; never require remembering
codes, prior screens, or which filter is active.
*PASS:* active filters/scopes are visibly displayed on the results they affect; pickers
show name + visual identity, recent/frequent first; edit forms open pre-filled.
*FAIL:* a filtered list identical to an unfiltered one; bare "N/W/S" or a color with no
label; blank edit forms.

**P7. Consistency, internal and platform.** The same concept looks and behaves
identically everywhere; controls follow platform conventions.
*PASS:* a category has one name, one color, one icon across dashboard, list, review
queue, and rules; debit/credit signing and what red means are identical on every screen.
*FAIL:* "Wants" amber on one screen, gray on another; credits negative here,
green-positive there; the same gesture doing different things on different screens.

**P8. Progressive disclosure with auditability.** Rows carry only what's needed to
recognize and act; full detail (raw source, confidence, rule provenance) is one explicit
tap away — and must actually be there, because a finance app's numbers must be auditable.
*PASS:* transaction row → tap → complete provenance.
*FAIL:* confidence scores and parse metadata crowding the default list; or a detail view
that omits provenance so a distrusted number can't be audited.

### Motion & feedback

**P9. Press-down feedback, on the down event.** Every pressable visibly responds the
instant the pointer goes down (`scale(0.97)`, 0.95–0.98, ~100–160ms ease-out) — never on
release. Especially damning on mobile, where there is no hover.
*PASS:* `:active`/`.press` states in code on every button, row, chip.
*FAIL:* feedback bound only to `click`/touch-up; a debounce or timer on the input path;
any primary pressable with no scale-down.

**P10. Action feedback is immediate and proportionate.** Every action shows its
consequence at the moment of action: optimistic UI or progress for anything >1s,
disabled controls that look disabled, and downstream numbers that move.
*PASS:* a swipe-categorize visibly commits — row updates, budget number moves.
*FAIL:* no state change until a network round-trip completes; budget totals that don't
update after categorization; ambiguity about whether an action registered.

**P11. Continuous 1:1 tracking.** During a drag/swipe, content moves 1:1 with the finger,
respecting the grab offset, for the entire gesture, with the pointer captured.
*PASS:* `transform` updates on every `pointermove` with `setPointerCapture`; extra touch
points ignored.
*FAIL:* listening for a completed-swipe event; snapping the element to center on grab;
animating only after `pointerup`; no pointer capture.

**P12. Interruptible motion; keyframes banned on re-triggerable UI.** Anything the user
can re-trigger or grab mid-flight (toasts, toggles, sheets, swipe cards) uses transitions
or springs that retarget from the current position and velocity; gesture-driven elements
never lock input during a transition.
*PASS:* interrupting an entrance and dismissing mid-flight animates from the live
on-screen value.
*FAIL:* `@keyframes` on an interruptible element (restarts from zero); `pointer-events:
none` or disabled handlers during a transition; a visible jump to the logical target on
interruption. *Resolution (HIG vs. Kowalski):* CSS transitions are acceptable for simple
state toggles because they retarget; genuinely gesture-driven surfaces (swipe deck,
sheet drag) need JS-driven position with a spring settle.

**P13. Velocity handoff.** The settle animation after a gesture inherits the finger's
release velocity — no seam, no dead frame at finger-up.
*PASS:* release velocity from a tracked position/time history feeds the settle spring's
initial velocity.
*FAIL:* release triggers a fixed-duration animation from rest (visible hitch at
finger-up).

**P14. Commit by projection, not position.** Commit-vs-cancel is decided by where the
gesture is going — projected endpoint (`project(v) = (v/1000)·d/(1−d)`) or at minimum
velocity sign; a flick of ~>0.11 px/ms commits regardless of distance.
*PASS:* velocity term present in the commit decision.
*FAIL:* `offset > 50%`-style position checks only — the symptom is a fast flick that
snaps back.

**P15. Rubber-band boundaries.** Dragging past a boundary meets progressive resistance —
never a hard clamp, never unbounded 1:1 follow.
*PASS:* a diminishing-follow function at the bounds.
*FAIL:* `Math.min/max` wall-stop, or full 1:1 follow past the edge.

**P16. Critically damped; no bounce on a finance surface.** Default motion is a
no-overshoot spring (response ~0.3s); interactive transitions never exceed ~300ms.
*Resolution (HIG allows bounce after a flick; Kowalski bans bounce on financial
surfaces): Kowalski wins here.* A gesture settle inherits velocity (P13) but is damped to
no decorative overshoot; programmatic transitions never bounce.
*PASS:* `bounce: 0` is the house default everywhere.
*FAIL:* a menu, fade-in, or programmatic transition that overshoots; bouncy toasts;
`ease-in-out` durations >300ms on interactive elements.

**P17. Spatial honesty: anchored origins, mirrored exits, nothing from nothing.**
Overlays originate from the element that spawned them (`transform-origin` at the
trigger); things exit the way they entered; entrances start at `scale(0.95)`+`opacity: 0`
or higher, never `scale(0)`; only viewport-centered modals scale from center.
*PASS:* menu anchored to a button grows from that corner; a sheet that slides in slides
out; centered Dialog scales from center (do not "fix" that).
*FAIL:* a sheet that enters sliding and exits fading; a popover scaling from its own
center; `scale(0)` entrances; hard-cut appearances with no opacity component.

**P18. Frequency gates animation; input-initiated changes are instant.** The more often
an interaction fires, the less it may animate: daily-path actions (filter switches, tab
changes, review-queue advance) get zero entrance/exit animation; keyboard- or
shortcut-initiated changes respond with no transition, ever; only rare moments earn
delight.
*PASS:* the highest-frequency interaction on the screen is animation-free.
*FAIL:* an entrance animation on a daily-path element; a keystroke result passing
through a transition.

**P19. Every animation names its purpose.** Valid purposes: spatial consistency, state
indication, feedback, explanation, preventing a jarring cut. "It looks cool" on a
frequently-seen element is a defect.
*PASS:* for each animation, "what does the user learn or feel from this motion?" has an
honest answer.
*FAIL:* decoration on anything seen more than occasionally.

**P20. Easing discipline.** Enter/exit uses the `--ease-out` token; on-screen movement
uses `--ease-in-out`; sheets use `--ease-drawer`. `ease-in` never appears on UI — it
delays movement at the exact moment the user is watching. Built-in browser easings are
banned outright by §1.6.
*PASS:* only the three tokens appear.
*FAIL:* any bare `ease-in`; any built-in easing keyword on a transition.

**P21. Speed budget, asymmetric.** Button feedback 100–160ms; tooltips 125–200ms;
dropdowns 150–250ms; modals/drawers 200–500ms; anything interactive ≥300ms is
broken-slow. Exits and releases are snappier than entrances; the system's response
(release, snap-back, dismiss) is always ~200ms ease-out.
*PASS:* durations in code sit inside these bands; exit ≤ enter.
*FAIL:* a 400ms dropdown ("but it looks smooth" is not a defense); an exit slower than
its enter; button feedback ≥200ms.

**P22. Perceived speed is a design property.** Engineer the feeling of fast: subsequent
tooltips skip delay and entrance; spinners read busy, not leisurely; ease-out over
ease-in at identical durations.
*PASS:* second tooltip in a row appears instantly.
*FAIL:* every tooltip re-running its delay; a languid loading indicator.

**P23. Compositor-only motion.** Animate only `transform`, `opacity` (and `clip-path`);
never `top/left/width/height/margin/padding/box-shadow`; never `transition: all`; never
per-frame CSS-variable writes that recalc a subtree; no main-thread rAF motion shorthands
on load-critical paths.
*PASS:* motion is transforms + opacity, `will-change` only where motion is imminent.
*FAIL:* `transition: all` anywhere; animated layout properties; per-frame
`setProperty('--x', …)` on a container with many children.

**P24. Respect the device: reduced motion and real hover.** `prefers-reduced-motion`
removes positional movement but keeps opacity/color feedback — it never deletes feedback;
hover effects are gated behind `@media (hover: hover) and (pointer: fine)`;
`prefers-reduced-transparency` solidifies any blur surface.
*PASS:* every animation has a reduced-motion treatment (fades survive; spinner slows,
doesn't stop); no sticky fake-hover on tap.
*FAIL:* no reduced-motion handling; a handler that kills all state feedback; un-gated
`:hover` transforms in a mobile-first PWA.

**P25. Multimodal feedback restraint.** Feedback (motion, sound, haptic) fires on the
causal event, same-frame across senses, and only for meaningful moments — status,
completion, warning, error. Over-feedback trains the user to ignore all of it.
*PASS:* flourishes reserved for meaningful moments; cross-sense feedback synchronized.
*FAIL:* routine actions (every scroll, every row render) triggering flourishes; haptic or
sound lagging the visual by a transition duration.

### Ergonomics

**P26. 44px targets with hysteresis and breathing room.** Every tappable control has a
≥44px effective hit area (visual may be smaller with a padded hit box; 36px only inside
dense stacked rows per §1.7), adjacent tappables have spacing, drags need ~10px of
hysteresis before committing to an axis, and tap-cancel by dragging away works.
*PASS:* measured hit areas ≥44px; swipe code waits for directional intent.
*FAIL:* any sub-44px effective target; axis lock on the first pixel of movement; no
tap-cancel.

**P27. Consequential actions physically separated from benign ones.** Destructive or
high-consequence controls are never adjacent to frequent benign ones, and are styled
distinctly; opposite swipe directions with opposite consequences must differentiate
visually mid-gesture.
*PASS:* delete is spatially distant and visually distinct from save/confirm.
*FAIL:* "Delete rule" one thumb-width from "Save"; opposite-consequence swipes that look
identical mid-gesture.

**P28. Mobile input correctness.** Every field triggers the right keyboard (amount →
numeric/decimal pad; date → native picker), is ≥16px font (iOS zoom guard, §1.7), shows
constraints upfront, and keeps its label visible while typing — placeholder-as-label is
banned.
*PASS:* labels persist above fields; impossible values prevented at entry.
*FAIL:* QWERTY for an amount; placeholder-only labels; constraints revealed only after a
failed submit.

**P29. Accelerate the repeated task.** The most frequent action — categorizing/confirming
transactions — costs the fewest gestures; sequential review keeps hands in position (no
re-aiming between items); the system learns so a repeat merchant never re-asks.
*PASS:* confirming a correct guess is one gesture; bulk flows keep the thumb planted.
*FAIL:* open → scroll → pick → save → return per item; the same merchant asking twice.

**P30. Chrome and overlay discipline.** Blocking modal tasks get a dimming scrim (and
progressively dim/push back stacked parents); parallel non-blocking panels get no scrim.
In ledger every overlay is `Dialog`, the app's single elevated surface (§1.7).
*Resolution (HIG's translucent-glass chrome vs. §1):* the aesthetic direction wins —
ledger's chrome is opaque paper separated by hairlines, not blur glass. What survives
from HIG: sticky chrome must still read as a layer content scrolls beneath (a hairline or
edge fade appearing on scroll is the sanctioned cue), and surfaces must never stack
ambiguously.
*PASS:* Dialog + scrim for blocking tasks; no scrim on non-blocking panels; scrolled
state legible at the chrome edge.
*FAIL:* a full-screen scrim on a filter panel; a true modal with no dim; hand-rolled
`fixed inset-0`; any `backdrop-filter` glass surface.

### Data display

**P31. Numerals, tabular, aligned.** Digits attract fixation — amounts are numerals,
right-aligned (or column-aligned) with consistent decimals and currency treatment, set in
`.tnum` via `<Money>` (§1.3), so the eye runs down the column and compares magnitude.
*PASS:* any list of amounts scans as a column.
*FAIL:* "1,200" next to "85.5"; center/left-ragged amounts; amounts buried mid-sentence;
money outside `<Money>`.

**P32. Mobile tables prioritize, never shrink.** Rows show merchant + amount + one or two
decision-critical fields; date/section context stays visible while scrolling (sticky
signposts); the amount is never hidden by truncation and never requires horizontal
panning.
*PASS:* mid-scroll, the user knows which date group they're in.
*FAIL:* a miniaturized desktop table; truncation hiding amount or merchant; horizontal
scroll to see the amount.

**P33. Money is integers, end to end.** All UI money math operates on int64 fils; floats
never touch an amount, a sum, a percentage-of-budget numerator, or a formatter input.
*PASS:* arithmetic in fils, division only at the final formatting step inside
`<Money>`/`lib` helpers.
*FAIL:* any `parseFloat`/float arithmetic on money in UI code (also an instant fail, §3).

**P34. Charts encode with position and length only.** Quantitative comparison rides 2D
position and length; angle, area, and color-only encodings are banned; every mark carries
its name in visible text (§1.2).
*PASS:* the chart's answer is readable without a legend lookup.
*FAIL:* pie/donut comparisons; series distinguishable only by hue; a legend required to
decode the main message.

### Error prevention & recovery

**P35. Prevent slips with constraints and defaults.** Impossible values are unenterable;
forgiving formatting absorbs variation; good defaults absorb edge cases invisibly.
*PASS:* amount fields cannot hold letters; dates cannot be malformed.
*FAIL:* free-text entry where a constrained control exists; format errors that
constraints would have prevented.

**P36. Undo over interrogation.** Slips get easy undo; confirmation dialogs are reserved
for genuinely destructive, irreversible actions. Routine reversible actions
(swipe-categorize, archive, rule write-back) get zero confirmation friction; every
consequential action is recoverable after the fact.
*PASS:* the common path is one gesture + undo; a wrong swipe is recoverable in ≤2 taps;
destructive actions have confirmation or undo; every sheet cancels cleanly.
*FAIL:* "Are you sure?" on a routine action; a destructive action with neither undo nor
confirmation; a wrong swipe that silently commits and writes a permanent auto-rule with
no visible trail.

**P37. Errors are visible, plain, and input-preserving.** Failures are signaled with
multiple cues (never color alone), in plain language with a constructive next step,
adjacent to the affected element; typed input always survives. Ledger-specific: parse
failures and ingest problems must be visible in the UI (review queue, drift alerts) —
nothing is silently dropped.
*PASS:* a failed save states what happened and what to do, next to the thing; the form
remains filled and editable.
*FAIL:* a toast reading "Error" or an HTTP code; red outline as the only cue; a form
that clears on validation failure; parse failures invisible anywhere.

**P38. Empty states teach and route; the three empties are distinct.** No region ever
renders blank: an empty state says why it's empty, what will appear, and routes to
populate it; "loading", "no data yet", and "filtered to nothing" are visually and
verbally distinct.
*PASS:* empty review queue: "Nothing to review — new low-confidence transactions land
here."; filtered-empty offers one-tap clear. (Voice per §1.8.)
*FAIL:* a blank area indistinguishable from a failure; "No data" with no explanation or
action; a first-run dashboard of unexplained zeros.

### Restraint & polish

**P39. One motion personality.** One easing vocabulary (the three tokens), one tempo,
matched to the app's mood — a budgeting surface is crisp and fast, never bouncy or
whimsical. Unseen details compound only when they all sing in tune.
*PASS:* the app-wide inventory of duration/easing pairs is small and rationalized.
*FAIL:* more than ~3 distinct easing curves; a 150ms dropdown next to a 500ms bouncy
toast; wildly mixed tempos with no rationale.

**P40. API restraint and excellent defaults.** A shared component is adoptable in one
line with zero config, ships beautiful defaults, and handles edge cases invisibly (pause
timers on hidden tabs, bridge hover gaps) rather than exposing props for them.
*PASS:* edge cases absorbed silently, no prop.
*FAIL:* hook + provider + config object for basic use; prop count growing to cover what
defaults should absorb.

**P41. Voice restraint.** All UI text follows §1.8: calm, sentence case, terse verdict
labels, meaning in words never in color alone.
*PASS:* copy reads like a quiet ledger.
*FAIL:* Title Case, exclamation marks, alarmist phrasing, emoji.

---

## 3. Scoring protocol

### Axes

Score each axis **1–5**. 5 = ship-quality: you would put this in front of the user today
with your name on it.

| Axis | Governed by |
|---|---|
| A. Aesthetic fidelity | Section 1 (all of it) |
| B. Clarity & hierarchy | P1–P8 |
| C. Motion & feedback | P9–P25 |
| D. Ergonomics | P26–P30 |
| E. Data display | P31–P34 |
| F. Error prevention & recovery | P35–P38 |
| G. Restraint & polish | P39–P41 |

Score meanings:

- **5** — ship-quality; no violations, and the work exhibits the principles, not merely
  avoids breaking them.
- **4** — minor nits only; nothing a user would feel; may pass with fixes noted.
- **3** — at least one real principle violation a user would feel; not shippable.
- **2** — multiple violations or one severe one; the screen misleads, lags, or frustrates.
- **1** — fundamental failure of the axis, or an instant-fail violation on this axis.

**Verdict rule: ANY axis below 4 = REJECT.** A REJECT must list mandatory concrete fixes
(see Section 4); a verdict without fixes is an invalid review. Axes with no applicable
work (e.g. a change touching no motion) are marked N/A, not 5.

### Instant-fail violations

Any one of these = automatic REJECT, regardless of every other score. Mark the governing
axis 1 and cite the violation by name:

1. **Off-token colors** — any raw hex or hue outside the token set in component code
   (exceptions named in §1.1 only). [Axis A]
2. **Sub-44px touch targets** — any effective hit area under 44px outside the sanctioned
   36px dense-row case. [Axis D; P26]
3. **Floats for money in UI math** — float arithmetic on any amount anywhere in UI code.
   [Axis E; P33]
4. **Layout shift on load** — content that jumps as data, fonts, or images arrive;
   skeletons must reserve final dimensions. [Axis B]
5. **Missing empty/loading/error states** — any data-bearing view lacking any one of the
   three, or rendering blank in any of them. [Axis F; P38, P37]
6. **Uninterruptible animation over 300ms** — any animation >300ms that locks input or
   cannot be re-targeted mid-flight. [Axis C; P12, P16, P21]
7. **Horizontal page scroll** — the page body scrolls horizontally at any mobile
   viewport width. [Axis B; P32]

### Procedure

1. Inventory what the work touches; mark untouched axes N/A.
2. Sweep the instant-fail list first. Any hit → REJECT immediately (still complete the
   review; the author needs the full picture, not just the first landmine).
3. Score each applicable axis against its principles, citing P-numbers (or §1.x) for
   every deduction.
4. Verdict: **PASS** only if every applicable axis ≥4 and no instant fail. Otherwise
   **REJECT** with the mandatory fix list.

---

## 4. Critic conduct

- **Be harsh.** The bar is "would ship today with your name on it," not "reasonable
  effort." A 3 is a rejection, not a compliment. If you are unsure whether something is
  a 3 or a 4, it is a 3.
- **Be specific.** Every criticism names the file/component/screen, the exact element,
  and what is wrong with it. "The motion feels off" is not a finding; "the review-deck
  card settles with a fixed 350ms transition from rest, dropping release velocity" is.
- **Cite the principle number.** Every deduction references a P-number or a §1.x rule.
  If you cannot cite one, either the charter is missing a rule (say so, separately) or
  your objection is taste — label taste as taste, and it cannot move a score below 4 on
  its own.
- **Propose the concrete fix.** Every violation ships with the fix that would clear it:
  the token to use, the duration band, the easing token, the component to reach for, the
  copy rewrite. A rejection without an actionable fix list is an invalid review —
  rewrite it.
- **Never pass work to be agreeable.** You are not the author's peer reviewer seeking
  consensus; you are the last gate before a user sees it. Effort, intent, and "it's
  better than before" are irrelevant to the score. If the author pushes back without new
  evidence, the score stands.
- **Do not invent requirements.** The charter is the whole law. Do not fail work for
  rules that are not here; propose charter amendments separately if you find a gap.
- **Verify before you condemn.** Read the actual code or capture before asserting a
  violation — a claimed missing `.press` state that exists in a shared wrapper is a false
  finding, and false findings destroy the critique's authority.
- **Praise only after a pass.** A REJECT contains findings and fixes, nothing else. When
  work passes, you may note — briefly — what it does exceptionally well, so good patterns
  propagate. Praise inside a rejection teaches the wrong lesson.
