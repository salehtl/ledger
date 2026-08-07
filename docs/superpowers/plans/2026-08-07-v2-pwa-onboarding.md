# v2 PWA — multi-user sign-up, onboarding, and first sync (one-day plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** By end of day, a fresh browser profile can sign up (invite-gated), onboard (bank → inbound address → forwarding → home currency), sync against the real `ledgerd`, and see a bank email arrive as a transaction — in the existing single-user UI's skin.

**Architecture:** The PWA becomes a fourth host for the already-built local-first core: `client/src` (Client, SyncEngine, sqliteStore, projection) runs unmodified in the browser via two new adapters — a browser `Platform` (noble + fflate) and a browser `SqlDriver` (sql.js, persisted to IndexedDB). Screens keep `web/`'s components and styling; their data source flips from v1 REST to the local projection. The Expo app's framework-free `source.ts` / auth / sync modules are ported, its React components are not.

**Tech Stack:** React 19 + Vite + Tailwind v4 (existing `web/`), `client/src` core, `@noble/hashes`, `@noble/curves`, `fflate`, `sql.js`, Google Identity Services (web), `ledgerd` + Postgres.

## Global Constraints

- **Do not modify `client/src` behavior.** New files there are allowed (`platform.web.ts`); edits to existing modules are not — 2,351 tests and the conformance suite guard it.
- **Do not touch `frontend/`, `internal/web/`, or anything v1 serves.** `web/` is the only frontend tree in play.
- **`web/` build output stays `web/dist/` (gitignored).** Never `../internal/web/dist`.
- **Design aesthetic is frozen** (direction doc, decision 1): existing tokens, fonts, `lib/motion.ts` constants, component catalog, 44px targets, 16px inputs. New screens compose existing `web/src/components/`; no new visual language.
- **Money is `int64` minor units** — in TS, `bigint` end to end (the projection already does this). Never `Number` for amounts.
- **No new server endpoints.** The 28 existing `/api/v1/*` routes are the whole surface.
- **Crypto scope today:** writer identity keys (ed25519, real) + session auth. HPKE ingest sealing / DEK / recovery phrase are Phase 3 and explicitly out.
- **All commands run from the worktree** (`/root/Coding/ledger/.claude/worktrees/v2-pwa`). Dev server: `ledgerd --dev-auth` on scratch Postgres + free port, never `:8080` or `/var/lib/ledger`.
- Commit after every task; `Co-Authored-By: Claude` trailer per repo convention.

## Blocked on Saleh (start these in parallel, none block local dev)

1. **Google web OAuth client ID** (Cloud console → Credentials → OAuth client, type *Web application*, authorized origin = the tailnet HTTPS origin + `http://localhost:5173`). Until it exists, sign-in uses the dev panel (`--dev-auth`), which is the whole local loop anyway.
2. **Invite codes**: decide the initial invite list. `POST /api/v1/auth/exchange` takes `invite_code`; codes are minted via the admin console (`internal/v2/admin`).
3. **Serving the PWA over the tailnet** for a phone test: `tailscale serve` an extra port fronting `vite preview` (or a static `web/dist`). Not needed for the desktop-browser E2E gate.

## File Structure

```
client/src/platform.web.ts          # browser Platform (noble + fflate)  — NEW
client/src/platform.web.test.ts     # same contract vectors, bun test    — NEW
web/src/v2/db/driver.ts             # sql.js SqlDriver + IndexedDB persist — NEW
web/src/v2/db/driver.test.ts
web/src/v2/session.ts               # Client bootstrap, login, enrolment  — port of app/src/auth/{session,enrollment}.ts
web/src/v2/session.test.ts
web/src/v2/engine.ts                # SyncEngine construction + coordinator — port of app/src/sync/coordinator.ts
web/src/v2/sources/budget.ts        # port of app/src/screens/budget/source.ts
web/src/v2/sources/transactions.ts  # port of app/src/screens/transactions/source.ts
web/src/v2/sources/review.ts        # port of app/src/db/reviewQueue.ts
web/src/v2/queries.ts               # react-query wrappers over the sources — NEW
web/src/screens/onboarding/*        # SignIn, Bank, Address, Verification, HomeCurrency — RN screens re-skinned with web/ components
web/src/app/AppShell.tsx            # MODIFY: auth/onboarding gate, nav trimmed to live screens
web/vite.config.ts                  # MODIFY: @ledger/client alias, sql.js asset, dev proxy
scripts/v2-check.sh                 # MODIFY: skip app/, add web/
```

Task order is risk-first: the two adapters (1–3) decide whether the day works; UI ports come after.

---

### Task 0: Housekeeping — retire `app/` from the gate, admit `web/`

**Files:** Modify `scripts/v2-check.sh`

- [ ] In `scripts/v2-check.sh`, find the `app/` section (the one that prints `v2-check: app/node_modules is missing`). Replace it with a comment — `# app/ (Expo) is retired on this branch; see docs/superpowers/specs/2026-08-07-v2-pwa-direction.md` — and delete its check.
- [ ] Add a `web/` section modeled on the `client/` one: fail with `v2-check: web/node_modules is missing; run (cd web && bun install)` when absent, else run `(cd web && bun run test)` and include it in the final `OK` line: `v2-check: OK (go + client + web + conformance)`.
- [ ] Run: `bash scripts/v2-check.sh` → expect the new OK line (go + client + web all green; ~2,351 + 1,360 tests).
- [ ] Commit: `chore(v2-check): retire app/ from the gate, admit web/`

---

### Task 1: Browser `Platform` — `client/src/platform.web.ts`

The seam is 14 synchronous methods (`client/src/platform.ts`); WebCrypto is async so the impl is pure JS. Contract is `client/src/platform.test.ts` — read it before writing anything.

**Files:**
- Create: `client/src/platform.web.ts`, `client/src/platform.web.test.ts`
- Modify: `client/package.json` (deps: `@noble/hashes@^1`, `@noble/curves@^1`, `fflate@^0.8`)

**Interfaces:**
- Produces: `export const webPlatform: Platform` — consumed by Task 5's boot (`setPlatform(webPlatform)`).

- [ ] **Step 1: failing test.** `client/src/platform.web.test.ts`, `bun test`. Two layers: (a) the fixed vectors — copy the sha256 empty-string vector, RFC 8032 ed25519 test-vector-1, the hex/base64 leading-zero and 0xFF cases, and the 4-byte-codepoint UTF-8 case out of `platform.test.ts` and assert them against `webPlatform`; (b) cross-impl equivalence — for 50 random byte strings assert `webPlatform.sha256/gzip-roundtrip/toHex/toBase64/utf8` agree with `bunPlatform` byte-for-byte, and that `bunPlatform.gunzip(webPlatform.gzip(x))` round-trips (the compressed bytes themselves may differ; the round-trip may not). Also: `gunzip` throws when output exceeds `maxOutputBytes` (gzip-bomb cap — see how `platform.test.ts` builds it).
- [ ] **Step 2:** `cd client && bun add @noble/hashes @noble/curves fflate && bun test src/platform.web.test.ts` → FAIL (module not found).
- [ ] **Step 3: implement.**

```ts
// client/src/platform.web.ts
import { sha256 } from "@noble/hashes/sha256";
import { ed25519 } from "@noble/curves/ed25519";
import { gzipSync, gunzipSync } from "fflate";
import type { Platform } from "./platform";

export const webPlatform: Platform = {
  sha256: (d) => sha256(d),
  gzip: (d) => gzipSync(d),
  gunzip: (d, maxOutputBytes) => {
    const out = gunzipSync(d); // fflate has no streaming cap on the sync path:
    if (out.length > maxOutputBytes) throw new Error(`gunzip: output ${out.length} exceeds cap ${maxOutputBytes}`);
    return out;
  },
  ed25519GenerateKey: () => {
    const priv = ed25519.utils.randomPrivateKey();
    return { priv, pub: ed25519.getPublicKey(priv) };
  },
  ed25519PublicKey: (priv) => ed25519.getPublicKey(priv),
  ed25519Sign: (priv, msg) => ed25519.sign(msg, priv), // noble is (msg, priv) — the test vectors catch a swap
  randomUUID: () => crypto.randomUUID(),
  randomBytes: (n) => crypto.getRandomValues(new Uint8Array(n)),
  toHex: /* loop over bytes, padStart(2,"0") */ ...,
  fromHex: ...,
  toBase64: (b) => btoa(String.fromCharCode(...chunked(b))), // chunk to avoid arg-limit; or a manual encoder
  fromBase64: (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)),
  utf8Encode: (s) => new TextEncoder().encode(s),
  utf8Decode: (b) => new TextDecoder("utf-8", { fatal: false }).decode(b),
};
```

Match each method's exact edge-case behavior to whatever `platform.test.ts` pins (lone surrogates, whitespace in base64, etc.) — the contract file wins over this sketch. `fromHex`/`toHex`: hand-rolled loops, no deps. **Do NOT call `setPlatform` at module load** — the app decides (bunPlatform auto-installs for tests; double-install throws or confuses).
- [ ] **Step 4:** `bun test src/platform.web.test.ts` → PASS. Then full `bun test` → count ≥ 2,351 + new file, nothing broken.
- [ ] **Step 5:** Commit: `feat(client): browser Platform over noble + fflate`

---

### Task 2: Wire `web/` to `client/src` — alias, deps, vitest

**Files:** Modify `web/vite.config.ts`, `web/tsconfig.json`, `web/package.json`

**Interfaces:** Produces the import path every later task uses: `import { ... } from "@ledger/client/net/client"` etc.

- [ ] **Step 1:** In `web/vite.config.ts` add `resolve: { alias: { "@ledger/client": fileURLToPath(new URL("../client/src", import.meta.url)) } }` (the file already uses the `fileURLToPath` pattern — follow it). In `web/tsconfig.json` add the matching `paths` entry `"@ledger/client/*": ["../client/src/*"]`. Mirror both into the vitest config block if `web/` uses a separate one (check `vite.config.ts` — vitest reads the same file here).
- [ ] **Step 2:** `cd web && bun add sql.js && bun add -d @types/sql.js`. (noble/fflate arrive transitively through the alias? **No** — the alias imports resolve from `web/node_modules`, so `bun add @noble/hashes @noble/curves fflate` here too, same versions as `client/`.)
- [ ] **Step 3: smoke test.** `web/src/v2/wiring.test.ts`: `import { fold, emptyState } from "@ledger/client/replay/replay"; test("fold folds", () => expect(fold([], emptyState())).toBeDefined())` and `import { webPlatform } from "@ledger/client/platform.web"` + one sha256 vector. Run `bun run test -- wiring` → PASS. Also `bun run build` → must succeed (this catches `bun:sqlite`/`node:` imports leaking into the bundle; `store/driver.ts` is import-type-only from `sqlite.ts`, and `platform.ts`'s `node:zlib`/`node:crypto` static imports mean **the app must never import `@ledger/client/platform`, only `platform.web`** — if the build still drags them in via `store/open.ts` or the test, mark those `external` in `build.rollupOptions` or avoid importing `open.ts` at all: the app constructs `sqliteStore(driver, …)` directly).
- [ ] **Step 4:** Commit: `feat(web): resolve @ledger/client, add browser crypto/sqlite deps`

---

### Task 3: Browser `SqlDriver` — sql.js + IndexedDB persistence

**Files:** Create `web/src/v2/db/driver.ts`, `web/src/v2/db/driver.test.ts`

**Interfaces:**
- Consumes: `SqlDriver`, `SqlStatement` from `@ledger/client/store/driver` (**import type only** — a value import drags in `bun:sqlite`).
- Produces: `openBrowserDriver(name: string): Promise<SqlDriver & { flush(): Promise<void> }>` — sql.js is async to *init* (WASM fetch) but the returned driver is fully synchronous, which is what `sqliteStore` requires. `flush()` persists; the driver also auto-persists (debounced 500 ms) after any `transaction()` and on `visibilitychange→hidden`.

- [ ] **Step 1: failing test** (vitest, node env — sql.js runs in node): open driver, `exec` a CREATE TABLE, prepared `run`/`all` with positional params round-trip a string + a `bigint`-as-text + a `Uint8Array` blob; `transaction` rolls back on throw; `flush()` then re-`openBrowserDriver` same name reloads the row (mock IndexedDB with a Map when `indexedDB` is undefined — keep the fallback in the driver itself: it doubles as the vitest path and a private-browsing fallback).
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3: implement.** `initSqlJs({ locateFile: (f) => new URL("sql.js/dist/" + f, import.meta.url).toString() })` (add `sql.js/dist/sql-wasm.wasm` to Vite's static handling — `?url` import is simplest); load prior bytes from IndexedDB (`ledger-v2` DB, `dbs` object store, key = name) into `new SQL.Database(bytes)`. Map the interface: `prepare` → sql.js `db.prepare` with `stmt.bind(args); while(stmt.step()) rows.push(stmt.getAsObject()); stmt.reset()` for `all`, `stmt.run(args)` for `run` — **note sql.js statements are not cached across calls the way bun's are; re-prepare per call or hold the handle, but `free()` on `close`**. `transaction`: `exec("BEGIN")` / `COMMIT` / `ROLLBACK` on throw (sql.js has no helper; not re-entrant is fine per the contract). Persist = `db.export()` → IDB put. sql.js `getAsObject` returns numbers for INTEGER columns — the store schema (`client/src/store/sqlite.ts` `SCHEMA`) stores seqs as TEXT via `seqKey` and blobs as blobs, so check what column types the projection schema uses (`PROJECTION_SCHEMA` in `replay/projection.ts`) and confirm amounts are TEXT there too; if any INTEGER column can exceed 2^53, return it via `stmt.getAsObject()` is unusable and you must read with `db.exec` raw... **verify against the schemas, don't guess** — the store was built for expo-sqlite which has the same JS-number problem, so TEXT is the expected answer.
- [ ] **Step 4:** run → PASS.
- [ ] **Step 5: the real gate — the store's own suite over this driver.** `web/src/v2/db/store-conformance.test.ts`: import `sqliteStore` from `@ledger/client/store/sqlite` and run a basic life-cycle against the browser driver: `load()` empty state → mutate (`st.userId = "u1"`) → `save(st)` → reopen → `load()` returns it; `rows("hot").append` a fake `WireRow` then `eachRowChunk` reads it back. (Running client's full `store.test.ts` here would be better but it's bun-test; this subset covers the driver surface the engine touches.)
- [ ] **Step 6:** Commit: `feat(web): sql.js SqlDriver with IndexedDB persistence`

---

### Task 4: Session + enrolment — `web/src/v2/session.ts`

**Files:**
- Create: `web/src/v2/session.ts`, `web/src/v2/session.test.ts`
- Reference (read first, port logic, drop RN imports): `app/src/auth/session.ts`, `app/src/auth/enrollment.ts`, `app/src/auth/devAuth.ts`

**Interfaces:**
- Consumes: `Client` from `@ledger/client/net/client` (`login(idp, idToken, inviteCode?)`, `enroll(writerId)`, `sessionToken`), `sqliteStore` over Task 3's driver, `webPlatform`.
- Produces:
  - `initV2(server: string): Promise<V2Handle>` — one call at app boot: `setPlatform(webPlatform)`, open driver, build store + `Client`.
  - `V2Handle = { client: Client; driver: SqlDriver; signedIn(): boolean; signIn(idp: "google"|"dev", idToken: string, invite?: string): Promise<void>; }`
  - `signIn` = `client.login(...)` then **enrol this device's writer immediately** (the `cb6904e`/`8365532` lesson: sign-in without enrolment leaves every write path throwing). Writer id: `web-<platform.randomUUID()>` persisted in the store; key material via `ed25519GenerateKey`, held in the sqliteStore's `SecretStore` (see `SECRET_WRITER` in `store/sqlite.ts` — the store already has the slot; mirror how `app/src/auth/enrollment.ts` names and stores it, exactly, so a future native app and the PWA agree).
- [ ] **Step 1: failing test** (vitest): with a fake `fetch` scripted from the wire shapes in `client/src/net/client.test.ts` (copy the `/api/v1/auth/exchange` and `/api/v1/writers/challenge`+`register` response fixtures from there), `signIn("dev","dev:alice")` leaves `signedIn() === true`, a writer enrolled (client no longer throws the "no writer is enrolled" error on a write), and both survive re-`initV2` from the same driver name.
- [ ] **Step 2:** FAIL → **Step 3:** implement (this is a port: `app/src/auth/session.ts` already sequences login→enroll→persist; strip RN, swap `expoDriver`→Task 3 driver) → **Step 4:** PASS.
- [ ] **Step 5:** Commit: `feat(web): v2 session bootstrap — login + device-writer enrolment`

---

### Task 5: Sync engine + boot gate in the shell

**Files:**
- Create: `web/src/v2/engine.ts`, `web/src/v2/queries.ts`
- Modify: `web/src/app/AppShell.tsx`, `web/src/queryClient.ts` (or wherever the router mounts — read `AppShell` first)
- Reference: `app/src/sync/coordinator.ts` (31 lines — copy it), `SyncEngine` in `client/src/net/engine.ts` (read its options/`SyncProgress`/`SyncResult` docs)

**Interfaces:**
- Produces: `startEngine(h: V2Handle): SyncCoordinator` (engine over the handle's client+driver; triggers: on start, on `visibilitychange→visible`, on the existing pull-to-refresh hook); `useSyncProgress(): SyncProgress` (subscribe → React state); `queries.ts` exports `qk.transactions`, `qk.budget`, `qk.review` query keys and a single `invalidateAfterSync(queryClient)` called from the coordinator's post-sync hook.
- Dev server plumbing: add to `web/vite.config.ts` `server.proxy = { "/api/v1": process.env.LEDGER_V2_API ?? "http://127.0.0.1:8091" }` — mirroring the existing `LEDGER_API` comment style; the `Client`'s `server` is then just `""` (same-origin) in dev and prod alike.
- [ ] **Step 1:** test (vitest): coordinator built over a fake engine (the `CoordinatedEngine` interface makes this trivial) forwards `run("launch")`, and `useSyncProgress` re-renders on progress events (`@testing-library/react` `renderHook`).
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5: the gate in `AppShell`.** Boot: `initV2("")` → not signed in ⇒ render onboarding stack (Task 6); signed in but onboarding incomplete (no home currency in projection meta — port the check from `app/src/screens/onboarding/OnboardingShell.tsx`) ⇒ resume onboarding; else main app + `startEngine`. A `halted` `SyncPhase` renders a full-screen non-dismissable error (reuse the existing error/empty-state component) — a chain break must not look like a loading state. **Keep v1's `PersistQueryClientProvider` out of the v2 data path** (projection is the cache; double-caching bigints through JSON persist will corrupt them — the `react-query-persist-ispending` lesson says gate carefully if any of it stays).
- [ ] **Step 6:** `bun run test` + `bun run build` green. Commit: `feat(web): sync engine, boot gate, v2 query plumbing`

---

### Task 6: Onboarding screens

**Files:**
- Create: `web/src/screens/onboarding/{SignIn,Bank,Address,Verification,HomeCurrency}.tsx` + one `Onboarding.test.tsx`
- Reference for flow/copy/logic (NOT for markup): `app/src/screens/onboarding/*.tsx`; `NotInvitedView.tsx` for the invite-rejected state
- Compose from: existing `web/src/components/` (Dialog, Pressable, ProgressBar, list rows, `Pill`…) — check `web/src/components/README.md` first, per its own rule

Flow (port exactly): **SignIn** (Google GIS button — render via `https://accounts.google.com/gsi/client` script, `import.meta.env.VITE_GOOGLE_CLIENT_ID`, callback hands `credential` to `signIn("google", credential, invite)`; plus a dev-only panel gated on `import.meta.env.DEV` mirroring `DevSignInPanel.tsx` — subject + invite-code fields) → **Bank** picker (supported list ↔ `GET /api/v1/templates` bank set; unsupported ⇒ `POST /api/v1/waitlist` + done) → **Address** (`GET /api/v1/address` → show `u-…@in.sirdab.ae` with a copy button + Gmail forwarding steps) → **Verification** (Gmail's confirmation mail arrives at our server: poll `GET /api/v1/quarantine`, surface the verification link/code from the listing the way `VerificationScreen.tsx` does) → **HomeCurrency** (currency list; writes the `home_currency_set` op through the client's outbox — find the exact op author in `app/src/screens/onboarding/HomeCurrencyScreen.tsx` and port it) → main app.

- [ ] **Step 1:** failing tests: render SignIn (dev panel present under test env), scripted-fetch walk of Bank→Address (address renders the token from the fixture), HomeCurrency writes the op (assert via the client's outbox/pending count).
- [ ] **Step 2–4:** FAIL → implement → PASS. Screens must pass the design constraints (44px, 16px inputs) — they're built from catalog components, so this is free unless you hand-roll; don't hand-roll.
- [ ] **Step 5:** Commit: `feat(web): onboarding — sign-in, bank, address, forwarding, home currency`

---

### Task 7: Rewire Home/Budget + Transactions to the projection

**Files:**
- Create: `web/src/v2/sources/{budget,transactions}.ts` (+ colocated `.test.ts`) — ports of `app/src/screens/budget/source.ts` and `app/src/screens/transactions/source.ts` (both are framework-free over `SqlDriver`; the port is mostly the import path)
- Modify: `web/src/screens/home/*` and `web/src/screens/Transactions.tsx` — swap their react-query `queryFn`s from `api/` calls to the sources via `queries.ts`; keep components, rows, filters, motion untouched
- [ ] **Step 1:** port each `source.ts` **with its existing tests** (the `.rn-test` files test components — skip those; `source.test.ts` files are runner-agnostic — port them to vitest as-is). Run → PASS (these test against an in-memory driver seeded with `PROJECTION_SCHEMA` fixtures — the ported tests carry their own fixtures).
- [ ] **Step 2:** swap the screens' data layer. The screens' prop shapes and v1 API types will disagree in places (v1 `TransactionRow` vs projection `Txn` from `replay/state.ts`) — adapt in `queries.ts` mappers, **not** inside components. Any v1-only widget on these screens with no projection data (AI-usage strip, ingest-health card, envelope/target cards if v2 has no envelope ops — check `state.ts` for what exists) is removed from the v2 screen, not stubbed.
- [ ] **Step 3:** existing screen tests: update their mocks from api-client to source layer; keep assertions. `bun run test` green.
- [ ] **Step 4:** Commit: `feat(web): home + transactions read the local projection`

---

### Task 8: Review queue + quarantine lane

**Files:**
- Create: `web/src/v2/sources/review.ts` (port `app/src/db/reviewQueue.ts` + its test), `web/src/screens/Quarantine.tsx`
- Modify: `web/src/screens/Review.tsx` (swap data source; categorize action authors a `txn_categorized` op through the client — port the author from `app/src/screens/review/`), nav in `AppShell`
- Reference: `app/src/screens/quarantine/` for the trust-sender flow: list `GET /api/v1/quarantine`, confirm `POST /api/v1/quarantine/confirm` **showing the verified signing domain or the prominent "unauthenticated" state** (spec §3.2 — the decision must never be made from attacker-rendered content alone; the RN screen has the exact copy, keep it)
- [ ] **Step 1:** port `review.ts` + test → PASS. **Step 2:** rewire `Review.tsx` (the swipe deck stays; only its feed and its commit action change). **Step 3:** build `Quarantine.tsx` from list-row + Dialog catalog components; test: fixture rows render domain badge; confirm fires the POST and invalidates. **Step 4:** `bun run test` green; commit: `feat(web): review queue on local ops, quarantine trust-sender lane`

---

### Task 9: Trim the nav to what's real

**Files:** Modify `web/src/app/AppShell.tsx` (nav), delete-from-nav only — files stay.

- [ ] Nav for v2 = Home, Transactions, Review, Quarantine, Settings. Screens with v1-only backends (Insights, Reports, Projects, Recurring, Accounts, Rules/Category managers, AI settings) are **unrouted** — not deleted, not "coming soon" placeholders; they return as their data grows projections. Settings keeps: sign-out (drop session + `closeSharedDriver`), inbound address display + copy, home currency display, and the sync status row (last sync, progress, halted reason).
- [ ] `bun run test && bun run build` green. Commit: `feat(web): v2 nav — route only projection-backed screens`

---

### Task 10: End-to-end gate (the definition of "done today")

**Files:** Create `docs/superpowers/notes/2026-08-07-pwa-e2e-gate.md` (the record)

- [ ] **Step 1: stack up.** Scratch Postgres (pattern from `internal/v2/pgtest` or the enabled service with a scratch DB — record which), `go build -o /tmp/claude-0/**/scratchpad/ledgerd ./cmd/ledgerd`, run with `--dev-auth`, HTTP on `127.0.0.1:8091`, templates seeded (`ledgerd seed-templates`; verify 4 published via admin). Mint one invite code via the admin console.
- [ ] **Step 2: the walk, in a fresh browser profile** (`cd web && bun run dev`, `LEDGER_V2_API=http://127.0.0.1:8091`): dev sign-in with the invite → bank: DIB → address shown → skip Gmail (dev) → home currency AED → lands on Home, empty-state.
- [ ] **Step 3: mail becomes a transaction.** Inject a corpus DIB email at the SMTP port (`swaks --to <the-address> --server 127.0.0.1:<smtp-port>` with a real corpus body — `internal/v2/corpus` fixtures; the sender is unknown ⇒ it must land in **Quarantine**). Trust the sender in the UI → confirm re-runs ingest → sync → **the transaction renders on Home and in Transactions with the correct amount**. Send a second mail from the now-trusted sender → arrives as a normal op, appears after refresh-sync.
- [ ] **Step 4: persistence + two-writer sanity.** Reload the tab: no re-login, no full re-pull (cursor persisted), state intact. Categorize the txn in the review deck → reload → sticks (op round-tripped through the server, not just local). Open a **second** browser profile, sign in as the same dev user, sync: sees the txn and the categorization (this is the two-writer case; the writer-roster/I11 machinery is what's being exercised).
- [ ] **Step 5: record.** Write the gate note: what passed, timings (cold restore, sync), every deviation, and the open Saleh items (Google client ID, invites, tailnet serve). `bash scripts/v2-check.sh` one last time → OK line. Commit: `docs(v2): PWA onboarding E2E gate record`

---

## Self-review notes

- **Spec coverage vs. the ask:** account creation (T4/T6, invite-gated per backend reality), onboarding (T6), "using the platform" (T5/T7/T8, mail→txn in T10), auth (T4), crypto = writer keys only with Phase 3 explicitly out (Global Constraints), UI unchanged (frozen-aesthetic constraint + catalog-only composition). No new server endpoints anywhere.
- **Known thin ice, named:** (a) sql.js INTEGER-vs-bigint — T3 Step 3 forces a schema read instead of a guess; (b) `platform.ts`'s static `node:` imports leaking into the Vite build — T2 Step 3 catches it at build time with the fix options listed; (c) `HomeCurrencyScreen`/review op authors — the plan points at the exact RN files that already author these ops rather than re-deriving op shapes.
- **Order is droppable from the back:** if the day runs short, T8→T9 can compress (Review ships, Quarantine confirm moves to Settings as a plain list) and T10 Step 4's two-profile check is the only step that may slip to tomorrow without lying about the goal. T1–T6 are not droppable.
