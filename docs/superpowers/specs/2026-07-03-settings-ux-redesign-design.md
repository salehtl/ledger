# Settings UX redesign

## Problem

The Settings screen (`frontend/src/screens/Settings.tsx`, ~530 lines) is one flat,
long-scrolling page. Four concrete UX problems, all confirmed by the user:

1. **Unpredictable saving.** Three save models coexist: the budget uses a draft +
   explicit "Save budget"; toggles auto-save silently; swipe config auto-saves to
   local storage with no confirmation; currency rates have per-row "Save" buttons.
   The user can't tell whether a change stuck.
2. **Long, undifferentiated scroll.** Six stacked sections, no way to jump.
3. **Overloaded Categorization card.** On/off settings, API-key status, a *running
   job* (Run/Stop/progress), and error reporting all crammed into one card — an
   action masquerading as a setting.
4. **Fiddly currency rates** — three separate sub-forms (existing rate, missing
   rate, add new).

## Constraints & principles

- **Stay inside the existing design system.** The app has a mature, coherent visual
  language (warm off-white `--color-bg`, indigo accent, per-bucket blue/purple/green,
  Inter + Roboto Mono figures, 8px card radius, custom easings, dark mode via
  `styles/app.css`). This redesign is a UX/structure change, **not** a new visual
  identity — a new aesthetic on one screen would fracture the app.
- **No backend/API changes.** Every endpoint already exists.
- **Follow existing patterns.** Navigation is `useState<TabId>` in `AppShell` (no
  router). Drill-ins (`CategoryManager`, `RulesManager`) are full-screen conditional
  panels: `fixed inset-0 z-40 bg-bg flex flex-col` with a back-arrow header + scroll
  body. Reuse this exact shell.
- **`lib/` convention.** Pure formatting/decision logic goes in `lib/*.ts` with a
  co-located `*.test.ts`.

## Design

### 1. Settings root becomes a hub

A short, scannable list of grouped drill-in rows. Each row carries a **live value
preview** on the right so the hub reads as a status dashboard — the one signature
move. Groups and rows:

```
PLAN
  Budget & income                    50/30/20  ›
AUTOMATION
  Categorization                    On · AI on  ›
  Swipe actions              ← Want  → Need …    ›
LIBRARY
  Categories                              12  ›
  Rules                                   47  ›
  Currencies                     AED · USD +1  ›
────────────────────────────────────────────
  Clear all categorization                     ›   (danger tone)
```

Reuses/extends the existing `NavRow`. The preview text is produced by pure formatters
(see §4). Below the rows, the "Icons by Lucide (ISC)" credit stays.

### 2. Drill-in pages

Each opens as the shared full-screen panel (extracted as `SettingsPage`, matching the
`CategoryManager` shell). Back arrow closes to the hub.

- **Budget & income** — monthly income, the live `SplitBar` (its hero), the three %
  fields, Freeze history toggle.
- **Categorization** — settings block at top (Auto-categorize, AI suggestions, AI
  auto-accept, API-key status), then a **visually separated "Run categorization now"**
  action block (scope button + Run/Stop + progress + error reporting). Splitting the
  running job away from the settings is the fix for the overloaded card.
- **Swipe actions** — the four direction selectors + "Reset to defaults".
- **Currencies** — rate rows, missing-rate warnings, add-currency form.
- **Categories / Rules** — unchanged (`CategoryManager` / `RulesManager`).
- **Clear all categorization** — a danger-tone hub row that opens the existing confirm
  `Dialog` directly (no near-empty page).

### 3. Save model: autosave + inline "Saved" flash

One shared `SavedFlash` indicator — a quiet "Saved" cue that appears then fades,
respecting `prefers-reduced-motion` (fade only, no movement). Applied uniformly:

- **Budget**: fields commit automatically once the split is valid (sums to 100%). The
  `SplitBar` + "100% allocated" line is the live proof. No "Save budget" button. An
  invalid split shows red (existing `text-bad`) and holds the save until valid.
  Monthly income and Freeze history commit on change/blur.
- **Toggles / swipe selects / rate edits**: commit on change (rates on blur), each
  showing the flash. The per-row rate "Save" buttons are removed.
- **Actions keep buttons** because they are not settings: "Add currency" (creates a
  new thing) and "Run"/"Stop" (a job). Delete-rate keeps its trash button.

Error handling is unchanged in spirit: a failed save still shows the existing error
toast; validation errors render inline as today (`role="alert"`).

### 4. Code structure

`Settings.tsx` splits into a thin orchestrator + focused files under
`frontend/src/screens/settings/`:

- `Settings.tsx` (orchestrator) — holds `useState<PageId | null>` for the open page,
  renders `<SettingsHub onOpen=… onClear=… />` and the active drill-in panel + the
  clear-categorization `Dialog`.
- `SettingsHub.tsx` — the grouped `NavRow` list with value previews.
- `SettingsPage.tsx` — shared full-screen panel shell (back header + scroll body).
- `BudgetPage.tsx`, `CategorizationPage.tsx`, `SwipePage.tsx`, `CurrenciesPage.tsx`.
- `SavedFlash.tsx` — the inline saved indicator (+ a small `useSavedFlash` hook or
  equivalent for triggering it around a save call).
- `lib/settingsSummary.ts` (+ `.test.ts`) — pure formatters: `budgetSplitLabel(cfg)` →
  `"50/30/20"`, `categorizationSummary(settings)` → `"On · AI on"` / `"On"` / `"Off"`,
  `currenciesLabel(rates)` → `"AED · USD +1"`, `swipeSummary(cfg)` → short direction
  hint.

Existing `Card`, `Button`, `Switch`, `Dialog`, `PeriodSheet`, `SplitBar`, `NavRow`,
`ToggleRow` are reused (some move into the new files).

### Testing

- New: `lib/settingsSummary.test.ts` covers each formatter incl. edge cases
  (0/invalid split, AI off, no extra currencies).
- Migrate the four existing suites (`Settings.test.tsx`, `Settings.danger.test.tsx`,
  `Settings.categorization.test.tsx`, `Settings.rates.test.tsx`): each now opens the
  relevant hub row first, then asserts on the drill-in. Add coverage that budget
  autosaves on a valid split and holds on an invalid one, and that rate edits save on
  blur without a Save button.
- Manual: build the combined dist and smoke-test the flow (parallel-agents rule —
  rebuild dist before finishing).

## Out of scope

New backend endpoints, changing what any setting does, and any restyle of the broader
app outside Settings.
