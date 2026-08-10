# Fix wave — final-review findings (1 Critical, 3 Important, 3 Minor)

Base: `e74f971`. Branch `v2-wip-2026-08-05`. Every finding in
`final-review.md` is addressed; nothing is deferred.

**Gate:** `go clean -testcache && bash scripts/v2-check.sh > /tmp/fw-gate.log 2>&1; echo $?`
→ **0**. Go all-green, client 2351 tests / 35 files, app **636 bun** (was 591)
and **20 jest suites / 102 tests** (was 18/92), `config-check` resolves.
**`expo export --platform ios` → exit 0** (5.65 MB iOS bundle);
`/tmp/fwcheck` deleted, `df -h /` = 82% used, 14G free.

**Mutation score: 13 deliberate defects planted, 13 killed.** One mutation
survived on the way and the *test* was fixed rather than the bar lowered — see
C1 below.

---

## C1 (Critical) — down → up → down silently skipped 100 rows

`app/src/lib/transactions.ts`, `app/src/screens/transactions/TransactionsScreen.tsx`

### What was wrong

`prependTxnWindow` trims from the tail to hold `MAX_RETAINED_TXNS`, so a
recovery scroll *unloads* rows below the window. The screen updated `rows` on
that branch and left `cursor`/`exhausted` alone, so the next `onEndReached`
resumed from a row that was no longer the bottom: `t0149 → t0250`, a hundred
rows gone with no marker, no spinner, no error. Worse, if the list had already
paged to the end, `cursor` was `null` and `onEndReached` was a permanent no-op
(`if (cursor !== null)`), so the evicted tail was unreachable for the life of
the screen.

### The fix, and why it is shaped this way

The review's diagnosis is the part that mattered: *the tests verified two
correct helpers and a correct query, and never composed them with the state
sitting between them*. So the state between them stopped existing as a separate
thing. `rows`, `cursor` and `exhausted` are now **one value** (`TxnWindow`) moved
by **one pure function** (`advanceTxnWindow`), and the screen holds one
`useState` instead of three. It is no longer possible to update the rows without
the transition also deciding what the cursor is.

The prepend arm asks the question **of the rows**, not of an arithmetic identity
over lengths:

```ts
const tail = rows[rows.length - 1];
const before = prev.rows[prev.rows.length - 1];
if (tail === undefined || before === undefined || tail.id === before.id) return { ...prev, rows };
return { rows, cursor: cursorOf(tail), exhausted: false };
```

"Is the bottom row still the bottom row?" — measured, not derived. That change
came out of a surviving mutation (below), not out of taste.

### The continuity assertion

`TransactionsScreen.rn-test.tsx`, new test **"down, back up, then down again
never skips a row — the window stays continuous across the whole walk"**. It
drives the real component through the real `FlatList` callbacks: 4 × down,
2 × up, 3 × down, over 350 rows with `PAGE_SIZE=50` / `MAX_RETAINED_ROWS=150`.
After **every single interaction** it does two separate things:

1. `expectContiguousWindow` — the retained window equals `all.slice(first,
   first + n)`: an unbroken run of the fixture, in the fixture's order, no
   index skipped.
2. records every index the list has held into a `Set`.

Then, at the end:

```ts
const indexes = [...seen].sort((a, b) => a - b);
expect({ from: low, count: indexes.length }).toEqual({ from: low, count: high - low + 1 });
expect(indexes.length).toBeGreaterThan(MAX_RETAINED_ROWS);
```

The union of everything ever shown is itself contiguous — `min..max` with
nothing missing inside it. (2) is measured separately from (1) on purpose: every
individual window can be well-formed while the walk *between* them jumps, which
is exactly the defect. The last line stops the whole thing being true by
construction: if the walk never exceeded the retained bound, nothing was ever
evicted and contiguity is vacuous.

A second test, **"recovers the tail after the list has already reached the end
of the account"**, covers the worse variant: page to exhaustion (`cursor` null,
summary drops "so far"), scroll up until the oldest row is evicted, then scroll
down — the row must come back. Pre-fix that loop changed nothing at all.

### Mutations (4/4 killed)

| mutation | result |
|---|---|
| A — never rewind the cursor on prepend (the original defect, restored) | **KILLED** by both new screen tests. The two *pre-existing* tests still passed, which is the direct measurement that the old suite could not see this. |
| B — rewind to the wrong end (`rows[0]` instead of the tail) | **KILLED** (1 jest + 1 bun) |
| C — keep the stale `exhausted` flag | **KILLED** by the tail-recovery test's "so far" assertion |
| D — append arm ignores `page.next` | **KILLED** (2 jest + 1 bun) |

**One mutation survived and was fixed properly.** With the first implementation
(`evicted = prev.length + page.length - rows.length; if (evicted === 0)`), an
off-by-one (`- 1`) survived the entire screen suite: every page there is exactly
50 rows, so every eviction is 50 at a time and a *single*-row skip is invisible
to it. Two responses, both taken: the production code now compares tail
identity so the off-by-one is not expressible, and
`transactions.window.test.ts` gained the single-row boundary case
(`advanceTxnWindow` with `MAX_RETAINED_TXNS` rows and one newer row) plus the
no-eviction and append/replace cases. The screen test is where the composition
is proved; the boundary the screen's page size cannot reach is proved one level
down, and the file says so.

---

## I1 (Important) — client and server disagreed on what a bank name is

`app/src/lib/bank.ts` (new), `internal/v2/admin/testdata/bank_names.json` (new),
`app/src/samples/source.ts`, `app/src/screens/onboarding/BankScreen.tsx`,
`internal/v2/admin/waitlist_test.go`

### Which side I changed, and why

**The client.** The server's grammar stays exactly as it was.

The narrow grammar is not drift, it is a documented decision enforced in two
places. `00012_waitlist.sql` argues it at length: this is the one column in v2
storing free user-authored text outside the op log and quarantine, the narrow
shape is what stops a demand counter becoming a suggestion box or a place a
pasted transaction line lands, and the migration states the consequence outright
— *"a bank name written in Arabic is REFUSED, not stored."* The grammar is
repeated as a `CHECK` constraint precisely so a row Go would refuse is a row the
database refuses. Widening it costs a migration against a live `CHECK`, a second
grammar to keep in sync, and re-opens the paste hole `amountRe` exists to close
— to buy punctuation the operator does not need in order to answer "write which
parser next".

So `app/src/lib/bank.ts` mirrors `admin.NormalizeBank` step for step: Go's
whitespace set (not JS `\s` — Go splits on U+0085 and JS does not; JS trims
U+FEFF and Go does not), `strings.Fields` + `Join` semantics, lower-case, then
**byte** length via `TextEncoder`, then `amountRe`, then the shape.

### They are held together by a shared fixture, not by two copies

`internal/v2/admin/testdata/bank_names.json` — 33 cases, 15 accepted / 18
refused. `internal/v2/admin/waitlist_test.go`'s
`TestTheClientAndServerAgreeOnWhatABankNameIs` drives them through
`NormalizeBank`; `app/src/lib/bank.test.ts` drives the same file through
`normalizeBankName`. A grammar change made to one side fails the other side's
suite. Both halves also assert the fixture has ≥5 of each verdict, so a table
that drifted to one-sided (and would pass against a constant-returning
function) fails loudly.

The fixture carries the byte-vs-codepoint trap the dispatch names (33 × U+00E9 =
33 code points, 66 bytes), NEL/NBSP/ideographic space, exactly-64 and 65 bytes,
NUL and ESC, and the reported `Mashreq (UAE)`.

### The user is never dead-ended — three separate things

1. **Refused before the request**, with the rule attached:
   `BANK_NAME_RULE` = *"Letters, digits, spaces and & . ' - only, up to 64
   characters. Write "Mashreq", not "Mashreq (UAE)"."* It says what to type,
   not just what went wrong, and the byte-length refusal reports **bytes**
   ("66 bytes of 64") because a user shortening by one character otherwise
   fails again.
2. **The rule is on the glass before anything is refused** (`bank-name-rule`),
   and the field borders warning-coloured while the draft would not be accepted.
3. **"Continue without adding it"** (`bank-skip`) advances the step with no
   request at all. This is the path for names the grammar genuinely cannot
   represent — Arabic, an en dash, a Turkish dotted I — where no retyping helps.

And **a failed request no longer gates onboarding**: `join` now advances on
network/server failure, surfacing the server's own `detail` (which was being
discarded in favour of the status code) with a message that does not claim the
bank was recorded. `BankScreen.rn-test.tsx`'s "does not advance … when the join
fails" was inverted to assert the opposite — that was the review's must-fix, and
the old assertion was the defect written down.

A client-grammar refusal is the one ending that does not advance by itself, and
deliberately: it is one edit from correct, and advancing would throw away a
demand signal the user was about to give. The escape hatch is on the same screen.

### Known residual, recorded rather than discovered

Go's `ToLower` is Unicode's *simple* case mapping; JS's is the *full* one. They
differ for U+0130 (`İ` → `i` in Go, `i`+U+0307 in JS), so `İstanbul Bank` is
accepted by the server and refused here. The direction is the safe one — the
client is stricter, so it is a correctable message rather than an invisible 400 —
and `bank.test.ts` pins it with a named test.

### Mutations (3/3 killed)

| mutation | result |
|---|---|
| E1 — client grammar widened to accept parentheses | **KILLED**, 4 fixture cases |
| E2 — client length measured in code points, not bytes | **KILLED**, the 33×U+00E9 case |
| E3 — **server** grammar widened to accept parentheses | **KILLED**, Go conformance FAIL |
| E4 — `join()` skips the local grammar check | **KILLED** by `samples/source.test.ts` ("sends nothing"). Note: `BankScreen.rn-test.tsx` stayed green, correctly — the screen validates independently, so the two layers are separately guarded. |
| E5 — `BankScreen` does not advance when the join fails | **KILLED** |

---

## I2 (Important) — the splash asset was 248×512

`app/assets/splash.png`

Confirmed the review, not the earlier report: `identify` read
`PNG 248x512 … 16-bit sRGB 471801B`. At `resizeMode: contain` on a 1290×2796
iPhone that is a ~5.2× upscale — a blurred first screen — and 16-bit depth is
why 248×512 cost 471 KB.

Regenerated with ImageMagick `convert` from
`frontend/public/manifest-icon-512.jpg` (verified `JPEG 512x512`): a
1290×2796 canvas filled with the artwork's own field colour `srgb(46,28,210)`
(sampled from the source, so the composite is seamless) with the 512×512 logo
centred at native resolution — no upscaling of the artwork at all. On a
1290×2796 device `contain` is an exact 1:1 fit; every shipping iPhone in the
beta range is within 0.001 of that aspect ratio.

**Real `identify` output for the new file:**

```
app/assets/splash.png PNG 1290x2796 1290x2796+0+0 8-bit sRGB 335473B 0.000u 0:00.000
```

1290×2796, 8-bit, 335,473 bytes — 28% smaller than the 248×512 file it replaces.
`app.json`'s `expo-splash-screen` plugin config is untouched: the review
verified that shape is correct and the image was the defect.

---

## I3 (Important) — the deletion copy rendered nowhere

`app/src/app/Navigation.tsx`, `app/src/screens/onboarding/SignInScreen.tsx`,
`app/src/app/RuntimeDestructive.rn-test.tsx`

`navigation.reset` unmounted `DeleteAccountScreen` before `setNotice` could
paint, so `deletionResultCopy`'s two branches — the `204` and `410` sentences,
the whole point of making that copy truthful — reached no user. A route param
survives the reset; screen state does not. So the sentence now **travels with
the reset**:

```tsx
navigation.reset({ index: 0, routes: [{ name: "SignIn", params: { notice: deletionResultCopy(result).body } }] });
```

`RootStackParamList.SignIn` becomes `{ notice?: string } | undefined`, and
`SignInScreen` renders it as a banner (`sign-in-notice`) above the failure
banner and the provider buttons — and also in the session-restoring branch,
since arriving there at all is the exceptional case worth explaining.

Coverage of every ending:

- **204** → reset + the "Your account is deleted…" sentence on SignIn.
- **410 account_deleted** (challenge or DELETE) → reset + the "already
  deleted elsewhere" sentence on SignIn.
- **401 / other-410 / other-2xx / 500** → no reset, `deletionFailureCopy` on
  `DeleteAccountScreen`, which is where it always rendered and still does.
- **wipe throws after a confirmed deletion** → see M1; no reset, on the delete
  screen, because the user has something to do about it.

**Proved by mounted render, after the reset.** `RuntimeDestructive.rn-test.tsx`
reads the sentence out of the rendered tree once `sign-in-apple` is present and
`delete-account-screen` is `null` — not from a setter having been called:

```tsx
expect(screen.getByText(deletionResultCopy({ outcome: "deleted", wiped: true }).body)).toBeTruthy();
expect(screen.queryByText(deletionResultCopy({ outcome: "already_deleted", wiped: true }).body)).toBeNull();
```

The 204 case needed the Apple authenticator mocked (deletion's third factor is a
fresh IdP credential and jest cannot open Apple's sheet); **only** the
authenticator is replaced — the Keychain seam, the nonce and the ed25519
signature over `deletionMessage` are all still production code. The 410-on-
challenge case needs no mock at all, because it short-circuits before that round
trip.

### Mutations (2/2 killed)

| mutation | result |
|---|---|
| E6 — the reset carries no notice (the original defect) | **KILLED**, 2 destructive tests |
| E7 — `SignInScreen` drops the notice it is handed | **KILLED**, 2 destructive tests |

---

## M1 (Minor) — a throwing `wipeAccount` after a 204 said two false things

`app/src/account/deletion.ts`

`opts.wipe()` closes the driver, deletes the database and purges the Keychain;
any of the three can reject. That rejection reached `deletionFailureCopy`'s
fallthrough — *"Your account was not deleted. Your data remains on this
device."* Both false: the server deleted, and the local database may be partly
gone. Covered by none of the eight cases in `deletion.test.ts`, because every
one of them has a wipe that succeeds.

New `LocalWipeError` carries the **confirmed outcome** (`deleted` /
`already_deleted`) and the underlying cause, and `deletionFailureCopy` handles
it first:

> Your account is deleted. Everything the server held for you is gone and it
> cannot be brought back. This device could not finish erasing its own copy, so
> some of your ledger may still be stored here — delete and reinstall ledger to
> remove it.

It is a **third** state, not a rephrasing of either existing one — the server
erased and this device did not — so the eight-case invariant table was
deliberately *not* stretched to hold it. Instead a separate test drives both
confirming endings (204, 410) with a throwing wipe and asserts: the error is a
`LocalWipeError`, its `outcome` matches the server's answer, `copy.wiped` is
false, the body contains **none** of `was not deleted` / `remains on this
device` / `are untouched`, and it does say the account is gone and names the
action. The `RuntimeDestructive` mounted test asserts the same sentence is on
screen with the delete screen still mounted (no reset — this device is not
clean, so sweeping the user to sign-in would be wrong).

**Mutation E8** — rethrow the wipe failure plain: **KILLED** (1 bun + 1 jest).

---

## M2 (Minor) — no error boundary anywhere in `app/`

`app/src/components/ErrorBoundary.tsx` (new), `app/src/app/Root.tsx`,
`app/src/components/ErrorBoundary.rn-test.tsx` (new),
`app/src/app/Root.rn-test.tsx` (new)

`BudgetScreen` calls `source.read(nowMs)` synchronously during render and the
money guard `exact()` fails **closed** by throwing. That guard keeps its teeth
— it is untouched — but failing closed into a blank white tree with no message
and no way back is not the right ending. Added `ErrorBoundary` (a class, because
`getDerivedStateFromError` has no hook equivalent) at the app root, **inside**
`ThemeProvider` so the fallback is themed and **outside** everything else so it
catches any screen. It renders the error text verbatim (that message is the
whole diagnostic — `budget/source.ts` names the column that failed) plus a
"Try again" that re-mounts the subtree, which is the right offer when the cause
is a projection mid-rebuild.

Two proofs, deliberately different:

- **It works** — mounted render of the **real `BudgetScreen`** with a source
  whose read throws the guard's own sentence; asserts `app-error-boundary`,
  the guard text, and the retry control are on screen; then flips the source to
  healthy, presses retry, and asserts the boundary is gone and
  `budget-rebuilding` (the screen's own honest state) is showing.
- **It is wired** — `Root.rn-test.tsx` renders the **real `Root`** (the
  component `index.ts` hands to `registerRootComponent`) with `RuntimeProvider`
  mocked to throw, and asserts the fallback is on screen. This is the
  "written, tested green, never wired" guard: a boundary is an especially easy
  thing to leave dangling, because everything looks fine until something throws.
  `react-native-safe-area-context`'s own jest mock is used because the real
  provider renders *nothing* until it has measured and `initialWindowMetrics` is
  null under jest; everything below it is the real tree.

**Mutation E9** — remove `<ErrorBoundary>` from `Root.tsx`: **KILLED** by
`Root.rn-test.tsx`, and `ErrorBoundary.rn-test.tsx` correctly stayed green,
which is the measurement that the two tests guard different things.

---

## M3 (Minor) — dead code

Both removed rather than wired; neither is promised to users by the spec.

- **`donationConsent()`** (`app/src/samples/source.ts`) — returned
  `DONATION_CONSENT`, which `DonateSheet.tsx` and `lib/redaction.ts` both import
  directly. A second name for one constant, with no caller at all. Deleted, with
  a comment recording what it was.
- **`DictionarySource.version()`** — no non-test caller. Removed from the
  interface and the implementation. The cursor it exposed is a real property
  worth asserting, so `dictionary/source.test.ts` now asserts it against
  `dictionaryCursor(db)` — the store function the sync path itself calls — which
  is a stronger assertion than one against an accessor kept alive by its own test.

---

## Not touched, on purpose

- **The exact-money path.** `CAST(SUM(...) AS TEXT)` + `exact()` is untouched;
  the review verified it still has teeth against an int64-max fixture and it
  keeps them. The `ErrorBoundary` is the *response* to that guard tripping, not
  a softening of it.
- **`app.json`'s splash config.** The review refuted the plugin-override
  suspicion and the shape is correct. Only the image changed.
- **The server bank grammar and `00012_waitlist.sql`.** See I1 for why.
- **M5 (white splash background under a dark theme)** and **M6** are on the
  review's deferred list, not in this dispatch's scope, and are unchanged.

## Verification commands, verbatim

```
go clean -testcache && bash scripts/v2-check.sh > /tmp/fw-gate.log 2>&1; echo $?   # 0
cd app && EXPO_PUBLIC_LEDGER_SERVER=https://example.test bunx expo export \
  --platform ios --output-dir /tmp/fwcheck                                          # 0
rm -rf /tmp/fwcheck; df -h /                                                        # 82%, 14G free
identify app/assets/splash.png   # PNG 1290x2796 ... 8-bit sRGB 335473B
```
