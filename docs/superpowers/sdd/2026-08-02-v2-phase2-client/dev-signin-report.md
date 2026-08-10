# Development-only sign-in for the Expo app

**Branch** `v2-wip-2026-08-05` · **base** `ed183db` · **gate** `bash scripts/v2-check.sh` → **exit 0**

## What was missing

`ledgerd serve --dev-auth` has accepted `dev:<subject>` as an identity since Task
14: `config.EnableTestOnly` sets `cfg.DevAuth` (refusing the flag off a loopback
listener), `api.NewServer` then *replaces* both verifiers with
`auth.NewDevVerifier`, and `devVerifier.Verify` cuts the `"dev:"` prefix and
returns `Identity{IdP, Subject}`. Every one of those has a Go test.

Nothing under `app/src` referenced `dev:` or anything like it. The capability
was reachable only from `internal/v2/api/sync_test.go` and the headless
`client/test/e2e` round trip — i.e. the server half was written, tested green and
never wired on the client, which is AGENT-RULES' defect shape #2. That matters
now because the operator's Apple ID is behind a hardware security key an iOS
simulator cannot present, so Sign in with Apple is unusable in the only
environment where this app can be seen render at all.

## What was built

| File | Role |
|---|---|
| `app/src/auth/devAuth.ts` | **new.** Pure: the `dev:` prefix, subject normalisation, the subject rules mirrored from the server, `devIdToken()`. Holds **no** gate — see below. |
| `app/src/auth/devAuth.test.ts` | **new.** 10 bun tests, two of which read `internal/v2/auth/dev.go` off disk. |
| `app/src/screens/onboarding/DevSignInPanel.tsx` | **new.** The affordance: a dashed warning-toned block, a prefilled subject field, one button. |
| `app/src/screens/onboarding/DevSignIn.rn-test.tsx` | **new.** 9 jest tests: presence, absence, floors, the exchange, the invite gate, the navigator. |
| `app/src/screens/onboarding/SignInScreen.tsx` | **changed.** `devSignInPanel()` (the gate), `startDev` (two dispatches), one JSX block. Nothing existing was edited. |
| `app/src/components/README.md` | **changed.** Catalog row, per the same-commit convention. |

### The subject is typed, with `simulator` prefilled

A single hard-coded subject is a single account, and AGENT-RULES' own lesson is
that *a fixture with one of something cannot distinguish correct scoping from no
scoping*. The invite gate, second-account behaviour and every per-account
partition in this app are only exercisable if a simulator can be two different
people. `DEV_SUBJECT_DEFAULT = "simulator"` keeps the common case at one tap.

The client re-states the server's two subject rules — non-empty, no `"|"` — and
refuses locally, because a `401` from the dev verifier renders through the
existing taxonomy as *"That sign-in expired"*, which would send a developer
hunting for an expiry that never happened. A 64-character cap is a UI bound the
server does not have.

### It uses the ordinary door

`startDev` dispatches `press` then `authenticated` — the same two transitions a
real provider round trip produces. Everything downstream is therefore literally
the same code: the `exchanging` effect, `exchangeOnce`, `Client.login`, the
`403 not_invited` routing into `NotInvitedView`, the whole failure taxonomy.
The panel has no network call of its own. `IDP_APPLE` is sent because
`--dev-auth` installs the dev verifier for *both* providers, so the choice is
free, and `apple` is the provider this build actually ships.

**The invite gate still applies.** A dev sign-in is a different *identity*, not
a way past the closed beta; `exchangeOnce` still sends no `invite_code` on the
first attempt, and account creation still requires one. Asserted end to end in
*"still has to produce an invite code to create an account"*.

**The Apple path is untouched.** `git diff HEAD -- app/src/screens/onboarding/SignInScreen.tsx`
adds a doc paragraph, one import symbol (`IDP_APPLE`), one type-only import, the
`devSignInPanel()` function, the `startDev` callback, one `const`, and one JSX
block. `start`, `runIdpFlow`, `ProviderButton`, the availability effect, the
exchange effect and the reducer are byte-identical, and no line in any of them
branches on the dev path. `SignInScreen.rn-test.tsx` (11 tests, unchanged) still
passes.

## The gate, and why it cannot be flipped at build time

```ts
function devSignInPanel(): ComponentType<DevSignInPanelProps> | null {
  return __DEV__ ? (require("./DevSignInPanel.tsx") as typeof import("./DevSignInPanel.tsx")).DevSignInPanel : null;
}
```

One `__DEV__`, one call site, read during render.

- **`__DEV__` and nothing else.** It is set by the bundler from its own mode:
  `expo start` makes it true; `expo export` and every release build make it
  false. No environment variable, `app.json` key or CLI flag makes a production
  bundle report `true`.
- **No `EXPO_PUBLIC_*` flag, not even in addition.** An `EXPO_PUBLIC_*` value is
  inlined from whatever environment ran the build, so it is one `export` away
  from being on in a shipped binary. Adding one here could only ever provide a
  way to turn the path *off* in development, which is not a safety property
  anyone needs, while adding a second thing to get wrong.
- **`require` inside the ternary, not a static import plus `{__DEV__ && …}`.**
  Both forms *hide* the control; only this one *removes* it. Metro replaces the
  `__DEV__` identifier with `false` and constant-folds, so in production the body
  is `return null`, the `require` never survives to dependency collection, and
  neither `DevSignInPanel.tsx` nor `auth/devAuth.ts` enters the graph. A static
  import would fold the JSX away and ship both modules — a bypass that ships and
  is merely not rendered. This is written into the catalog row so the next
  refactor does not "simplify" it.
- **Read during render, deliberately.** A module-scope `const` would read
  `__DEV__` once at import and could then only be exercised by re-evaluating the
  module, which under jest means a second copy of React and an invalid-hook-call
  instead of a test. Read here, the gate is observable by a mounted render in
  both directions.

`DEV_SIGN_IN_MARKER = "LEDGER_DEV_SIGN_IN"` is rendered on the panel, so "can I
read this string in the running app" and "is this string in the bundle" are the
same question with the same answer.

## Proof of absence from a production bundle

```
$ df -h /            # before:  75G  60G  13G  83%
$ cd app && NODE_ENV=production EXPO_PUBLIC_LEDGER_SERVER=https://example.test \
    bunx expo export --platform ios --output-dir /tmp/prodbundle
… iOS Bundled 6569ms index.ts (1780 modules)
› ios bundles (1): _expo/static/js/ios/index-4370234c728ef1e5a41c663297de258d.hbc (5.65 MB)
Exported: /tmp/prodbundle

$ cd /tmp/prodbundle
$ grep -ra "LEDGER_DEV_SIGN_IN" .   ; echo rc=$?      → rc=1   (no output)
$ grep -ra "dev-sign-in" .          ; echo rc=$?      → rc=1   (no output)
$ grep -ra "DevSignInPanel" .       ; echo rc=$?      → rc=1   (no output)
$ grep -ra "Developer sign-in" .    ; echo rc=$?      → rc=1   (no output)
$ grep -ra "dev-auth" .             ; echo rc=$?      → rc=1   (no output)
```

**Positive control** — the emitted artefact is Hermes bytecode, so "grep found
nothing" is worthless until grep is shown to find *something* in it:

```
$ grep -rac "Sign in with Apple" .            → …/index-4370234c….hbc:2
$ grep -rac "ledger is invite-only" .         → …/index-4370234c….hbc:1
$ grep -rac "Paste the code you were sent" .  → …/index-4370234c….hbc:1
```

**Negative control** — and "the strings are absent" is worthless until the gate
is shown to be *what* removes them. With `__DEV__ ?` mutated to `true ?` and
nothing else changed, re-exported under the identical command:

```
$ grep -rac "LEDGER_DEV_SIGN_IN" _expo/static/js/ios/  → …/index-5de1a004….hbc:1
$ grep -rac "dev-sign-in"        _expo/static/js/ios/  → …/index-5de1a004….hbc:2
$ grep -rac "Developer sign-in"  _expo/static/js/ios/  → …/index-5de1a004….hbc:1
```

The gate was restored, both export directories deleted, and disk re-checked:
`75G 60G 13G 83%` — unchanged.

**Normal dev export**, as required:

```
$ cd app && EXPO_PUBLIC_LEDGER_SERVER=https://example.test \
    bunx expo export --platform ios --output-dir /tmp/devbundle2 > /tmp/devexport.log 2>&1; echo $?
0
```
(deleted afterwards)

## Mutation battery

Six deliberate defects, each applied alone and reverted. All six were caught.

| # | Mutation | Killed by |
|---|---|---|
| 1 | `return __DEV__ ? …` → `return true ? …` | jest 1/8 fail: *is absent … when `__DEV__` is false* |
| 2 | `__DEV__` → `typeof __DEV__ !== "undefined"` (a plausible "defensive" version, always true in RN) | jest 1/8 fail: same test |
| 3 | `devIdToken` returns the bare subject (prefix dropped) | jest 3/8 fail |
| 4 | `devSubjectProblem` stops rejecting `"\|"` | jest 1/8 fail + bun 2/10 fail (including the test that reads `dev.go`) |
| 5 | `startDev` dispatches `authenticated` without `press` | jest 3/8 fail |
| 6 | panel button `minHeight: TOUCH_TARGET_MIN` → `30` | jest 1/8 fail: *clears the mobile floors* |

Mutations 1 and 2 are the guard itself, as asked. Mutation 1 was additionally
run through a full production export (the negative control above), so the
`__DEV__` gate is measured at both levels — the rendered tree and the emitted
bytecode.

## The non-test caller

`app/src/screens/onboarding/SignInScreen.tsx` renders it; `app/src/app/Navigation.tsx`
renders `SignInScreen` as the `SignIn` route, which is the initial route when
`bootstrap.step === "signed_out"`. That is asserted rather than described: the
last test in `DevSignIn.rn-test.tsx` mounts the real `Navigation` inside a real
`RuntimeProvider` with the real `deviceSignInDeps` (only Apple's native module
is stubbed, exactly as `RuntimeDestructive.rn-test.tsx` does), waits for
`sign-in-apple`, and then finds `dev-sign-in` on the glass and enabled. Every
other test in the file renders `SignInScreen` directly, which proves the control
works and proves nothing about whether the app puts it anywhere.

## Server side

Untouched. No new bypass, no change to what `--dev-auth` does, no new route, no
new flag. `git show --stat` contains no Go file.

## Operator instructions

```
# on the box, loopback only — EnableTestOnly refuses the flag otherwise
./ledgerd serve --config /path/to/dev.toml --dev-auth     # logs a *** warning at startup
./ledgerd mint-invite --note "simulator"                  # the code the first dev sign-in needs
```

Point the app at it and run it in the simulator:

```
cd app && EXPO_PUBLIC_LEDGER_SERVER=https://<origin> bun run ios
```

**One friction worth naming, not a defect in this change.** `app/src/app/config.ts`
requires an **HTTPS** origin with no path, while `--dev-auth` requires the Go
listener to be loopback. Both hold at once only behind a TLS front — `tailscale
serve` in front of `127.0.0.1:<port>` is the arrangement this box already runs
for v1. Relaxing `serverURL` to permit `http://localhost` would be a change to
the *real* sign-in path, which this task is explicitly not allowed to make, so
it was not made. If plaintext loopback is wanted for the simulator, that is its
own decision with its own gate.

## Gate

```
$ go clean -testcache && bash scripts/v2-check.sh > /tmp/dev-gate.log 2>&1; echo $?
0
```

`v2-check: OK (go + client + app + conformance)`. Deltas against `ed183db`:
client `bun test` 2351 pass (unchanged); app `bun test` 636 → **646** (+10, the
new `devAuth.test.ts`); jest 20 suites / 102 tests → **21 suites / 111 tests**
(+1 suite, +9 tests). Go, `config-check` and the conformance runners unchanged.
