# ledgerd (v2) — operator runbook

You are the operator, the only developer, and alpha #1. This box also runs v1,
which you use every day. This document assumes you are reading it at 2am because
something stopped working, so the troubleshooting section is at the bottom and
is the part worth bookmarking.

Everything here is derived from the code on branch `v2`, not from the plans.
Where the code and a plan disagree, the code wins and this file says so.

---

## 0. Status: v2 is NOT deployed

As of 2026-08-01, on this box:

| Thing | State |
|---|---|
| `/etc/ledger-v2`, `/var/lib/ledger-v2` | **do not exist** |
| `ledgerd.service` | **does not exist** (`deploy/` has only v1's `ledger.service`) |
| Running services | `ledger.service` (v1) only |
| PostgreSQL 16 | installed, cluster `16/main` **down** |
| `tailscale serve` | `/` → v1 on `127.0.0.1:8080`; `:8443` → `/srv/ledger-storybook` |

So nothing below is "check the running system" — it is "here is how the binary
behaves when you run it". Everything in §1–§7 is **ready to run** today against
a Postgres you point it at. What is **not** done is the D-series (§8).

### The live edge you are carrying right now

`in.sirdab.ae MX 20 → mx2.sirdab.ae` is published and **does not resolve**
(verified with `dig` on 2026-08-01: `MX 10 mx1.sirdab.ae → 178.104.132.41`
answers, `mx2.sirdab.ae` returns nothing). This is harmless while mx1 is up and
*actively harmful* the moment it is not: a sending MTA that fails over to a
non-resolving backup retries a dead host instead of deferring cleanly against
the primary. Today the record is worse than having no backup MX at all.

Two fixes, either is fine: provision the relay (task D3) or **delete the MX 20
record** (task D1, one minute, strictly improves things). See
`docs/superpowers/NEEDS-SALEH.md` item 4.

---

## 1. The subcommands

`cmd/ledgerd/main.go` dispatches on `os.Args[1]` **before** flag parsing. The
dispatch table is `modeHandlers`, and `checkModeHandlers()` panics at the top of
`main()` if it ever disagrees with `config.Modes()` — so the list below cannot
silently drift.

```
serve  relay  verify  seed-dictionary  seed-templates
purge-user  record-consent  parse-rate  mint-invite
```

Nine modes. Note two things:

- **There is no `ledgerd import`.** CSV/XLSX backfill is a *v1* subcommand
  (`ledger import`). v2 ingests over SMTP only.
- **The mode comes first**, always. `ledgerd serve --dev-auth` works;
  `ledgerd --dev-auth serve` is refused outright (not ignored) with
  `unexpected argument "serve": the mode comes first (…)`.

There is **one global `FlagSet`**, not one per mode, so there is no
`ledgerd purge-user --help`. `ledgerd -h` prints every flag in the binary
annotated with which modes read it, exits 1, and **does not list the modes** —
to see those, run an invalid mode name.

### `serve`

Opens the Postgres pool, applies migrations, seeds templates, then runs four
listeners/loops until SIGINT/SIGTERM:

- HTTP sync API on `server.http_listen` (plain HTTP, loopback-only — §2)
- SMTP receiver on `mail.smtp_listen` (public `:25`, DKIM/ARC verified)
- Admin console on `server.admin_listen`, **only if `LEDGER_ADMIN_TOKEN` is set**
- Three hourly sweeps: quarantine expiry, donated-sample retention, dictionary
  submission retention. Each runs once at startup and then hourly; each is its
  own loop so one dying cannot stop the others. A sweep error is logged and the
  loop continues.

Health: `GET /api/v1/healthz` → `200 {"status":"ok","db":"ok"}`, or
`503 {"status":"degraded","db":"down"}`. It is a 503 and not a sad-field 200
deliberately — the status line is the part a checker reads.

Two **test-only** switches, with no TOML key and no env override, refused unless
`http_listen` is loopback (`config.EnableTestOnly`):

- `--dev-auth` — accepts `dev:<subject>` as an ID token and **rejects every real
  Apple/Google token**. It replaces the verifiers rather than joining them, so a
  deployment that left it on fails every genuine sign-in instead of working
  perfectly *and* accepting `dev:anyone`. Logged as a banner on every start.
- `--dns-fixtures <dns.json>` — a recorded TXT map served as the DKIM/ARC
  resolver. Loaded and validated at startup, so a bad path fails the process
  rather than surfacing later as a DKIM error that looks like a crypto bug.

> `config.v2.example.toml` still says `--dns-fixtures` is loaded and *nothing
> consumes it*. That comment is stale — `runServe` now hands the resolver to the
> ingest pipeline, and Tasks 24/25 landed.

### `seed-templates`

Publishes the four embedded bank templates — `dib.card.v1`, `dib.account.v1`,
`enbd.transfer.v1`, `enbd.alert.v1` — into the `templates` table.

**It also runs automatically inside `runServe`**, immediately after the
migrations and before any listener opens. That is deliberate: a subcommand alone
reproduces the original defect one level up, because it only works if somebody
remembers, and forgetting is silent (see §9 "Nothing parses on a fresh
install"). A seed failure is **fatal to the start**.

Idempotent by version comparison, not by existence: re-running publishes only
what is strictly newer, so a hand-authored fix at a higher version is never
retired by the seed's own v1. The standalone command is still worth having —
it is how you apply a bumped seed without a restart.

### `mint-invite`

```bash
ledgerd mint-invite --note "who this is for"   # prints ONE code to stdout
ledgerd mint-invite --show                     # lists hashes, never codes
```

> ## ⚠ THE CODE IS PRINTED ONCE AND IS NOT RECOVERABLE
>
> Only its **SHA-256** is stored. There is no command, no query and no backup
> that can recover the plaintext code. If you close the terminal without copying
> it, that code is gone — mint another.

This gates **account creation only**; existing accounts sign in without one and
never spend one. Single-use, redeemed in the same transaction as the account.
The code goes to **stdout alone on its own line** and the warning goes to
stderr, so `ledgerd mint-invite --note x | pbcopy` copies the code and not a
sentence.

`--show` lists each row as `<hash-prefix>  minted <ts>  OUTSTANDING|redeemed …
<note>`. A code redeemed by an account you later purged shows as "redeemed by a
since-deleted account" (`ON DELETE SET NULL`).

### `parse-rate` — the ship gate

This is the instrument for spec §5's "≥95% of transaction emails parse". It has
two halves because the numerator is a query and **the denominator is a
judgement**: `parse_diagnostics` stores no content, so nothing in the schema
knows whether an unparsed message was a bank alert or a newsletter.

```bash
ledgerd parse-rate --from 2026-08-01T00:00:00Z --to 2026-08-15T00:00:00Z
ledgerd parse-rate --from … --to … --adjudicate     # interactive, READS MAIL
ledgerd parse-rate --from … --to … --json           # machine-readable
```

**It exits non-zero when the gate fails.** A tool that prints "gate: false" and
exits 0 is not machine-checkable — a deploy script or release checklist reading
only the status code would be told everything was fine. Three distinct failures:

| Situation | Exit | Message |
|---|---|---|
| messages still unadjudicated | 1 | `N message(s) still need a verdict; run again with --adjudicate` |
| gate not met | 1 | `the exit criterion is NOT met: <reasons joined by "; ">` |
| gate met | 0 | — |

`--json` emits the whole `ParseRateReport`, including:

```json
"gate": { "passed": false, "reasons": ["the 95% lower bound is 0.9312, below 0.95"] }
```

`gate.passed` is what `MeetsGate()` returns — a precomputed field, so the JSON
and the method can never disagree. `gate.reasons` is **accumulated, not
short-circuited**: all six checks always run, so one invocation tells you
everything that is wrong.

**The comparison is the Wilson 95% lower bound, never the point estimate.**
`GateThreshold = 0.95` is tested against `LowerBound`; the field `rate` is
deliberately not consulted. When the whole population was adjudicated,
`LowerBound == Rate` exactly and the distinction is invisible — it only bites
once the run **sampled** (`DefaultSample = 200`; the sample is
`ORDER BY ingest_id` — SHA-256 of the body — so it is uniform *and* stable, and
not chronological, which would invalidate the interval).

**The floors.** Both are gate reasons in their own right:

- `MinimumWindow = 336h` (14 days). Below it the criterion is not assertable at
  all — an earlier exit record printed a green gate over a **two minute**
  window. Reason: `the window is <span>; the criterion is two consecutive weeks (336h0m0s)`.
- `MinimumMessages = 100`, measured against `Denominator()`. Reason:
  `N message(s) in the window is below the 100 needed for the number to be stable`.

**The sub-gates**, because an average hides both failures a beta cares about:

- **Per account** (`MinimumUserMessages = 20`): an account with ≥20 messages
  whose own rate is under 0.95 fails the gate by itself. Four accounts at 130
  clean messages plus one at 27 failures averages to 0.9506 and used to pass.
  Accounts under 20 messages are printed as `(too few messages to judge)` and
  cannot contribute a reason.
- **Per week** (fixed 7-day slices from `--from`): every week must clear 0.95 on
  its own — 0.90 then 1.00 averages to a pass and is not two weeks above the
  line. **There is no minimum-message rule for weeks**, and an empty week scores
  `0.0000`, so a 14-day window with all its traffic in week 1 fails with
  `the week from <date> parsed 0.0000 of its 0 message(s)`. That is working as
  designed; widen or move the window.

**Adjudication.** `--adjudicate` prints a banner and then **shows you the
content of users' mail** — it is the one exception to `internal/v2/verify`'s
absolute "reads no content" rule, exists only because Phase 1 stores cold bodies
in plaintext, and is deleted at the Phase 3 cutover. Per message you answer
`[t]ransaction / [n]ot transactional / [u]nreadable / [q]uit`. A mistyped answer
loops rather than guessing. `q` (or EOF) stops and **keeps** what was recorded.

How a verdict moves the number:

| Verdict | Effect |
|---|---|
| `transaction` | stays in the denominator, **drags the rate down** |
| `non_transactional` | leaves the denominator entirely — neutral |
| `unreadable` | counted **against** the rate |

`unreadable` counting against you is the load-bearing choice: a body nobody
could read is not assumed harmless, otherwise the metric would improve every
time the cold stream got harder to read. A message whose body cannot be fetched
is auto-recorded as `unreadable` without asking.

**Verdicts are append-only, with an operator recorded.** Migration `00018` adds
a `bigserial` id, an `operator` column, and triggers that raise `check_violation`
on `UPDATE`, on `TRUNCATE`, and on `DELETE` while the user row still exists (the
carve-out lets an account purge cascade). Re-judging inserts a *superseding*
row; the live verdict is the highest id. The motivating number, recorded in both
the SQL and the Go: flipping six of ten verdicts moved a reported rate from
**0.9000 (fail) to 0.9574 (pass)**, leaving ten rows and no trace.

The report prints the audit trail unconditionally: who adjudicated and how many,
then `verdicts revised  N superseded, M changed the answer`, with each change
flagged `<- RAISES the rate` when it moved off a denominator verdict. That is
not an accusation — a first pass over an unfamiliar bank *should* be revised —
it is the subset to read first. Set `LEDGER_OPERATOR` before adjudicating;
otherwise it falls back to `$USER`, and an empty value records as
`(unattributed)` rather than refusing (refusing would push you toward editing
the table by hand, which is what the trigger exists to stop).

Finally, printed on every run: **`this is parse COVERAGE, not correctness: a
template that matches and extracts the wrong amount counts as a success here.`**

### `verify` — the accounting and structural check

```bash
ledgerd verify                       # default window: last 14 days, all users
ledgerd verify --user <uuid> --json
```

Runs two halves; **both always run and both are always printed**, and it exits
non-zero on any finding from either, so it is the thing a deploy or a cron can
gate on. It deliberately does **not** apply migrations — a tool that migrates the
database it is about to audit has changed the thing it is measuring. Against an
unmigrated database it fails with a missing relation, which is the correct and
visible answer.

**A finding is an accounting or integrity statement that did not hold.** It is
not a warning. Findings never echo a value taken from a blob — only the position
the *row* claims — because this runs against real users' mail.

*Structural* (per user, over both the hot and cold streams). Note the package
doc still says "four invariants"; there are **five**:

| ID | Means |
|---|---|
| `S1_seq_dense` | holes *between* surviving ops — a botched repair or partial restore |
| `S2_ingest_chain` | the hash chain does not verify **from the stored bytes** (counter jump, prev-hash not the head, or a blob whose own bytes do not produce its recorded hash) |
| `S3_aad_matches_row` | a blob was sealed for a different position than the row it occupies |
| `S4_bucket_valid` | blob length disagrees with `size_bucket`, or the bucket is not one of the seven rungs |
| `S5_counter_matches_head` | `oplog_seq.next_seq` ≠ `max(seq)+1` — **the only invariant that can see mail that is GONE rather than out of order**, since a truncated *tail* is perfectly dense to S1 |

`S2` reports at most one finding per chain and then resynchronizes, so one
tampered blob does not report a break on every row after it — the difference
between a restore and an investigation. Output stops at 2000 findings with a
`truncated` pseudo-finding.

*Accounting* (over the window) asserts:

```
inbound_total = appended + quarantined + rejected + over_quota + duplicate + unaccounted
```

`unaccounted` is excluded from `ArrivalSum()` on purpose — that is what makes
the equation a statement with content rather than one that balances by
construction. Three finding conditions, none of which read the window's totals:

- `A1_unaccounted_row` — rows carry an event/outcome pair this build cannot
  classify. The equation cannot close over a row nobody can name.
- `A2_quarantine_untraced` — messages recorded as held are in neither
  `quarantine` nor `quarantine_removals`. A `BEFORE DELETE` trigger makes that
  impossible on the normal path, so **something bypassed it**.
- `A3_duplicate_of_nothing` — mail refused as a duplicate of something this
  server does not have. A duplicate is a *claim* that we already kept the
  message; where the claim is false the message was discarded.

The quarantine reconciliation is computed over **all time**, not the window (a
message held in January and expired in March is reconciled by neither month
alone), and `untraced`/`extra` are independent set differences rather than a
subtraction — subtracting let one lost message and one benign missing
diagnostics row cancel out, disarming the only genuine cross-store check.

`GET /admin/accounting` runs the identical arithmetic, so the shell and the
browser cannot disagree.

### `purge-user`

```bash
ledgerd purge-user --user <uuid> --dry-run     # ALWAYS do this first
ledgerd purge-user --user <uuid>
ledgerd purge-user --retention-due --dry-run
ledgerd purge-user --retention-due
```

Exactly one of `--user` / `--retention-due`; both or neither is refused **before
any database connection is opened**, so a mistyped destructive command fails
against its arguments and not against whatever DSN was in the environment.

This is the *operator's* path, gated on having a shell on the box — which is the
strongest gate available and the only one that works for a user who has lost
every device. The **user's** own path is `DELETE /api/v1/account`, and *that* is
what carries three-factor authorization:

1. a live session — which account is being talked about, and nothing else;
2. a fresh ID token from the account's IdP, resolving to the same user and
   minted within `reauthMaxAge` (5 min);
3. an Ed25519 signature by an enrolled, non-revoked device key over a single-use
   nonce from `POST /api/v1/account/challenge`.

Every authorization failure is the same empty 403, so a caller cannot learn
which factor they still need. A *purge* failure is loud and different — 500,
saying the account was **not** deleted.

**`runServe` starts no retention timer, deliberately.** It sweeps quarantine and
donated samples on a ticker; it will not delete an account unattended. With a
handful of alphas, no in-app deletion UX, and a deadline that can be extended by
re-consenting, a timer that removes accounts is a footgun with no upside — you
running the command is exactly the property an automated sweep gives up.

**It refuses entirely if any relation is unclassified.** `purge.Classify` reads
`pg_class` (not `information_schema`, which cannot see materialized views, is
scoped to `public`, and filters by privilege) and sorts every relation into
user-scoped / handled-by-hand / not-user-linked / **unclassified**. One stray
relation refuses the whole purge:

```
purge: refused: cannot account for every relation: unclassified relations
[public.foo (table)] — give them a user_id column, or classify them in internal/v2/purge
```

The refusal is **global, not per-account** — while it stands, `DELETE
/api/v1/account` answers 500 for *every* user. So: **run `purge-user --dry-run`
after any schema change.** The dry run performs the same classification and the
same cascade check as the real thing, so a clean dry run means the real one will
not refuse for a reason the dry run could have found.

**What survives on purpose** (`notUserLinked` — every entry is a decision):

| Relation | Why |
|---|---|
| `smtp_rejections` | per-**day** aggregate count of protocol refusals that never resolved a recipient. There is no user to scope a row to; a count is not a record of a person |
| `templates` | operator-published parsers, not authored by users and shared by all of them |
| `dict_entries` | the global merchant dictionary. Not justified by k-anonymity (k gates *publication*, not storage) — what makes it acceptable is that `ForgetSubmitter` destroys the pattern↔person link, leaving a string attributable to nobody |
| `waitlist` | a bank name and a count, never linked to who asked |
| `invite_codes` | `redeemed_by` is nulled by the schema; what survives is "some code was spent, and nobody knows by whom" |
| `deleted_account_sessions` | the tombstone that makes deleted devices get 410 and not 401 — it is *written by* the deletion, so it must survive one |
| `goose_db_version` | the migration ledger |

Plus `dict_submissions` and `users`, which are handled by explicit steps rather
than by discovery. Everything else with a `user_id` is discovered and deleted.

Read the report's warnings; each names a schema defect, not a purge problem:

- `SweptWithoutCascade` — that table's `user_id` FK is missing `ON DELETE
  CASCADE`, so **every other path** that deletes a user leaves rows behind.
- `RefreshedViews` — a materialized view held rows for the purged account. A
  matview is a *stored copy* of user data that nothing else in the system
  tracks; check it should exist at all.
- `WithoutConsentRecord` — accounts with no deadline. Reported, never purged: a
  sweep that deleted on a missing row would convert any bug in the
  consent-recording path into the destruction of every account it touched.

One trap worth knowing before it bites: if `LEDGER_DICT_HMAC_KEY` is lost and
`dict_submissions` is non-empty, **every** purge refuses — the pseudonyms cannot
be recomputed, so they cannot be forgotten.

### `record-consent`

```bash
ledgerd record-consent --user <uuid> --document alpha-plaintext-v1 \
                       --retention-until 2027-01-31T00:00:00Z [--signed-at …]
ledgerd record-consent --show
```

> **Nothing writes `user_consent` automatically.** Not sign-up, not the invite
> redemption, not onboarding. Until you run this, `purge-user --retention-due`
> has no input at all: a sweep run a hundred years past every deadline purges
> zero accounts and reports each one as having no record.

Recording is manual by design — the row asserts that a specific person signed a
specific document on a specific date, and a row written by the sign-up path
would be the server asserting a signature nobody made. Re-consenting **replaces**
the deadline.

`--show` lists every account beside its deadline, *including the ones with no
record*, which are the interesting ones — they are exactly what the sweep will
report and refuse to act on. State is `current` or `OVERDUE`.

### `seed-dictionary`

One-shot import of v1's categorization rules into the merchant dictionary.
Requires `LEDGER_CORPUS_DB` pointing at a **`.backup` snapshot** of the v1
database — `internal/v2/corpus` refuses the live one.

Seeded entries bypass the k-submitter threshold (one identified party's own data
contributed deliberately is not a crowd signal that could be one user's
fingerprint) and **nothing else**: every entry lands unmoderated and publishes
nothing until approved via `POST /admin/dictionary/approve-seed`. Idempotent.

Read the reconciliation line — v1's rule table holds inactive rules, exact
duplicates and genuine conflicts, so `seeded N` alone would not add up against
`select count(*) from rules`. Rules v2 will not accept (a regex, an
out-of-range pattern) are **reported, never dropped silently**.

### `relay` — the backup MX

Not deployed (task D3). It has **no database at all**: no pool, no migrations,
no user data beyond the address replica and whatever is currently spooled. That
is the entire security argument for running our own relay instead of a managed
one. Three loops: the same hardened SMTP receiver on `:25`, an address-replica
sync every 5 minutes, and a spool drain every minute.

A failed first sync is **not** fatal — the relay exists for the case where the
primary is unreachable, and a process that refused to start without it would be
absent in exactly the situation it was provisioned for. It comes up on the last
persisted replica and defers (never permanently refuses) recipients it cannot
confirm.

> **Gotcha, and it will bite you on D3:** `config.Load` validates before the mode
> is known, so it **requires `server.dsn`** even in relay mode, where no database
> is ever opened. A relay host must set `LEDGER_PG_DSN` to a placeholder such as
> `relay-mode-has-no-database`. Making validation mode-aware is the clean fix and
> is not done.

Also unresolved and worth deciding before the relay carries real mail: the spool
is plaintext on a second host that **no database purge can reach**. Account
deletion cannot clean it.

---

## 2. Config: which values are rails, not preferences

`config.v2.example.toml` is annotated field by field — read it there rather than
here. What matters operationally is which values `validate()` **refuses** rather
than accepts:

| Value | Rail |
|---|---|
| `server.http_listen` | **must be loopback.** `":8443"`, `"0.0.0.0:8443"` and `":443"` all fail. The listener is plain HTTP and carries a session bearer token on every request plus the user's whole op log. Lifted only by task D4, in the same commit that adds autocert to `runServe` |
| `server.admin_listen` | **must be loopback or Tailscale `100.64.0.0/10`.** An empty host binds every interface and is explicitly refused. Checked **three** times: in `validate()`, at the top of `runServe` before any I/O, and again immediately before `net.Listen` so no code added in between can have changed it. **Never lifted** — §3.1 keeps the console off the internet for the life of the system |
| `mail.max_message_bytes` | **1..`blob.MaxColdMail` (1,000,000), and larger is refused — not clamped.** The default already *is* `MaxColdMail`. Accepting mail at SMTP that the ingest path then cannot store is the worst available failure, so the receiver refuses at DATA instead |
| any listener ending `:8080` | refused — `:8080` belongs to the running v1 instance |
| a DSN containing `/var/lib/ledger` | refused — that is v1's data directory |
| `push.enabled = true` with no `LEDGER_EXPO_ACCESS_TOKEN` | refused. Expo's endpoint accepts unauthenticated POSTs until a project opts into enhanced security, so without the token anyone holding a user's push token can write to that lock screen |
| `push.expo_url` | must be `https` and an Expo host, checked **whenever set**, not only when push is enabled. It is the only outbound request this server makes and it carries the access token plus the timing of every user's transactions |

Two more behaviours of `Load` worth knowing at 2am:

- **An unrecognized TOML key is a fatal error, not a warning.** Including a
  misspelling: `mail.domian` fails the process. BurntSushi/toml's default is to
  leave an unmapped key undecoded and say nothing, which for a secret means
  "looks configured, does nothing".
- **Putting a secret in the TOML fails the same way.** `server.admin_token = "x"`
  is rejected with the message telling you to use the environment.

`http_listen` defaults to `127.0.0.1:8443`. Tailscale's Storybook mount also uses
`:8443`, but on the *tailnet* addresses (`100.68.143.4:8443`), not loopback, so
there is no socket collision — it is still worth picking a different port to
avoid confusing yourself.

---

## 3. Secrets are environment-only

Never in the TOML; `Load` rejects the file if they appear there. The **actual**
v2 list, confirmed from `internal/v2/config`:

| Variable | Used by |
|---|---|
| `LEDGER_ADMIN_TOKEN` | admin console bearer token. **Unset ⇒ the console is not served at all** |
| `LEDGER_DICT_HMAC_KEY` | merchant-dictionary submitter HMAC. See the rotation warning below |
| `LEDGER_RELAY_TOKEN` | relay → primary delivery auth (both hosts) |
| `LEDGER_EXPO_ACCESS_TOKEN` | Expo push; required when `push.enabled = true` |
| `LEDGER_PG_DSN` | not tagged as a secret in the code, but it carries the database password — treat it as one |

> **v1's secrets are not v2's.** `LEDGER_IMAP_APP_PASSWORD`, `LEDGER_AI_API_KEY`
> and the `LEDGER_VAPID_*` keys appear **nowhere** in `internal/v2` or
> `cmd/ledgerd` — v2 has no IMAP client, no AI path, and uses Expo rather than
> Web Push. Do not copy them into `/etc/ledger-v2/ledgerd.env`.

Non-secret environment overrides: `LEDGER_MAIL_DOMAIN`, `LEDGER_HTTP_LISTEN`,
`LEDGER_ADMIN_LISTEN`, `LEDGER_SMTP_LISTEN`, `LEDGER_RELAY_PRIMARY_URL`,
`LEDGER_APPLE_CLIENT_IDS`, `LEDGER_GOOGLE_CLIENT_IDS`. Plus two read outside
`config`: `LEDGER_CORPUS_DB` (`seed-dictionary`) and `LEDGER_OPERATOR`
(`parse-rate --adjudicate` audit trail).

### ⚠ `LEDGER_DICT_HMAC_KEY` cannot be rotated once `dict_submissions` is non-empty

`runServe` calls `dict.VerifyKeyEpoch` **before the listener opens** and
**refuses to start** if any submission was written under a different key:

```
dict_submissions holds N identifier(s) written under an earlier LEDGER_DICT_HMAC_KEY.
They cannot be counted toward the k threshold or erased by an account purge under
the current key. Restore the previous key, or clear them first and then rotate
```

Why the refusal rather than a warning: a rotated key breaks the dictionary in
two directions **and neither shows a symptom**.

- **k-anonymity.** The k threshold counts *distinct HMACs*. After a rotation one
  user reappears as one submitter per key generation, so a single person can
  push their own merchant string past k=3 on their own and get it published to
  every device.
- **Erasure.** An account purge recomputes the pseudonym under the current key,
  matches nothing, deletes nothing — **and reports success**. The user is told
  their data is gone while their submitter identifiers sit in the table forever.

**Right now this is free.** `dict.Submit` has no production caller — there is no
submission endpoint, `dict_submissions` is empty, and no identifier about any
user has ever been written. If you want a different key, set it **before the
submission endpoint ships**. After that, rotation costs you a deliberate wipe of
`dict_submissions` first.

---

## 4. Migrations

goose, embedded via `//go:embed migrations/*.sql`, applied by `pg.Migrate` at
startup and by every subcommand **except `verify`** (which must not modify what
it audits). Idempotent; a clean no-op against an up-to-date database.

> **`00004` and `00015` are permanently vacant. Do not "fix" the gap.**
> `00004` is vacant by ruling — goose hard-fails when a migration appears
> *below* an already-applied version, so the number can never be claimed again.
> `00015`'s original cause is unrecorded, but the same rule applies. Numbering
> runs `00001–00003, 00005–00014, 00016–00021`. The next free number is one past
> the highest file on disk — re-run `ls internal/v2/pg/migrations/` at the moment
> you write one, because sessions run concurrently.

Production has **two roles** (task D5): `ledger_migrate` owns the schema,
`ledger_runtime` serves and is never the owner. This is a security requirement,
not tidiness: `key_history` is append-only by trigger, and `ALTER TABLE …
DISABLE TRIGGER` needs only *ownership* — a single role that migrates and serves
could switch the guard off and rewrite the log peer devices audit for key
substitution. Consequence for the deploy script: **apply migrations out-of-band
as `ledger_migrate` before starting the new binary.**

---

## 5. The admin console

Bound to loopback/Tailscale **permanently by design**, and never served without
`LEDGER_ADMIN_TOKEN` — with no token, `Routes` returns an error, nothing is
mounted, and `serve` logs a warning at every start while continuing to run
everything else. That is the deliberate middle answer: mounting it open is out
of the question, and failing the whole process would mean a forgotten variable
used for template authoring stops users' mail from being received.

Auth is `Authorization: Bearer <token>`, `subtle.ConstantTimeCompare`. Every
failure — no header, wrong scheme, wrong token, or a perfectly valid *user
session* token — is the identical 401. The package does not import
`internal/v2/auth` at all, so a session can never become an admin credential.
The console gets its own `ServeMux` on its own listener; the public mux does not
contain `/admin/` patterns at all.

| Capability | Routes |
|---|---|
| Templates | `GET/POST /admin/templates`, `POST /admin/templates/{id}/{version}/validate`, `…/publish`, `…/reprocess` |
| Donated samples | `GET /admin/samples`, `DELETE /admin/samples/{id}` |
| Dictionary | `GET /admin/dictionary`, `POST /admin/dictionary/moderate`, `POST /admin/dictionary/approve-seed` |
| Waitlist | `GET/POST /admin/waitlist` |
| Quarantine | `GET /admin/quarantine?user=<uuid>[&include_blob=1]` |
| Diagnostics | `GET /admin/diagnostics` |
| Accounting | `GET /admin/accounting` |

There is **no `/admin/parse-rate`** — that instrument is CLI-only.

**Why it stays off the internet.** The binding is the control; the bearer token
stops an accident inside the tailnet, not an attacker outside it. What a caller
with the token can do:

- **Publish a template to every device in the beta.** A published template is
  auto-trusted. The publish gate replays the candidate over the donated corpus
  and *absolutely refuses* a `regression` (there is no force flag); a
  `value_change` needs `{"accept_changes": true}`. If the sample store is
  unconfigured it answers **503 rather than a clean pass** — reporting an unrun
  gate as a clean one is how a gate stops being one.
- **Approve a merchant mapping to every device**, or bulk-approve every seeded
  entry at once (`approve-seed` is scoped in SQL to `source='operator_seed'`, so
  it cannot touch a crowd submission).
- **Reprocess across every affected user's log**, superseding existing ops.
- **Read diagnostics across all users** — the user filter is optional.
- **Read a user's raw mail.** `GET /admin/quarantine?include_blob=1` is the one
  route in the system that hands a user's message to somebody who is not that
  user. Opt-in, capped at 20 items a page, and logged:
  `admin: OPERATOR READ n raw quarantined message(s) for user <id>`.

There is deliberately **no rate limiter** on this listener.

---

## 6. Backups

> Nothing below has been run in anger — v2 has no production database yet. This
> is the procedure to establish as part of D5, written now so it is not invented
> under pressure.

v1's runbook learned two things the hard way, and both have Postgres analogues:

**1. The pre-deploy dump runs as `root`.** In v1 the failure was
`sudo -u ledger sqlite3 … ".backup '/var/backups/…'"` — `/var/backups` is
root-owned, so the unprivileged user could not create the file. The same trap
exists here in a subtler form: `sudo -u postgres pg_dump -f /var/backups/…`
fails, because **`pg_dump` itself opens the output file**, as `postgres`. Run
the whole command as root and authenticate to Postgres over loopback with the
credentials from `/etc/ledger-v2/ledgerd.env`.

**2. Do not chain it under `set -e`.** Make the dump its own step with an
explicit status check, so a failure is reported as *the backup failed* rather
than aborting the deploy script at a line that does not say which half died.
Postgres adds its own version of this hazard: **never pipe `pg_dump`.**

```bash
pg_dump … | gzip > out.gz      # WRONG: the exit status is gzip's.
                               # A failed dump writes a truncated file that looks fine.
```

Use the custom format, which is already compressed and writes with `-f`, so the
status you check is `pg_dump`'s own:

```bash
# pre-deploy, as root
out=/var/backups/ledger-v2/ledger-v2-$(date +%F-%H%M).dump
mkdir -p /var/backups/ledger-v2
pg_dump --format=custom --file="$out" "$LEDGER_PG_DSN"
rc=$?
if [ "$rc" -ne 0 ]; then echo "BACKUP FAILED (rc=$rc) — not deploying" >&2; exit 1; fi
pg_restore --list "$out" >/dev/null || { echo "dump is not readable" >&2; exit 1; }
```

(If you must pipe, `set -o pipefail` first. `pg_restore --list` is the cheap
proof that the file is a dump and not a truncated one.)

Dump as `ledger_migrate` or `postgres`, **not** `ledger_runtime` — a non-owner
without read on every relation produces a partial dump.

Nightly to `/var/backups/ledger-v2/` with 14-day rotation. And the check that
makes a backup a backup: restore last night's dump into a scratch database and
run `ledgerd verify` against it. A dump that exists is not a dump that restores,
and a dump that restores is not a dump whose chains verify.

Backups contain plaintext financial mail. Encrypt them if they leave the box.

---

## 7. Where things live (once D4/D5 land)

| Path | Contents |
|---|---|
| `/etc/ledger-v2/config.toml` | non-secret config |
| `/etc/ledger-v2/ledgerd.env` | secrets, `0600` |
| `/var/lib/ledger-v2/` | `0700`; autocert cache at `autocert/` |
| `/var/backups/ledger-v2/` | dumps, root-owned |
| `deploy/ledgerd.service` | **not written yet** — model it on `deploy/ledger.service`: dedicated user, `ProtectSystem=strict`, `NoNewPrivileges`, plus `AmbientCapabilities=CAP_NET_BIND_SERVICE` for `:25` |

After any restart, confirm the **running process** is the new binary (inode/PID
check), not merely that health is green — v1's runbook learned that one too.

---

## 8. What still needs the D-series

| Task | Blocks | State |
|---|---|---|
| **D1** domain + DNS | — | domain chosen (`sirdab.ae`), MX 10 / api records live. **Outstanding: delete the MX 20 record or do D3** |
| **D2** probe port 25 on the relay provider | D3 | not done; `spike/phase0/RESULTS.md` covers the primary only |
| **D3** provision + deploy the relay | backup MX | deferred by decision |
| **D4** TLS, firewall, systemd unit | public access | not done. Adds autocert to `runServe` and is the commit that lifts the loopback rail on `http_listen`. Until then the device reaches ledgerd over Tailscale, as v1 does |
| **D5** PostgreSQL on the primary | everything | not done. Cluster is down; two roles, `C.UTF-8` locale, backups |
| **D6** alpha onboarding + the two-week measurement | Phase 1 exit | not started. Needs the consent document, which **does not exist and no task writes it** |

---

## 9. Troubleshooting

### "Mail stopped arriving."

In this order.

**1. `ledgerd verify` first.** It is the only thing that distinguishes *nothing
arrived* from *something arrived and was lost*. A clean run means the pipeline
is not dropping mail and the problem is upstream. Findings mean stop and read
§1's finding table before touching anything.

**2. Is the process alive and is the port open?**

```bash
systemctl status ledgerd
ss -ltnp | grep ':25 '
curl -s http://127.0.0.1:8443/api/v1/healthz      # {"status":"ok","db":"ok"}
```

A 503 with `"db":"down"` is Postgres, not mail.

**3. Did it refuse the mail at the protocol layer?** `smtp_rejections` is a
per-day count with a closed reason set — `too_large`, `unknown_rcpt`,
`over_quota`, `no_text_part`, `normalize_error`:

```sql
SELECT day, reason, count FROM smtp_rejections ORDER BY day DESC LIMIT 20;
```

`unknown_rcpt` climbing means the inbound address is wrong or was rotated.
`over_quota` means `mail.per_address_daily` (default 50) was hit.

**4. Is it being held rather than dropped?** See the quarantine section below —
held mail is the single most likely answer, and to the user it looks identical
to mail that never came.

**5. DNS and the MX.** `dig +short MX in.sirdab.ae`. If a sender failed over to
`mx2`, that host does not exist (§0) and mail is sitting in *their* queue.

**6. Only then, the sender.** Check `/admin/diagnostics` filtered by the window;
an `arrival` row means we got it and the problem is downstream of SMTP.

### "Everything is in the review queue."

**For DIB, this is currently expected and correct.** DKIM at DIB does not cover
`Content-Type`. That header decides how the signed body *bytes* are decoded —
charset, transfer encoding, which MIME part is the text — so somebody holding one
genuine DIB message can rewrite it in place, leave the signature valid, and
change what the parser reads out of bytes the bank really signed. It was proved
by construction: a body containing `Amount =31=30=30.00` matches as **900.00**
under quoted-printable and **100.00** as raw text.

The response is not refusal — refusing would quarantine every message from a
bank that simply does not sign the header. What is denied is **auto-trust**: the
transaction is extracted and appended exactly as before, and it lands in the
review queue. So the symptom is "everything needs confirming", never "nothing
arrives". In code this is `needsReview: unattestedForward || unsignedDecoding` in
`internal/v2/ingest/pipeline.go`.

The cost is real: six of seven corpus fixtures lose auto-trust, and **a DIB user
confirms every transaction by hand.** Only ENBD's Proofpoint mail, which signs
both headers, stays automatic.

**The lever is one line** — drop `"Content-Type"` from `origin.DecodingHeaders`
in `internal/v2/origin/dkim.go`; two tests fail loudly so it cannot happen by
accident. This is a product decision, not a bug: see
`docs/superpowers/NEEDS-SALEH.md` **item 0**, which lays out the three options
(keep it safe / restore auto-trust for DIB / gate DIB auto-trust on the Arabic
literal surviving the decode) and is explicitly waiting on your call.

If it is *not* DIB, the other cause of the same symptom is
`unattestedForward` — a forwarded message with no attestable forwarder.

### "A sender's mail is quarantined."

Held, not lost. The user's own lane is `GET /api/v1/quarantine`, which returns
held items **and** removal records, so a client that has not synced in a month
still gets the full account. Nothing in it carries a subject, a display name or
body text.

Confirming is `POST /api/v1/quarantine/confirm` with `{"domain", "scope"}`,
scope `"outer"` or `"inner"`:

- **Confirming re-ingests, synchronously, inside the request.** The allowlist row
  and the release happen in one transaction, then held mail is promoted through
  the *same* `ingest.Pipeline` a live delivery uses. Capped at 500 messages per
  confirm; the response carries `remaining` when it truncated, and `incomplete`
  when re-ingest errored — the allowlist row is committed either way and held
  mail is untouched, so simply confirm again.
- **It is idempotent.** A second confirm re-ingests nothing, because promoted
  mail is no longer held. Under concurrency the correctness comes from an
  exclusive promotion claim plus an already-appended check, not from the ordering
  — with the caveat that the claim is a **Go lock, not a database one**, so two
  `ledgerd` processes against one database can still race into a bounded
  duplicate (which replay folds as a `duplicate_ingest` anomaly). Run one.
- Two 409s are meaningful and distinguishable: `forwarder_domain` (you tried to
  trust a forwarder's own domain at outer scope) and `origin_unproven` (nothing
  held from that sender has provable origin — the confirm button will always
  refuse for it).
- Rate limit: 1/min sustained, burst 10, per user, checked before the body is
  read.

**Revocation exists**: `DELETE /api/v1/quarantine/allowlist` with the same
`{"domain","scope"}`. Revoking something not trusted is `200 {"revoked": false}`,
not a 404. It closes the lane **going forward** — the allowlist is re-read on
every arrival *and* on every reprocess.

> **It does not retract ops already in the log.** Those ops are in the user's
> integrity chains and removing them is not something this system can do; the
> transactions are theirs to delete on the client like any other. Nor does it
> re-quarantine already-promoted mail — the held copy was deleted at promotion.

**Expiry.** TTL 30 days, warned 7 days ahead, swept hourly. An **unwarned item is
never deletable**, and a late-warned item lives *longer*, never shorter — so
nothing is dropped without a user-visible notice even for an account nobody has
synced in a month. Removal records outlive the message.

Onboarding note: Gmail's forwarding verification mail arrives from
`forwarding-noreply@google.com`, is not allowlisted, and is therefore
**permanently quarantined by design**. The first thing a new alpha sees is a
held message, and you read the verification link out of
`GET /admin/quarantine?user=<id>&include_blob=1`.

### "Nothing parses on a fresh install."

This was a real defect, not a misconfiguration: `internal/v2/tmpl/seed` was
imported by nothing and `tmpl.Store.Publish` had no production caller, so a
freshly migrated `ledgerd` served with an **empty `templates` table** — taking
mail, storing it, and extracting no transaction from any of it — while the spec
said the parsers were "ported into the template store".

Fixed: `runServe` seeds immediately after the migrations, and the seed failing is
fatal to the start. Confirm templates are live:

```bash
curl -sH "Authorization: Bearer $LEDGER_ADMIN_TOKEN" \
  http://127.0.0.1:8079/admin/templates
```

Expect **four** published templates: `dib.card.v1`, `dib.account.v1`,
`enbd.transfer.v1`, `enbd.alert.v1`. In the log, on every start, one of:

```
ledgerd serve: N bank template(s) published, M already current
ledgerd serve: N bank template(s) already current
```

If the table is genuinely empty on a running server, run `ledgerd seed-templates`
— it does the same thing without a restart.

If templates are live and mail still does not parse, that is drift, not seeding:
a template matched and then could not fill in its required fields. Look at
`/admin/diagnostics` for the `tier` recorded on those arrivals.

### A `parse-rate` run reports blind spots

Every report prints `what this number CANNOT see`. All five push the rate
**up**, so a passing number is the optimistic reading:

| Blind spot | Effect |
|---|---|
| `prediagnostic_refusals_are_not_in_the_denominator` | tarpit, connection caps, over-long lines, a declared SIZE over the cap — all refused before a recipient is resolved, so they leave no user-scoped row at all. `verify`'s `protocol_rejections` is the only place they are counted, and it cannot say whose they were |
| `relay_spool_is_not_in_the_denominator` | mail in an undrained backup-MX spool has no diagnostics row anywhere. **Drain the relay before measuring** |
| `deleted_accounts_shrink_a_past_window` | see below |
| `heuristic_hits_count_as_parses` | a heuristic hit is a *guess* the user must confirm. It is in the numerator because the criterion is coverage; `by_tier` prints the split so you can discount it |
| `verdicts_are_interested_judgement` | the denominator rests on an operator who wants the beta to ship. Append-only verdicts bound this; they do not remove it |

**The deletion one is the trap that produces a wrong ship decision.** Verbatim:

> *parse_diagnostics cascades away with the account, and a purged account takes
> its FAILURES out of every past window with it. Two runs of the same window
> across a deletion are not comparable, and the later one reads better.*

So if you purge an account — including via `--retention-due` — and then re-run
`parse-rate` over a window that account was in, the number goes **up**, and
nothing in the output says why. The accounting side has the same shape as
`retention_and_deletion_shrink_past_windows`, whose text is the rule to follow:
**an exit measurement has to be taken and kept, not recomputed later.** Record
the run output (`--json`) into `docs/superpowers/specs/v2-phase1-exit-record.md`
at the time, along with the adjudication counts.

### Everything is 500 after a schema change

Check `ledgerd purge-user --dry-run --user <any-uuid>`. `purge.Classify` refuses
globally while any relation is unclassified, and that refusal reaches
`DELETE /api/v1/account` as a 500 for **every** user, not just the one being
deleted. The fix is one line in `internal/v2/purge` (`handledWithoutUserID` or
`notUserLinked`), or a `user_id` column with `ON DELETE CASCADE`.

### `serve` refuses to start

In the order the checks run: admin bind → Postgres connect → migrate → template
seed → dictionary key epoch → SMTP bind → admin bind (again) → listeners. The
message names which. The two least obvious are the dictionary key epoch (§3) and
the `:25` bind, which needs `CAP_NET_BIND_SERVICE`.
