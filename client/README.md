# The v2 headless client

**This is Phase 1's exit-test instrument, not a product.** Spec §5 makes the
exit criterion "a minimal headless client that authenticates, pulls, replays,
runs the invariant checker, and round-trips client-authored ops" — not the PWA —
so this directory exists to *be* that instrument, and every design choice in it
favours checkability over the things a real client needs. It re-folds its entire
op log on every command so that "the state agrees with a re-fold of its own log"
is a claim about something rather than a tautology; it keeps every verified row
on disk so that `check` can re-verify each chain from genesis; it holds its
writer key in a plain file. A phone client does none of those. Phase 2's Expo
app is a separate program, and it must not be built by growing this one.

## The commands

```
bun run cli login             --server <url> --idp apple|google --id-token <token>
bun run cli enroll            --writer <id> [--sign-with <writer-id>]
                              [--pubkey <base64>] [--keygen-only]
bun run cli pull              [--stream hot|cold] [--limit <n>]
bun run cli pull-cold-hashes  [--stream hot|cold] [--limit <n>]
bun run cli replay
bun run cli check             [--stream hot|cold] [--json]
bun run cli emit              --type <op_type> --json '<payload>'
                              [--entity <kind>:<id>] [--parent <n>] [--ingest-id <64 hex>]
bun run cli checkpoint
bun run cli push
bun run cli state             [--json]
```

Global flags: `--server <url>`, `--state-dir <path>` (default `./.ledger-client`),
`--profile <name>` (default `default`). **The command comes first**, before any
flag — which flags take a value depends on which command is running (`--json` is
`emit`'s payload and every other command's switch), so it has to be known first.

Exit codes: `0` success, `1` a hard stop or a failed command, `2` usage. `check`
exits `1` when any violation is a `hard_stop`.

### login

Trades an IdP token for a session. Against a server started with `--dev-auth`
the token is `dev:<subject>`; that flag also makes the server reject every real
Apple or Google token, which is what stops a deployment quietly running with it
on. A profile refuses to be logged into a second account.

### enroll

A session names the *account* and authorizes nothing else. Enrolment is
authorized by an Ed25519 signature over a server-issued single-use nonce, so a
stolen session token alone cannot add a writer.

Three forms:

- `enroll --writer dev-a` — the new key signs for itself. The server accepts
  this exactly once per account (the TOFU bootstrap).
- `enroll --writer dev-b --sign-with dev-a` — an enrolled writer whose key is in
  *this* state file vouches for a new one, also generated here.
- The two-device pairing, where the private key never moves:
  ```
  # on the joining device
  bun run cli enroll --profile b --writer dev-b --keygen-only     # prints the PUBLIC key
  # on the enrolled device
  bun run cli enroll --profile a --writer dev-b --sign-with dev-a --pubkey <that key>
  ```

There is deliberately no way to print or import a private key.

### pull, and the per-stream cursor model

Local state holds **two** cursors and **per-(writer, stream) pinned heads**,
never one of either. `pull` with no `--stream` is **hot only**, because spec
§3.3:70 makes the cold stream lazily synced behind a rolling window, so hot-only
is the mode the product ships and therefore the mode the default has to
exercise.

`seq` is one total order across both streams, so a hot-only pull legitimately
sees `1, 3, 5, …`. Those gaps are the cold rows this client chose not to fetch,
not dropped data. Detecting a genuinely dropped row is the per-(writer, stream)
chain's job, which *is* contiguous, and it is what `I2_writer_counters` checks.

The two streams are verified by different mechanisms, and that is the point:

| stream | what a body fetch is checked against |
| --- | --- |
| `hot` | `verifyChain` from the pinned head — every row present, contiguous, correctly linked |
| `cold` | `verifyFetchedRange` against hashes a previous `pull-cold-hashes` pinned |

A cold body whose hash was never pinned is refused. Run `pull-cold-hashes`
first; "I have no pin for this one" is exactly the answer a hostile server
wants.

Within a page the order is fixed: **verify → fold → check → persist.** The
cursor, the rows and the new pinned heads are written together, and only after
`checkAll` reports no `hard_stop`. A cursor persisted over an uncertified page
can never be walked back, because the client would never ask for those rows
again.

A blob that will not open or will not decode is set aside with a visible warning
and the cursor still advances past it (spec §3.3:68). One bad blob must not
strand a device. The two conditions that *do* stop a sync are a chain break and
an unknown newer schema version; nothing else is ever promoted to them.

### emit, checkpoint, push

`emit` appends a validated op to a pending batch. `push` seals the batch into
padded blobs on the size-bucket ladder, chains them onto this writer's hot head,
uploads, and then syncs so the ops are folded at the positions the server
assigned. The ingest writer never batches — that is a server-side rule, so one
email is one row — but a client always may.

`push` emits a `writer_checkpoint` **without being asked** whenever the roster
differs from the one it last checkpointed against, including the first time. A
device enrolled after the last checkpoint is therefore checkpointed on its own
first push, which is what makes `I11_roster_checkpoint`'s roster-race tolerance
self-healing.

**A checkpoint names the roster, not the observed chains.** One head for every
`(roster writer × stream)` pair, with `counter: 0` and the 64-zero genesis hash
for a chain that holds no blobs. A checkpoint built from observed heads could
never name an enrolled writer that has authored nothing — there is no head to
observe — so that writer would hard-stop `I11` on every sync forever with no
checkpoint any device could emit able to clear it. A zero entry asserts nothing
false, because `0 > observed` is never true.

The counters come from **verified** heads only, never from this device's own
upload record. Claiming a head that has not been pulled back would be true and
would still hard-stop `I11` on this device's very next check.

**A landed checkpoint does not empty the notice list, and cannot.** The plan
(Task 14 step 4) expects `0 hard stops, 1 notice` once a checkpoint exists, with
`I14` alone. That is unreachable, and the two rules that make it so are both
deliberate: a checkpoint names a head for every `(writer × stream)` pair, and
`I11` reports every head on a stream the check did not cover as
"not cross-checked". A hot check therefore always carries one such notice per
writer. The real counts are `2` before the first checkpoint
(`I11 no checkpoint yet` + `I14`) and `N + 1` after, for `N` live writers. What
the assertion should be is "no `I11` **hard stop**, and no `no checkpoint yet`
notice" — the count is not the property.

If a batch straddles the server's committed head, the server refuses it with
`409` rather than trimming it. The client then reads the chain head and resends
**only the rows above it** — the contract quoted verbatim from `oplog/chain.go`.

### A multi-device account hard-stops until a checkpoint lands

Two or more enrolled device writers and no checkpoint covering them is a
`hard_stop`, and `pull` persists nothing over a hard stop. So a second device
cannot finish its first sync until some device has written a checkpoint naming
it. That is the rule doing its job — such an account has no cross-check against
a withheld writer — and enrolment and the first checkpoint are strictly ordered
because of it.

## State

`--state-dir/<profile>.json`, one file per **profile**. A profile is one
device's view of one account: two devices on one account differ in every field
the file holds — their own writer key, their own cursors, their own pinned
heads — so the file cannot be keyed by user alone.

The file holds the writer's Ed25519 **private key** and the session bearer
token, both in the clear. The directory is created `0700` and the file written
`0600`, re-chmod'ed on every save and written through a temp file and a rename.
There is no passphrase and no keychain: this is a scratch artifact for a test
rig, `client/.gitignore` keeps `.ledger-client/` out of the repository, and a
product client must put its key in the platform keystore instead.

## Tests

```bash
bun run typecheck
bun test                 # unit + wire + replay + invariants; no Postgres needed
```

`test/e2e/roundtrip.test.ts` drives a real `ledgerd` against a real Postgres. It
**skips** unless `LEDGER_TEST_POSTGRES_URL` is set, which `scripts/v2-check.sh`
exports — so a bare `bun test` stays fast and standalone while the gate runs the
round trip every time.

```bash
bash ../scripts/v2-check.sh     # go vet + go test + typecheck + bun test (incl. e2e)
```

## Reading order

`wire/` (the frozen op, blob and chain model) → `replay/` (the fold) →
`invariants/check.ts` (the seventeen) → `net/client.ts` (this client) →
`store/store.ts` (what it persists and why it is the rows).
