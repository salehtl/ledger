# Device writer enrolment — report

Commit `8365532` on `v2-wip-2026-08-05`, parent `0781256`.
Gate `bash scripts/v2-check.sh` → **exit 0**. `expo export --platform ios` → **exit 0**.

---

## 1. The defect, confirmed

```
$ grep -rn "\.enroll(" app/src client/src | grep -v test
app/src/auth/native.ts:264: * `Client.enroll(writerId)` — challenge, `registrationMessage`, strict base64,   <- a comment
client/src/cli/main.ts:261:      await client.enroll(writer, {                                                <- the only call
```

`ensureWriterId` (`app/src/auth/keys.ts:165`), written for exactly this purpose,
had the same shape: no caller outside its own test.

The consequence is not "one feature is missing". `Client.writerId`
(`client/src/net/client.ts:486`) throws while `ClientState.writerId` is null, and
every authoring path reads it — `Outbox.flush`, `txn_edited`, `txn_categorized`,
`home_currency_set`, splits, `writer_checkpoint`. `bootstrapRuntime`'s launch
sync is the *first* thing to read it, so a device that signed in successfully hit
the throw on its next launch, and `Navigation`'s `fatal` branch rendered the
error's own message:

> Ledger could not safely open this account. no writer selected: run \`cli enroll --writer <id>\`

Two defects in one screen: the app could never enrol, and a product surface was
telling a person to run a command-line tool.

Both are instances the project has seen before — "written, tested green, never
wired" (AGENT-RULES defect shape 2), at instance nine, and the most consequential
so far: **every** suite was green while the app was unusable.

---

## 2. Where enrolment is triggered, and why there

`app/src/auth/enrollment.ts` exports one function, `ensureDeviceWriter(deps)`.
`AppRuntime.ensureDeviceWriter()` (`app/src/app/runtime.ts`) composes it over the
three things only that graph owns: the one `Client`, the persisted `ClientState`
(`store.load()`, **not** the folded projection `client.state()` returns), and the
Keychain.

Two non-test call sites, both on the real post-sign-in path:

| where | file | why there |
|---|---|---|
| launch bootstrap | `app/src/app/bootstrap.ts` — first statement inside the try, **before** `refresh`/`coordinator.run("launch")` | The launch sync is the first reader of `Client.writerId`. It also covers every device that signed in *before* this existed, and every device whose enrolment failed halfway. A sign-in-only trigger would leave those permanently unable to write. |
| the exchange | `app/src/screens/onboarding/SignInScreen.tsx` — inside the `exchanging` effect, between `exchangeOnce` resolving and `dispatch({type:"exchanged"})` | Bootstrap runs once, at mount, *before* there is a session; it does not re-run after sign-in. Without this, the launch on which a user signs in walks straight into onboarding and `commitOnboardingOps` throws on the first op. Dispatching `exchanged` only after enrolment is what keeps "signed in" and "able to author" from coming apart. |

Rejected alternatives:

- **Re-running bootstrap from `onSignedIn`.** It would unmount the whole
  navigator mid-navigation (the `opening` branch renders instead of the stack)
  and hand an enrolment failure to the `fatal` wall.
- **Enrolling inside `Client.login`.** `client/src` is a library the CLI shares,
  where `login` and `enroll` are deliberately separate verbs (`--keygen-only`,
  `--sign-with`, peer enrolment). Fusing them would break the pairing flow.
- **A dedicated onboarding step.** A user cannot act on it, so it is a screen
  that only ever says "wait".

---

## 3. Idempotency, guarded three deep — and none of the guards is a tautology

A device that enrols twice pollutes an append-only roster permanently and orphans
the first writer's chain. AGENT-RULES defect shape 1 asks whether a check is
*measured* or *derived from the thing it checks*, so each guard is named:

1. **The id is minted once and persisted before use.** `ensureWriterId(secrets,
   mint)` writes `SECRET_WRITER_ID` to the Keychain and refuses (rather than
   re-mints) a stored id that no longer validates. Every retry, relaunch and
   second sign-in therefore asks about the *same* id — the roster cannot grow a
   second row for this phone however many times enrolment runs.
2. **The fast path reads the persisted state and the secret store**, not a
   result of the enrolment attempt: `st.writerId === writerId` **and**
   `st.writers.has(writerId)` **and** `secrets.get("writer_key:<id>") !== ""`.
   It makes **no network call**, which is what makes an unconditional call on
   every launch free. (Measured live: runs 2 and 3 of the probe in §7 issue zero
   requests.)
3. **When the fast path misses, the server's roster decides.** This closes the
   window between the server's `204` and `Client.enroll`'s `commit()`: the writer
   *is* enrolled, local state does not know it, and re-registering earns a
   permanent `403 registration_rejected` (`auth.ErrWriterExists`). Seeing our own
   id in the roster, the device calls `Client.useWriter` instead of registering.

Guard 3 compares the **roster's public key** against the one this device holds
(`entry.pubkey` vs `WriterKey.x`, decoded to bytes — standard base64 on one side,
base64url on the other). It does not infer "same id ⇒ same key". They can
genuinely diverge: `writer_id` is not secret and a restored backup could carry it,
while the `WHEN_UNLOCKED_THIS_DEVICE_ONLY` seed cannot. That device is told it
cannot sign (`key_lost`) rather than handed a writer whose blobs nobody can
verify. The server was checked for this: `api.WriterEntry.PubKey` is
`json:"pubkey"` and `internal/v2/api/sync_test.go:975` already asserts it is
non-empty for a device writer and empty for the ingest writer.

A revoked roster row is refused too, rather than re-registered under the same id.

**Nothing here mints a second writer id, regenerates a key for an id the server
knows, or retries by itself.** The only retry is a user pressing something.

---

## 4. What happens when enrolment fails

`ensureDeviceWriter` throws, and the throw is classified once:

- **`401` and `410` travel unwrapped.** They are session answers, not enrolment
  answers, so `bootstrap.ts`'s `classify` (sign out) and `session.ts`'s
  `mayWipeLocalData` (wipe) keep matching structurally on `status`/`code`. In
  `bootstrapRuntime`'s catch, `classify` runs **first** and the enrolment check
  second — reversing that would turn an expired token into a permanent "this
  phone was not accepted" wall with no way back to sign-in.
- Everything else becomes an `EnrollmentError` with a `kind`:
  `offline | unavailable | rate_limited | rejected | revoked | key_lost`. It
  still carries the cause's `status`/`code`, so the rules above cannot be
  bypassed by wrapping.

On the **launch** path the result is a new bootstrap state, `unenrolled`, and a
new screen (`UnenrolledWall` in `Navigation.tsx`, `testID="bootstrap-unenrolled"`)
— deliberately **not** `fatal`, because nothing is fatal: the account is fine, the
data is fine, and for the transient causes one press fixes it. `RuntimeProvider`
gained `retryBootstrap()`, a counter bumped by that press and by nothing else, so
there is no timer and no silent forever-retry. The app is not entered: a device
that cannot author must not be walked into screens whose controls all fail on
touch.

On the **sign-in** path the result is a `failed` dispatch carrying the new
`AuthFailureKind` `"enrollment"`, so the user stays on the sign-in screen with a
banner and both provider buttons live. Pressing again re-runs sign-in and
enrolment; guard 1 makes that adopt this device's existing id rather than mint a
second. The session token *is* already stored at that point, and that is fine —
the next launch's bootstrap will finish the job.

**The retry button only exists when a retry could work.** `offline`,
`unavailable` and `rate_limited` offer it; `rejected`, `revoked` and `key_lost`
do not, because the server would answer identically every time and a button that
always fails is worse than none.

### The copy that replaces the CLI instruction

`client/src/net/client.ts:486` now throws:

> this device is not set up to make changes yet: no writer is enrolled for it

That string is the *internal* one, and it no longer names a tool. What a person
actually sees comes from `enrollmentCopy(kind)` — the single source for both the
launch wall and the sign-in banner, so the two cannot drift. The transient
sentence is:

> **ledger could not finish setting up this phone**
> You are signed in, but registering this phone as one that can make changes needs
> a connection. Nothing was lost. Try again when you are online.

The refusal is the one that has to be careful about honesty: the server answers
every registration rejection with the same bodyless `403`, so the copy may not
claim to know why —

> **This phone was not accepted**
> You are signed in, but the server refused to register this phone as one that can
> make changes, and it does not say why. If another device is already set up on
> this account, adding a second one has to be approved from that device — which
> this beta cannot do yet. Trying again will not change the answer.

A test asserts that **no** sentence in `enrollmentCopy` matches
`/\bcli\b|--writer|`|terminal|command line|enroll/i`, and the mounted tests assert
the rendered tree contains neither `--writer` nor `cli enroll` nor "could not
safely open this account".

---

## 5. Proof that it is wired

### Non-test callers

- `app/src/app/bootstrap.ts` → `runtime.ensureDeviceWriter()`
- `app/src/app/Navigation.tsx` → `deviceSignInDeps({ …, enrollDevice: () => runtime.ensureDeviceWriter() })`
  → `SignInScreen`'s exchange effect

### Mounted renders — `app/src/app/Enrollment.rn-test.tsx` (7 tests)

Nothing in that file stubs `ensureDeviceWriter`. Each case builds the **real**
runtime graph with `createRuntime` (real `sqliteStore`, real `Client`, real
`Outbox`) over an in-memory `SqlDriver` and a fake HTTP server, and mounts the
real `Navigation` inside the real `RuntimeProvider` with the real
`bootstrapRuntime`. Only Apple's sheet is mocked, and it returns a genuine
compact JWS whose nonce claim `runIdpFlow`'s `checkNonceClaim` verifies for real.

| case | what it presses / does | what it measures |
|---|---|---|
| sign-in enrols | presses `sign-in-apple` | one `POST /writers/register`; its `writer_id` equals `secrets.get("writer_id")`; `writer_key:<id>` is a non-empty seed (the exact name `account/deletion.ts:91` and `account/address.ts:177` read); `client.writerId` answers; `deviceIdentity()` (what `SecurityScreen` renders) is non-null |
| failed enrolment holds the line | enrolment offline, then online | stays on sign-in with the true sentence, no "Sign-in failed", zero registrations; second press enrols exactly one |
| launch enrols | seeded session, no writer | `client.writerId` throws *before* mount, one registration after, no `bootstrap-fatal`, no `bootstrap-unenrolled` |
| relaunch does not double-enrol | two runtimes over one driver | still one registration; the second launch does not even read the roster |
| the crash window | rolls `writer_id` back in the persisted state | `adopted`, still one registration |
| the wall recovers | offline launch, then press `enrollment-retry` | `bootstrap-unenrolled` renders, no CLI text, retry enrols and clears |
| the refusal does not lie | server 403s every register | no retry button, "does not say why" on screen, `writerId` still throws |

Two of these use **two** of the thing being counted (two launches, two presses),
per the project's "a fixture with one of something cannot distinguish correct
grouping from no grouping" rule.

### Unit coverage

`app/src/auth/enrollment.test.ts` (20 tests) and the new `launch enrolment` block
in `app/src/app/bootstrap.test.ts` (4 tests).

---

## 6. Mutation testing — 8 written, 8 killed

Each mutation was applied to the working tree, the relevant suites run, and the
file restored from a byte copy taken beforehand.

| # | mutation | verdict |
|---|---|---|
| 1 | delete `await runtime.ensureDeviceWriter()` from `bootstrapRuntime` | **killed** — 4 bun tests + 5 mounted tests fail |
| 2 | delete the `enrollDevice()` await from `SignInScreen`'s exchange | **killed** — 2 mounted tests fail |
| 3 | enrol unconditionally (drop the `already` fast path *and* the roster adoption) | **killed** — 6 unit + 2 mounted tests fail |
| 4 | swallow the enrolment error in `bootstrapRuntime` (`try { … } catch {}`) | **killed** — 3 bun + 2 mounted tests fail |
| 5 | swallow the enrolment error at sign-in (`.catch(() => undefined)`) | **killed** — the "keeps the user on sign-in" mounted test fails |
| 6 | restore `"no writer selected: run \`cli enroll --writer <id>\`"` in `client.ts` | **killed** — the launch-enrolment mounted test fails |
| 7 | give the `rejected` copy `retry: true` | **killed** — 2 unit + 1 mounted test fail |
| 8 | drop the roster/local public-key comparison | **killed** — 1 unit test fails |

**Score 8/8.** No mutation survived, so no test was weakened to make one die.

Mutation 6 is the weakest kill of the set: it dies on the assertion that the
throw's *message* changed, not on a rendered CLI string, because after this change
the raw error can no longer reach the glass through the enrolment path at all —
the wall renders `enrollmentCopy`, never the error. That is the intended design,
and the "no command line in any sentence" test plus the two rendered-tree
assertions cover the surface.

---

## 7. Live verification

Run against a **scratch** `ledgerd serve --dev-auth` on `127.0.0.1:8123` with its
own throwaway Postgres cluster and database — not the operator's server on `:8099`,
which was not touched, restarted or reconfigured. Both were removed afterwards.

The real `ensureDeviceWriter` was driven against it three times in a row, then
once more after rolling local selection back to simulate the crash window:

```
logged in as 2b1f… (dev:enrol-probe-1, invite minted on the scratch DB)
run 1: { status: "enrolled", writerId: "c7c2715f-5345-41e0-804b-185db7601adc" }
run 2: { status: "already",  writerId: "c7c2715f-…" }        <- no network call
run 3: { status: "already",  writerId: "c7c2715f-…" }        <- no network call
keychain writer_id:    c7c2715f-5345-41e0-804b-185db7601adc
keychain seed present: true
client.writerId:       c7c2715f-5345-41e0-804b-185db7601adc  <- used to throw
roster: [{"writer_id":"ingest","kind":"ingest","pubkey":"",…},
         {"writer_id":"c7c2715f-…","kind":"device",
          "pubkey":"81CScdH9ptoS7W2W+DIPDD1CpVSruqR/HyZI7MrICf8=", "revoked_at":null}]
after crash-window rollback: { status: "adopted", writerId: "c7c2715f-…" }
roster after: … still exactly one device writer …
```

Three things this confirms that no fake could:

1. `GET /api/v1/writers` really does carry `pubkey`, populated for a device
   writer and **empty for the ingest writer** — which is why the comparison
   treats an absent/empty key as a legitimate answer rather than a refusal.
2. The real base64url (`WriterKey.x`) ↔ standard-base64 (`pubkey`) round trip
   compares equal.
3. The crash-window path adopts against a real server and leaves the real roster
   at one row.

The `client/test/e2e/roundtrip.test.ts` step of the gate additionally drives
`Client.enroll` against a compiled `ledgerd` over a socket on every run.

---

## 8. What was not changed

- The server's enrolment endpoints, `auth.Writers.Register`, and the three-factor
  proofs used by `account/deletion.ts` and `account/address.ts` — untouched. The
  key is written by `sqliteStore.save()` under `writer_key:<id>`, the id under
  `writer_id`, which is exactly where both already look; the mounted sign-in test
  asserts both names.
- `client/src`'s `Writer` type. The roster's `pubkey` is picked up in `app/` as
  `RosterEntry = Writer & { pubkey?: string }` rather than by editing the shared
  type.
- No money code, so the `int64` / `bigint` invariants are not in play.
- Peer enrolment (`--sign-with` + `--pubkey`, the QR-code flow) is untouched and
  still CLI-only; `ensureDeviceWriter` only ever self-enrols this device.

## 9. Known gap, stated rather than papered over

A **second** device on one account cannot enrol itself: the TOFU bootstrap is
spent, and the peer flow needs the first device to sign the registration — which
this beta has no UI for. That is a pre-existing product gap, not something this
change introduced. What it *does* now do is say so honestly on the glass (the
`rejected` copy) instead of showing a bare 403 or a CLI instruction.

## 10. Numbers

| | before (`0781256`) | after (`8365532`) |
|---|---|---|
| gate exit | 0 | **0** |
| client `bun test` | 2351 | 2351 |
| app `bun test` | 646 | 670 |
| app jest | 21 suites / 111 tests | **22 suites / 118 tests** |
| `expo export --platform ios` | 0 | **0** (5.66 MB hbc; output deleted) |
