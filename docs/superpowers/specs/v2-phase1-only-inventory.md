# The Phase-1-only inventory: server-side plaintext read paths

**Status:** live for the duration of Phase 1 (the unencrypted closed alpha).
**Owner of the deletion:** the Phase 3 cutover.
**Written by:** Task 30 of `docs/superpowers/plans/2026-08-01-v2-phase1-backend.md`.

Cold blobs are HPKE-sealed to the user's public key from Phase 3 onward. The
server holds no private key, so a server-side read path over cold bodies is not
"hard" in Phase 3 — it is **structurally impossible**. Everything in this
document is scaffolding for the unencrypted alpha phase and must be **deleted,
not migrated**.

The point of writing it down is that these paths are *enumerated, banner-marked
and dated* rather than assumed to be temporary. The plan explicitly rejected a
throwaway PWA materialized view on the grounds that "a server-side materialized
view is exactly the plaintext read path Phase 3 must delete." These four paths
are the same category of thing. The difference is only that they are on this
list.

Every one of them carries `⚠ PHASE 1 ONLY` at the top of its file or on the
function itself. **Adding a fifth means adding a row here in the same commit.**

---

## The four paths

### 1. `ingest.Pipeline.Reprocess` — server-side re-parse over cold bodies

`internal/v2/ingest/reprocess.go` (Task 30).

Re-runs the parse cascade over mail already in a user's log after a template is
fixed, and appends a `txn_superseded` keyed by the same ingest id when the
result differs. It reads:

- the **cold stream**, for the raw body (`openBlob` → `oplog.DecodeRawBody`);
- the **hot stream**, for the current parse of that ingest id
  (`currentPayloads`), which is what "identical results append nothing" is
  measured against.

Both are ciphertext in Phase 3. `openBlob` is the exact line: it calls
`blob.Sealer.Open`, which in Phase 1 is `blob.PlaintextSealer` (framing and
padding, no encryption) and in Phase 3 is an HPKE sealer whose `Open` needs a
key the server does not have and must never have.

The hot read is the one with the least obvious replacement, and it should not be
"solved" by making the server keep a plaintext copy. There is deliberately **no
plaintext column beside the blobs** to read instead — the ingest id is already
the join key the ingest path keeps out of a column for this reason, and a
materialized "current parse" table would be the rejected PWA view under another
name.

**Not on this list, deliberately:** `recordedOrigin`, which reads
`parse_diagnostics` for the domain whose signature was verified at arrival.
That table is content-free by construction (hostnames, closed enums, a size rung
and a structure digest) and survives the cutover intact.

### 2. `quarantine.Confirm` → `Reprocess` — re-ingest of held mail

`internal/v2/quarantine/quarantine.go`'s `Held` and `Promote` (Task 27), driven
by `ingest.Pipeline.reprocessHeld` (Task 30) and reached from
`POST /api/v1/quarantine/confirm` (Task 38, `api.Server.Reprocessor`).

Quarantined mail is **not** in the cold stream — it was never appended — so its
raw body lives in `quarantine.blob`, plaintext in Phase 1. Confirming a sender
returns the ingest ids of everything held from that origin **and re-ingests
them in the same request**: reprocess reads those bodies, re-runs steps 4–7 and
appends the results, and *that append* is when the messages enter the integrity
chains. `Promote` then clears the rows.

The two halves are one request rather than two on purpose. Between Tasks 27 and
38 the confirmation allowlisted the origin and *reported* the eligible ids with
nothing consuming them, so a client that did not make a second call the API
never described left the mail the user had just vouched for held until it
expired — announced, per §2, but gone. Phase 3 keeps the shape and moves the
work: the server returns the held **ciphertext** and the device re-parses it.

### 3. `samples.Donate` pulling the raw body from the user's cold stream

`internal/v2/samples/samples.go`'s `coldBody` (Task 31). The opt-in,
content-bearing donation path: the server pulls the body from the user's own
cold stream rather than accepting an upload, so a donation can never introduce
content the user did not actually receive. Same `blob.Sealer.Open` call, same
impossibility after the cutover.

Only that read is on this list. The rest of the package survives intact — the
content-free `Report` path, `Clusters`, `ForSender`, the retention sweep and the
`donated_samples` table itself — and so does the replay the admin console runs
over the corpus, since a donated sample is stored decrypted in its own column
rather than read back out of the op log.

**What the cutover has to re-establish**, and it is not just the read: the
property that a donation cannot introduce content the user never received is
today a consequence of WHERE the bytes come from. When the client uploads the
sample instead, that property has to be rebuilt deliberately — the server can
check that the uploaded body hashes to an `ingest_id` it has an arrival record
for, which is the same fact by a different route. Losing it silently would turn
this table into an unauthenticated upload endpoint whose contents gate every
template publish.

### 4. `ledgerd parse-rate` adjudication over unparsed cold bodies

Task 36. The operator subcommand that reads unparsed bodies to decide whether a
message was a transaction at all. Reads plaintext cold bodies; the table it
writes is dropped at the cutover.

Delivered as `verify.ColdTexts`, called only from `adjudicatePending` in
`cmd/ledgerd/main.go`, and reached only via `ledgerd parse-rate --adjudicate`.
Three properties are worth writing down, because they are what keep this
narrower than the other three paths:

- **It is opt-in behind its own flag.** `ledgerd parse-rate` with no
  `--adjudicate` reports counts and refuses to print a rate; it never opens a
  blob. Reading a user's mail is never a side effect of asking for a number.
- **It prints a banner naming this file** before the first body appears.
- **The rest of `internal/v2/verify` reads no content at all** — the structural
  verifier hashes stored bytes and compares cleartext framing, and the
  accounting reads counts and closed enums. `ColdTexts` is the single exception
  and lives below a marked line in `parserate.go`.

What is dropped at the cutover: `parse_rate_adjudications`
(`00016_parse_rate.sql`), `verify.ColdTexts`, `adjudicatePending`, and the
`--adjudicate` flag. `verify.ParseRate` itself survives with a numerator and no
denominator, which is the honest shape of the metric once nobody can read the
mail — see the table below.

---

## What replaces them

Spec §3.5:109 puts reprocessing **on the client**, over its own decrypted,
chain-verified cold bodies. Phase 1 builds the *verification* half of that —
Task 10's `verifyHashList` / `verifyFetchedRange`, Task 14's `pull-cold-hashes`,
invariant `I3b_cold_hash_list` — precisely so Phase 2 has a safe foundation. It
does **not** build the reprocessing half.

Concretely, after the cutover:

| Phase 1 (this list) | Phase 3 |
| --- | --- |
| server re-parses a cold body and appends a supersede | the client re-parses its own decrypted body and uploads the supersede under its own writer |
| server compares against the current parse it read from the hot stream | the client already holds the materialized state; the comparison is local and free |
| server re-parses held quarantine mail on confirmation | the server returns the held **ciphertext**; the client re-parses locally and uploads the resulting ops |
| server pulls a donated sample out of the cold stream | the client uploads the decrypted sample itself, after showing the redaction preview |
| operator reads unparsed bodies to adjudicate parse rate | no equivalent; the metric becomes what the content-free diagnostics ledger can support |

Two preconditions that belong to the client half and are **not** met yet:

1. **There is no TypeScript heuristic** (Decision 16). The conformance suite
   covers the template rung only, so a client cannot reproduce a
   heuristic-parsed result. Until the heuristic is converted to the regex
   dialect and entered into the conformance suite, a client must skip
   reprocessing any transaction whose `tier == "heuristic"`.
2. **A supersede over an `unparsed` predecessor folds to an anomaly.** The
   replay engine's `decodeTxnPayload` refuses `amount_minor: "0"` /
   `currency: ""`, so an unparsed op never materializes a transaction, and a
   later supersede on that ingest id raises `supersede_without_origin`. It is
   visible rather than lost, but it is not the review-queue entry §3.2:112
   describes. See Task 29's report, concern 1.

---

## The consent tie-in

The alpha consent document (Task 38) must name these four paths **in plain
words** — reprocessing, quarantine re-ingest, sample donation and parse-rate
adjudication — because "we can read your mail during the alpha" is the actual
thing being consented to. This file is the source it is written from.

It must also carry a **retention deadline**, per spec §5's "unencrypted, under
signed plain-language consent (plaintext handling, retention limit,
migrate-or-delete at Phase 3 cutover)". That deadline is not prose: Task 34
gives it a row. `user_consent` (`00014_account_deletion.sql`) holds one record
per alpha — which document they signed, when, and the instant their plaintext
must be gone — and `ledgerd purge-user --retention-due` is what acts on it.
Recording it is `ledgerd record-consent`; previewing the sweep is
`ledgerd purge-user --retention-due --dry-run`. The document's date and that
column must be the same date, and an alpha admitted without the row is reported
by every sweep (`Report.WithoutConsentRecord`) rather than silently exempt from
the promise.

## Operating account deletion (for the deploy runbook)

Three operational facts about `internal/v2/purge` that belong in the runbook the
D-series tasks will write, recorded here so they are not rediscovered:

1. **Admitting an alpha is two steps, not one.** Signing them in creates the
   account; `ledgerd record-consent --user <uuid> --document alpha-plaintext-v1
   --retention-until <RFC3339>` is what puts them inside §5's retention promise.
   `ledgerd record-consent --show` lists every account beside its deadline and
   names the ones with no record. An account with no record is never purged
   automatically — it is reported, because "no deadline written down" and "the
   write failed" look identical and only one survives being wrong.

2. **The retention sweep is manual, deliberately.** `runServe` starts a sweep
   for quarantine expiry and one for donated-sample retention, and none for
   this: those delete a message, this deletes a person's account. Run
   `purge-user --retention-due --dry-run` first; it runs the same
   classification and the same due-list query as the real thing.

3. **One unclassified relation breaks deletion for EVERYONE.** The purge
   refuses if any relation in any non-system schema is unaccounted for — a
   `users_backup_20260801`, a leftover materialized view — and `DELETE
   /api/v1/account` then answers 500 for every user, with the reason only in
   the operator log. That fail-closed direction is intended (the alternative is
   reporting a deletion that did not happen) but the blast radius is total and
   invisible from outside. **Run `ledgerd purge-user --dry-run` after any schema
   change**, including ad-hoc ones; the fix is one line in the purge package's
   `handledWithoutUserID` / `notUserLinked`, or a `user_id` column with `ON
   DELETE CASCADE`.

   Related: a deployment that loses `LEDGER_DICT_HMAC_KEY` also cannot delete
   any account while any row remains in `dict_submissions`, because without the
   key one account's pseudonyms are indistinguishable from another's and the
   only sound check is that nobody has any.
