# Provider-agnostic forwarding setup — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A closed-beta user can set up forwarding from **any** mail provider — not just Gmail — and complete onboarding without getting stuck, without the app claiming knowledge of a provider it does not have.

**Architecture:** Replace the hardcoded Google recognition, the literal `mail-settings.google.com` link host, and the Gmail-only instructions with three provider-agnostic mechanisms: recognition by *user choice over verified held mail*, a link host pinned to the message's **own verified signing domain**, and a provider registry that carries only *instructions* — never trust decisions. Direct bank registration becomes a first-class path that skips forwarding entirely.

**Tech stack:** existing — React 19 + Vite in `web/`, `client/src/norm` for the shared normalizer, no new dependencies.

## Why the obvious design is wrong

A per-provider table of confirmation formats (sender domain, code length, link host) would be wrong on day one and stale within months. The research already contradicts it:

- **iCloud requires no verification at all** — you enter the destination address and mail flows. There is no code, no confirmation mail, nothing to recognise.
- **Outlook is two different products.** Consumer Outlook.com forwards; Microsoft 365 / Exchange Online **blocks external auto-forwarding by default** as an anti-BEC control, so a work account may be unable to forward at all regardless of what our UI says.
- Providers change these flows without notice, and we would learn only from a stuck user.

So the mechanism must not depend on knowing any provider in advance. Provider knowledge is confined to **instructions**, which are copy, and are allowed to be incomplete as long as they say so.

## The security property that must not regress

`web/src/v2/verificationCode.ts` runs regexes over **attacker-controlled content** on the user's device: anyone who learns an inbound address can put a megabyte of anything into that lane. Its header states four load-bearing rules, and the project has already measured a **125,744 ms** pathological match (`dialect-redos.md`):

1. Every pattern starts with a **literal anchor**.
2. **No unbounded quantifier anywhere** — no `+`, no `*`, no `{n,}`. Widest run is `{0,16}`.
3. **Disjoint adjacent classes**, so a backtracking engine has exactly one way to continue.
4. An **8 KB slice**, so the linear factor is a constant we choose.

`SCAN_BUDGET_MS` is a tripwire on top of those, not the bound. Every pattern this plan adds must satisfy all four, and Task 2 makes that mechanically checked rather than asserted in a comment.

Equally: what may be shown to the user is **a digit run and a link whose host we did not take from the message body**. The raw body stays available as a capped, untrusted-labelled, inert-text fallback (`CodeScan.body`) — it is what stops any of this being a dead end, and it must survive.

## Global Constraints

- Do not weaken the four ReDoS rules or the 8 KB slice. Do not remove the raw-body fallback.
- **The server's verification remains the only trust decision.** Nothing in this plan may promote a forwarder domain, render a link host taken from message content, or treat an `unverified:`-prefixed domain as verified.
- Design aesthetic FROZEN: compose from `web/src/components/`; read `web/src/components/README.md` first; 44px targets, 16px inputs.
- Motion: `lib/motion.ts` is the sole source of durations/curves; `m.*` never bare `motion.*`; no `opacity: 0` in `initial` for first-paint content; tests rendering `m.*` wrap in `MotionProvider`.
- Money is `bigint`; never `Number` for an amount.
- The git index is shared with concurrent agents: stage and commit in ONE atomic command with explicit paths, from the repo root.
- Do not run `cd web && bun run build` — it rewrites the tracked `internal/v2/webui/dist` embed artifact the deploy step owns. Verify with `bun run test` and `bunx tsc -b`.
- Commit with a `Co-Authored-By: Claude` trailer.

---

### Task 1: Recognition by choice, not by domain list

**Files:** Modify `web/src/v2/verificationCode.ts`, `web/src/screens/onboarding/Verification.tsx`; tests alongside.

`isForwarderConfirmation` currently requires `innerDomain === ""` **and** a Google domain. Dropping only the domain list does not work: a bank that sends **directly** to the inbound address also has `innerDomain === ""`, so the predicate cannot distinguish "my provider's confirmation" from "my bank's first alert". Both are legitimate and they need opposite handling.

The resolution is to stop classifying. The user knows which message they are waiting for; the app does not.

- [ ] **Step 1:** Write the failing test. `isForwarderConfirmation` is replaced by `couldBeConfirmation(item)` — `innerDomain === ""` and the outer domain is verified (no `unverified:` prefix). Assert: a Google item qualifies, a non-Google verified item **also** qualifies (this is the bug being fixed), an `unverified:`-prefixed item does not, and an item with a non-empty `innerDomain` does not.
- [ ] **Step 2:** Run it, see it fail.
- [ ] **Step 3:** Implement. Keep `GOOGLE_DOMAINS` **only** if something still needs to sort Google first in the list; if nothing does, delete it — a dead trust-shaped constant is a liability.
- [ ] **Step 4:** In `Verification.tsx`, the step lists every candidate held item with its **verified signing domain** and received time, and the user opens the one that is their provider's. Scanning runs on the opened item. Keep the existing "unauthenticated" treatment: an unverified item is listed but cannot be opened for a code.
- [ ] **Step 5:** Tests pass; `bunx vitest run src/v2/ src/screens/onboarding/`; commit.

---

### Task 2: A link host taken from the signature, not from the body

**Files:** Modify `web/src/v2/verificationCode.ts` + tests.

Today `LINK_PATTERN` hardcodes `https://mail-settings.google.com/mail/`. The generalisation must not become "any URL in the body" — that would let a held message show the user a link to anywhere, which is precisely the attack this file is built against.

**Interface:** `scanForCode(text, opts: { linkHost: string; now?: () => number })` — `linkHost` is the item's **verified** `outerDomain`, supplied by the caller from server data, never parsed out of `text`.

- [ ] **Step 1:** Failing tests. (a) A link on the verified host is returned. (b) A link on a *different* host in the same body is **not** returned, even when it appears first. (c) A host containing regex metacharacters is escaped, not interpreted. (d) `linkHost` empty ⇒ no link is ever returned. (e) The existing Gmail fixture still yields its link when `linkHost` is `mail-settings.google.com`.
- [ ] **Step 2:** Run, see them fail.
- [ ] **Step 3:** Implement: build the pattern from an **escaped** literal host, keeping scheme and path-shape fixed and only the opaque tail captured, still within the four rules. Note the verified signing domain is the organisational domain (`google.com`) while the link host is often a subdomain (`mail-settings.google.com`) — accept a subdomain of the verified domain, anchored so `evil-google.com` cannot match.
- [ ] **Step 4:** Broaden `CODE_PATTERNS` beyond Gmail's exact wording and nine digits: anchor on a small set of literals (`confirmation code`, `verification code`, `security code`, `confirm your`), and widen the captured run to `[0-9]{4,12}` — still bounded, still preceded by a disjoint `[^0-9]{0,16}`. `CODE_DIGITS` becomes a range; update its doc.
- [ ] **Step 5: the mechanical shape check.** The file already exports `SCAN_PATTERNS` "so their SHAPE can be measured rather than asserted in a comment" — make that real. A test walks every exported pattern's `source` and fails on `+`, `*`, `{n,}` with no upper bound, or a `{0,N}` class adjacent to a class it intersects. Prove it fails by adding a bad pattern temporarily.
- [ ] **Step 6:** Full targeted run; commit.

---

### Task 3: A provider registry that carries only instructions

**Files:** Create `web/src/v2/providers.ts` + test; modify `web/src/screens/onboarding/Address.tsx`.

**Interface:** `interface Provider { id, label, needsConfirmation: boolean, steps: string[], caveat?: string }`, `PROVIDERS: readonly Provider[]`, `GENERIC: Provider`.

- [ ] **Step 1:** Failing test: every provider has non-empty `steps`; `icloud.needsConfirmation === false`; `outlook.caveat` is non-empty; `GENERIC` exists and is returned for an unknown id.
- [ ] **Step 2:** Run, see it fail.
- [ ] **Step 3:** Populate, honestly and no further than the evidence goes:
  - **Gmail** — needs confirmation. Existing steps, kept.
  - **iCloud** — `needsConfirmation: false`. Enter the destination address in Mail settings on iCloud.com; no code is sent. ([Apple Support](https://support.apple.com/guide/icloud/automatically-forward-email-mm6b1a3960/icloud))
  - **Outlook / Hotmail** — caveat: a **work or school account on Microsoft 365 may block external forwarding entirely**, as an anti-BEC default an administrator controls. Say so before the user tries, not after.
  - **Yahoo** — needs confirmation.
  - **Proton** — forwarding to an external address is a paid-plan feature.
  - **GENERIC** — "Find the forwarding or auto-forward setting in your mail provider, and add this address. If your provider emails a confirmation code, it will appear on the next screen."
- [ ] **Step 4:** `Address.tsx` renders a provider picker; the chosen provider's steps replace the hardcoded Gmail block; `GENERIC` for "another provider". The choice is UI state only — **it must not become a trust input**, and a test asserts nothing in the trust path reads it.
- [ ] **Step 5:** Tests pass; `web/src/components/README.md` updated if a shared component was added; commit.

---

### Task 4: Skip the confirmation step when the provider has none

**Files:** Modify `web/src/screens/onboarding/Verification.tsx`, `web/src/v2/onboarding.ts` + tests.

An iCloud user has no code to enter. Showing them a screen that waits for one and offers a code box is a promise the flow cannot keep — the failure mode this branch has hit repeatedly.

- [ ] **Step 1:** Failing test: with a `needsConfirmation: false` provider, the step renders "waiting for your first bank email" and offers **no** code box; with `true`, both appear. In both cases the advance gate stays `firstMailAt()` — a real transaction in the log — because that is the only provider-agnostic proof forwarding actually works.
- [ ] **Step 2:** Run, see it fail. **Step 3:** Implement. **Step 4:** Pass.
- [ ] **Step 5:** Check the copy honestly against behaviour. Four review rounds on this screen found sentences the code did not make true; re-read every string you touch and delete any that overstates. Commit.

---

### Task 5: Direct bank registration as a first-class path

**Files:** Modify `web/src/screens/onboarding/Address.tsx`, `web/src/v2/onboarding.ts` + tests.

Most UAE banks let a customer set an alert email address directly in their app or portal. That path has **no forwarder, no confirmation code, and no rule a provider can silently disable** — it removes the single largest availability risk in the product, which is a forwarding rule turning itself off after an outage and nobody noticing.

- [ ] **Step 1:** Failing test: the address step offers two routes — "Set this address with your bank directly (recommended)" and "Forward from my email" — and choosing the direct route reaches the same waiting-for-first-mail state without any forwarding or confirmation copy.
- [ ] **Step 2:** Run, see it fail. **Step 3:** Implement. **Step 4:** Pass.
- [ ] **Step 5:** Commit.

---

### Task 6: Re-run the gate

- [ ] `bash scripts/v2-check.sh` → `v2-check: OK (go + client + web + conformance)`.
- [ ] `cd web && bun run test` and `bunx tsc -b` clean, on a quiet tree (concurrent edits have produced spurious failures before — do not diagnose a bulk-only failure until nothing else is running).
- [ ] Do **not** rebuild `internal/v2/webui/dist`; the deploy step owns it and will rebuild at cutover.

## Self-review notes

- **Covers the ask:** any provider works because no mechanism depends on knowing one (Tasks 1, 2); the popular ones get accurate instructions (Task 3); providers with no confirmation are not asked for one (Task 4); and the most reliable route avoids forwarding altogether (Task 5).
- **The security property is strengthened, not relaxed.** The link host moves from a hardcoded literal to a value derived from a cryptographic signature the server verified, and the pattern-shape rules become mechanically enforced rather than documented.
- **Known thin ice, named:** the verified organisational domain and the link's subdomain differ (Task 2 Step 3 handles it explicitly, with an anchor so `evil-google.com` cannot match); and `couldBeConfirmation` deliberately cannot distinguish a provider confirmation from a bank's first direct alert, which is why Task 1 hands that judgement to the user rather than guessing.
