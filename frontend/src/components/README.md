# UI Component Catalog

Every shared component: what it's for, when to use it, when not to. **Rule: before
hand-rolling any button, field, sheet, badge, label, or card, check this catalog.
If you add or meaningfully change a shared component, update this file in the same
commit.** Colocated `*.test.tsx` files are the behavioral spec.

## Conventions (apply to all UI work)

- **Tokens only.** Colors, radii, easings come from `src/styles/app.css`
  (`--color-*`, `--radius-card` (3px), `--radius-sheet` (12px), `--ease-*`). Never raw hex.
- **Elevation is Dialog-only.** The app's one box-shadow utility (`app.css`)
  exists for exactly one surface — the `Dialog` sheet, which must read as
  above the page. Every other surface is paper: separation comes from a
  `border border-border` hairline, never a shadow. Don't reach for that
  utility outside `Dialog.tsx`.
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
- **Purpose:** small inline status/label badge with a semantic `tone`
  (good/warn/bad/muted/neutral). Used for transaction status.
- **Don't use when:** the badge is a count overlay (BottomNav's tiny badge is
  a deliberate exception) or needs custom glyphs (→ `insights/DeltaBadge`).

### SectionLabel
- **Purpose:** the one eyebrow/section-heading style (11px, semibold,
  uppercase, 0.08em tracking, muted). `as` picks `p`/`h2`/`legend`.
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
- **Purpose:** the screen's single floating creation action, positioned above
  the bottom nav. One per screen, max.

### TopBar / BottomNav
- **Purpose:** app chrome. TopBar owns the page title + period scope stepper;
  BottomNav owns tab navigation (5 tabs, review badge). Screens never render
  their own h1 outside these.

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
