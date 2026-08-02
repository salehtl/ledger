# Task 13 — Sign in with Apple and Google

Plan: `docs/superpowers/plans/2026-08-02-v2-phase2-client.md`, Task 13 (line ~1055).
Branch `v2`, worktree `/root/Coding/ledger/.claude/worktrees/v2`.
Commits: **`c777f11`** (code) and the docs commit recording this file.
Base: `4abd77c`.

Steps 1–5 are built. **Step 6 is half-open by construction**: "tests green" is
done, "on-device sign-in against the P3 server succeeds" cannot be — there is no
Mac, no Apple Developer account, no device, and P3 has not run, so nothing is
listening on `:8444`. What that costs is itemised at the end rather than
implied.

---

## What was built

```
app/src/auth/
  idp.ts          providers, scopes, nonces, ID-token decoding, Google config   PURE
  session.ts      failure taxonomy, the wipe decision, the sign-in reducer      PURE
  keys.ts         Keychain key escaping, the accessibility class, writer id     PURE
  native.ts       expo-secure-store + expo-apple-authentication + expo-auth-session
  {idp,session,keys}.test.ts                                                    bun
app/src/screens/onboarding/
  SignInScreen.tsx        the app's initial route
  NotInvitedView.tsx      the 403 not_invited surface
  SignInScreen.rn-test.tsx                                                      jest
app/src/app/Navigation.tsx     SignIn added, and made the initial route
app/src/components/README.md   the screens table + two conventions this screen sets
```

The split mirrors `src/platform/`: **every decision is pure and runs under `bun
test` on this box; `native.ts` is glue with no branch, no encoding, no policy.**
That is the only way any of this is testable here at all.

### What is wired, and where it stops

`Navigation.tsx` makes `SignIn` the **initial route** and hands it
`deviceSignInDeps()`. So the screen is on the glass, not merely written.

`deps.backend` is `null`, deliberately, and the screen says so at first paint
rather than failing at tap time. Constructing a `Client` needs a server base URL
that exists nowhere in this app: P3 has not run, and the tailnet hostname is
deliberately not recorded in this repo (`deploy/README.md` redacts it as
`<tailnet>`). Task 8 landed its sync engine in `client/src/net/engine.ts` and
stopped at the same line — nothing in `app/` instantiates a `Client` today.
Writing one against a URL nobody has is the "written, tested green, never wired"
defect with an extra step, so it is not written; the handoff is one function
argument and is documented at the site.

Because sign-in is the initial route and cannot complete in a serverless build,
the screen carries one escape hatch — "Open the seam checks instead" — rendered
**only while `backend` is null**, so it removes itself the moment a backend
exists and can never ship to an alpha as a way round signing in.

---

## The invite code, and the returning alpha

The requirement is not "the server tolerates a code from an existing account"
(it does — `UpsertUserInvited` ignores the field). It is that a returning alpha
is never **asked**. That is a property of the screen, so it is enforced in two
places and measured in two more.

**The rule:** the first exchange carries no code, and the code field does not
exist in the tree until the server has answered `403 not_invited`.

- `signInReducer`'s `authenticated` transition always produces `inviteCode:
  null`. There is no path from a provider round trip to an exchange carrying a
  code.
- `exchangeOnce` calls `backend.login(idp, idToken)` with **two arguments** when
  the code is null, so the request body has no `invite_code` field at all rather
  than an empty string.

**How it is tested:**

1. `session.test.ts` — a backend that **throws if a code is ever passed**, driven
   through the whole flow, asserting `arguments.length === 2` on every call.
   `arguments.length` is the only thing that distinguishes `login(a, b)` from
   `login(a, b, undefined)`, which is exactly the difference the wire sees.
2. `SignInScreen.rn-test.tsx` — the same backend behind the real screen, then
   `expect(screen.queryByTestId("invite-code")).toBeNull()`. A reducer test can
   prove the state was unreachable; only a render proves nothing put the field on
   the glass anyway.
3. And the case that matters more often than either: a device holding a session
   in the Keychain **never renders the screen**. `hasSession` is read in a lazy
   `useState` initialiser — synchronously, before first paint, so a returning
   user does not see a frame of "sign in" that reads as being logged out. Tested
   by seeding `SECRET_SESSION` and asserting no provider button was ever
   rendered.

Mutation M17 (ask for a code before any exchange) and M20 (always carry a code)
are both caught; M33 (invite field always rendered) and M34 (ignore the stored
session) are caught by the render tests.

The `403` surface keeps two arrivals distinct, which a single branch got wrong
in the first draft and a test caught: arriving with **no** code shows a blank
field and no error; arriving with a **rejected** code keeps what was typed and
says the code is the problem. Retyping a whole code because of a typo in its last
character is how somebody gives up on an alpha. And a `401` while the code is
being typed — Apple's identity token is short-lived — returns to sign-in with
"Nothing was lost", because re-submitting a code against a dead token fails
forever.

`NotInvitedView` offers **no waiting list**. The plan's step says to offer one;
there is nothing to offer. `00012_waitlist.sql` is `waitlist(bank, demand,
first_seen, last_seen)` — a bank-demand counter with no users in it — and no
endpoint accepts a person. A button that posted nowhere is Decision 10's
recovery-phrase lie in a smaller font, so the copy says where a code comes from
instead. **Recorded as a deliberate under-delivery.**

---

## Apple's hashed nonce — and a server gap this surfaced

Handled entirely on the client, as instructed. `expectedNonceClaim(idp, nonce)`
returns `hex(sha256(nonce))` for Apple and `nonce` for Google; the raw nonce is
what is sent to the provider and what is stored. `checkNonceClaim` compares the
token's claim against the expected shape **on the device**, before the token
reaches the exchange, so a reply belonging to a different authorize call is
caught locally where "press it again" genuinely fixes it — rather than coming
back as an opaque 401.

`observedNonceShape` exists because this cannot be run on a phone here: it
*measures* which of the two shapes came back and names it in the error. The two
readings of Apple's documentation that circulate disagree on whether Apple
hashes the value or embeds it verbatim, and both produce the same claim when the
client passes the raw value. If the plan's reading is wrong, the first device log
says `raw` in one word instead of a silent mismatch.

Sign-in's nonce is minted locally (`newNonce`), in **exactly** the encoding the
server's challenge endpoints hand out — standard base64 of 32 bytes — because
`api/addresses.go` re-encodes its challenge with `StdEncoding` and compares
against that spelling. So the day a sign-in challenge store lands, only the
source of the string changes. There is deliberately **no** `serverNonceSource()`
helper: the re-auth screens do not exist, and the seam they need is the `nonce`
**parameter** on `authenticate(nonce)`, which already exists.

### The gap, stated rather than papered over

Task 13 Step 2 says `auth.VerifyOpts.Nonce` "must compare `SHA-256(issued)`
against Apple's claim and `issued` against Google's, selected by provider", and
assigns that to Task 6 Step 1. **It is not in the tree.**
`internal/v2/auth/idp.go:481,570` does a `subtle.ConstantTimeCompare` of
`opts.Nonce` against the claim with no per-provider branch, and
`api/addresses.go` sets `opts.Nonce` to the raw challenge. Task 6's report does
not mention Apple or hashing at all.

Consequence, precisely: on `POST /api/v1/address/rotate` and `DELETE
/api/v1/account`, an Apple re-authentication presents `hex(sha256(C))` where the
server expects `C`, and **it can never match** — no client can produce a raw
nonce whose SHA-256 is a value someone else chose. Google is unaffected. Sign-in
is unaffected (it binds no nonce).

**I did not touch the server**, per the dispatch and because relaxing the
server's comparison to make a client test pass is the exact failure mode the plan
names. The fix is one per-provider branch on the server, at two call sites.
Pinned here so it cannot be forgotten:

- `idp.test.ts`: *"Apple's expected claim is never the nonce itself — the re-auth
  gap, pinned"* asserts `expectedNonceClaim("apple", C) !== C`, with a comment
  saying that if a later commit makes this fail, either Apple stopped hashing or
  somebody "fixed" the client to send the hash **as** the challenge, and the
  second is a forged challenge rather than a fix.
- `APPLE_REAUTH_GAP` is the sentence as a value, so a screen can explain it.

**Whoever owns Tasks 26/27 must not build Apple re-auth against today's
server.**

---

## `410 account_deleted` versus an expired-session `401`

One function, `mayWipeLocalData(err)`, is the only thing in the app permitted to
say a wipe is authorized. It requires **both** halves:

```ts
http.status === 410 && http.code === "account_deleted"
```

- **Not the status alone.** A future `410` on this endpoint would otherwise
  inherit a destructive meaning nobody granted it.
- **Not the code alone.** A body is the part an intermediary can most easily
  rewrite; a proxy answering `401 {"error":"account_deleted"}` would be able to
  wipe a device.
- **Never a bare `401`.** That is what every routine token expiry looks like,
  including one that happens while a user is offline with a full outbox.

Matched **structurally** (`{status, code}`) rather than with `instanceof
ApiError`: Metro keeps one copy of `client/src` today
(`disableHierarchicalLookup`), but a class-identity check fails silently if that
ever stops being true.

Tested across all four crossings of `{401, 410} × {account_deleted, other}`,
plus a `TypeError`, a `null`, a bare string and an object whose `status` is the
*string* `"410"`. Mutations M14 (410 alone), M15 (code alone) and M16 (401 →
account_deleted) are all caught.

`clearSession` drops the session token **and nothing else** — the writer key
survives a sign-out, because a device that regenerated its identity key on every
sign-out would fork its own chain (M22 catches the over-broad version). The
database half of an account-deleted wipe belongs to the store and to Task 26's
deletion path; this file does not pretend to be it.

---

## The Google reversed client ID

Kept absent, as instructed — and wired so it **cannot be half-filled**, which is
the failure the dispatch actually describes:

- `GOOGLE_IOS_CLIENT_ID` in `idp.ts` is `null`.
- `app.json` has no `CFBundleURLTypes` entry.
- `idp.test.ts` **reads `app.json` from disk** and asserts the two agree in both
  directions: if the constant is null there must be no
  `com.googleusercontent.apps.*` scheme, and if it is set the scheme must be
  exactly `reversedClientId(GOOGLE_IOS_CLIENT_ID)`. Filling one without the other
  fails a test on this box instead of a tap on a phone. Mutation M11 (a
  plausible placeholder client id) is caught by exactly this.

**The failure is loud and early**: `googleConfig()` returns `null`,
`googleAuthenticator()` returns `null`, and the screen renders the Google button
**disabled with the reason on it at first paint** — not omitted (a missing
feature nobody notices until App Review) and not live (fails only under a thumb).
M35 (button live with no client id) and M37 (no-server banner hidden) are caught.
An Apple-only build is shippable: the App Store rule runs the other way — Apple
is required *if* another provider is offered.

`reversedClientId` refuses `".apps.googleusercontent.com"` with an empty client
half, which would otherwise produce the scheme `com.googleusercontent.apps.` —
a scheme every Google app matches (M09).

`NEEDS-SALEH.md` §1b is updated with what to fill and where. **It is not in the
commit: the file is untracked in this worktree** (`git ls-files` does not know
it), so adding it would sweep another session's unstaged file. The edit is on
disk.

---

## The Keychain

**`WHEN_UNLOCKED_THIS_DEVICE_ONLY`**, for the session token and the device
identity key.

- `..._THIS_DEVICE_ONLY` is the non-negotiable half: without it the item rides an
  encrypted iCloud backup onto a different phone, which is exactly the "device
  Keychain (not synced)" spec §3.4 forbids. (Not the device *wrap* key, which is
  synced and is Phase 3.)
- `WHEN_UNLOCKED` over `AFTER_FIRST_UNLOCK` because **nothing in Phase 2 reads
  either value while the device is locked**: push is content-free (§3.8), the
  user taps it, the app foregrounds, the phone is unlocked by definition.
  `AFTER_FIRST_UNLOCK` would widen the window in which a phone seized
  locked-but-once-unlocked yields the writer key, and buys nothing this phase
  spends.

**On the undecided floor (open item 10, `NEEDS-SALEH` §8):** this choice is safe
at *any* plausible floor — the constant has existed since iOS 4 — so sign-in is
no longer blocked on that decision, and §8 now says so. The constant that *would*
have been floor-sensitive is `WHEN_PASSCODE_SET_THIS_DEVICE_ONLY`, rejected for a
different reason: on a phone with no passcode the item cannot be written at all,
so a passcode-less alpha would meet a Keychain error instead of an explanation.
**Flagged:** if background sync while locked is ever wanted, the *session token*
— never the identity key — moves to `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`.

It is applied as `SecureStore[KEYCHAIN_ACCESSIBILITY]`, a computed access, so a
typo fails `tsc` rather than silently reading back the SDK's default
(`WHEN_UNLOCKED`, which *is* iCloud-backed). `keys.test.ts` reads `native.ts` as
text and fails if any accessibility constant is hard-coded beside it (M31).

### A device-only crash this found: `SecretStore`'s colon

`sqliteStore` writes writer keys under `SECRET_WRITER + <writer id>` =
`"writer_key:01J…"`. `expo-secure-store` refuses any key outside `/^[\w.-]+$/`
(`build/SecureStore.js:152`) — **a colon is not in that set**. Unescaped, the
first `save()` after enrolment throws `Invalid key provided to SecureStore`, and
only ever on a device: every other `SecretStore` in the tree is a `Map` or a
file.

`keychainKeyFor` escapes injectively — `_` + two hex digits per UTF-8 byte for
everything outside `[A-Za-z0-9.-]`, including `_` itself, which is what makes it
reversible. The naive `replace(":", "_")` maps `writer_key:X` and `writer_key_X`
onto one key: two writers' private seeds in one Keychain slot, i.e. signing blobs
with a key the roster does not name. M24 (naive replacement) and M25 (`_` left
unescaped) are both caught by a pairwise-distinctness test over the exact
colliding names.

`SecretStore.set(name, null)` writes `""` — there is no synchronous delete in the
SDK and `Store.save()` is synchronous all the way down (Decision 3). The value is
destroyed (the item is updated in place), `get` maps `""` back to `null`, and
`hasSession` knows about it rather than assuming a clear leaves nothing behind
(M21). `purgeAsync` does real deletion where the caller can await.

### The write no transaction covers (Task 5's flag, checked)

`sqliteStore.save()` writes the Keychain **first** and the database second
(`sqlite.ts:208-226`), and `Store.transaction` cannot cover the first. That
ordering is the safe one for the common case — a crash between them leaves an
orphan secret, which `load()` ignores because it only reads `d` for writers the
state names.

**One direction is not safe**, and it is written down in `keys.ts` for whoever
wires enrolment: `save()` also *clears* the private half of any writer the new
state has dropped. Inside a transaction that later rolls back, the database keeps
the writer and the Keychain has lost its key, so `decodeState` refuses the state
("writer X has no usable key") and the device needs re-enrolment. It is narrow —
it needs a writer removal and a rollback in the same save — and it is not this
task's to fix (`client/src` is Task 5's), but it is the one destructive,
non-rollbackable write in the store.

---

## Writer enrolment (Step 4) — what is mine and what already existed

Built: `ensureWriterId(secrets, mint)`, the **stable per-install** id, minted
once, written **before** it is returned (a key used to enrol and then lost to a
crashed process is a writer the server knows and this device can never sign for
again — M27 catches the reordered version), validated against
`writers_writer_id_charset` (`^[A-Za-z0-9._-]{1,64}$`, mirrored from
`00003_writers.sql:32`), and **refusing** rather than silently re-minting a
stored id that no longer satisfies it (M26).

Not built, deliberately: the network call. `Client.enroll(writerId)` already does
challenge → `registrationMessage(nonce, writerId, pub)` → Ed25519 → register, and
I verified its base64 is strict on both halves (`unbase64` refuses anything
outside `^[A-Za-z0-9+/]*={0,2}$`; `platform().toBase64` emits standard base64) —
which is Phase 1's `--pubkey` lesson already applied. `registrationMessage`
matches Go's `signingMessage` byte for byte (domain ‖ nonce ‖ 0x00 ‖ id ‖ 0x00 ‖
pub). Calling it needs a `Client`, which needs a server URL that does not exist.
Writing that call blind is the defect two earlier tasks correctly refused; the
handoff is documented in `native.ts`.

---

## Tests

```
cd app && bun test src        →  144 pass / 1 pre-existing flake (below)
cd app && bun test src/auth   →   75 pass, 0 fail, 216 expect()   [0.26s]
cd app && bun run test:rn     →   15 pass, 0 fail (11 new)        [8.7s]
cd app && bun run typecheck   →   clean
cd app && bun run bundle      →   exit 0 — Metro resolves expo-apple-authentication,
                                  expo-auth-session and expo-secure-store
```

`bun run bundle` matters more than it looks: it is the only thing on this box
that proves `native.ts` is in a graph Metro can build, since no test can import
it.

**The one red line, and it is not mine.** `src/platform/platform.test.ts` →
*"the cap is refused during inflation, not after it"* times out at the 5 s
default under load. It inflates a 32 MiB buffer eight times. Measured:

| tree | runs | result |
|---|---|---|
| pre-existing files only (`src/platform src/host-globals src/metro-config`) | 3 | **3/3 fail** |
| whole suite including my files | 3 | 2/3 fail |

It fails *more often without my files than with them*, so it is box contention,
the same family as the `fx.test.ts` note in AGENT-RULES. **The timeout was not
raised.**

### `bash scripts/v2-check.sh` — exits 1, on a test this task does not touch

Run twice: once in the shared worktree, and once at **my own commit `c777f11`**
in a clean `git archive` export with `client/node_modules` copied in, which
removes every other session's uncommitted work.

Both exit **1**, both on the same single test:

```
client/src/invariants/stream.test.ts
(fail) a whole-log check holds a chunk, not the log — and the measurement can
       see the difference   [6,666 ms]  ^ this test timed out after 5000ms
2,217 pass / 1 fail
```

That test arrived with **Task 12** (`306a3e9`). My commit adds files under
`app/` only (`git show --stat c777f11`), and `v2-check.sh` does not run `app/`
at all, so the `client/` tree in the export is byte-identical to the base
commit's. Isolated, at the base commit, it fails **3/3** at 7.65 / 7.77 / 8.26 s.

It is a wall-clock ceiling on a **2-core box carrying load average 6.7** from the
concurrent sessions — everything runs roughly threefold slow. That is the
`fx.test.ts` situation AGENT-RULES describes, and two sibling commits from other
sessions are the same cleanup (`d296bc3 test(v2): make the retention measurement
survive a busy box`, `08cdf1e test(v2): drop two wall-clock ceilings from the
categorization suite`). **I did not touch it and did not raise the timeout.** It
belongs to whoever owns `stream.test.ts`; the honest statement here is that the
gate is red at my commit for a reason that is not this task, evidenced rather
than asserted.

---

## Mutation testing — 38 written, **38 caught**

Runner: `scratchpad/task13/mutate.py` — applies one defect, runs `bun test
src/auth` (or `bun run test:rn` for the screens), reverts, and refuses any
anchor that is not unique.

| | |
|---|---|
| `idp.ts` | M01 Apple nonce unhashed · M02 Google nonce hashed · M03 nonce length guard dropped · M04 base64url nonce · M05 token size cap dropped · M06 array payload accepted · M07 segment count unchecked · M08 mismatch not raised · M09 empty Google client half · M10 Gmail scope added · M11 placeholder client id · M12 flow skips the nonce check · M13 base64url not translated |
| `session.ts` | M14 wipe on any 410 · M15 wipe on the code alone · M16 401→deleted · M17 invite asked first · M18 every failure opens the invite screen · M19 rejected code loses the draft · M20 always carry a code · M21 empty token is a session · M22 sign-out drops the writer key · M23 empty code submittable |
| `keys.ts` | M24 naive colon replacement · M25 `_` unescaped · M26 invalid id re-minted · M27 id returned before stored · M28 charset widened · M29 writer keys dropped from the wipe list · M30 empty name allowed |
| `native.ts` | M31 iCloud-syncable class · M32 unescaped Keychain key |
| screens | M33 invite field always rendered · M34 stored session ignored · M35 Google button live · M36 buttons below 44 pt · M37 no-server state hidden · M38 invite input below 16 pt |

**The first run was 36/38, and both survivors were faults in my tests, not in the
bar.** Fixed the tests:

- **M07** — every "not three segments" case in the test also failed a *later*
  check (a one-character payload is not a legal base64 length), so `< 2` passed.
  The test now asserts the message `/segments/` against tokens whose payload is
  genuinely well formed.
- **M13** — no test payload contained base64url's 62nd or 63rd character, so
  removing the `-`→`+`, `_`→`/` translation changed nothing. This one is worth
  naming: with the translation gone, `fromBase64` (strict, deliberately) refuses
  those characters, so **every real Apple and Google token would be rejected as
  malformed** — 100 % sign-in failure on a device and 0 % here. The test now
  carries a hand-built vector (`x~xx?` puts `~` and `?` at the third byte of
  their groups, the only place ASCII can reach index 62/63) whose base64url
  really does contain `-` and `_`.

Re-run after the fixes: **38/38**.

---

## What is unexercised without a device

Everything in `native.ts`, in full, plus the three things above it:

- **No native call has ever run.** `AppleAuthentication.signInAsync`,
  `SecureStore.getItem/setItem/deleteItemAsync`, `AuthRequest.promptAsync` and
  `exchangeCodeAsync` are held up by `tsc` against the pinned SDK 54
  declarations, by two source-reading tests over the two things most likely to be
  silently wrong (the Keychain class, the key escaping), and by Metro building
  them into a bundle. That is not the same as having run them.
- **Apple's actual nonce shape is unconfirmed.** The client implements the plan's
  reading (Apple hashes) and *measures* what comes back, so one device log settles
  it. If the other reading is true, the fix is one line in `expectedNonceClaim`
  and the test that pins it.
- **`ERR_REQUEST_CANCELED`** is the string `expo-apple-authentication` is
  documented to throw; that it is what iOS 18/26 actually throws is unverified.
  Getting it wrong shows a red failure for a deliberate dismissal.
- **The whole Google leg** — no client id exists, so the authorize call, the
  custom-scheme return and the PKCE code exchange have never been near a browser.
- **The Keychain's real behaviour**: that `""` overwrites rather than appends,
  that `getItem` reads back an item written under
  `WHEN_UNLOCKED_THIS_DEVICE_ONLY`, and that the escaped key is accepted, are all
  read off the SDK's source and docs.
- **`bun run test:rn` is jsdom.** No keyboard, no safe-area insets that are not
  supplied by the test, no real 44 pt. The v1 lesson — *measure laid-out geometry,
  don't eyeball it* — has no equivalent here yet; `harness/audit.mjs` is a web
  tool and this is React Native. The touch-target and font-size assertions read
  the **style objects**, which catches a regression in the value and cannot catch
  a layout that clips.
- **Step 6's second half**: no sign-in has been performed against a real
  `ledgerd`, because P3 has not run.

## Handoffs

1. **Server (whoever owns Task 6's follow-ups):** add the per-provider nonce
   branch — `SHA-256(issued)` for Apple, `issued` for Google — at
   `api/addresses.go` and `api/account.go`. Until then Apple cannot rotate an
   address or delete an account.
2. **Whoever constructs the app's `Client`:** pass it to `deviceSignInDeps(...)`
   and call `Client.enroll(ensureWriterId(keychainSecretStore(), ulid))` once.
   Both seams exist and are type-checked.
3. **Task 14:** `SignIn` is the initial route; the step machine wraps it.
   `onSignedIn(userId | null)` is the entry point, `null` meaning "a session was
   already on this device".
4. **Saleh:** `NEEDS-SALEH.md` §1b — the two Google placeholders must be filled
   together, and a test enforces it.
