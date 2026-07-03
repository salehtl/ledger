# Text Size Setting — Design

**Goal:** A global font-size control in Settings that scales all text in the app, primarily downward (user request: denser UI on demand).

**Decision context:** Designed while the user was away; per-device storage and the 80–100% preset range are recommended defaults, explicitly flagged for veto. Everything here is client-side and reversible.

## Behavior

- Preference is **per device**, persisted in localStorage under `ledger-font-scale` (same pattern as `lib/swipe.ts`). Different devices can hold different scales; no server/API changes.
- Allowed values: **80, 85, 90, 95, 100** (percent). Default **100**.
- Applying: set `document.documentElement.style.fontSize = "<n>%"`; at 100 remove the override so the browser/user-agent default rules. All Tailwind rem-based type scales proportionally. Fixed-pixel outliers (`text-[11px]` chart labels) deliberately don't scale.
- Startup: `main.tsx` applies the stored scale before `createRoot`, so there's no flash of the wrong size.
- Changing the value in Settings applies immediately (the settings page itself visibly scales — that's the preview) and autosaves with the standard SavedFlash.

## Components

- `frontend/src/lib/fontScale.ts` — pure/device helpers: `FONT_SCALE_OPTIONS`, `DEFAULT_FONT_SCALE`, `isFontScale`, `loadFontScale` (validates; falls back to default on garbage), `saveFontScale` (swallow storage errors — private-mode Safari), `applyFontScale` (no-op outside a browser). Co-located test.
- `frontend/src/lib/settingsSummary.ts` — add `fontScaleLabel(scale)`: `"Default"` at 100, else `"90%"`; used by the hub row preview.
- `frontend/src/screens/settings/TextSizePage.tsx` — drill-in page mirroring `SwipePage`: `SettingsPage` shell, hint text, `SegmentedControl` (string values "80"…"100", labels "80%"…"100%"), reset-to-default ghost button shown only when ≠100, `useSavedFlash`.
- `frontend/src/screens/settings/SettingsHub.tsx` — new `Group label="Device"` (between Automation and Library) with a "Text size" `HubRow`; `"textsize"` added to `SettingsPageId`.
- `frontend/src/screens/Settings.tsx` — route `page === "textsize"` to `TextSizePage`.
- `frontend/src/main.tsx` — `applyFontScale(loadFontScale())` before render.

## Testing

- `lib/fontScale.test.ts`: default when unset; save/load roundtrip; invalid stored values ("abc", "120") fall back to default; `applyFontScale` sets and clears the html inline style.
- `screens/settings/TextSizePage.test.tsx`: renders all options with the current one `aria-pressed`; selecting 90% updates the html font-size and localStorage; reset restores default and clears the override.
- `lib/settingsSummary` label covered alongside the existing summary tests.

## Out of scope

- Syncing the preference across devices (would need the settings API; add later if wanted).
- Scaling above 100% (accessibility enlarge) — trivially added to `FONT_SCALE_OPTIONS` if requested.
- Theme/appearance settings beyond text size (the "Device" hub group gives them a home later).
