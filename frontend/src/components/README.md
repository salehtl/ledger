# UI Component Catalog

Every shared component: what it's for, when to use it, when not to. **Rule: before
hand-rolling any button, field, sheet, badge, label, or card, check this catalog.
If you add or meaningfully change a shared component, update this file in the same
commit.** Colocated `*.test.tsx` files are the behavioral spec.

## Conventions (apply to all UI work)

- **Tokens only, for colour.** Colors and easings come from `src/styles/app.css`
  (`--color-*`, `--ease-*`). Never raw hex in component code (project colours
  in `ProjectForm.tsx`'s `COLOR_PRESETS` are the one exception — user data, not
  app chrome). **Radius is not yet tokens-only in practice**: `--radius-card`
  (3px) and `--radius-sheet` (12px) are the intended scale, but a Task 12 audit
  found only ~7 of ~73 live radius utilities actually reference
  `--radius-card` — the rest are untouched Tailwind defaults (`rounded-lg`
  ×11, `rounded-md` ×12, bare `rounded` ×14, `rounded-full` ×27, the last
  mostly avatars/dots/ticks that were never meant to carry the card radius).
  Treat `--radius-card`/`--radius-sheet` as what to reach for on new work;
  reconciling the drift on existing surfaces is known follow-up, not done.
- **The spot ink has three registers.** One plate, different tints for
  different jobs (ordinary two-colour press practice) — a contrast audit found
  the shipped single value sub-AA in two of these three roles:
  - **Fill** (`--color-accent`, `#c93d26`) — always paired with
    `--color-accent-fg: #ffffff` on top. 5.03:1.
  - **Text on light paper** (`--color-bad`, `#b8331d`) — 5.27:1 on
    `--color-bg` (`#f2f1ef`). This is what `.money-neg` renders.
  - **Text on dark ground** (`--color-bad` in the dark override, `#f0866f`,
    unchanged) — 7.31:1 on `#141416`.

  **The *fill* register (`--color-accent`) is only ever a fill — it is never
  coloured text, in either theme.** Never use `--color-accent` as a label's
  text colour; applied to text it's 4.45:1 on light paper and worse still on
  dark, sub-AA either way. The *text* register (`--color-bad`) is a different
  story: it is deliberately used as coloured text at roughly 20 live
  `text-bad` sites app-wide (not just `.money-neg`), and every one of them is
  contrast-safe because it uses the correct per-theme text register described
  above. So: the fill is never text; the text register is text in more places
  than just `.money-neg`, by design. See "Red is rationed" under `Pill` for
  where the fill register is allowed to appear at all.
- **Elevation is mostly Dialog-only, not exclusively.** The app's one
  box-shadow *token* (`.shadow-1` in `app.css`) exists for exactly one
  surface — the `Dialog` sheet, which must read as above the page — and nothing
  else should reach for that class. In practice, though, four other surfaces
  carry a Tailwind default shadow utility (not the token): `Toast.tsx`
  (`shadow-lg`), `swipe/SwipeDeck.tsx` (`shadow-lg`, the resting-stack card),
  `swipe/SwipeCard.tsx` (`shadow-lg`, the commit-direction chip), and
  `dither-kit/tooltip.tsx` (`shadow-sm`, vendored chrome). Everywhere else,
  separation is a `border border-border` hairline, never a shadow. Reconciling
  those four (token vs. ad hoc utility, and whether they should be elevated at
  all) is known follow-up; don't add a fifth without checking here first.
- **Touch targets.** Interactive elements are ≥44px (`min-h-11`) by default.
  36px (`IconButton size="sm"`) is allowed only inside dense stacked rows.
- **16px inputs.** Form controls use `Input`/`Select` (text-base). Anything
  smaller makes iOS Safari zoom on focus.
- **Press feedback.** Every tappable element carries `.press` (scale on
  `:active`) — hover-only affordances don't exist on touch.
- **Haptics.** `Button` and `IconButton` fire `fire("selection")` from
  `lib/feedback` themselves; don't add a second call in onClick handlers.
- **Money & counts** use `.tnum` (tabular mono figures) via `<Money>` or the
  class directly.
- **Overlays**: every sheet/modal is a `Dialog`. Full-screen drill-ins are a
  `SettingsPage`. No hand-rolled `fixed inset-0` overlays.
- **Loading**: `Skeleton` for list-shaped primary loads; a centered `Loader2`
  spinner only for non-list loads (Review deck) and inline waits.
- **Component logic** that grows beyond trivial goes into a pure `lib/`
  function with its own test (see CLAUDE.md).
- **Sans/Mono division of labour.** Geist Sans takes prose, merchant names and
  screen titles — anything a person reads as a sentence. Geist Mono takes
  *everything else*: every figure, date, category label, count, eyebrow, chart
  axis and nav label. Geist alone is a neutral grotesk that reads as Inter by
  another name; pushing Mono well past a "figures" role is what makes the app
  feel technical and ledger-like. When a string's classification is unclear,
  ask "would a person read this as a sentence?" — yes is Sans, no is Mono.
  The scale:

  | Role | Face | Size | Weight | Tracking |
  | --- | --- | --- | --- | --- |
  | Hero amount (Home) | Mono | 44px | 600 | -0.02em |
  | Screen title | Sans | 16px | 600 | -0.015em |
  | Row primary | Sans | 14px | 500 | -0.01em |
  | Row meta | Mono | 10px | 400 | 0.04em |
  | Eyebrow / label | Mono | 10px | 500 | 0.14em, uppercase |
  | Nav label | Mono | 8px | 500 | 0.10em, uppercase |
  | Button | Sans | 13px | 500 | normal |

  The hero amount is not a general scale step — it is the one live number on
  Home (`text-[2.75rem] font-semibold`, `screens/Home.tsx`), sized to be the
  largest thing on the screen. Don't derive other "big number" treatments from
  it; if a mockup implies 32px/500 for a hero, that is the mockup rendered at
  mockup scale, not this token.

  The swipe deck's display eyebrows (`0.18em` tracking) are a deliberate,
  recorded exception to the eyebrow row above — leave them. TopBar's period
  stepper is another named variant of the same eyebrow row: `0.12em` tracking
  (tighter than the standard `0.14em`) at eyebrow weight/size, because it's
  chrome sitting next to a sans screen title rather than a standalone label.

## Primitives — `components/ui/`

### Button
- **Purpose:** any labeled tap action. Variants: `primary` (the screen's one
  main action), `secondary` (default, tonal), `ghost` (low-emphasis/cancel),
  `danger` (destructive).
- **Use when:** the action has a text label.
- **Don't use when:** icon-only (→ `IconButton`); navigation between screens
  (→ `BottomNav` / `HubRow`-style rows).

### IconButton
- **Purpose:** icon-only action with a required accessible `label`. 44px
  default; `size="sm"` (36px) only in dense stacked rows (e.g. TransactionRow's action column, CategoryManager's list rows).
  Tones: `muted` (default), `accent` (positive/primary row action),
  `danger` (delete).
- **Don't use when:** the action fits a text label (→ `Button`).

### Input / Select (`Field.tsx`)
- **Purpose:** the only text/select controls. 16px font (iOS zoom guard),
  44px min height. `icon` prop renders a leading icon (search fields).
- **Use `inset`** inside a `Dialog` (panel is already `bg-surface`); default
  `bg-surface` on pages (background `bg-bg`).
- **Don't:** copy a `className` string to make a one-off field; don't set
  `text-sm` on a control. Add `inputMode="decimal"` for money,
  `inputMode="numeric"` for integers, `enterKeyHint`/`autoCapitalize`/
  `autoCorrect` where the keyboard matters.
- With `icon`, `className` lands on the inner input (not the wrapper) — apply margins to a wrapping element, not via `className`.

### Dialog
- **Purpose:** the one modal/bottom-sheet. Scrim, slide-up, focus trap,
  Escape, drag-to-dismiss, safe-area padding, `85dvh` scroll containment.
  `titleAdornment`/`titleStyle` decorate the header (see SubcategoryPanel).
  The one elevated surface in the app (see `app.css`'s box-shadow utility) —
  a sheet must read as above the page; everywhere else uses a
  `border-border` hairline instead.
- **Use when:** anything overlays the current screen but keeps context.
- **Don't use when:** the destination is a full screen task (→ `SettingsPage`).

### SettingsPage (`screens/settings/SettingsPage.tsx`)
- **Purpose:** full-screen drill-in shell — back arrow, title, optional
  `headerRight` (autosave flash), scrolling body. CategoryManager and
  RulesManager use it too.
- **Don't:** hand-roll a `fixed inset-0 z-40 bg-bg` overlay.

### Card
- **Purpose:** the paper content surface (`bg-surface`, card radius,
  `border border-border`, `p-4`) — bounded by a hairline, not a shadow.
  `className="!p-0"` + an inner `divide-y` list is the list-card idiom.
- **Don't:** inline `bg-surface rounded-[var(--radius-card)] border border-border`.

### Pill
- **Purpose:** small inline status/label badge with `tone`
  `"default" | "muted" | "attention"`. Colour no longer carries status — the
  label text does. Used for transaction status.
- **Red is rationed:** `attention` (`bg-accent`) is the *only* tone that spends
  the app's one spot ink at full opacity. Full-opacity vermilion marks five
  things app-wide: the primary action, the create plate, the active-tab
  marker, the review badge, and alert-severity feedback (`Toast`'s error tone,
  `Home`'s hero over-budget badge) — there is only one red, so an urgent or
  destructive state is told apart by its *label*, never a second colour.
  `Pill`'s only sanctioned `attention` use is the `needs_review` status pill
  (`statusTone` in `lib/format.ts`) — every other status, including
  data-quality notes like "no AED rate", is `default` or `muted`. Never reach
  for `attention` just because a state feels warning-ish; if two pills would
  land in the same row and both want `attention`, only the more urgent one
  keeps it — demote the other to `default` and make its label clearer instead.

  Separately, several components tint `bg-accent` at low alpha (`/10`, `/15`,
  `/30`) to mark *selected* filter state instead of full-opacity fill:
  `FilterBar`'s chips and active-filter tokens, `FilterChips`'s dimension
  buttons, `SegmentedControl`'s badge, and `Transactions`'s filter-toggle
  button. This is a second, unreconciled convention for "selected," not a
  sixth sanctioned full-opacity use — `BottomNav` deliberately rejected a
  tinted pill for its active tab in favor of a 2px tick (see below), so the
  two patterns disagree about whether a tint should mean "selected" at all.
  Recorded here as a known inconsistency to resolve later, not as settled
  guidance to copy.
- **Don't use when:** the badge is a count overlay (BottomNav's tiny badge is
  a deliberate exception) or needs custom glyphs (→ `insights/DeltaBadge`).

### SectionLabel
- **Purpose:** the one eyebrow/section-heading style (mono, 10px, medium,
  uppercase, 0.14em tracking, muted). `as` picks `p`/`h2`/`legend`.
- **Exception:** the swipe deck's display eyebrows (0.18em tracking) are
  intentionally wider-set; leave them.

### ProgressBar
- **Purpose:** budget progress with auto tone signaled by texture: under budget
  (pct < 1.0) renders dithered, at or over budget (pct ≥ 1.0) fills solid ink.
  An optional `tone` prop overrides the automatic reading. Includes optional
  pace marker and `onAccent` variant for the hero panel.

### SegmentedControl
- **Purpose:** exclusive choice between 2–6 short options (filters, day
  windows). Generic over the value type. `fullWidth` stretches to equal-width,
  never-wrapping segments (the Transactions status filter); an option's optional
  `badge` renders a small count (e.g. items needing review).
- **Don't use when:** options overflow — put long sets in a `Dialog` list.

### Switch
- **Purpose:** boolean toggle over a real checkbox (native semantics).
  Settings rows wrap it in a full-row `<label>`.

### Fab
- **Purpose:** the screen's single creation action: a square vermilion plate
  above the bottom nav, flush to the 16px content margin. Deliberately not
  elevated — nothing in this design floats. If it needs separating from
  content beneath it, that is a layout problem, not an elevation problem.
  One per screen, max.

### TopBar / BottomNav
- **Purpose:** app chrome. TopBar owns the page title + period scope stepper;
  BottomNav owns tab navigation (5 tabs, review badge). Screens never render
  their own h1 outside these.
- **TopBar type:** the title is sans (screen-title row of the scale); the
  period-scope stepper is mono micro-caps (eyebrow-weight, tighter tracking) —
  it's data, not prose.
- **BottomNav active tab:** marked by a 2px vermilion tick (`data-active-tick`)
  sitting on the top hairline, plus `text-fg` on the label — never a tinted
  pill behind the icon, and never the accent ink rendered as the label's own
  coloured text (the spot ink is a fill only, in both themes; as text it's
  sub-AA on the dark ground). The review badge is `bg-accent text-accent-fg`
  — one of the sanctioned full-opacity red contexts app-wide (primary action,
  create plate, active-tab marker, review badge, alert-severity feedback; see
  "Red is rationed" under `Pill`). Its 2px tick is also the app's answer to
  "how do you mark selected without a tint" — contrast with the low-alpha
  `bg-accent/NN` tints used for that job elsewhere (same section).

### PeriodSheet
- **Purpose:** month/range picker built on Dialog. Reuse it anywhere a scope
  is chosen; don't build a second date picker.

## Shared components — `components/`

### Money
- **Purpose:** formats fils (int64 minor units) with sign/zero color coding.
  All amounts render through it — never format currency inline. It does NOT
  apply `.tnum` itself: wrap it (or its container) in a `.tnum` element for
  tabular digit alignment, as every existing call site does.

### RollingNumber
- **Purpose:** odometer display for one hero number — per-digit 0–9 wheels
  roll on mount (spin-up from zero) and on value change; scales down (never
  up) instead of overflowing its container. Pass pre-formatted text
  (`formatFils(...)`); geometry lives in `lib/rollingNumber`.
- **Use when:** a single prominent live number (Home hero).
- **Don't use when:** lists/rows of amounts (→ `Money` — rolling every row is
  noise), or anything keyboard-driven.

### EmptyState
- **Purpose:** canonical empty/error state (icon chip + title + hint). Used
  for both "no data" and query-error states.

### Skeleton
- **Purpose:** pulse placeholder rows for list-shaped primary loads.

### Toast (`ToastProvider` / `useToast`)
- **Purpose:** transient outcome feedback (saved/failed), swipe-dismissable.
  Not for persistent states (→ `IngestHealthBanner` pattern).

### PullToRefreshIndicator / IngestHealthBanner
- **Purpose:** app-shell plumbing: PTR spinner; app-wide warning strip.

### DitherFill (`charts/`)
- **Purpose:** a horizontal dithered magnitude/proportion bar. Shares the bar
  charts' *dither* — dither-kit's 4×4 Bayer matrix and its `OFF_TIER` alpha for
  an off cell, thresholded against a density ramped along the row — so it reads
  as the same family. Segments fill left→right against `max`.
- **Use for:** horizontal magnitude or proportion bars that should match the
  charts' dither texture (`LensBreakdown`'s row bars, `ComparativeSummary`'s
  need/want/saving split).
- **Don't use for:** progress or budget meters — those stay `ProgressBar`,
  which is CSS and stays legible at 6px.
- Not pixel-identical to the charts, and not trying to be: the charts'
  `paintColumn` also modulates alpha with density and caps each column with a
  border outline + feather row, while this thresholds to two flat alphas with no
  outline. `backingSize` also floors the backing at 8 rows, so at 10–12px the
  vertical cell is 1.25–1.5px against a 2px horizontal one — cells are not
  square, and "2px" is not a height threshold.
- Minimum useful height is 10px — below that the ramp has too few rows to read
  as texture.
- `bloom` defaults to `"off"`: the aura preset's 15px blur is clipped by the
  component's own `overflow-hidden` box at these heights, so it costs a
  filtered, `plus-lighter`-blended layer per instance and shows nothing. Opt in
  only on a taller surface.
- **Bucket density (the signature).** `--color-need`/`--color-want`/
  `--color-save` all resolve to the same ink, so the 50/30/20 buckets are told
  apart by a segment's `density` (`Density` from this file) instead of hue:
  needs `"dense"`, wants `"medium"`, saving `"sparse"`. A bucket at or over its
  budget renders `"solid"` — the same texture-not-colour reading as
  `ProgressBar`'s `pct >= 1.0`, and wired to agree with it: `bucketDensity`
  takes an `isOverBudget` flag, and `overBudgetBuckets` (`lib/insights.ts`)
  turns a period's `BucketSummary[]` (`pct_used >= 1.0`) into the set of names
  callers pass in. `Insights.tsx` threads its `summary` query's buckets through
  to both `ComparativeSummary` (`overBudgetBuckets` prop) and `LensBreakdown`'s
  `buckets` lens (`bucketRows`'s `overBudget` param) so their bars go solid in
  step with Home's `ProgressBar`s for the same period. `color` still selects
  the ink *seed* on every segment (unchanged for `red`/`grey`, which aren't
  buckets); `density` is the new, separate axis. `bucketDensity`/`bucketDither`
  in `lib/ditherColor.ts` are
  the single source of truth for both. Density is never the sole encoding —
  every call site (`ComparativeSummary`'s legend, `LensBreakdown`'s row name)
  states the bucket in visible text next to the bar, since the bar itself stays
  `aria-hidden`. Same **red is rationed** rule as everywhere else: this
  encoding exists specifically so buckets never need another spent-ink use —
  don't reach for `--color-accent` on a bucket bar to "help" it read as urgent.

### ActiveBandHighlight (`charts/`)
- **Purpose:** the surface-tint band drawn behind the active month's bar in
  `TrendBars`/`FlowBars`. dither-kit's `BarChart` colors per *series*, not per
  *bar*, and its `markerIndex` prop is inert in dither-kit 0.1.0, so this is
  the app's own stand-in for that emphasis. Must render *before* the chart's
  canvas in DOM order (neither element carries a z-index) so it stays behind
  the bars.
- **Use for:** anything built on a dither-kit `BarChart` that needs to
  emphasize one band by position rather than color.
- **Don't use for:** anything outside that context — it positions itself via
  `activeBandRect` (`lib/trendBars.ts`), which assumes the same d3 band
  layout the charts lay their bars out on.

## Feature components

Domain components live beside their feature (`transactions/`, `swipe/`,
`insights/`, `charts/`) and compose the primitives above. Notable:

- `TransactionRow` — one calm, tap-only list line (merchant + amount, then
  `category · date`); a status pill shows only for review/archived rows. Tapping
  is the whole action surface — it has no inline buttons. Used by the
  Transactions list and the Insights drill-down/search sheets.
- `SwipeableRow` — wraps a row to add swipe-to-act: right = leading action,
  left = trailing. Full-swipe past the commit threshold fires it (haptic +
  spring-back); short swipes cancel; a swipe never doubles as a tap. Geometry is
  the pure, tested `lib/rowSwipe`. Touch enhancement only — keep every action
  reachable by tapping the row open too.
- `TransactionDetailSheet` — the tap-opened action hub for one transaction
  (categorize, transfer, ignore, link/unlink refund, archive/restore), gated by
  status. Swipe covers the two commonest moves; everything else lives here.
- `CategorizeSheet` — category picker as tap-target chips grouped by bucket
  (not a radio list), search, a "make a rule" `Switch`, and a project picker
  (assigns immediately, locally-stated so the choice sticks while the sheet is
  open). Preselects the current category so recategorizing reads as a change;
  tapping the selected chip deselects it, and saving with no category
  decategorizes (back to the review queue, rule toggle disabled).
- `FilterBar` — inline, in-place filtering for the Transactions page: bucket /
  type / category / source as direct toggle chips (no per-dimension sheet),
  with removable active-filter tokens. `FilterChips` (the older sheet-per-
  dimension picker) is still used by the Insights `SearchSheet`.
- `SubcategoryPanel` — the swipe deck's post-swipe picker (a `Dialog`): bucket
  categories as tap targets, optional project chips with date-window matches
  surfaced first as suggestions (project rides along with the categorize call),
  and an income group when the card is a credit. Selection reports
  `(categoryId, projectId)` in one shot — no separate save step.
- `SwipeDeck` / `SwipeCard` — the review sorting deck. Every commit
  (categorize or transfer) shows an undo toast that restores the card and
  reverses the write (including deleting a just-created rule / project
  assignment); a failed save puts the card back with an error toast instead of
  failing silently. Cards carry an account chip (registered name or masked
  last4) plus a why-is-this-here line from `lib/reviewMeta`. Commits fire on
  distance or on flick velocity (`lib/swipe.flickDirection`); skipping is the
  visible "Skip for now" button or a triple tap.
- `AddTransactionSheet` / `LinkRefundSheet` — further `Dialog` composition
  examples.
- `TrendBars` / `FlowBars` (`charts/`) — monthly spending / money-in-vs-out
  charts, rendered as dither-kit `BarChart`s wrapped in app markup for the
  bits dither-kit doesn't provide: the active-month band (`ActiveBandHighlight`),
  band-center-aligned month labels, and (`FlowBars`) the net lane, thread and
  In/Out legend. Both wrap the chart in one labelled `role="img"` and mark
  dither-kit's own inner SVG `aria-hidden`, so assistive tech sees a single
  accessible chart rather than two nested `role="img"`s. Used by Home and
  Insights.
- `LensBreakdown` (`insights/`) — ranked, drillable magnitude-bar list for the
  selected analysis lens; each row's bar is a `DitherFill` scaled to the
  largest row's spend, tapping opens the transactions behind it.
- `ComparativeSummary` (`insights/`) — the month's net/saved hero plus one
  `DitherFill` (12px) showing the need/want/saving split, with a
  tap-to-drill legend beneath it.

## Known deliberate exceptions

- BottomNav's review-count badge: too small for `Pill`, stays bespoke.
- `insights/DeltaBadge`: direction arrows + domain colors, stays bespoke.
- Insights' search trigger: a `button` styled as a fake input (it opens
  `SearchSheet`), kept because a real input would summon the keyboard.
- Swipe deck cards use `rounded-[12px]` and wide-tracked eyebrows — display
  surface, intentionally denser than the card idiom.
- `FilterBar` chips and `SwipeableRow` action icons run at 36px inside their
  dense panels/rows — the sanctioned exception to the 44px target, same as
  `IconButton size="sm"`.
- Transactions list is not virtualized; acceptable at current volumes.
  Revisit if months exceed ~500 rows.
