# Fix round — content-free push (`internal/v2/pushv2`)

**Responds to:** `task-30-critic.md` (which, per its own §0, reviews **Task 29**'s
code — `internal/v2/pushv2/`, delivered by `21ce0a8`. Task 30 is server-side
reprocess and remains unreviewed by that critic.)

**Date:** 2026-08-01. **Branch:** `v2`.
**Scope:** C1 and I2–I8. Minors N11–N16 addressed where they were part of a
Critical/Important fix; the rest are recorded below with reasoning.

---

## What was preserved, deliberately and exactly

The payload contract is untouched. A notification is still

```json
{"to":"<expo token>","title":"New transaction","body":""}
```

and `Notify(ctx, userID)` still has no parameter through which an amount,
merchant, currency, bank, count or transaction id could travel.
`TestPushPayloadIsContentFree` is unchanged and still pins the payload as an
exact three-key map. Mutants M01–M05, M14 and M24 remain caught, and the new
`TestTheAccessTokenNeverRidesInTheBody` adds a *second* exact-payload assertion
on the path where a credential is configured — the one the original test never
covered (I6).

No field was added to the payload. No test was weakened.

---

## C1 — a revoked, signed-out or handed-on device kept receiving forever

**Closed.** `push_tokens` now names both revocable things, and both revocation
paths sweep it.

`internal/v2/pg/migrations/00019_push_token_device_link.sql`:

| column | why |
| --- | --- |
| `writer_id` **NOT NULL**, FK `(user_id, writer_id) → writers` | key revocation deletes by it |
| `session_hash` **NOT NULL**, FK `→ sessions(token_hash)` | sign-out deletes by it |
| `id uuid` UNIQUE | the handle a user deletes a device *by* |

Sweeps, each **inside the caller's existing transaction** so the revocation and
the silence commit together (`auth.forgetPushTokens`):

- `auth.Writers.Revoke` → `DELETE … WHERE user_id = $1 AND writer_id = $2`
- `auth.Sessions.Revoke` → `DELETE … WHERE session_hash = $1`
- `auth.Sessions.RevokeAllForUser` → `DELETE … WHERE user_id = $1`

User-facing routes (`internal/v2/api/push.go`, mounted unconditionally):

- `GET /api/v1/push/tokens` — **the route without which deletion was
  unreachable.** Returns `{id, token_prefix, platform, writer_id, created_at,
  current}` newest-first, plus `max`. `current` marks the row the *calling*
  session registered, so a user with two iOS rows can tell which one is the
  phone in their hand. The token itself is returned only as a 12-character
  prefix: a listing that returned whole tokens would hand every device target
  this user has to anything holding a session, and a token is exactly what
  Expo's public send endpoint accepts as a target.
- `DELETE /api/v1/push/tokens/{handle}` — matches the token **or** the row id,
  because a client knows its own token and a user with a stolen phone has only
  the id. Both user-scoped; still 204 for an unknown handle (no oracle).
- `DELETE /api/v1/push/tokens` — the panic button. Every device the user still
  holds re-registers on its next launch, so over-deleting costs one app open.

Registration now **requires** a `writer_id` naming a live, non-revoked `device`
writer of the calling user. Nullable would have been a link the first client to
forget the field silently opts out of; there is no deployed client to break
(push has been disabled since the table was created), so the contract is set now
while it is free. The ingest writer is refused too — it is the server's own, has
no key and therefore no revocation ceremony, so a token pinned to it would be
unrevocable by construction: the same hole, reintroduced through a
client-chosen value.

**The false claim is corrected, not left in place.**
`00010_push_tokens.sql`'s "recoverable by the user who still has the device" now
carries an explicit CORRECTION paragraph saying it was false as implemented and
pointing at 00019.

**Account deletion:** confirmed still swept. `purge` discovers relations from
`pg_class` by the presence of a `user_id` column, which `push_tokens` still has,
so it remains classified as user-scoped and `purge_test.go:404` still lists
`public.push_tokens`. The new FKs add a second cascade path (users → sessions →
push_tokens) which is harmless. The purge seeder was updated to plant the two
new links, because a row without them is a shape the schema no longer admits.

**Migration clears the table.** `writer_id`/`session_hash` are NOT NULL and
existing rows cannot be backfilled — nothing recorded which device registered
them. Clearing is provably free here: push has never been enabled, no client
exists, and registration is an upsert performed on every launch, so any row
deleted would be re-created *correctly linked* the next time its app opened. A
backfill with an invented writer_id would have produced exactly the unrevocable
row the migration exists to make impossible.

---

## I2 — the cap dropped the user's *newest* device

**Fixed on both sides, and made visible.**

- Fan-out order is now `ORDER BY created_at DESC, token DESC`
  (`pushv2.fanoutOrder`), so the cap's casualty is always a device the user
  stopped using.
- The cap is now enforced at **INSERT** (`api.evictPushTokensOverCap`) using the
  identical ordering expression, so the table cannot exceed 20 rows at all and
  the two enforcement points cannot disagree about who is kept.
- `maxDevicesPerUser` → exported `pushv2.MaxDevicesPerUser`, so there is one
  constant rather than two that drift.
- Not silent any more, in three places: eviction logs how many rows it forgot;
  `tokens()` selects `cap+1` and logs when a user exceeds the cap; and
  `GET /push/tokens` publishes `max` so a client can show the limit.

`created_at` is still deliberately not refreshed on re-registration — that is
what keeps "newest" meaningful.

---

## I3 / I4 — the config had no push rails

`Config.validate()` now has a push clause (`validatePush`):

- `push.enabled = true` with no `LEDGER_EXPO_ACCESS_TOKEN` is **refused**, and
  the message names the variable. Expo's send endpoint accepts unauthenticated
  POSTs until a project opts into enhanced security, so without the token anyone
  who learns a user's push token can write an arbitrary title and body to that
  lock screen. pushv2's content-free guarantee bounds what *this server* sends;
  it cannot bound what the channel can display.
- `push.expo_url` must be **https** and must name an Expo host (`exp.host` /
  `expo.dev` or a subdomain). Checked **whenever it is set**, not only when push
  is enabled: a wrong value sitting inert in a file until somebody flips a
  boolean is precisely the failure this function exists to refuse.

I did not wire a test-only override. Nothing in the repo needs one — every push
test constructs `pushv2.Expo` directly with an `httptest` endpoint and never
goes through `config.validate`.

---

## I5 — Expo receipts: **deferred to Phase 2, with the gap documented**

Not implemented, and the reasoning is in the package doc rather than only here.
Expo's model is two-phase: the ticket answers the POST, the *receipt* — fetched
later from `/push/getReceipts` by ticket id — is where APNs/FCM report an
uninstall. Implementing it means persisting ticket ids, a poller, and an error
taxonomy that can only be verified against the live service. No test in this
repo has ever contacted `exp.host` and none should start; Phase 2 ships the
client, turns push on, and is the first point at which the behaviour can be
observed rather than guessed.

What it costs is now stated plainly in `push.go`: an uninstalled app leaves a row
that is POSTed to on every append forever, wasting one request each time. It is
no longer a *privacy* problem, which is the part that mattered — a token is now
deleted on key revocation, on sign-out, on sign-out-everywhere, from the user's
own device list, by the insert-time cap, and on account deletion. Uninstall is
the one disowning gesture with no server-side signal, and an uninstalled app
renders nothing.

The **proved** half (M08) is fixed now: `TestATransientExpoErrorKeepsTheDevice`
pins that only `DeviceNotRegistered` is permanent, across
`MessageRateExceeded`, `MessageTooBig`, `InvalidCredentials` and an empty error.

---

## I6 / I7 — tests that passed for the wrong reason

- **I6:** `TestTheAccessTokenNeverRidesInTheBody` runs *with* `AccessToken` set
  and asserts both that the secret is absent from the body and that the payload
  is still exactly three keys.
- **I7:** `TestANon2xxIsDetectedEvenWhenTheBodyIsWellFormed` sends **429 with a
  valid `{"data":[{"status":"ok"}]}` body** — the case the old test could not
  distinguish, because its 500 body had no `data` key and so failed in the
  receipt decoder instead. It asserts the log names the status code and that the
  token survives (a rate limit is not a dead device).

---

## I8 — no rate limit, no row cap

`PushPerUser` (1/min sustained, burst 20, 4096 keys) now covers registration and
both deletes on one budget, matching `AddressPerUser`/`AccountPerUser`'s
reasoning. `GET` is deliberately **off** the budget: a user who has just been
rate limited must still be able to see which devices are notified. The row cap
is `evictPushTokensOverCap` (see I2).

---

## Minors

- **N13 (package doc silent on timing):** fixed. `push.go`'s doc now has a
  "What the one rule does NOT cover: timing" section stating what Expo, APNs and
  FCM learn — the precise moment of every transaction, the source IP, the
  project credential — and **N14**, that the jitter-free sequential fan-out lets
  Expo group a user's devices by timing alone. It also says not to "fix" that by
  delaying, since §3.8 requires immediacy.
- **N16 (the migration's injection rationale is wrong):** superseded. 00019's
  comment states the real reason the column is bounded.
- **N15 (delete handler did not validate its token):** now moot — the handle is
  matched against `token OR id::text` in one user-scoped statement.
- **Not done, and why:** **N9** (push on the SMTP critical path with a 5 s
  budget) and **N10** (no batching) are both changes to the ingest pipeline's
  call site, which is `internal/v2/ingest/` — under active edit by other
  sessions this round, and out of the scope I was given. Both are performance,
  not correctness: neither can lose a transaction. **N11** (`platform` is
  write-only) is now half-answered — `platform` is returned by
  `GET /push/tokens`, so it has a reader. **N12** (`Platforms` is a mutable
  package-level slice) left as is; cosmetic.

---

## Mutation results

Battery: the critic's **nine survivors**, re-run verbatim, plus **sixteen new
mutants**, one per fix. Script: `scratchpad/pushfix-9f3c/mutate.py`, applied to
an isolated worktree (see below).

**25 / 25 caught. 0 survived.**

| # | Mutant | Was | Now | Killed by |
| --- | --- | --- | --- | --- |
| M06 | the Expo access token is ALSO put in the JSON body | survived | **caught** | `TestTheAccessTokenNeverRidesInTheBody` |
| M07 | the 20-device fan-out cap is removed | survived | **caught** | `TestTheFanoutCapKeepsTheNewestDevices` |
| M08 | ANY receipt error deletes the token | survived | **caught** | `TestATransientExpoErrorKeepsTheDevice` |
| M12 | a token-store read failure is swallowed | survived | **caught** | `TestATokenReadFailureIsReturned` |
| M16 | the zero-user guard is removed | survived | **caught** | `TestNotifyRefusesAnUnusableConfiguration` |
| M19 | a non-2xx is treated as success | survived | **caught** | `TestANon2xxIsDetectedEvenWhenTheBodyIsWellFormed` |
| M20 | `Content-Type` is not set | survived | **caught** | `TestTheRequestIsWellFormedForExpo` |
| M21 | the nil-pool guard is removed | survived | **caught** | `TestNotifyRefusesAnUnusableConfiguration` |
| M22 | the 64 KB response bound is removed | survived | **caught** | `TestAnOversizedExpoResponseIsBounded` |
| N01 | revoking a writer does not forget its tokens | — | caught | `TestRevokingAWriterStopsThatDevicesNotifications` |
| N02 | revoking a session does not forget its tokens | — | caught | `TestRevokingASessionStops…`, `TestARevokedSessionsDeviceIsNotNotified` |
| N03 | sign-out-everywhere does not forget tokens | — | caught | `TestSignOutEverywhereStopsEveryDevicesNotifications` |
| N04 | fan-out order back to ASCENDING | — | caught | `TestTheFanoutCapKeepsTheNewestDevices` |
| N05 | insert-time cap not enforced | — | caught | `TestRegistrationEnforcesTheDeviceCapKeepingTheNewest` |
| N06 | insert-time cap evicts the NEWEST | — | caught | same |
| N07 | registration accepts any writer_id | — | caught | `TestATokenMustNameALiveDeviceOfTheCallingUser` |
| N08 | registration accepts a REVOKED device | — | caught | same |
| N09 | registration accepts the ingest writer | — | caught | same |
| N10 | delete handle not user-scoped | — | caught | 3 tests |
| N11 | delete-all not user-scoped | — | caught | `TestDeletingEveryDeviceIsOneCall` |
| N12 | the listing returns whole tokens | — | caught | `TestTheDeviceListIsWhatMakesDeletionReachable` |
| N13 | push routes are not rate limited | — | caught | `TestPushRoutesAreRateLimited` |
| N14 | push enabled with no access token | — | caught | `TestEnablingPushWithoutTheAccessTokenIsRefused` |
| N15 | expo_url may be cleartext http | — | caught | `TestExpoURLIsRailed` |
| N16 | expo_url may name any host | — | caught | `TestExpoURLIsRailed` |

**Honesty note on M06.** The first form of this mutant did not compile
(`err` redeclared against the named return), so its "caught" was worthless. It
was rewritten to compile and re-run on its own; it then failed on the assertion,
with the leak visible in the output:
`{"accessToken":"expo-secret-do-not-leak","body":"","title":"New transaction","to":"..."}`.
Every other mutant's kill is backed by a named `--- FAIL` line in
`scratchpad/pushfix-9f3c/mutation.log`.

M23 (re-registration bumps `created_at`) still does not apply — the surrounding
code changed again — and remains excluded, as in the original review.

---

## Verification

The shared worktree was transiently **red** for the whole of this round:
another session's in-flight edit to `internal/v2/origin/inner.go` did not
compile, which blocks `internal/v2/api` transitively. Everything below was
therefore run in a **private detached worktree** at `bf565c6` with only this
session's thirteen files copied in.

```
go clean -testcache && bash scripts/v2-check.sh
```

All 27 Go packages pass, including `cmd/ledgerd`. On the first run one
TypeScript test — `client/src/replay/fx.test.ts`, "incremental application in
seq order equals a full re-fold from 0" — timed out at 6.17 s against a 5 s
budget while several sessions' suites shared the box. Re-run alone it passes in
4.21 s (51 pass, 0 fail). This change touches no TypeScript at all.

---

## Files

- `internal/v2/pg/migrations/00019_push_token_device_link.sql` (new; 00018 was
  taken by another session's in-flight work)
- `internal/v2/pg/migrations/00010_push_tokens.sql` (comment correction only)
- `internal/v2/pushv2/push.go`, `push_test.go`
- `internal/v2/auth/session.go`, `writer.go`, `push_revocation_test.go` (new)
- `internal/v2/api/push.go`, `api.go`, `push_test.go`
- `internal/v2/config/config.go`, `push_test.go` (new)
- `internal/v2/purge/purge_test.go` (seeder only — the new NOT NULL links)
- `config.v2.example.toml` (push section only)

## What remains for Phase 2

1. **Expo receipts** (I5) — persist ticket ids and poll `/push/getReceipts`, so
   an uninstalled app's token is reaped. Needs the real service to verify
   against. Documented in `push.go`.
2. **A logout route.** `Sessions.RevokeAllForUser` still has no non-test caller;
   the sweep is wired and waiting for it. `DELETE /push/tokens` covers the
   user-facing need in the meantime.
3. **The spec gap the critic named** (§3.8 ties push to nothing revocable). The
   implementation now goes further than the spec; the spec should be updated to
   say a push token is revoked with its device.
4. **Disclosure surface.** The timing side channel is now stated in the package
   doc; §2 still has no *user-facing* owner for it.
