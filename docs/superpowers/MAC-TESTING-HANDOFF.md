# Handoff: running ledger v2 on a Mac + iOS simulator

Written 2026-08-05 for a Claude instance running **on Saleh's Mac**. The main
development session runs on `dinosaur` (Linux), which has no Xcode and no
simulator — that is why this exists.

---

## 0. What you are being asked to do

Get the **v2 Expo app** running on an iOS simulator against a **local `ledgerd`**,
walk the product, and report what is broken. You are the first eyes on this app
in a simulator; nobody has run it outside unit tests.

**You are not being asked to fix things.** Report precisely; the Linux session
owns the repairs. If a fix is a one-liner and obviously correct, say so in the
report rather than committing it — that session is mid-repair on these exact
files and a concurrent commit will collide.

---

## 1. The repo

```bash
git clone git@github.com:salehtl/ledger.git      # SSH
# or: git clone https://github.com/salehtl/ledger.git
cd ledger
git checkout v2-wip-2026-08-05
git pull                                          # ALWAYS — this branch moves hourly
```

**Branch `v2-wip-2026-08-05` — not `main`, not `v2`.**

- `main` is the live **v1** single-user PWA. Unrelated to this.
- `v2` is stale (`3f2d8ff`) and does **not** contain the Phase 2 app.
- `v2-wip-2026-08-05` is the real work. Agents are committing to it continuously,
  so pull before you start and again if something looks inconsistent.

**Never push to `main`. Never force-push. Prefer not to commit at all** — see §0.

### Read these first, in this order

1. `.superpowers/sdd/2026-08-02-v2-phase2-client/AGENT-RULES.md` — the standing
   rules. Short. Read all of it.
2. `deploy/README-v2.md` — the operator runbook: every `ledgerd` subcommand,
   the config rails, which secrets are environment-only. **This is the
   authoritative source for running the server; prefer it over anything below.**
3. `.superpowers/sdd/2026-08-02-v2-phase2-client/progress.md` — the live ledger.
   The tail tells you what is currently broken and being worked on, so you do
   not report a known defect as news.

Note `.superpowers/` is **gitignored**. If it is absent after cloning, ask the
Linux session to send it — it is the entire project memory.

---

## 2. Prerequisites

- **Xcode** + iOS simulator (that is the whole point of you)
- **Bun** — `curl -fsSL https://bun.sh/install | bash`
- **Go 1.22+** — `ledgerd` builds on macOS, no cgo needed
- **PostgreSQL 14+** running locally — `brew install postgresql@16 && brew services start postgresql@16`
- **Tailscale** — needed for HTTPS, see §3

Expo is pinned and the pins are load-bearing: **expo 54.0.36 / RN 0.81.5 /
expo-sqlite 16.0.10**. `create-expo-app@latest` scaffolds SDK 57, which will not
work. Do not upgrade anything to fix an error; report it.

```bash
(cd app && bun install)
(cd client && bun install)
```

---

## 3. THE TRAP: the app refuses anything but HTTPS

`app/src/app/config.ts` validates `EXPO_PUBLIC_LEDGER_SERVER` and **throws unless
it is an absolute `https://` origin** with no path, query, fragment or
credentials. There is no localhost exemption and no dev bypass.

So `http://localhost:8080` **will not work**. You need a real HTTPS origin in
front of your local `ledgerd`. Easiest, since Tailscale is already in use here:

```bash
tailscale serve --bg --https=443 http://127.0.0.1:8099
tailscale serve status          # prints the https://<host>.<tailnet>.ts.net origin
```

Then `EXPO_PUBLIC_LEDGER_SERVER=https://<that-host>` — origin only, no trailing path.

Any other trusted-cert terminator (Caddy with a local CA, ngrok) is fine. A
self-signed cert the simulator does not trust is not.

**Do not use port 8080 and do not point at `dinosaur`'s `/var/lib/ledger`** —
8080 on that box is the live v1 instance serving Saleh's real money data. Use a
scratch port (8099) and a scratch database, locally on your Mac.

---

## 4. Bring up the server

`deploy/README-v2.md` §1 is authoritative. The short version:

```bash
CGO_ENABLED=0 go build -o ledgerd ./cmd/ledgerd
createdb ledger_v2                              # migrations run at startup
cp config.v2.example.toml config.local.toml     # then edit, see below
```

In `config.local.toml`: bind a scratch port (**8099**), point at your local
Postgres. `config.v2.example.toml` documents every key; `deploy/README-v2.md` §2
explains which values are rails rather than preferences.

**Secrets are environment-only, never in the TOML** (README-v2 §3).

```bash
./ledgerd -config config.local.toml serve
```

Then, because **account creation is invite-gated** and you cannot sign up
without a code:

```bash
./ledgerd -config config.local.toml mint-invite
# prints the code ONCE and stores only its SHA-256 — copy it now
```

### Sign in with Apple on a simulator

The server validates the `id_token` **audience** against `[auth] apple_client_ids`
in the config. The app's bundle id is **`ae.sirdab.ledger`** — put exactly that
in `apple_client_ids`.

Sign the simulator into an iCloud account (Settings → Sign in). If Sign in with
Apple still fails on the simulator, **report it and stop** rather than loosening
the audience check — that check is load-bearing and a previous review found a
forgeable-key defect in this exact area.

---

## 5. Build and run the app

There is a **local Swift native module** (`app/modules/ledger-crypto`), so Expo
Go cannot load it and you need a dev client. With Xcode present that is local —
no EAS Build needed:

```bash
cd app
EXPO_PUBLIC_LEDGER_SERVER=https://<your-host> bunx expo prebuild --platform ios
EXPO_PUBLIC_LEDGER_SERVER=https://<your-host> bunx expo run:ios
```

`ledger-crypto` degrades gracefully (`isAvailable → false`) and is **not** on the
product path — only `app/src/bench/` imports it. If it fails to build, the app
still runs; report it and continue.

---

## 6. What to actually test

Onboarding is a derived state machine (`app/src/lib/onboarding.ts`): sign in →
invite → bank → **address** → forwarding → verification → home currency → product.

**Known incomplete, do not report as new:**

- **Task 15 is not built.** The address / forwarding / verification steps render
  honest placeholders naming Task 15 as owner. The **address step has no
  advance button**, because the address is server truth a device may not fake.
  Expect onboarding to dead-end there. Getting past it is the current priority
  on the Linux side.
- Gmail forwarding instructions are a placeholder (deliberately — that path is
  unmeasured).
- Remote push does not work in Expo Go; in a dev client it should.

**Most useful things you can do, in order:**

1. **Get to the address dead-end and describe exactly what the user sees.** Is
   the placeholder honest and legible, or does it look like a bug?
2. **Seed past onboarding and walk the product.** `ledgerd load-corpus`
   (README-v2 §1) creates ingest singletons without needing real SMTP — that is
   the intended way to get a populated account. Then exercise Transactions,
   Transaction detail + split editor, Review queue, Budget, Currencies, Import,
   Settings → Export / Security / Delete Account.
3. **Report layout and interaction defects with screenshots.** Nobody has seen
   these screens rendered. Check 44pt touch targets, 16px inputs, safe-area
   insets, the keyboard covering inputs, and anything unreachable behind a nav
   bar. This is the highest-value thing you can produce.
4. **Try to break inputs.** Clear every field and check it stays clear; type
   huge amounts; long merchant names. On the v1 app this method found real bugs
   that unit tests could not see.

---

## 7. What you must NOT do

- **Do not run the crypto or cold-restore benchmarks (Tasks 1, 1b, 28) on the
  simulator.** A simulator executes natively on the Mac's CPU, so the numbers
  measure a laptop, not a phone. A fast result there is worse than none — it
  would be mistaken for a passing architecture gate. Those need the real iPhone.
- Do not upgrade Expo, React Native or `expo-sqlite` off their pins.
- Do not weaken a test, a time limit, or the Apple audience check to get green.
- Do not touch `:8080`, `/var/lib/ledger`, or anything on `dinosaur`.

---

## 8. Reporting back

Write findings to `app/test/device/sim-run-<date>.md` and hand the text back to
Saleh. For each defect: what you did, what you expected, what happened, a
screenshot, and whether it reproduces. Separate **"broken"** from **"unfinished"**
— §6 lists what is knowingly unfinished, and conflating the two costs the Linux
session a wasted investigation.

State plainly what you could not test and why. An honest gap is worth more than
a green report that papers over it — that failure mode has cost this project
real defects, repeatedly.
