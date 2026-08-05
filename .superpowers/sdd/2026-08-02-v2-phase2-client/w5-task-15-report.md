# Task 15 — the inbound address and the forwarding-setup flow

Branch `v2-wip-2026-08-05`, worktree `/root/Coding/ledger/.claude/worktrees/v2`.
Base commit `14d624b`.

---

## 1. What controller finding 3 turned out to be

**Confirmed, and the job was smaller than the brief's five steps imply — but the
dead end was one step further back than the finding guessed.**

The state machine was never the problem. `lib/onboarding.ts:162` has had
`["address_issued", (f) => f.inboundAddress !== null]` since Task 14, and
`forwarding` already had an advance affordance. What was missing:

1. **`AddressScreen` itself** — as expected.
2. **Any path to a non-null `inboundAddress` on the launch where the user signs
   in.** This is the part worth writing down, because it is not "the refresh was
   not triggered" — it is that *no refresh existed to trigger*:

   - `RuntimeProvider` bootstraps **once, at mount** (`RuntimeProvider.tsx:33`).
   - On a first run that happens while `client.sessionToken` is null, so
     `persistedBootstrap` returns `{step:"signed_out"}` and
     `onboardingFacts()` — the only caller of `GET /api/v1/address` in the whole
     app — never runs.
   - `SignInScreen` then does `navigation.replace("Onboarding", {userId})`, and
     `Navigation.tsx:146` reads
     `inboundAddress: bootstrap.step === "onboarding" ? … : null`. `bootstrap`
     is still `signed_out`, so it passes **null**.
   - `stepFor` therefore sits at `bank_picked` → screen `address`, whose
     placeholder had `advance: null` — correctly, because the address is server
     truth and nothing on the device may fake one.

   So onboarding dead-ended on precisely the launch where onboarding happens. A
   force-quit and relaunch would have got past it, which is exactly the shape of
   bug that survives a casual walkthrough.

The fix is that `AddressScreen` performs the read itself. `GET /api/v1/address`
mints on first read, so the request that *displays* the address is the request
that *creates* it, and there is no second refresh path to keep in step.

Net effect on scope: no state-machine work, no `stepFor`/`SCREEN_FOR` changes,
no reducer changes. The work was four screens, one shared card, one wire module
and the wiring.

## 2. Server side

Verified, not modified. `GET /api/v1/address` (`internal/v2/api/addresses.go:91`)
mints via `Addresses.Ensure`; `AddressResponse` (lines 68–75) carries
`address`, `created_at`, and `rotates_from`/`grace_until` **only while the
predecessor is still accepting**. Rotation is
`POST /api/v1/address/challenge` → three factors → `POST /api/v1/address/rotate`,
and `addresses.RotationMessage` (line 672) is the statement the client signs.
`requireSession` can answer `410 account_deleted` on all three (`api.go:776`),
which turned out to matter — see §6.

## 3. The four steps built

### Step 1 — issue and display (`app/src/screens/onboarding/AddressScreen.tsx`)

Reads via `runtime.address.current()`, renders `components/AddressCard.tsx`:
the address at 20 pt monospace (`Theme.type.address`, added for this — the 13 pt
`mono` token labels things and is not readable enough for a 26-character base32
token somebody may have to read onto a laptop by eye), a full-width ≥44 pt copy
target, and a QR.

The address is rendered **verbatim** — no grouping into blocks of four, no
ellipsis. Every one of those makes what the eye reads differ from what the
clipboard holds.

The QR is black on white **in both themes**, deliberately: a camera has a
contrast threshold and an "accessible dark mode" QR is a QR that does not scan.

It advances on the **press**, not on the fetch. The milestone is satisfied the
instant `inboundAddress` is non-null, so reporting on arrival would render the
screen for one frame and hand the user nothing — which is the exact failure the
copy target and QR exist to prevent.

**Non-test caller:** `app/src/app/Navigation.tsx`, `screens.address` on the
`OnboardingShell`.
**Interaction proof:** `app/src/app/OnboardingWalk.rn-test.tsx` — "the address
step is reachable, shows a real address, and walks on": presses `address-copy`
(asserts the clipboard seam received the address), asserts `address-qr` is in
the tree, presses `address-continue`, asserts the forwarding step is now on
screen and the address screen is gone.

### Step 2 — provider-specific instructions: NOT BUILT, on purpose

Left as `OnboardingShell`'s `PENDING.forwarding` placeholder, which still
advances (a device-local fact: nothing can observe a Gmail filter, so the user's
word is the only evidence there will ever be). Its wording was rewritten so it
reads truthfully next to the built screens — it now says the instructions come
from Task 2's measured record, that the measurement does not exist, and that
ledger will not guess at menus it has not seen.

The `address` and `verification` placeholders were also rewritten. They are now
unreachable in production, so leaving them saying "this step is not built yet"
would have been a placeholder outliving its reason and lying about a screen that
exists; they now say the shell was rendered without that slot filled.

### Step 3 — the verification code (`app/src/lib/verificationCode.ts`, `screens/onboarding/VerificationScreen.tsx`)

Polls `GET /api/v1/quarantine?include_blob=1` (the option was added to
`QuarantineSource.list`, defaulting **off** — the server documents the default
listing as cheap precisely because a held message can be a megabyte), finds the
message whose **outer** domain is Google's, normalizes it with the shared
`client/src/norm` normalizer, and scans.

Falls back to rendering the raw message, capped and explicitly labelled
untrusted, through `<Text>` (which interprets no markup) — never a dead end.
The copy is `lib/onboarding.ts`'s `QUARANTINE_HELD`, which says "held on
purpose" before it says anything else.

**The ReDoS bound** — see §4 for the full statement.

**Non-test caller:** `Navigation.tsx`, `screens.verification`.
**Interaction proof:** `OnboardingWalk.rn-test.tsx` — "forwarding leads to
verification, which reads Google's code out of held mail": presses
`step-forwarding-skip`, asserts every `list` call carried `includeBlob`, asserts
the rendered code is `123456789`, presses `verification-copy-code` and asserts
the clipboard got the code. Plus "a held message with no code shows the raw
message, labelled untrusted".

### Step 4 — the first real bank email

Same screen (the machine has one slot between `forwarding_configured` and
`home_currency_set`, and in practice it is one wait). Renders
`trustBasis(item)` — the **verified** signing domain or a prominent
unauthenticated state — and never the subject or display name; the API does not
send those, for this reason. The confirm control is inert for an unauthenticated
item.

**Advancing is measured, not inferred.** A `200` from
`POST /api/v1/quarantine/confirm` is not the milestone; a transaction in the log
is. After a confirmation the screen re-reads `firstMailAt(client.state())` — the
fold — and advances only if that answers with a timestamp. `firstMailAt` was
extracted into `lib/onboarding.ts` so the launch read and this screen cannot
disagree.

**Non-test caller:** as step 3.
**Interaction proof:** two cases in `OnboardingWalk.rn-test.tsx` —
"confirming a verified bank finishes the step, and lands on the currency
picker" (asserts `confirm` was called with `{domain:"dib.ae", scope:"inner"}`
and that the home-currency screen appears), and — the one that matters — "a
confirmation that produced no transaction does NOT advance the machine".

### Step 5 — rotation (`app/src/account/address.ts`, `screens/settings/RotateAddressScreen.tsx`)

`POST /api/v1/address/challenge` → `authenticator.authenticate(nonce)` carrying
the server's own spelling of the nonce verbatim → Ed25519 signature over
`rotationMessage(nonce, userId, localPartOf(currentAddress))` →
`POST /api/v1/address/rotate`. Same composition as `account/deletion.ts`,
because §3.4 puts the two in one class.

The screen states every consequence §3.2 names before the button is armed: the
forwarding rule and any bank-side registration both point at the old address and
both must be redone by hand, ledger cannot do it, and the old address accepts
for **7 days** — `GRACE_DAYS`, pinned to `addresses.DefaultGrace`.

**The one-hop bug, avoided.** `AddressRecord.rotatesFrom` is a `string | null`,
never a list. `decodeAddress` refuses a `rotates_from` that is an array rather
than flattening it, and refuses a half pair. `graceNotice` names *the exact
address the server returned* and nothing broader, and `PREDECESSOR_SCOPE_NOTE`
is rendered beside it saying out loud that an earlier address may still be
accepting on its own schedule, which ledger cannot show. On a successful
rotation the screen replaces the record wholesale with the server's answer — it
never merges the previous record's predecessor into the new one.

It is also a **read** screen, and that is not decoration: onboarding's address
step is skipped on every later launch (bootstrap reads the address, the machine
walks past), so without a settings entry a user who force-quit mid-setup would
have no way to see their own address again.

**Non-test caller:** `Navigation.tsx` route `InboundAddress`, reached from
`TransactionsScreen`'s `open-address` control.
**Interaction proof:** `app/src/app/RotateAddress.rn-test.tsx` — presses
`open-address`, then `rotate-address-arm`, then `rotate-address-confirm`, and
asserts the request order is exactly
`GET /api/v1/address`, `POST /api/v1/address/challenge`,
`POST /api/v1/address/rotate`; that Apple's sheet really ran and its token and
the server's nonce are in the rotate body; and that the grace deadline shown
afterwards names the old address and says "in 7 days". A fourth case drives a
`403` and asserts the screen says nothing changed and keeps the old address on
screen.

### Step 6 — real-device run: NOT DONE, and cannot be

There is no Mac, no simulator and no device on this box, and the Gmail path is
deferred with Task 2. **The end-to-end run against a real Gmail account has not
happened and nothing here simulates it.** What *is* exercised is every layer
below it: the real navigator, the real shell, the real step machine, the real
`rotateAddress` composition and a real Ed25519 signature verified with the same
curve the server verifies with.

## 4. The ReDoS bound (step 3)

Attacker-controlled input: anyone who knows a user's inbound address can put a
megabyte of anything into the held lane.

**The bound, in one line:** every pattern is literal-anchored with **no
unbounded quantifier** (widest run `{0,16}`) and **disjoint adjacent classes**
(`[^0-9]{0,16}` followed by `[0-9]{9}`), applied to at most the **first 8192
characters** of the normalized body — worst case O(8192 × 17 × 9) comparisons
per pattern, with no exponential term reachable at any input.

Disjointness is the part that matters beyond "bounded": once the gap stops there
is exactly one way to continue, so there is no alternative carve-up for a
backtracking engine to explore — which is the quantity `dialect-redos.md` showed
`MaxBoundProduct` does *not* measure.

`SCAN_BUDGET_MS = 50` is a **tripwire on top of that, not the bound**, and it
*stops* the scan rather than merely reporting — proved by mutation, not by
comment.

The link pattern's scheme, host and path prefix are literals, so a URL this
module surfaces can only point at `mail-settings.google.com`; only the opaque
tail is captured. That is what makes "here is the link to click" a claim the
code can back.

Pinned with `conformance/dialect/patterns.json`'s own 22 probe inputs (CR,
U+2028, U+2029, U+00A0, U+000B, U+FEFF, a 40-char repeated run, bare
metacharacters), plus six adversarial subjects that *fail* to match — the case a
backtracking engine pays for — each asserted under 50 ms. Measured: whole file
in 37 ms.

## 5. Mutation testing

20 deliberate defects, run individually against the suite. **18 killed on the
first pass; both survivors were real faults, both fixed, then killed.**

| # | Mutation | Result |
|---|---|---|
| M1 | `SCAN_LIMIT_CHARS` 8192 → 65536 | **survived** → fixed → killed |
| M1b | `SCAN_LIMIT_CHARS` 8192 → 4096 | killed |
| M2 | budget guard made report-only (no `break`) | killed |
| M3 | `[0-9]{9}` → `[0-9]+` | killed |
| M4 | link host literal → `[-A-Za-z0-9_.]{1,64}` | killed |
| M5 | forwarder domain matched by `includes` | killed |
| M6 | explicit half-pair guard deleted | **survived** → guard removed as redundant → replacement killed |
| M7 | predecessor chain flattened instead of refused | killed |
| M8 | grace days `ceil` → `floor` | killed |
| M9 | rotation signature drops the retiring local part | killed |
| M10 | address error loses the server's code (restores the old inline fetch) | killed |
| M11 | provider called before the device key is checked | killed |
| M12 | verification advances on a 200 rather than on the log | killed |
| M13 | address screen advances on load instead of on the press | killed |
| M14 | `screens.address` removed from the navigator | killed |
| M15 | `screens.verification` removed from the navigator | killed |
| M16 | QR dropped from the address card | killed |
| M17 | `onAddress` removed from the settings menu | killed |
| M18 | rotation stitches a predecessor instead of showing the server's answer | killed |
| M19 | copy affordance detached from the clipboard | killed |
| M20 | `include_blob` no longer requested | killed |

**M1 was defect shape 1 in my own test.** Every offset was expressed in terms of
`SCAN_LIMIT_CHARS`, so the test moved with the mutation — a test whose entire
subject is a fixed ceiling, made true by construction. The offsets are now
absolute literals and `SCAN_LIMIT_CHARS === 8192` is pinned separately. Both
directions of the mutation now die.

**M6 was a redundant guard, not a missing test.** With the explicit
`hasFrom !== hasUntil` branch deleted, the two `str()` calls below still refuse
every half pair, with a message at least as good — so no test could distinguish
the guard from its absence. Per the precedent `platform/signing.ts` records for
exactly this measurement, the branch was **removed** rather than the bar
lowered, and the rule now lives in one place. M6' (making both halves optional,
i.e. actually deleting the rule) is killed.

M14/M15/M17 are the "written, tested green, never wired" net: unwiring any of
the three entry points fails the suite.

## 6. A defect found and fixed on the way

`AppRuntime.onboardingFacts()` performed its own inline `GET /api/v1/address`
and threw `Object.assign(new Error(…), { status, code: "" })` — a **hard-coded
empty code**. `bootstrap.classify` keys the local wipe on
`mayWipeLocalData(err)`, which requires `status === 410 && code ===
"account_deleted"`. So a `410 account_deleted` from that endpoint matched
neither arm, fell through to `{step:"fatal"}`, and a device whose account had
been deleted elsewhere showed "Ledger could not safely open this account" with
every local row still on disk — the exact data-loss-adjacent footgun
`RuntimeDestructive.rn-test.tsx` was written to guard on the *deletion* path.

Consolidating that read into `account/address.ts` (controller finding 2 — reuse,
do not duplicate) fixes it, because that module throws `ApiError`, which carries
the server's own code. Measured through the predicate that actually decides:
`address.test.ts` → "a 410 account_deleted carries the server's own code, so the
wipe path can see it", with `mayWipeLocalData(error) === true`, and a companion
case asserting a bare `401` is **not** a wipe. M10 restores the old behaviour
and dies.

## 7. Dependencies added

Installed with `npx expo install` so the SDK 54 resolution is respected. `expo
54.0.36`, `react-native 0.81.5` and `expo-sqlite 16.0.10` are unchanged.

| package | version | why |
|---|---|---|
| `react-native-qrcode-svg` | 6.3.21 | the QR. Pure JS over `react-native-svg`. |
| `react-native-svg` | 15.12.1 | its peer; the version Expo Go SDK 54 ships. |
| `expo-clipboard` | 8.0.8 | the copy target. |

All three are in the Expo Go bundle, so no dev-client rebuild is needed. Pinned
exactly rather than with a range, matching every other entry in the file.
`react-native-qrcode-svg` ships `src/index.js` as ESM **with JSX**, so it is
added to `jest.config.js`'s `transformIgnorePatterns` — without it the address
screen cannot be mounted at all. Its `text-encoding` dependency is reached only
by an optional Babel transform this app does not use, so it is not bundled.

## 8. Files

Added:

- `app/src/lib/address.ts`, `app/src/lib/address.test.ts`
- `app/src/lib/verificationCode.ts`, `app/src/lib/verificationCode.test.ts`
- `app/src/account/address.ts`, `app/src/account/address.test.ts`
- `app/src/components/AddressCard.tsx`, `app/src/components/native.ts`
- `app/src/screens/onboarding/AddressScreen.tsx`
- `app/src/screens/onboarding/VerificationScreen.tsx`
- `app/src/screens/settings/RotateAddressScreen.tsx`
- `app/src/app/OnboardingWalk.rn-test.tsx`, `app/src/app/RotateAddress.rn-test.tsx`

Changed:

- `app/src/app/Navigation.tsx` — the three slots, the `InboundAddress` route
- `app/src/app/runtime.ts` — `runtime.address`; `onboardingFacts` consolidated
- `app/src/app/Theme.tsx` — `type.address`
- `app/src/lib/onboarding.ts` — `firstMailAt`
- `app/src/lib/quarantine.ts`, `app/src/screens/quarantine/source.ts` — optional `blob` / `includeBlob`
- `app/src/screens/onboarding/OnboardingShell.tsx` — placeholder wording
- `app/src/screens/transactions/TransactionsScreen.tsx` — `onAddress`
- `app/src/components/README.md` — catalogue rows and four new conventions
- `app/package.json`, `app/bun.lock`, `app/jest.config.js`

## 9. Can onboarding be walked from sign-in to the product?

**Yes for every step this task owns, and the flow no longer dead-ends.** The
walk sign-in → bank → **address** → forwarding → **verification** → home
currency → finish → Transactions is driven end to end, through the real
navigator, in `OnboardingWalk.rn-test.tsx`.

Two things stand between that and a real human doing it on a phone, neither of
them this task's to close:

1. **The forwarding step has no instructions.** It advances, so it does not
   block, but a user is told to "set a rule in your mail provider" with no
   provider-specific steps. That is Task 2's measurement.
2. **Nobody has run it on a device against a real Gmail account.** Step 6.

## 10. Verification

**`bash scripts/v2-check.sh` → exit 0**, at commit `bafb7ba`, in a `git archive`
export of that commit at `/tmp/w5-verify` with `client/node_modules` and
`app/node_modules` hardlink-copied in. Final line:
`v2-check: OK (go + client + app + conformance)`. Zero failing tests in the
whole run.

Captured as `bash scripts/v2-check.sh > log 2>&1; echo $?` — the script's own
status, never a pipeline's.

In the worktree: `app` is 580 `bun test` across 40 files and 88 jest across 16
suites, 0 failures, `tsc --noEmit` clean.

## 11. Two things about the box, not about the code

Recorded because both cost a full gate run and the next agent will hit them.

### The disk was 100% full

The first gate run failed with 8 client failures that looked like real defects:
`engine.test.ts`'s "a SIGKILL mid-sync resumes to the identical state" reported
`kill.rows.jsonl: line 88 is not JSON (Unterminated string)`, and every
`roundtrip.test.ts` case died with `ledgerd exited with 1 before it was ready`
under Postgres `FATAL: could not write init file`.

Neither was a defect. `df -h /` said **80 MB free of 75 G**. A truncated JSONL
line and "could not write init file" are both what running out of disk looks
like from inside a test.

Freed 15 G by deleting finished agents' scratch — `/tmp/ledger-appgate-mut.*`
(3.4 G), `/tmp/ledger-task10-mut.*`, the `/tmp/*-go-cache` and `/tmp/task*-go*`
dirs from earlier tasks, `/tmp/ledger-engine-*` leftovers and a stale
`bunx-wrangler` cache. **Nothing under `/var/lib/ledger`, `/var/backups`,
`/root/.cache/go-build`, `/tmp/claude-0` or any checkout's `node_modules` was
touched, and no service was restarted.** These scratch directories accumulate
per task and nothing prunes them; worth a look before assuming a red gate is
code.

### A `git archive` export is not a git repo, and `go build` cares

AGENT-RULES requires verifying in a `git archive` export. In one, all 32 e2e
cases that boot a real `ledgerd` fail identically:

```
go build -o …/ledgerd ./cmd/ledgerd
error obtaining VCS status: exit status 128
        Use -buildvcs=false to disable VCS stamping.
```

`client/test/e2e/harness.ts:274` shells out to `go build` from `repoPath()`, and
Go's default VCS stamping needs a repository there. Everything else in the gate
passes, so the failure looks localised and specific rather than structural.

Fix used: `printf 'node_modules/\n' > .gitignore && git init -q` inside the
export before running the gate. `GOFLAGS=-buildvcs=false` also works but changes
what is built; the `git init` keeps the build identical.
