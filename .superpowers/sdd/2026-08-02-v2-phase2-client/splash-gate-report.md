# Splash bundling defect + gate hole — report

Branch `v2-wip-2026-08-05`, based on HEAD `8aab3fe`.

## Defect 1 — app could not bundle

Commit `5b00344` added `"expo-splash-screen"` to `app/app.json`'s `plugins`
array but never added the package to `app/package.json` or `app/node_modules`.
Reproduced the reported symptom first, before touching anything:

```
$ EXPO_PUBLIC_LEDGER_SERVER=https://example.test bunx expo export --platform ios --output-dir /tmp/x
PluginError: Failed to resolve plugin for module "expo-splash-screen" relative to ".../app"
```

Fixed by installing the package the pinned way:

```
$ npx expo install expo-splash-screen
› Installing 1 SDK 54.0.0 compatible native module using bun
> bun add expo-splash-screen@~31.0.13
```

Pinned the declared range down to an exact version (`31.0.13`) to match every
other dependency in `app/package.json`, which are all exact pins, then ran
`bun install` once to resync `app/bun.lock` with the tightened range (no
resolution change — same 31.0.13 was already installed).

## Which splash configuration SDK 54 actually wants

`5b00344` left **both** a top-level `"splash"` block in `app.json` and a bare
`"expo-splash-screen"` plugin entry with no config object. I did not assume
which one wins — I measured it three ways:

1. **Read the installed plugin source**
   (`node_modules/expo-splash-screen/plugin/src/withSplashScreen.ts` →
   `@expo/prebuild-config/.../getIosSplashConfig.js`). A bare plugin entry
   passes `props === undefined`, and `getIosSplashConfig` falls through to
   `config.splash` (the top-level legacy key) when no plugin-level props are
   given — it does **not** silently apply plugin defaults over the top-level
   block. This refutes the exact risk the dispatch flagged ("may render a
   blank splash").
2. **Ran a real `expo prebuild --platform ios`** against a scratch copy with
   the original bare-entry + top-level-splash combination. It generated
   `SplashScreenLegacy.imageset` (untouched 248×512 source at every scale) and
   a full-screen `imageView` pinned top/leading/trailing/bottom to the
   container — i.e. it worked, not blank. Confirms point 1 empirically rather
   than by reading code alone.
3. **Fetched the official SDK 54 docs**
   (`docs.expo.dev/versions/v54.0.0/sdk/splash-screen/`): the config-plugin
   form is explicitly "the recommended method for configuring the splash
   screen," and the top-level `splash` / `ios.splash` / `android.splash` keys
   are explicitly called out as "now considered legacy and will be removed in
   the future."

**Decision:** migrated to the explicit plugin-config form and removed the
top-level `splash` block, so `app.json` carries the setting exactly once, in
the form SDK 54's own docs say is current and non-deprecated:

```json
[
  "expo-splash-screen",
  {
    "image": "./assets/splash.png",
    "resizeMode": "contain",
    "backgroundColor": "#ffffff",
    "dark": { "backgroundColor": "#000000" }
  }
]
```

This is not a defensive fix for a bug that turned out not to exist (point 2
shows the old combination rendered fine) — it is fulfilling the dispatch's
explicit ask for "one coherent configuration" using the convention SDK 54's
docs actually name as current, ahead of the removal the docs already
announce. Verified the new form end-to-end with a second scratch
`expo prebuild --platform ios`: generates `SplashScreenLogo.imageset`, image
centered via `centerX`/`centerY` constraints, `contain` fit — not blank.

Added a `dark.backgroundColor: "#000000"` since `userInterfaceStyle` is
`"automatic"` and the light background was hard-coded white — without a dark
variant, a dark-mode launch would flash white before the mascot's own
blue-background artwork paints. Verified `SplashScreenBackground.colorset`
gets both a `universal` white entry and a `luminosity: dark` black entry from
a scratch prebuild. No new asset was needed — `dark.image` was left unset, so
light and dark share the same `image`.

**Asset dimensions — flagged, not fixed, out of scope for this task.**
Measured with `identify`, not assumed:

```
$ identify app/assets/splash.png
app/assets/splash.png PNG 248x512 248x512+0+0 16-bit sRGB 471801B
$ identify app/assets/icon.png
app/assets/icon.png PNG 1024x1024 1024x1024+0+0 8-bit sRGB 1.00586MiB
```

An earlier report's claim of `2592×5346` for `splash.png` is false — the real
file is 248×512, single-density. `expo-splash-screen`'s asset pipeline in the
chosen config resizes/pads to `imageWidth` (default 100pt) × 2/3 for @2x/@3x,
i.e. up to 300×300px generated from a 248px-wide source — visibly soft on a
3x device. Regenerating from `frontend/public/manifest-icon-512.jpg` (512×512
square, confirmed via `identify`) would require a genuine crop/composition
decision for a portrait splash that this task was not scoped to make ("Keep
the existing assets — they are fine. Do not change ... "), so it was left
alone per the dispatch's own asset-preservation instruction. Flagging for a
follow-up wave with real numbers rather than repeating the false ones.

## Defect 2 — gate hole

`scripts/v2-check.sh`'s Go/`client/`/`app/` steps are all pure
TypeScript-typecheck / Go-test / Jest — none of them ever asks Expo to
resolve `app.json`. Measured before adding anything: with the defect present,
`bun run typecheck && bun run test:all` stayed green while
`bunx expo export --platform ios` failed with the `PluginError` above.

Considered `npx expo config --type prebuild` (resolves every config plugin,
same as `expo export`, without bundling the JS graph) versus a real
`expo export`/`bundle` step. Measured, not assumed:

| step | time | catches the defect? |
|---|---|---|
| `expo config --type prebuild` | ~0.65s | yes (below) |
| `bunx expo export --platform ios` | ~14s (bundled 1778 modules) | yes |

Proved `expo config --type prebuild` actually has teeth before wiring it in:
moved `node_modules/expo-splash-screen` aside, ran the command — it failed
with the identical `PluginError: Failed to resolve plugin for module
"expo-splash-screen"` and exit 1; restored the directory, ran again, exit 0.
Chose the cheaper check since it demonstrably catches this exact defect class
(unresolvable plugin modules) at ~20x the speed of a full export.

Added `"config-check": "expo config --type prebuild"` to `app/package.json`
scripts (matching the existing `typecheck`/`test`/`test:all`/`bundle` script
convention) and wired it into `scripts/v2-check.sh` between `typecheck` and
`test:all`, inside the existing `app/node_modules` guard, with
`EXPO_PUBLIC_LEDGER_SERVER=https://example.test` (an obviously-fake HTTPS
origin — `src/app/config.ts` throws without one; no real host belongs in the
gate). Comment follows the voice and node_modules-guard pattern established
by `2483918` and `ebd1963`.

## Teeth test (defect 1 re-created against the gate step, not the whole gate)

```
$ EXPO_PUBLIC_LEDGER_SERVER=https://example.test npx expo config --type prebuild   # fix in place
EXIT=0
$ mv node_modules/expo-splash-screen /tmp/hidden && EXPO_PUBLIC_LEDGER_SERVER=... npx expo config --type prebuild
PluginError: Failed to resolve plugin for module "expo-splash-screen" relative to ".../app". Do you have node modules installed?
EXIT=1
$ mv /tmp/hidden node_modules/expo-splash-screen   # restored
```

`git status` after restoring showed no diff versus the fixed tree (only the
intended `app/app.json`, `app/package.json`, `app/bun.lock`,
`scripts/v2-check.sh` changes remained dirty).

## Full gate runs

Both runs used `go clean -testcache && bash scripts/v2-check.sh > LOG 2>&1;
echo "GATE_EXIT=$?"` — the script's own exit code, captured to a variable
before any `tail`, not a pipeline's.

- First full run (before the dark-mode fix): `GATE_EXIT=0`. Go tests passed,
  client `2351 pass / 0 fail` (matches the `8aab3fe` baseline), app
  `bun run test:all` `18 suites / 92 tests passed`.
- Second full run (after adding `dark.backgroundColor`, since it touched
  `app.json` again after the first green run): see reply for the observed
  exit code — captured the same way.

`EXPO_PUBLIC_LEDGER_SERVER=https://example.test bunx expo export --platform
ios --output-dir /tmp/expocheck` after the fix: exit 0 (1778 modules
bundled, 5.64MB `.hbc`). Output directory deleted immediately after
inspection each time; `df -h /` checked before and after every export/prebuild
(stayed at 13–14G free throughout, never approached full).

## Files touched

- `app/app.json` — removed legacy top-level `splash`; `expo-splash-screen`
  plugin entry now carries explicit `image`/`resizeMode`/`backgroundColor`/
  `dark.backgroundColor`.
- `app/package.json` — added `expo-splash-screen: 31.0.13` dependency, added
  `config-check` script.
- `app/bun.lock` — resynced by `bun install` after tightening the pin.
- `scripts/v2-check.sh` — added the `config-check` gate step with rationale
  comment.
