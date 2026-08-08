# Where user configuration lives — spec

**Date:** 2026-08-08
**Status:** Decided. Supersedes the 2026-08-07 decision in `2026-08-08-multi-bank-and-device-parity.md` that declared banks live on the server.
**Decided by:** the assistant, at the operator's explicit instruction to run its own analysis and ignore the earlier direction.

## What needs a home

Four things, all the same class — user configuration that must survive a new device:

1. **Declared banks** — several, editable later.
2. **Budget split** — the needs/wants/savings percentages. Currently hardcoded (`DEFAULT_BUDGET_MAPPING`); the user never chooses.
3. **Categories** — v1 had `{ Name, Kind, Bucket, IsActive, Color }` with kinds `spending` (bucketed need/want/saving), `income` and `excluded`. v2 has no category entity at all: `category` is a bare `string` on a transaction.
4. **Other preferences** as they arrive.

## The decision: the op log, not the server

New op kinds carry this configuration. `SCHEMA_VERSION` goes 2 → 3.

### Why this reverses yesterday's call

Yesterday we chose server-side storage for the bank list, on the reasoning that the server already knows which banks a user uses (from `parse_diagnostics`) so the disclosure cost is near zero. That reasoning was sound **for banks alone**. It does not survive contact with the other three.

**The crypto phase is next, and it changes what "server-side" costs.** After Phase 3, op-log content is sealed to the user's key and the operator cannot read it. Server-side tables stay plaintext **permanently**. So the question is not "is this sensitive today" but "do we want the operator able to read this forever".

**Categories are sensitive.** A user's own category names describe their life — "Therapy", "Legal fees", "Fertility treatment", "Gambling". That is not bank metadata; it is user-authored text about themselves. The operator's stated principle is that data of that kind belongs encrypted, readable only by the client. Putting it in a plaintext server table would contradict that at exactly the moment we are turning encryption on.

**One mechanism beats two.** Splitting configuration — banks on the server, categories in the log — means two sync paths, two failure modes and two places to look. Banks are the least sensitive of the four, so folding them in costs nothing; splitting for their sake would cost a second system.

**Multi-device falls out for free.** The second-device problem (a new device re-running onboarding) is precisely "configuration is device-local". Configuration in the log syncs by construction, which is the mechanism the whole architecture already relies on.

### What it costs, stated plainly

`SCHEMA_VERSION` 2 → 3 makes an older client **hard-stop**: `UnknownNewerVersionError` stops sync and demands an upgrade rather than folding a half-understood log into money (`client/src/wire/op.ts:53-61`, spec §3.3). That is deliberate and must not be weakened.

The cost is one page reload, today, for one user. It is the cheapest this will ever be — after alphas onboard it is a forced upgrade and a support conversation each. If we are going to owe this bump, owing it now with a single user is strictly better, and it lands before the crypto migration rather than tangled with it.

Also required: `internal/v2/oplog/op.go`'s `Types`, the Go/TS conformance suite that pins the two in step, and the server's op-type validation.

### Precedent

`home_currency_set` is already exactly this: user configuration, parent-free, folded by position, synced across devices. `rate_set`/`rate_unset` are the same shape. These ops are not an exception being invented; they are the established pattern for "a fact the user chose".

## The ops

Parent-free append-only facts, folded by position, last write wins per key — the `rate_set` shape, not the versioned-entity shape. Record-level LWW is forbidden for transactions and splits (spec §3.3, because it breaks invariants); it is correct for a keyed configuration value, where there is no invariant across keys.

| Op | Payload | Fold |
|---|---|---|
| `bank_declared` | `{bank, active}` | last write per `bank` wins; `active: false` retires |
| `budget_split_set` | `{need, want, saving}` integer percents summing to 100 | replaces the split |
| `category_defined` | `{id, name, kind, bucket, color, active}` | last write per `id` wins; `active: false` retires |

**Amended 2026-08-08, during implementation, before any v3 op existed in the
live log.** This table first specified `banks_declared` as `{banks: string[]}`
replacing the whole set. That is last-write-wins over a COLLECTION, which is the
shape §3.3 forbids, and the failure it forbids is reachable: two devices offline,
each adding a different bank to the same starting list, and the later op silently
drops the earlier one's addition — no fork to resolve (these ops are
parent-free), no anomaly, and nothing for the user to notice beyond a bank they
added going missing. The paragraph below is the argument for record-level LWW
here, and it says *keyed*; a replaced list is not keyed. `bank_declared` names
one bank, matching `category_defined`, at a cost of one boolean.

`category_defined` carrying `active` removes the need for a delete op — retiring is a definition, not an absence, which also keeps historical transactions referring to a retired category readable.

## What does not change

- **Transactions, splits and rules keep their existing ops.** No entity changes.
- **The trust path never reads configuration.** Declared banks route the waitlist and drive the UI; they must not influence parsing, the sender allowlist, or any origin decision.
- **`category` on a transaction stays a string.** `category_defined` supplies the *set* a user picks from and its bucket; it does not become a foreign key. This keeps the fold simple and means a transaction categorised before a category was retired still reads correctly.

## Migration

There is one real user and one device writer. The upgrade path is: ship the client, reload. No data migration is needed — absent configuration falls back to today's defaults (`DEFAULT_BUDGET_MAPPING`, the derived category set), so an account with no configuration ops behaves exactly as it does now.
