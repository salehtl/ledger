# v2 PWA — passkey sign-up, onboarding, and public deployment (one-day plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** By end of day, `https://app.sirdab.ae` is publicly reachable, and an invited alpha can sign up with a passkey, onboard (bank → inbound address → Gmail forwarding → home currency), forward a bank email, and watch it become a transaction — in the existing single-user UI's skin.

**Architecture:** The PWA is a fourth host for the already-built local-first core: `client/src` (Client, SyncEngine, sqliteStore, projection) runs unmodified in the browser behind two new adapters — a browser `Platform` (noble + fflate) and a browser `SqlDriver` (sql.js → IndexedDB). Auth changes from Apple/Google OIDC to **passkeys (WebAuthn)** as a third provider behind the existing `auth.Verifier`/`Identity`/`SubjectHash` seam; sessions, invite gating, and writer enrolment are untouched. `ledgerd` gains autocert and serves the embedded PWA on the same origin as the API.

**Tech Stack:** React 19 + Vite + Tailwind v4 (existing `web/`), `client/src` core, `@noble/hashes`, `@noble/curves`, `fflate`, `sql.js`, `github.com/go-webauthn/webauthn@v0.17.4`, `golang.org/x/crypto/acme/autocert`, `ledgerd` + PostgreSQL 16.

## Decisions taken 2026-08-07 (these supersede the spec where they differ)

1. **Auth is passkeys, not Apple/Google.** Spec §3.8's "Sign in with Apple + Google Sign-In" is replaced. Dropping Expo removed the App Store rule that forced Apple sign-in. No passwords still holds — the spec's "passwords never exist anywhere in v2" is *strengthened*, not weakened. **The `dev:<subject>` verifier stays** for local tests; it is structurally refused off a loopback listener (`config.EnableTestOnly`), so production cannot accept it.
2. **Beta scope today: the operator plus 3–5 invited alphas**, gated by the existing single-use invite codes, under the signed plaintext-consent document (Task D6). Not open signup.
3. **One public hostname, `app.sirdab.ae`**, serving both the PWA and `/api/v1/*` same-origin (no CORS; the `Client`'s `server` stays `""`). `api.sirdab.ae` keeps resolving and is covered by the same certificate. **WebAuthn RP ID is `sirdab.ae`** so credentials work across both names.
4. **No backup relay today.** `MX 20 → mx2.sirdab.ae` does not resolve; Task D1 **deletes that record** so senders retry `mx1` correctly instead of failing over to nothing. The relay (Phase 1 Task D3) is the first fast-follow and needs a second VPS. This is a disclosed availability gap in the consent document, not a silent one.
5. **Phase 1 is plaintext.** HPKE sealing, DEK, and recovery phrase remain Phase 3. Every alpha signs the consent document naming the four server-side read paths before an address is issued.

## Global Constraints

- **Do not modify `client/src` behavior.** New files there are allowed (`platform.web.ts`); edits to existing modules are not — 2,351 tests and the conformance suite guard it.
- **Do not touch `frontend/`, `internal/web/`, `/var/lib/ledger`, or `:8080`.** v1 keeps running, loopback + tailnet only, throughout.
- **`admin_listen` stays loopback-or-tailnet.** `config.CheckAdminBind` enforces it and Task D3 does **not** lift that rail — only `http_listen`'s.
- **Design aesthetic is frozen:** existing tokens, fonts, `lib/motion.ts` constants, component catalog, 44px targets, 16px inputs. New screens compose existing `web/src/components/`; no new visual language.
- **Money is `int64` minor units** — `bigint` end to end in TS. Never `Number` for amounts.
- **Crypto scope today:** WebAuthn credentials (server-verified) + ed25519 writer identity keys. HPKE/DEK/recovery phrase are explicitly out.
- **Secrets are env-only**, never in TOML: `LEDGER_ADMIN_TOKEN`, `LEDGER_DICT_HMAC_KEY`, `LEDGER_PG_DSN`.
- Local dev runs `ledgerd serve --dev-auth` on scratch Postgres + a free port. Never `:8080`, never `/var/lib/ledger`.
- Commit after every task, `Co-Authored-By: Claude` trailer.

## Part D is operator-executed

Tasks **D1–D6 touch a public box that also holds v1 production data**: firewall rules, systemd units, DNS, and a live cutover. They are executed by the controller in-session with the operator watching, **not dispatched to subagents**, and each irreversible step is confirmed before it runs. Tasks 0–10 are subagent work and depend on none of Part D except the final gate.

## File Structure

```
client/src/platform.web.ts            # browser Platform (noble + fflate)          NEW
client/src/platform.web.test.ts
web/src/v2/db/driver.ts               # sql.js SqlDriver + IndexedDB persistence   NEW
web/src/v2/session.ts                 # initV2, passkey signup/login, enrolment    NEW
web/src/v2/engine.ts                  # SyncEngine + coordinator (port of app/src/sync/coordinator.ts)
web/src/v2/queries.ts                 # react-query wrappers over the sources
web/src/v2/sources/{budget,transactions,review}.ts   # ports of app/src/**/source.ts
web/src/screens/onboarding/*          # Passkey signup/login, Bank, Address, Verification, HomeCurrency
web/src/app/AppShell.tsx              # MODIFY: auth/onboarding gate, trimmed nav
internal/v2/auth/passkey.go           # WebAuthn ceremonies over the Verifier seam  NEW
internal/v2/auth/passkey_store.go     # credentials + ceremony session data         NEW
internal/v2/api/passkey.go            # 6 endpoints                                 NEW
internal/v2/pg/migrations/00021_passkeys.sql                                        NEW
internal/v2/webui/                    # embed.FS of the built PWA + SPA fallback    NEW
cmd/ledgerd/serve.go                  # MODIFY: autocert, static mount
deploy/ledgerd.service                                                              NEW
```

---

### Task 0: Housekeeping — retire `app/` from the gate, admit `web/`

**Files:** Modify `scripts/v2-check.sh`

- [ ] Find the `app/` section (prints `v2-check: app/node_modules is missing`). Replace with a comment `# app/ (Expo) is retired on this branch; see docs/superpowers/specs/2026-08-07-v2-pwa-direction.md` and delete its check.
- [ ] Add a `web/` section modeled on the `client/` one: absent deps ⇒ `v2-check: web/node_modules is missing; run (cd web && bun install)`; else run `(cd web && bun run test)`. Final line becomes `v2-check: OK (go + client + web + conformance)`.
- [ ] Run `bash scripts/v2-check.sh` → expect the new OK line.
- [ ] Commit: `chore(v2-check): retire app/ from the gate, admit web/`

---

### Task 1: Browser `Platform` — `client/src/platform.web.ts`

The seam is 14 **synchronous** methods (`client/src/platform.ts`); WebCrypto is async, so the implementation is pure JS. **Read `client/src/platform.test.ts` first — it is the contract and it wins over any sketch below.**

**Files:** Create `client/src/platform.web.ts`, `client/src/platform.web.test.ts`; modify `client/package.json`

**Interfaces:** Produces `export const webPlatform: Platform`, consumed by Task 4's boot via `setPlatform(webPlatform)`.

- [ ] **Step 1: write the failing test.** Two layers. (a) *Fixed vectors*: copy from `platform.test.ts` the sha256 empty-string vector, RFC 8032 ed25519 test-vector-1, the hex and base64 leading-zero-byte and `0xFF` cases, and the 4-byte-codepoint UTF-8 case; assert each against `webPlatform`. (b) *Cross-implementation equivalence*: for 50 pseudorandom byte strings (fixed seed, not `Math.random`), assert `webPlatform.sha256`, `toHex`, `toBase64`, `utf8Encode` agree with `bunPlatform` byte-for-byte, and that `bunPlatform.gunzip(webPlatform.gzip(x), 1<<20)` round-trips (compressed bytes may differ between implementations; the round-trip may not). Plus: `gunzip` throws when output exceeds `maxOutputBytes` — build the bomb the way `platform.test.ts` does.
- [ ] **Step 2:** `cd client && bun add @noble/hashes @noble/curves fflate && bun test src/platform.web.test.ts` → FAIL (module not found).
- [ ] **Step 3: implement.**

```ts
// client/src/platform.web.ts
import { sha256 } from "@noble/hashes/sha256";
import { ed25519 } from "@noble/curves/ed25519";
import { gzipSync, gunzipSync } from "fflate";
import type { Platform } from "./platform";

const HEX = "0123456789abcdef";

export const webPlatform: Platform = {
  sha256: (d) => sha256(d),
  gzip: (d) => gzipSync(d),
  gunzip: (d, maxOutputBytes) => {
    const out = gunzipSync(d);
    if (out.length > maxOutputBytes) {
      throw new Error(`gunzip: output ${out.length} exceeds cap ${maxOutputBytes}`);
    }
    return out;
  },
  ed25519GenerateKey: () => {
    const priv = ed25519.utils.randomPrivateKey();
    return { priv, pub: ed25519.getPublicKey(priv) };
  },
  ed25519PublicKey: (priv) => ed25519.getPublicKey(priv),
  // noble's argument order is (message, privateKey) — the RFC 8032 vector catches a swap.
  ed25519Sign: (priv, msg) => ed25519.sign(msg, priv),
  randomUUID: () => crypto.randomUUID(),
  randomBytes: (n) => crypto.getRandomValues(new Uint8Array(n)),
  toHex: (b) => {
    let s = "";
    for (const byte of b) s += HEX[byte >> 4] + HEX[byte & 15];
    return s;
  },
  fromHex: (s) => {
    if (s.length % 2 !== 0) throw new Error("fromHex: odd-length input");
    const out = new Uint8Array(s.length / 2);
    for (let i = 0; i < out.length; i++) {
      const byte = Number.parseInt(s.slice(i * 2, i * 2 + 2), 16);
      if (Number.isNaN(byte)) throw new Error(`fromHex: bad hex at ${i * 2}`);
      out[i] = byte;
    }
    return out;
  },
  toBase64: (b) => {
    // Chunked: String.fromCharCode(...b) blows the argument limit on large blobs.
    let s = "";
    for (let i = 0; i < b.length; i += 0x8000) {
      s += String.fromCharCode(...b.subarray(i, i + 0x8000));
    }
    return btoa(s);
  },
  fromBase64: (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)),
  utf8Encode: (s) => new TextEncoder().encode(s),
  utf8Decode: (b) => new TextDecoder("utf-8").decode(b),
};
```

**Do NOT call `setPlatform` at module load** — `bunPlatform` auto-installs for tests and the app installs `webPlatform` explicitly at boot.
- [ ] **Step 4:** `bun test src/platform.web.test.ts` → PASS. Then full `cd client && bun test` → collected count ≥ 2,351 + the new file, nothing weakened or skipped.
- [ ] **Step 5:** Commit `feat(client): browser Platform over noble + fflate`

---

### Task 2: Wire `web/` to `client/src`

**Files:** Modify `web/vite.config.ts`, `web/tsconfig.json`, `web/package.json`; create `web/src/v2/wiring.test.ts`

**Interfaces:** Produces the import path every later task uses — `import { fold } from "@ledger/client/replay/replay"`.

- [ ] **Step 1:** In `web/vite.config.ts` add `resolve.alias` mapping `@ledger/client` → `fileURLToPath(new URL("../client/src", import.meta.url))` (the file already imports `fileURLToPath` — follow its existing comment convention about why, not `new URL(...).pathname`). Add the matching `"@ledger/client/*": ["../client/src/*"]` to `web/tsconfig.json` `compilerOptions.paths`. Vitest reads the same config file here, so no second copy — verify that claim by running the Step 3 test.
- [ ] **Step 2:** `cd web && bun add sql.js @noble/hashes @noble/curves fflate && bun add -d @types/sql.js`. Versions must match `client/package.json`'s — the alias resolves imports from `web/node_modules`, so a version skew silently gives two different crypto implementations.
- [ ] **Step 3: smoke test.** `web/src/v2/wiring.test.ts`: import `fold`/`emptyState` from `@ledger/client/replay/replay` and assert `fold([], emptyState())` is defined; import `webPlatform` from `@ledger/client/platform.web` and assert the sha256 empty-string vector. Run `bun run test -- wiring` → PASS. Then `bun run build` → must succeed. **The build is the real assertion:** `client/src/platform.ts` statically imports `node:zlib` and `node:crypto`, so **the app must never import `@ledger/client/platform`, only `platform.web`**, and must never import `store/open.ts` (which pulls `bun:sqlite` through `./driver`) — construct `sqliteStore(driver, …)` directly instead. If the build still drags a `node:` builtin in, find the importing module and route around it; do not paper over it with an `external` entry that would fail at runtime instead of build time.
- [ ] **Step 4:** Commit `feat(web): resolve @ledger/client, add browser crypto/sqlite deps`

---

### Task 3: Browser `SqlDriver` — sql.js over IndexedDB

**Files:** Create `web/src/v2/db/driver.ts`, `web/src/v2/db/driver.test.ts`, `web/src/v2/db/store-conformance.test.ts`

**Interfaces:**
- Consumes `SqlDriver`, `SqlStatement` from `@ledger/client/store/driver` — **`import type` only**; a value import drags in `bun:sqlite`.
- Produces `openBrowserDriver(name: string): Promise<SqlDriver & { flush(): Promise<void> }>`. sql.js is async to *initialise* (WASM fetch) but the returned driver is fully **synchronous**, which is what `sqliteStore` requires. `flush()` persists on demand; the driver also auto-persists debounced 500 ms after any `transaction()`, and on `visibilitychange → hidden`.

- [ ] **Step 1: failing test.** Open a driver; `exec` a `CREATE TABLE`; prepared `run`/`all` round-trip a string, a bigint-as-TEXT, and a `Uint8Array` blob; `transaction` rolls back on throw; `flush()` then reopening the same name reloads the row. Keep an in-memory fallback inside the driver for when `indexedDB` is undefined — it doubles as the vitest path and as private-browsing behaviour, so it is production code, not test scaffolding.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3: implement.** `initSqlJs({ locateFile })` pointing at the `sql.js` wasm asset (import it with Vite's `?url` suffix so it is fingerprinted and precached like any other asset). Load prior bytes from IndexedDB (database `ledger-v2`, object store `dbs`, key = `name`) into `new SQL.Database(bytes)`. Map the interface: `prepare` returns an object holding a sql.js statement — `all` does `stmt.bind(args); const rows = []; while (stmt.step()) rows.push(stmt.getAsObject()); stmt.reset(); return rows`, `run` does `stmt.run(args)`; `free()` every held statement on `close`. `transaction` is `exec("BEGIN")` + `COMMIT`, `ROLLBACK` on throw (sql.js has no helper; the contract says it need not be re-entrant). Persist = `db.export()` → IDB put.
  **The bigint trap, which you must resolve by reading and not by guessing:** sql.js returns JS `number` for INTEGER columns, so any value above 2^53 is silently corrupted. Read `SCHEMA` in `client/src/store/sqlite.ts` and `PROJECTION_SCHEMA` in `client/src/replay/projection.ts` and confirm every column that can exceed 2^53 (seqs, amounts, counters) is declared TEXT. The store was built for `expo-sqlite`, which has the identical constraint, so TEXT is the expected finding — but confirm it, and if any such column really is INTEGER, stop and report it as a blocker rather than working around it locally.
- [ ] **Step 4:** run → PASS.
- [ ] **Step 5: the real gate — the store's own surface over this driver.** `store-conformance.test.ts`: import `sqliteStore` from `@ledger/client/store/sqlite`, build it over the browser driver, then: `load()` on a fresh store returns empty client state; mutate a field and `save()`; reopen the driver by the same name and `load()` returns the mutation; `rows("hot").append` one `WireRow` and read it back through `eachRowChunk`. (`client/`'s own `store.test.ts` is a `bun:test` file and cannot run here; this is the subset covering the driver surface the engine touches.)
- [ ] **Step 6:** Commit `feat(web): sql.js SqlDriver with IndexedDB persistence`

---

### Task 4: Backend — passkey authentication

Adds WebAuthn as a third provider behind the **existing** `auth.Verifier`/`Identity`/`SubjectHash` seam. Sessions, invite redemption, writer enrolment, and the key-history log are untouched.

**Files:**
- Create: `internal/v2/auth/passkey.go`, `internal/v2/auth/passkey_test.go`, `internal/v2/auth/passkey_store.go`, `internal/v2/api/passkey.go`, `internal/v2/api/passkey_test.go`, `internal/v2/pg/migrations/00021_passkeys.sql`
- Modify: `internal/v2/auth/idp.go` (`validIdP`), `internal/v2/api/api.go` (routes), `internal/v2/config/config.go` (`[auth]` keys)

**Read first:** `internal/v2/auth/idp.go` (the `Verifier` contract, `Identity`, `SubjectHash` and its `"|"`-separator warning), `internal/v2/auth/invite.go` (`ErrNotInvited`, redemption), `internal/v2/auth/session.go` (how an `Identity` becomes a user + session), `internal/v2/api/ratelimit.go`.

**Interfaces produced (the client in Task 5 depends on these exact shapes):**

```
POST /api/v1/auth/passkey/register/begin   {invite_code}          -> {ceremony_id, options}
POST /api/v1/auth/passkey/register/finish  {ceremony_id, credential} -> {session_token, user_id}
POST /api/v1/auth/passkey/login/begin      {}                     -> {ceremony_id, options}
POST /api/v1/auth/passkey/login/finish     {ceremony_id, credential} -> {session_token, user_id}
POST /api/v1/auth/passkey/add/begin        {}  (authenticated)    -> {ceremony_id, options}
POST /api/v1/auth/passkey/add/finish       {ceremony_id, credential} (authenticated) -> {credential_id}
```

`options` is go-webauthn's `protocol.CredentialCreation` / `CredentialAssertion` marshalled as-is — the browser consumes it directly. Errors keep the existing envelope: `403 {"error":"not_invited"}` when no unredeemed code authorised creation.

- [ ] **Step 1: the migration.** `internal/v2/pg/migrations/00021_passkeys.sql` (**re-run `ls internal/v2/pg/migrations/` immediately before writing it and claim the next free number — 00021 is expected but three sessions are concurrent; never claim the vacant 00004 or 00015**). Two tables plus one constraint change:
  - `webauthn_credentials(credential_id BYTEA PRIMARY KEY, user_id … REFERENCES users ON DELETE CASCADE, public_key BYTEA NOT NULL, sign_count BIGINT NOT NULL DEFAULT 0, aaguid BYTEA, transports TEXT, backup_eligible BOOL NOT NULL, backup_state BOOL NOT NULL, created_at TIMESTAMPTZ NOT NULL, last_used_at TIMESTAMPTZ)` + an index on `user_id`.
  - `webauthn_ceremonies(id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('register','login','add')), user_handle BYTEA, session_data JSONB NOT NULL, invite_code_hash BYTEA, created_at TIMESTAMPTZ NOT NULL, expires_at TIMESTAMPTZ NOT NULL)` — go-webauthn's `SessionData` must survive between begin and finish, and it holds the challenge, so it is server-side state and never a client cookie.
  - Widen the `users.idp` CHECK constraint to admit `'passkey'`. **Mirror the grant pattern documented in `00003_writers.sql`'s header** — new tables need explicit `ledger_runtime` grants and the sequence grants, or every write fails with `permission denied` in production only.
- [ ] **Step 2: write the failing auth test.** `passkey_test.go` against `pgtest`, using go-webauthn's own test helpers or a scripted software authenticator: (a) register with a valid invite creates exactly one user whose `idp = 'passkey'` and redeems the code; (b) register with an already-redeemed code returns `ErrNotInvited` and creates nothing; (c) login with the registered credential returns a session for the *same* `user_id`; (d) login with an unknown credential is rejected; (e) a replayed `ceremony_id` is rejected (single-use); (f) an expired ceremony is rejected; (g) a `sign_count` that goes backwards is rejected as cloned-authenticator evidence. Run → FAIL.
- [ ] **Step 3: implement `passkey.go`.** `go get github.com/go-webauthn/webauthn@v0.17.4`. Config from `[auth] rp_id`, `rp_display_name`, `rp_origins` (list). The `Identity` produced is `{IdP: "passkey", Subject: base64url(user_handle)}` where `user_handle` is 32 random bytes minted at registration and stored as the credential's user handle — **discoverable credentials return it in the assertion, which is what makes username-less login possible.** Add `"passkey"` to `validIdP`; the `SubjectHash` `"|"`-separator warning stays satisfied because the value contains no `"|"`. Ceremonies: single-use (delete on finish), 5-minute TTL, `id` from `crypto/rand`. Require `UserVerification: preferred`, `ResidentKey: required`.
- [ ] **Step 4:** run the auth tests → PASS.
- [ ] **Step 5: the API layer.** `api/passkey.go` wires the six routes, applies the **existing** per-IP rate limiter from `ratelimit.go` to all six (an unauthenticated endpoint that mints ceremonies is a memory-growth target), and returns the documented error envelope. Test each route's happy path plus: register/finish with a mismatched `ceremony_id`, add/* without a session (401). Run → PASS.
- [ ] **Step 6:** `go test ./internal/v2/... && bash scripts/v2-check.sh` green. Commit `feat(v2): passkey authentication behind the Verifier seam`

---

### Task 5: Client session — passkey ceremonies + device-writer enrolment

**Files:** Create `web/src/v2/session.ts`, `web/src/v2/session.test.ts`
**Read first (port the logic, drop the RN imports):** `app/src/auth/session.ts`, `app/src/auth/enrollment.ts`

**Interfaces:**
- Consumes `Client` from `@ledger/client/net/client`, `sqliteStore` over Task 3's driver, `webPlatform`, and Task 4's six endpoints.
- Produces:
  - `initV2(server: string): Promise<V2Handle>` — one call at boot: `setPlatform(webPlatform)`, open the driver, build store + `Client`.
  - `V2Handle = { client: Client; driver: SqlDriver; signedIn(): boolean; signUp(inviteCode: string): Promise<void>; signIn(): Promise<void>; signOut(): Promise<void> }`
- **`signUp` and `signIn` must both end with the device writer enrolled.** Sign-in without enrolment leaves every write path throwing `"this device is not set up to make changes yet"` (the exact regression fixed in `8365532`). Writer id `web-<platform.randomUUID()>`, ed25519 key from `webPlatform.ed25519GenerateKey()`, stored in the `SecretStore` under the **same key naming `app/src/auth/enrollment.ts` uses** (`SECRET_WRITER` in `store/sqlite.ts`) so a future native client and the PWA agree.
- WebAuthn plumbing: `navigator.credentials.create/get` need `ArrayBuffer`s, and the server sends base64url JSON — convert with `webPlatform.fromBase64`/`toBase64` (URL-safe variants), not a hand-rolled second implementation.

- [ ] **Step 1: failing test.** With a scripted fake `fetch` (copy the wire fixtures for `/writers/challenge` and `/writers/register` from `client/src/net/client.test.ts`) and a stubbed `navigator.credentials`: `signUp("CODE")` leaves `signedIn() === true`, a writer enrolled (a write no longer throws), and both survive a re-`initV2` against the same driver name. A `403 not_invited` surfaces as a typed error the UI can branch on, not a generic failure.
- [ ] **Step 2:** FAIL → **Step 3:** implement → **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat(web): passkey sign-up/sign-in with device-writer enrolment`

---

### Task 6: Sync engine + boot gate

**Files:** Create `web/src/v2/engine.ts`, `web/src/v2/queries.ts`; modify `web/src/app/AppShell.tsx`, `web/vite.config.ts`
**Read first:** `app/src/sync/coordinator.ts` (31 lines — port it), `SyncEngine` in `client/src/net/engine.ts`

**Interfaces:** `startEngine(h: V2Handle): SyncCoordinator` (triggers: boot, `visibilitychange → visible`, the existing pull-to-refresh hook); `useSyncProgress(): SyncProgress`; `queries.ts` exports the query keys and `invalidateAfterSync(queryClient)`.

- [ ] **Step 1:** dev proxy — add to `web/vite.config.ts` `server.proxy = { "/api/v1": process.env.LEDGER_V2_API ?? "http://127.0.0.1:8091" }`, matching the file's existing `LEDGER_API` comment style. Production is same-origin, so the `Client`'s `server` is `""` in both.
- [ ] **Step 2: failing test.** The coordinator over a fake `CoordinatedEngine` forwards `run("launch")`; `useSyncProgress` re-renders on progress events (`renderHook` from `@testing-library/react`).
- [ ] **Step 3–4:** FAIL → implement → PASS.
- [ ] **Step 5: the gate in `AppShell`.** Boot: `initV2("")` → not signed in ⇒ auth screens (Task 7); signed in but onboarding incomplete ⇒ resume onboarding (port the completeness check from `app/src/screens/onboarding/OnboardingShell.tsx`); else the main app + `startEngine`. A `halted` `SyncPhase` renders a **full-screen, non-dismissable** error — a chain break must never look like a loading state. Keep v1's `PersistQueryClientProvider` off the v2 data path: the projection *is* the cache, and round-tripping bigints through its JSON persister corrupts them.
- [ ] **Step 6:** `bun run test && bun run build` green. Commit `feat(web): sync engine, boot gate, v2 query plumbing`

---

### Task 7: Auth + onboarding screens

**Files:** Create `web/src/screens/onboarding/{Welcome,Bank,Address,Verification,HomeCurrency}.tsx` + `Onboarding.test.tsx`
**Read first for flow, copy and logic (NOT markup):** `app/src/screens/onboarding/*.tsx`, `NotInvitedView.tsx`
**Compose from** existing `web/src/components/` — read `web/src/components/README.md` first, per its own rule, and update it in this commit if you add a shared component.

Flow:
1. **Welcome** — two paths. *Create account*: invite-code field → `signUp(code)` → the browser's passkey sheet ("Save a passkey for sirdab.ae"). *Sign in*: a single button → `signIn()` (username-less; discoverable credentials mean no email field anywhere). A `not_invited` error renders the ported `NotInvitedView` copy. Include the `import.meta.env.DEV`-gated dev panel mirroring `DevSignInPanel.tsx` so local work needs no authenticator.
2. **Bank** picker — supported set from `GET /api/v1/templates`; unsupported ⇒ `POST /api/v1/waitlist` and stop with the waitlist confirmation.
3. **Address** — `GET /api/v1/address`, show `u-…@in.sirdab.ae` with a copy button and the Gmail forwarding steps.
4. **Verification** — Gmail's confirmation mail lands in our quarantine lane (it is from `forwarding-noreply@google.com`, not allowlisted). Poll `GET /api/v1/quarantine` and surface the verification link the way `VerificationScreen.tsx` does.
5. **HomeCurrency** — currency list; writes the `home_currency_set` op through the outbox. Port the op author from `app/src/screens/onboarding/HomeCurrencyScreen.tsx` rather than re-deriving the op shape.

- [ ] **Step 1: failing tests.** Welcome renders both paths and surfaces `not_invited`; a scripted-fetch walk Bank → Address renders the fixture's address token; HomeCurrency writes the op (assert via the outbox's pending count).
- [ ] **Step 2–4:** FAIL → implement → PASS. Built from catalog components, so the 44px/16px rules come for free — do not hand-roll controls.
- [ ] **Step 5:** Commit `feat(web): passkey welcome + onboarding flow`

---

### Task 8: Home + Transactions on the projection

**Files:** Create `web/src/v2/sources/{budget,transactions}.ts` + tests (ports of `app/src/screens/budget/source.ts`, `app/src/screens/transactions/source.ts` — both framework-free over `SqlDriver`; mostly an import-path change). Modify `web/src/screens/home/*`, `web/src/screens/Transactions.tsx`.

- [ ] **Step 1:** port each `source.ts` **with its existing `source.test.ts`** (those are runner-agnostic; the `.rn-test.tsx` component tests are not — skip them). Run → PASS.
- [ ] **Step 2:** swap each screen's react-query `queryFn` from `api/` to the sources via `queries.ts`. Keep components, rows, filters and motion untouched. Where v1's API types and the projection's `Txn` (`client/src/replay/state.ts`) disagree, adapt in `queries.ts` mappers — **never inside components**. Any v1-only widget with no projection data behind it (AI-usage strip, ingest-health card, and envelope/target cards if no such ops exist — check `state.ts`) is **removed from the v2 screen, not stubbed**.
- [ ] **Step 3:** update the existing screen tests' mocks from the api client to the source layer, keeping their assertions. `bun run test` green.
- [ ] **Step 4:** Commit `feat(web): home + transactions read the local projection`

---

### Task 9: Review queue + quarantine lane

**Files:** Create `web/src/v2/sources/review.ts` (port `app/src/db/reviewQueue.ts` + test), `web/src/screens/Quarantine.tsx`. Modify `web/src/screens/Review.tsx`, nav in `AppShell`.

- [ ] **Step 1:** port `review.ts` + its test → PASS.
- [ ] **Step 2:** rewire `Review.tsx` — the swipe deck stays; only its feed and its commit action change (the categorize action authors a `txn_categorized` op; port the author from `app/src/screens/review/`).
- [ ] **Step 3:** `Quarantine.tsx` from list-row + Dialog catalog components: `GET /api/v1/quarantine`, confirm via `POST /api/v1/quarantine/confirm`, **showing the verified signing domain or a prominent "unauthenticated" state** — spec §3.2 requires the trust decision never be made from attacker-rendered content alone; the RN screen has the exact copy, keep it. Test: fixture rows render the domain badge; confirm fires the POST and invalidates.
- [ ] **Step 4:** `bun run test` green. Commit `feat(web): review queue on local ops, quarantine trust-sender lane`

---

### Task 10: Trim the nav

**Files:** Modify `web/src/app/AppShell.tsx`

- [ ] v2 nav = Home, Transactions, Review, Quarantine, Settings. Screens with v1-only backends (Insights, Reports, Projects, Recurring, Accounts, Rules/Category managers, AI settings) are **unrouted — not deleted, not replaced with "coming soon" placeholders**; they return as their data grows projections. Settings keeps: sign-out, inbound address + copy, home currency, "add another passkey" (Task 4's `add/*` endpoints), and a sync-status row (last sync, progress, halted reason).
- [ ] `bun run test && bun run build` green. Commit `feat(web): v2 nav — route only projection-backed screens`

---

## Part D — Public deployment (operator-executed, in-session)

### Task D1: Finish the DNS

- [ ] Add `app.sirdab.ae` A → `198.51.100.1`, **DNS-only (grey cloud)**. Cloudflare proxying would break autocert's TLS-ALPN challenge and collapse the per-IP sign-in limiter to a single key, since every request would arrive from a Cloudflare address.
- [ ] **Delete the `MX 20 mx2.sirdab.ae` record** (Decision 4) — it resolves to nothing, and a backup MX that fails to resolve is worse than none: senders fail over to it exactly when mx1 is down.
- [ ] Add `TXT sirdab.ae` = `v=spf1 -all` (this domain receives, never sends) and `TXT _dmarc.sirdab.ae` = `v=DMARC1; p=reject; rua=mailto:<operator>`.
- [ ] Set rDNS/PTR for `198.51.100.1` → `in.sirdab.ae` in the **Hetzner console** (currently the default `static.41.132.104.178.clients.your-server.de`, which hurts inbound reputation).
- [ ] Verify: `dig +short A app.sirdab.ae` → the IP; `dig +short MX in.sirdab.ae` → only `10 mx1…`; `dig +short -x 198.51.100.1` → `in.sirdab.ae`.

### Task D2: PostgreSQL on the primary

- [ ] Enable and start the installed-but-disabled cluster (`postgresql@16-main`, currently `disabled`/`down`). `listen_addresses = 'localhost'` only.
- [ ] Create the database with `ENCODING='UTF8' LC_COLLATE='C.UTF-8' LC_CTYPE='C.UTF-8'` — matching `pgtest`'s cluster locale exactly. A production collation that differs from the test cluster's produces ordering, `LIKE` and index bugs that only appear after deploy.
- [ ] **Two roles, not one:** `ledger_migrate` owns the schema, `ledger_runtime` serves and never owns. This is a security control, not tidiness: `key_history` is append-only *by trigger*, and `ALTER TABLE … DISABLE TRIGGER` needs only ownership — so a single role that both migrates and serves can switch off the guard that peer devices audit for key substitution. Follow the recipe in `internal/v2/pg/migrations/00003_writers.sql`'s header verbatim, including the two easily-missed steps: `GRANT USAGE, SELECT ON ALL SEQUENCES` (a `bigserial` makes every registration fail without it) and `ALTER DEFAULT PRIVILEGES FOR ROLE ledger_migrate … GRANT … ON TABLES/SEQUENCES` (a plain `GRANT ON ALL TABLES` is a snapshot, not a policy, so Task 4's new tables would be unreachable).
- [ ] Apply migrations out-of-band as `ledger_migrate` **before** starting the new binary.
- [ ] Nightly `pg_dump` to `/var/backups/ledger-v2/`, 14-day rotation, plus a pre-deploy dump. **Run backups as root** — `/var/backups` is root-owned, and don't chain the dump under `set -e` with the restart.
- [ ] Verify: `ledgerd verify` exits 0 against the production database.

### Task D3: autocert and the public listener (the one code change in Part D)

**Files:** Modify `cmd/ledgerd/serve.go`, `internal/v2/config/config.go`

- [ ] `config.validate()` currently **refuses any non-loopback `http_listen`**, with a comment naming this task as the change that lifts it. Lift it *only* when TLS is configured: add `[server] tls_domains = []` and `autocert_cache = "/var/lib/ledger-v2/autocert"`; a non-loopback `http_listen` is permitted **if and only if** `tls_domains` is non-empty. Plain HTTP off loopback stays refused — that listener carries a session bearer token on every request and the user's whole op log in its responses.
- [ ] **Do not touch `CheckAdminBind`.** The admin console stays loopback-or-tailnet permanently (spec §3.1): it publishes parsers and merchant mappings to every device and reads diagnostics across all users.
- [ ] Wire `golang.org/x/crypto/acme/autocert` into `runServe` with a `HostWhitelist(app.sirdab.ae, api.sirdab.ae)` and the cache dir at 0700. Keep `:80` bound only for the HTTP-01 redirect if autocert needs it, else use TLS-ALPN-01 and leave :80 closed.
- [ ] Confirm `EnableTestOnly` still refuses `--dev-auth` off loopback — production must be structurally incapable of accepting `dev:` tokens. Add a test asserting exactly that against a `tls_domains`-configured non-loopback listener.
- [ ] `go test ./internal/v2/config/... ./cmd/ledgerd/...` green. Commit `feat(ledgerd): autocert TLS and the public listener rail`

### Task D4: Serve the PWA from ledgerd

**Files:** Create `internal/v2/webui/{embed.go,spa.go}`; modify `cmd/ledgerd/serve.go`, `web/vite.config.ts`

- [ ] Point `web/vite.config.ts` `build.outDir` at `../internal/v2/webui/dist` (it is currently the placeholder local `dist/`, deliberately not v1's `../internal/web/dist`). Gitignore rules follow v1's convention for a committed build artifact.
- [ ] `internal/v2/webui`: `//go:embed all:dist` plus an SPA fallback modeled on `internal/server/spa.go` — unknown `/api/*` must still 404 rather than being swallowed by the fallback.
- [ ] Mount it in `runServe` **after** the API routes, on the same listener, so the PWA and `/api/v1/*` share an origin (no CORS; WebAuthn RP ID `sirdab.ae` covers both hostnames).
- [ ] Verify: `cd web && bun run build && CGO_ENABLED=0 go build -o /tmp/…/ledgerd ./cmd/ledgerd`, run locally, `curl -I http://127.0.0.1:8091/` returns the index and `/api/v1/nope` returns 404.
- [ ] Commit `feat(ledgerd): embed and serve the v2 PWA`

### Task D5: Firewall, systemd, cutover

- [ ] `deploy/ledgerd.service` modeled on `deploy/ledger.service`'s hardened sandbox (`ProtectSystem=strict`, `NoNewPrivileges`, dedicated user, `AmbientCapabilities=CAP_NET_BIND_SERVICE` for :25 and :443). Config `/etc/ledger-v2/config.toml`, secrets `/etc/ledger-v2/ledgerd.env` (0600), state `/var/lib/ledger-v2` (0700).
- [ ] `ufw allow 25/tcp` and `ufw allow 443/tcp` (v4 **and** v6). **Then check the Hetzner Cloud Firewall in the panel** — it is a second layer upstream of the host that ufw cannot see and Phase 0 never inspected. Verify v1 is unaffected: `:8080` stays loopback, `/var/lib/ledger` untouched, tailnet rules intact.
- [ ] Seed templates and confirm: `GET /admin/templates` (over the tailnet) lists **four** published templates — `dib.card.v1`, `dib.account.v1`, `enbd.transfer.v1`, `enbd.alert.v1`.
- [ ] Verify the running process is the new binary by inode/PID, not just that health is green (deploy runbook convention).
- [ ] Verify from **off** the tailnet: `curl https://app.sirdab.ae/api/v1/healthz` returns 200 over a real certificate, and the PWA loads in a browser.

### Task D6: Consent, invites, and the alpha cutover

- [ ] Write the plain-language alpha consent document. It must name, in plain words, the **four Phase-1-only server-side read paths** from the Phase 1 inventory — reprocessing, quarantine re-ingest, sample donation, and parse-rate adjudication — because "we can read your mail during the alpha" is the actual thing being consented to. It must also disclose the **no-backup-MX availability gap** (Decision 4) and the retention/migrate-or-delete commitment at the Phase 3 cutover.
- [ ] Collect a signature from each alpha **before** issuing an address.
- [ ] `ledgerd mint-invite` one code per alpha plus one for the operator.

---

### Task 11: End-to-end gate — the definition of done

**Files:** Create `docs/superpowers/notes/2026-08-07-pwa-e2e-gate.md`

- [ ] **Step 1: the operator's own walk, against the public deployment.** Fresh browser profile → `https://app.sirdab.ae` → invite code → create passkey (Face ID / Touch ID) → bank DIB → address shown → home currency AED → Home renders its empty state.
- [ ] **Step 2: mail becomes a transaction.** Set up a real Gmail forward to the issued address; confirm Google's verification mail appears in the quarantine lane and complete the verification. Then forward a real DIB alert. It arrives from an unallowlisted origin ⇒ **Quarantine**; trust the sender (verified signing domain shown) ⇒ re-ingest ⇒ sync ⇒ **the transaction renders on Home and in Transactions with the correct amount.** A second mail from the now-trusted sender arrives as a normal op.
- [ ] **Step 3: persistence and two writers.** Reload: no re-auth, no full re-pull (cursor persisted), state intact. Categorize in the review deck → reload → it sticks (proving the op round-tripped through the server, not just locally). Sign in from a **second** browser/device with a second passkey (`add/*`), sync, and see both the transaction and the categorization — this is the two-writer path that exercises the writer roster and the I11 checkpoint machinery.
- [ ] **Step 4: the negative checks.** `curl` the admin console from off-tailnet → must fail. `--dev-auth` must be absent from the running unit. v1 still serves over the tailnet and `:8080` is still loopback.
- [ ] **Step 5: record.** Write the gate note: what passed, cold-restore and sync timings, every deviation, and the open follow-ups (backup relay, Phase 3 crypto, rich push). Run `bash scripts/v2-check.sh` → OK. Commit `docs(v2): PWA public deployment E2E gate record`

---

## Self-review notes

- **Coverage of the two decisions:** passkeys replace Apple/Google in Task 4 (server), Task 5 (client), Task 7 (UI), with the `dev:` path preserved for local work and structurally refused in production (D3). Public reachability is D1–D5; invited-alpha scope with consent is D6.
- **Known thin ice, named rather than hidden:** (a) sql.js's `number`-typed INTEGER columns — Task 3 forces a schema read and escalation rather than a local workaround; (b) `platform.ts`'s static `node:` imports leaking into the Vite bundle — Task 2 catches it at build time with the routing-around fix stated; (c) `users.idp`'s CHECK constraint and `SubjectHash`'s non-injective separator — Task 4 Step 1/3 handle both explicitly; (d) the two-role Postgres grant recipe, whose two easy misses fail only in production — D2 names both.
- **Ordering:** Tasks 0–3 are the risk (adapters); Task 4 is the only Go work the client blocks on; 5–10 are UI. Part D is independent of 0–10 until Task 11 and is operator-executed. If the day runs short, Tasks 9–10 compress (Review ships, quarantine confirm moves into Settings as a plain list) and Task 11 Step 3's second-device check may slip; Tasks 0–7 and D1–D5 are not droppable, because without them there is no multi-user product.
