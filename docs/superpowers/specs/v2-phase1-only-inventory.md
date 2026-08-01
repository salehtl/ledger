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
by `ingest.Pipeline.reprocessHeld` (Task 30).

Quarantined mail is **not** in the cold stream — it was never appended — so its
raw body lives in `quarantine.blob`, plaintext in Phase 1. Confirming a sender
returns the ingest ids of everything held from that origin; reprocess reads
those bodies, re-runs steps 4–7 and appends the results, and *that append* is
when the messages enter the integrity chains. `Promote` then clears the rows.

### 3. `samples.Donate` pulling the raw body from the user's cold stream

Task 31. The opt-in, content-bearing donation path: the server pulls the body
from the user's own cold stream rather than accepting an upload, so a donation
can never introduce content the user did not actually receive. Same cold read,
same impossibility.

### 4. `ledgerd parse-rate` adjudication over unparsed cold bodies

Task 36. The operator subcommand that reads unparsed bodies to decide whether a
message was a transaction at all. Reads plaintext cold bodies; the table it
writes is dropped at the cutover.

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
