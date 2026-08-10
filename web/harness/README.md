# UI harness (v2)

**Read this before trusting a green run in this directory.** Until
2026-08-10, `web/harness/` also held a second harness — `stack.sh`,
`shoot.mjs`, `probe.mjs`, `nav.mjs`, `seed.mjs`, `gestures.mjs`, `hero.mjs`,
`ios.mjs`, `sheets.mjs` — forked from `frontend/` with the tree and still
driving **v1**: `stack.sh` built `./cmd/ledger` and ran vite in
`$REPO/frontend`, `nav.mjs` tapped v1's Settings hub rows. Pointing any of
them at a v2 change reported a clean screen it had never loaded. Those nine
files are gone. Every script left in this directory loads `web/src` and only
`web/src`. For v1 work, use `frontend/harness/` — full docs at
`frontend/harness/README.md`.

A way to actually *use* the app — not render a component in jsdom, but drive
the real PWA in a real browser against the real Go API (`ledgerd`), then
screenshot and audit the screens vitest and Storybook cannot reach: a control
under the bottom nav, a field that refuses to stay empty, a sheet hidden
behind the keyboard.

## Quick start

```bash
cd web
harness/v2stack.sh up                 # scratch Postgres + ledgerd + vite, prints an invite
node harness/v2settings.mjs <invite>  # walks sign-in, screenshots + audits Settings
harness/v2stack.sh down
```

`v2stack.sh up` starts `ledgerd` with **`--dns-fixtures`**, serving the
recorded DKIM/ARC TXT records offline so the corpus's signed bank mail
verifies. **Without it every message a harness sends reads as
`unauthenticated`, the verification step never clears, and no script can
reach the product at all.** If you write a new v2 runner or a new stack
script, it needs this flag too.

Nothing here touches production: `v2stack.sh` runs `ledgerd` and vite on
ports **8123** (API, `127.0.0.1`) and **5177** (UI, `localhost` — WebAuthn
needs a secure context) against a throwaway Postgres cluster under `/tmp`. It
opens neither `/var/lib/ledger` nor `/etc/ledger-v2` nor the running
`ledgerd` service.

## The four runners

Three of the four walk the real sign-in or recovery ceremony — `BootGate` is
in front of every v2 screen, and there is no way past it but a real account.
`vault.mjs` is the exception: it needs no server, no invite and no passkey,
only a page on the origin.

| script | proves |
| --- | --- |
| `v2settings.mjs <invite>` | Settings — the longest screen in the app — laid out, screenshotted, geometry-audited |
| `recovery.mjs <invite>` | a browser with its site data cleared, given twelve words, gets its keys back |
| `vault.mjs` | the key vault round trip, in Chromium **and** WebKit — no server, invite or passkey needed |
| `operator.mjs signup <invite> \| recover` | the whole sign-up → phrase → reload path, in WebKit |

**Screens beyond Settings, recovery, the vault and the operator path rest on
vitest alone.** That coverage gap is real and tracked in `CLAUDE.md`, not
closed by anything in this directory yet.

## `v2settings.mjs` — Settings, in the real v2 tree

It walks the whole ceremony, because `BootGate` is in front of every screen
and there is no way past it but a real account, then screenshots and audits
Settings — the longest screen in the app, and so the one where a control ends
up under the bottom nav.

```bash
harness/v2stack.sh up
node harness/v2settings.mjs <invite-code>
harness/v2stack.sh down
```

Two things make the walk completable at all:

- `v2stack.sh` starts `ledgerd` with `--dns-fixtures`, so the corpus's signed
  bank mail verifies DKIM offline. Without it every message reads as
  `unauthenticated`, the verification step never clears, and **no script can
  reach the product**.
- `sendmail.py` posts one corpus message byte-for-byte. Rebuild a header and
  the signature stops verifying.

It sends a **forwarded** message on purpose. A direct one passes DKIM and is
still held with `attested = false` — `origin/inner.go` attests an *inner*
origin, and a message nothing relayed has none — and the client offers trust
only for attested mail. Whether a direct bank email should be trustable from
the verification step is an open question for the mail path.

The capture asserts its own honesty: if the scroll produces two identical
segments it fails, because the first version of this file picked an inner
816px scroller and reported a clean 2983px screen it had never scrolled.

Screenshots land in `harness/shots/` with a machine-readable
`harness/shots/v2-settings.report.json`.

### The automated audit — `audit.mjs`

`v2settings.mjs` (and any runner that wants it) imports `audit(page)` from
`audit.mjs`, which runs inside the page and measures laid-out geometry,
catching what a screenshot hides:

- `page-h-overflow` / `element-past-viewport` — content crossing the viewport edge
- `control-obscured` — a control whose centre point hits a *different*
  element, i.e. it cannot be tapped
- `control-under-bottom-nav` — actions trapped beneath the fixed nav
- `content-clipped-unscrollable` — `overflow-hidden` over content taller than its box
- `tap-target-too-small` — below the documented 44px minimum
- `input-font-too-small` — under 16px, which makes iOS zoom on focus
- `text-clipped-no-ellipsis`, `control-without-accessible-name`, `img-without-alt`
- `bad-value-rendered` — a literal `NaN` / `undefined` / `[object Object]` on screen

Findings are geometric facts, not opinions. Judgement calls — hierarchy,
rhythm, copy, whether a screen looks finished — are for a human or a
reviewing agent looking at the screenshots.

Precision is the point. A checker that cries wolf gets ignored, so the audit
knows about several things it would otherwise report forever, including
`.sr-only` text, `line-clamp` and the rolling-digit animation clipping on
purpose, the overlay stack (only the top layer is audited), and
`data-dense-target`, which `IconButton size="sm"` sets to claim the 36px
dense-row allowance `components/README.md` grants it. If you add a
deliberate exception to a convention, teach the audit about it in the same
commit — otherwise the next person learns to skip the output.

## `recovery.mjs` — the at-rest keys, and a browser with nothing in it

This one is about a different kind of claim than layout: **a browser whose
site data has been cleared, given twelve words, gets its keys back.** Every
layer of that is a real browser behaviour — IndexedDB actually being gone, a
`CryptoKey` actually refusing to export, WebAuthn actually finding a
discoverable credential — and jsdom simulates none of them, so it cannot be a
vitest file however well written.

```bash
harness/v2stack.sh up
node harness/recovery.mjs <invite-code>
harness/v2stack.sh down
```

It creates an account, walks the recovery step, **attempts to export the
stored private key material and requires Chromium to refuse**, declares a
bank, then throws the browser context away and does the whole thing again
from the phrase.

One thing it documents rather than tests: a cleared browser is a new device
*writer*, because the writer's identity key was in the database that was just
destroyed — so it stops at the enrolment wall before the onboarding walk.
That gate is the writer roster's, not the key material's, and the script says
so where it steps around it.

### It is Chromium-only, and that shipped a bug

Its authenticator comes from CDP, which Chromium alone speaks. So this file —
the one that proves key custody — proved it on one engine, and the bug that
reached the operator was WebKit-only: **WebKit accepts an X25519 `CryptoKey`
into IndexedDB, completes the transaction, and returns `null` for that record
on every later read.** Every iPhone published a key set it could never open
and was sent back to the recovery screen on every launch, while this run was
green. Same shape as a timezone guard that passes because the box is UTC.

Two files close it, and a change to `v2/keys.ts` should run both.

## `vault.mjs` — the key vault, in Chromium **and** WebKit

```bash
node harness/vault.mjs        # needs only a vite on the origin
```

Writes a key set through the app's own `installAccountKeys`, opens a **new**
connection, reads it back, opens the ingest key and derives with it, and
requires every export attempt to be refused — in both engines. No passkey, no
invite, no server. This is the assertion that would have caught the WebKit
loop above, and it fails on the old storage shape with `webkit: read null`.

## `operator.mjs` — the whole path, in WebKit

```bash
node harness/operator.mjs signup <invite>   # phase one
node harness/operator.mjs recover           # phase two
```

Sign up, twelve words, confirm, **reload**, and check the next launch does
not land back on the phrase screen. It uses `webauthn.mjs`, a real ES256
software authenticator (go-webauthn verifies its signatures like any other),
because Playwright cannot give WebKit a virtual one. A **persistent profile**
is what makes the two phases separable: run `signup` against an old
`v2/keys.ts` and `recover` against a new one, and phase two is the operator's
repair — same account, same published blob, same twelve words, no re-keying.

## `addpasskey-repro.mjs` — a targeted repro, not a pass/fail check

```bash
node harness/addpasskey-repro.mjs <invite-code>
```

Reproduces adding a SECOND passkey on an authenticator that already holds the
first one — the same situation as an iCloud Keychain user signed into the
same Apple ID on a second device. It asserts nothing automatically: it prints
the raw `addPasskey()` result and the on-screen note, and the reader confirms
the note names this specific failure rather than a generic one.

## Shared helpers

- `webauthn.mjs` — a real ES256 software WebAuthn authenticator, for the
  engine (WebKit) Playwright cannot give a virtual one. Used by `operator.mjs`.
- `sendmail.py` — posts one corpus `.eml` byte-for-byte to the scratch SMTP
  listener. Used by `v2settings.mjs`; also runnable standalone as
  `python3 harness/sendmail.py <inbound-address> <path-to.eml>`.

## Two traps worth knowing

- **`v2settings.mjs` runs with motion left ALONE — no script in this
  directory sets `reducedMotion`.** `reducedMotion: "reduce"` makes `Dialog` /
  `SettingsPage` skip their slide entirely, which would hide any bug in the
  slide itself. That flag belongs to v1's `shoot.mjs` (`frontend/harness/`),
  which sets it for stable screenshot captures — don't carry the habit over
  here.
- **Check which tree vite is serving** (`ls -l /proc/<vite-pid>/cwd`).
  `v2stack.sh` resolves the repo from its own location, so running it from a
  stale checkout serves that checkout — it is easy to "verify a fix" against a
  tree that does not contain it.
