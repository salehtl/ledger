# Task 3 — grow `app/` into the product shell

Commit **`057c144`**, parent `60e6fee`, branch `v2`. 27 files, +4,351.

Two earlier tasks stopped deliberately short of writing into `app/`: Task 4
(`4ddf942`) refused `app/src/platform/*` and Task 5 (`72ce132`) refused
`app/src/db/*`, both on the grounds that a module written blind — no Metro, no
`expo-*` in tree — reproduces this project's *written, tested green, never
wired* defect. **Both seams are now wired, and both are proven to load.** What
remains unproven is stated below, per seam, rather than implied.

---

## What was built

```
app/
  .gitignore          node_modules/ ios/ android/ .expo/   — written FIRST, before any git add
  package.json        every version exact; zero ^ or ~ (verified by grep)
  bun.lock
  app.json  eas.json  metro.config.js  babel.config.js  tsconfig.json
  jest.config.js  jest.setup.js
  index.ts            installs the platform seam, then registers Root
  src/
    platform/         bytes.ts gzip.ts hash.ts signing.ts platform.ts index.ts
                      + platform.test.ts (53 vectors + a drift guard)
    db/driver.ts      expoDriver — Task 5's one deferred function
    app/              Root.tsx Navigation.tsx Theme.tsx (+ Theme.rn-test.tsx)
    screens/Shell.tsx a temporary screen that reports whether both seams are live
    components/README.md
    host-globals.test.ts  metro-config.test.ts
```

---

## Verification

Measured in the shared worktree for the app suites (nothing outside `app/` was
touched, so there is nothing to isolate from) and in a `git archive 057c144`
export with `client/node_modules` copied in for the gate.

```
$ cd app && bun run typecheck        TYPECHECK_EXIT=0
$ cd app && bun test src             BUNTEST_EXIT=0
    66 pass / 0 fail / 110 expect() calls / Ran 66 tests across 3 files [2.86s]
$ cd app && bunx jest                JEST_EXIT=0
    Test Suites: 1 passed / Tests: 4 passed
$ cd app && bunx expo export --platform ios --clear   EXPORT_EXIT=0
    Bundled 22362ms index.ts (1165 modules)
    _expo/static/js/ios/index-*.hbc (3.58 MB)

# at commit 057c144, in $S/gate-057c144 (git archive + client/node_modules)
$ go clean -testcache && bash scripts/v2-check.sh     V2CHECK_EXIT=0
    2052 pass / 0 fail / Ran 2052 tests across 19 files
    v2-check: OK (go + client + conformance)
```

The gate's client figure is **2,052 pass / 0 fail across 19 files**, identical
to Task 5's recorded number at `72ce132`. That is the check that matters here:
this task changed no file under `client/`, and the gate confirms it.

---

## Resolved version pins

Every one is exact — `grep -E '[~^]' app/package.json` returns nothing.
`bunx expo install` was used to discover each SDK-54-correct version, then
`package.json` was rewritten to pin it, as the plan requires.

| package | pinned | how it was chosen |
|---|---|---|
| `expo` | **54.0.36** | Task 1 / Phase 0 pin. Expo Go on the App Store is SDK 54. |
| `react-native` | **0.81.5** | Task 1 pin; `bundledNativeModules` agrees. |
| `react` | **19.1.0** | Task 1 pin. |
| `expo-sqlite` | **16.0.10** | Task 1 pin (`~16.0.10` in `bundledNativeModules`). |
| `@noble/curves` | **2.2.0** | matches `spike/phase0/replay-app`'s resolved version. |
| `@noble/hashes` | **2.2.0** | same. |
| `fflate` | **0.8.3** | same. |
| `ulid` | **2.3.0** | matches `client/package.json`. |
| `typescript` | **5.9.2** | matches `client/package.json`. |
| `expo-secure-store` | **15.0.8** | `expo install` |
| `expo-auth-session` | **7.0.11** | `expo install` |
| `expo-crypto` | **15.0.9** | `expo install` |
| `expo-apple-authentication` | **8.0.8** | `expo install` |
| `expo-notifications` | **0.32.17** | `expo install` |
| `expo-file-system` | **19.0.23** | `expo install` |
| `expo-sharing` | **14.0.8** | `expo install` |
| `expo-document-picker` | **14.0.8** | `expo install` |
| `react-native-reanimated` | **4.1.7** | `expo install` resolved `~4.1.1` → 4.1.7 |
| `react-native-safe-area-context` | **5.6.2** | `expo install` resolved `~5.6.0` → 5.6.2 |
| `react-native-screens` | **4.16.0** | `expo install` |
| `@react-navigation/native` | **7.3.14** | `expo install` |
| `@react-navigation/native-stack` | **7.18.6** | `expo install` |
| `react-native-worklets` | **0.5.1** | see below |
| `expo-dev-client` | **6.0.21** | `expo install`; the `development` EAS profile needs it |
| dev: `jest-expo` 54.0.17, `jest` 29.7.0, `@testing-library/react-native` 14.0.1, `@types/bun` 1.2.19, `@types/jest` 29.5.14, `@types/react` 19.1.10 | | |

**`react-native-worklets` is the pin that would have bitten.** Reanimated 4
declares it a *peer*, so `bun install` silently pulled **0.8.3** — a version
nothing in `package.json` named. Expo's `bundledNativeModules.json` pins it
without a range at all (`"react-native-worklets": "0.5.1"`, no tilde), which is
how Expo says "the native half of this is compiled into Expo Go, the JS half
must match". `bunx expo install react-native-worklets` resolved 0.5.1 and it is
pinned there. Compatibility was checked rather than assumed:
`react-native-reanimated/compatibility.json` lists `4.1.x → worklets
0.5.x–0.8.x` and RN `0.78–0.82`, and running the package's own validator
(`require('react-native-reanimated/scripts/validate-worklets-version')('4.1.7')`)
returns `{"ok":true}`. Reanimated's runtime check compares **major.minor only**
(`checkCppVersion.js`), so 4.1.7 JS against Expo Go's 4.1.x native is a match.

**`react-test-renderer` was installed and then removed.** `expo install --dev`
pulled 19.2.8 against `react@19.1.0`, which warned. `@testing-library/react-native`
14 uses React Native's own `test-renderer`, not `react-test-renderer` — removing
it left all four component tests green, so it was a dependency nothing used.

---

## `app/.gitignore` preceded the first `git add app`

Yes, and it is the first thing in the transcript after `mkdir app`. The file was
written before `bun install` ran, so `node_modules/` was never a candidate. The
commit is 27 files; `git show --stat 057c144` contains no `node_modules`, no
`.expo`, no `ios/`, no `android/` and nothing that could carry a real merchant
or amount.

---

## Task 4's deferred seam: wired, and proven under Bun

`app/src/platform/{bytes,gzip,hash,signing,platform,index}.ts` now exist and
`app/index.ts` calls them before anything else. Four of the six are pure
JavaScript, which is the design decision that makes this provable here rather
than only on a device: **`createPlatform(random)` takes its RNG as a
parameter**, so `expo-crypto` — the only native dependency — lives in `index.ts`
alone and everything else runs under `bun test` exactly as it runs under Hermes.

`app/src/platform/platform.test.ts` runs the seam's contract against that
implementation: **53 tests, all of `client/src/platform.test.ts`'s vectors plus
four this task added.** Two vectors were adapted rather than copied, and both
adaptations are the interesting part:

- **"compresses at level 9"** cannot assert byte-equality with `zlib` here —
  `fflate` is a different DEFLATE implementation. The first draft compared
  sizes; on the contract's own highly-compressible input, `fflate` at level 9
  and at its default both produced exactly **50 bytes**, so the assertion
  measured nothing. It now asserts **XFL, gzip header byte 8**, which is 2 for
  maximum compression and 0 otherwise — `fflate`'s `gzh` writes
  `o.level == 9 ? 2 : 0` and zlib was measured writing the same (2 at level 9,
  0 at level 6). That is an independent observation of the level, plus both
  interop directions.
- **"truncated gzip throws rather than returning a short read"** now asserts the
  message. See the defect below.

### The defect this found, which is defect shape #1 exactly

The first `gunzip` decided "did the stream end?" from `fflate`'s `final`
callback flag. **`Gunzip.push(chunk, final)` hands that same `final` argument
straight back to the callback** — so the check was true by construction, and a
gzip with its 8-byte footer removed returned **1,100 bytes and no error**. A
short read presented as success, on attacker-influenced input, which is the one
failure `wire/blob.ts`'s callers cannot detect for themselves. The contract test
caught it on the first run.

The fix validates the gzip footer — CRC-32 and ISIZE — because `fflate` checks
neither (`Gunzip` ignores the footer entirely; `gunzipSync` reads ISIZE only to
size an allocation, which is itself a 4-attacker-chosen-byte allocation
primitive). Consequence recorded in the source: **multi-member gzip is refused**,
since its trailing footer describes only the last member.

### The cap, which is the load-bearing part

`fflate` has no `maxOutputLength`. Three approaches were tried and two rejected
in the source comments: `gunzipSync(data)` preallocates from ISIZE;
`gunzipSync(data, {out})` never grows the buffer but also never stops — writes
past the end of a typed array are silently dropped and it returns a truncated
result with no error. What shipped is the streaming `Gunzip` fed in 4 KiB
slices with a throw out of `ondata` the moment the running total passes the cap,
which aborts inflation rather than measuring afterwards. The contract's
self-calibrating timing test (capped path vs. the same implementation under a
cap that never trips) holds it in place, and mutation M06 — feeding the whole
input in one push — is caught by it.

### What is still owed for this seam

- **Nothing here has run on Hermes.** Bun is not Hermes: different regex engine,
  different `Date` parser, different BigInt. Task 4 Step 4's on-device run is
  undischarged, and so is Step 5's re-derivation of `MAX_BOUND_PRODUCT` /
  `MAX_UNBOUNDED_PER_BRANCH` and the U+212A case-folding divergence.
- **`expo-crypto` was never called.** `index.ts` bundles (it is in the 1,165-module
  graph) but its `randomUUID`/`getRandomBytes` are native.
- **A `ulid` hazard was found and closed app-side.** `client/src/net/client.ts:1090`
  mints every `op_id` with `ulid()`, whose `detectPrng` falls back to
  `Math.random` — with a `console.error` and nothing else — when it finds
  neither `globalThis.crypto.getRandomValues` nor Node's `crypto`. React Native
  has no `crypto` global and **Expo's winter runtime does not add one** (checked:
  `expo/build/winter` ships `fetch`, `FormData`, `TextDecoder`, `url` — no
  WebCrypto). `app/src/platform/index.ts` installs `getRandomValues` backed by
  `expo-crypto` before `setPlatform`, so `detectPrng` takes its first branch.
  The plan's own remedy — passing an explicit PRNG — needs an edit to
  `net/client.ts`, which is not one of the four permitted `client/src` edits;
  this is noted in the source so the two mechanisms do not both end up present.

---

## Task 5's deferred seam: written and type-checked, NOT run

`app/src/db/driver.ts` implements `expoDriver(name)`, the "exactly one function"
`app/` contributes to the store. It holds a module-level single handle
(`openLedgerDatabase`), caches and finalizes prepared statements, resets the
cursor after every `executeSync`, and sets the same two pragmas `bunDriver` sets.

**It has not been executed, and I am not claiming otherwise.** `expo-sqlite`'s
sync API is a native module; there is no simulator and no Mac on this box. What
it is checked against is `expo-sqlite@16.0.10`'s own type declarations, which
`bun run typecheck` enforces, and against the API table Task 5 left in
`client/src/store/driver.ts`. What will discharge it is Task 5 Step 4's contract
suite — `client/src/store/store.test.ts`, 63 tests already green against
`bunDriver` and `memStore` — re-run on-device against this driver. The file says
so in its header, so the next reader does not mistake "it type-checks" for "it
works".

I deliberately did **not** write a mock-of-`expo-sqlite`-backed-by-`bun:sqlite`
test for it. A mock I write, tested against an adapter I write, from a `.d.ts` I
read, is three expressions of one belief — the tautology shape the standing
rules name first.

---

## Step by step against the plan

| Step | State |
|---|---|
| 1 — Metro resolves `client/src` | **Done, and proven twice.** `expo export --platform ios` builds a 1,165-module graph; the emitted Hermes bytecode contains `ReplayOrderError` (i.e. `client/src/replay/replay.ts` is really in it) and contains no `client/src/cli` string. `src/metro-config.test.ts` exercises the resolver rules directly. The plan asked for a *throwaway* import of `fold`; it was kept instead, as `src/screens/Shell.tsx`, because a throwaway that is deleted leaves nothing reaching `client/src` until Task 8 and the next person to break resolution finds out weeks later in an unrelated task. |
| 2 — Reanimated + Hermes | **Half.** `react-native-worklets/plugin` is last in the plugin list (Reanimated 4 moved the plugin there; `react-native-reanimated/plugin` is now a one-line re-export of it, so the real name is used). A `FadeIn` entrance is in `Shell.tsx` and it renders under `jest-expo`. **"Confirm the app runs on the dev client and a trivial `withTiming` animates" is NOT done** — no dev client exists, and building one needs the Apple Developer account. |
| 3 — EAS profiles | **Written, never run.** `eas.json` has `development` (dev client, internal), `preview` (release, internal — Task 28's measurement target), `production`. **No build times and no quota consumption to record**: EAS Build needs the paid account, and `app.json` has no `extra.eas.projectId` because `eas init` requires an authenticated account. The P1 device UDIDs cannot be added because no device has been named. |
| 4 — Test runner | **Done, as two runners.** `bun test src` for pure logic (66 tests). `bunx jest` (jest-expo preset) for components. **The split is forced, not stylistic**: `react-native`'s entry point is Flow-typed (`import typeof * as … from './index.js.flow'`) and Bun's transpiler cannot parse it — measured, the probe fails at `Unexpected typeof`. jest takes `*.rn-test.tsx`, bun takes `*.test.ts`, so a file needing `react-native` under the wrong name fails loudly rather than being skipped by both. `app/test/device/` is matched by neither runner. |
| 5 — `app/src/components/README.md` | **Done.** Conventions first (tokens-not-literals, 44 pt, 16 pt, string-draft numeric input, safe areas, motion + the 300 ms ceiling, no full-table reads), component table empty because there are no shared components yet. |
| 6 — Portal work | **Blocked, and recorded.** `app.json` has `ios.bundleIdentifier` (`com.salehtl.ledger`), `scheme` (`ledger`), `newArchEnabled`, and the four config plugins. It has **no `CFBundleURLTypes` reversed-client-ID entry**, deliberately: a plausible-looking placeholder builds, installs and fails only when a user taps "Sign in with Google". The Apple App ID, the Sign-in-with-Apple capability, the Google iOS OAuth client and the deployment-target floor all need you. Written up as a new §1b in `docs/superpowers/NEEDS-SALEH.md` — **see the caveat below, that edit is NOT in this commit**. |
| 7 — Re-measure `T_paint` | **Not possible.** Task 1 never ran, so there is no baseline to compare against, and there is no device to measure on. Recorded as owed. For whoever picks it up: the release iOS bundle is **3.58 MB of Hermes bytecode**, 1,165 modules, which is the input that figure will move with. |
| 8 — typecheck + test green, commit explicit paths | **Done.** Exit codes above; `git show --stat` verified before reporting. |

---

## Mutation score: 21 / 21, with 2 controls that survived

Run on a throwaway copy of `app/` with `node_modules` and `client/` symlinked
in; each mutation applied alone, `bun test src` run, file restored. Driver and
raw results: `$S/mutate-task3.py`, `$S/mut/results.json`.

| # | Mutation | Result |
|---|---|---|
| M01 | gzip level 9 dropped → fflate default | CAUGHT (1) |
| M02 | cap checked *after* inflation instead of during | CAUGHT (1) |
| M03 | cap off by one (`>` → `>=`) | CAUGHT (2) |
| M04 | gzip ISIZE check removed | CAUGHT (2) |
| M05 | gzip CRC check removed | CAUGHT (1) |
| M06 | whole input in one push — no early abort | CAUGHT (1) |
| M07 | `toHex` via `toString(16)`, drops the leading zero | CAUGHT (4) |
| M08 | `toHex` upper case | CAUGHT (6) |
| M09 | `fromHex` lenient | CAUGHT (3) |
| M10 | base64url alphabet instead of standard | CAUGHT (3) |
| M11 | `fromBase64` lenient | CAUGHT (2) |
| M12 | decoder keeps the leading BOM | CAUGHT (1) |
| M13 | decoder strips a BOM anywhere, not only leading | CAUGHT (1) |
| M14 | lone surrogate encoded as CESU-8, not U+FFFD | CAUGHT (1) |
| M15 | key seeded from noble's RNG, not the injected one | CAUGHT (1) |
| M16 | `ed25519.sign` arguments swapped | CAUGHT (3) |
| M17 | `bun:sqlite` no longer stubbed by Metro | CAUGHT (1) |
| M18 | CLI ban becomes a substring match | CAUGHT (2) |
| M19 | hierarchical lookup back on — two copies of `ulid` | CAUGHT (1) |
| M20 | a host global lands in shipped app code | CAUGHT (1) |
| M21 | the mirrored contract drifts from the client's | CAUGHT (1) |
| C22 | *control:* two independent declarations reordered | survived, as required |
| C23 | *control:* a comment reworded | survived, as required |

**The first run scored 19/21, and both survivors were fixed rather than
reported — one by changing a test, one by deleting code.**

- **M04 (ISIZE check removed) survived** because the truncation test asserted
  only `toThrow()`, and with the length check gone the CRC check caught the same
  corruption. Two checks that catch the same thing are indistinguishable to a
  bare `toThrow()`. Closed by asserting the *message* — which pins a property
  that is real rather than cosmetic: the O(1) length comparison must run before
  the O(*n*) CRC, because otherwise a 1 MiB attacker-supplied blob gets hashed
  on the phone to reach a conclusion four bytes already gave. The tests were also
  restructured so each corruption is visible to exactly one check: a tampered
  ISIZE (CRC still valid) and a tampered CRC field (length still valid).
- **M16 (seed length unchecked) survived**, and the fault was the *code*.
  `requireSeed`'s `if (priv.length !== 32) throw` was redundant: `@noble/curves`
  validates identically on every path, with a message that is at least as good —
  measured at 0, 31 and 33 bytes on both `getPublicKey` and `sign`:
  `"secretKey" expected Uint8Array of length 32, got length=31`. A guard no test
  can distinguish from its absence is not defence in depth, it is a second place
  for the rule to live and later disagree. **Deleted**, with the measurement
  recorded in `signing.ts` so it is not re-added. M16 was then replaced with a
  mutation that is not redundant — swapping `ed25519.sign`'s arguments — which
  the RFC 8032 vectors catch.

Three of the mutations are worth calling out because they test *guards*, not
product code, and a guard nobody mutates is a guard nobody has checked:
**M18** (the CLI ban degraded to a substring match — caught, because
`client/src/invariants/check.ts` contains "cli" inside "client"), **M20** (a
`Buffer.from` planted in `src/db/driver.ts` — caught by the host-globals
checker), and **M21** (a renamed vector title — caught by the contract-drift
guard, which reads `client/src/platform.test.ts` off disk).

---

## Two design choices that deserve challenge

**1. `@types/bun` is in `app/tsconfig.json`'s scope, and the plan warns against
exactly that.** The plan says to ensure `client/tsconfig.json`'s `"types":
["bun"]` does not leak into the RN type graph. It does not leak — but `app/`
needs Bun's types anyway, because `client/src/platform.ts` genuinely contains
`new Bun.CryptoHasher(...)` (it is the seam; it necessarily holds both sides),
and without those types `tsc` cannot check *any* file that imports the seam,
which is every file that touches the library. The alternatives were a
`declare const Bun: any` shim, which is a silent hole, or leaving `app/`
un-type-checked.

The cost is real and is mitigated by measurement rather than by types:
`src/host-globals.test.ts` reads every non-test file under `src/` and fails on
`Bun.`, `Buffer.`, `process.env|argv|exit|platform`, a `node:` or `bun:` import,
or `__dirname` — with `src/platform/` exempt, and with two self-tests so the
checker cannot pass by finding no files or by having patterns that match
nothing. M20 confirms it fires.

**2. `expo export` logs `Using src/app as the root directory for Expo Router`.**
`expo-router` is not a dependency and the entry point is `index.ts`
(`package.json` `main`), so nothing routes — but the plan's own file layout puts
the shell in `app/src/app/`, which is the directory name Expo Router claims by
convention. It is harmless today and would stop being harmless the moment anyone
adds `expo-router`. Flagged rather than renamed, because renaming diverges from
the plan's published layout.

---

## Concerns

1. **`docs/superpowers/NEEDS-SALEH.md` is NOT in this commit, and my edit to it
   is sitting uncommitted in the worktree.** The file has never been committed —
   `git ls-files` does not list it and `git log` has nothing for it — so adding
   it would mean committing ~240 lines another session wrote, which is precisely
   the sweeping the standing rules forbid. My addition is a new **§1b** (the
   three portal items above, plus a pointer to the deployment-target floor).
   Whoever commits the register should pick it up; if the worktree is reset it
   is reproduced verbatim in this report's Step 6 row.

2. **Task 1's gate is still unsatisfied.**
   `docs/superpowers/specs/v2-phase2-crypto-gate.md` does not exist, so by
   Global Constraints no task numbered ≥ 3 has been unblocked. This was executed
   on explicit instruction, as Tasks 4, 5, 6 and 7 were. Task 3's exposure is
   *higher* than theirs, though, and that should be said plainly: a CONDITIONAL
   or FAIL verdict from Task 1 changes what the shell has to be, and Task 1 also
   owns `app/modules/ledger-crypto/` and `app/src/bench/`, which are directories
   inside the tree this task just created. Neither exists here; nothing in this
   commit seals anything; Phase 2 remains plaintext.

3. **The whole device half of this task is blocked on procurement, not on
   effort.** No Apple Developer account, no Mac, no named floor device. That
   blocks: Step 2's dev-client confirmation, Step 3's build times and quota,
   Step 6's portal items, Step 7's `T_paint`, Task 4 Steps 4–5, and Task 5 Step
   4's on-device store run. Everything that can run on this box does, and the
   gate is green.

4. **`app/test/device/` does not exist yet.** The plan's structure names it and
   `jest.config.js` already excludes it, but Task 1 is what populates it (the
   bench screen drives those suites). Deliberately not stubbed — an empty
   directory of device tests nobody runs is the same shape as a module nobody
   wires.

5. **The `expoDriver` "one connection" rule is enforced in `app/src/db/driver.ts`,
   not in `client/`.** `openStore` in `client/src/store/open.ts` opens a new
   `bunDriver` per call and never closes it (Task 5's Concern 3). The device
   path cannot do that — `openLedgerDatabase` throws on a second name and
   returns the cached handle otherwise — but Task 8 owns making the *callers*
   honour it, and nothing here stops a caller from calling `expoDriver` twice
   with the same name and getting two `SqlDriver` wrappers over one connection.
   That is safe for the connection and wasteful for the statement cache; Task 8
   should own a single driver instance.
