# The DIB decode guardrail — narrow auto-trust on an unsigned `Content-Type`

Branch `v2-wip-2026-08-05`. Implements the operator's decision of 2026-08-05,
item 0 of `docs/superpowers/NEEDS-SALEH.md`: auto-trust a DIB template hit when
the decoded text still carries the Arabic gate literal, route it to review when
it does not.

---

## 1. What shipped

Three packages, one decision point.

| File | Change |
| --- | --- |
| `internal/v2/tmpl/witness.go` | new — `Definition.DecodeWitnesses()`: which of a template's own gate literals are evidence of how the message decoded |
| `internal/v2/origin/dkim.go` | `HeaderContentType` / `HeaderContentTransferEncoding` constants; `DecodingHeaders` now names them (list unchanged — still exactly two) |
| `internal/v2/origin/inner.go` | `Origin.UnsignedDecodingHeaders()` and `Origin.TransferDecodingSigned()`; the join separator is now a shared constant |
| `internal/v2/ingest/pipeline.go` | new `decodeWitnessed`, wired at `parse`'s template-hit branch |

The wired line, in `parse`, inside the branch where a template has just won:

```go
mistrusted := unsignedDecoding && !decodeWitnessed(o, def, res.Text)
return tierResult{
    tier: diag.TierTemplate, ext: ext,
    needsReview: unattestedForward || mistrusted, unparsed: false,
    ...
```

### Why there

`parse` is the only place any tier decides `needs_review`, and all three
production callers reach it — `Deliver` (`pipeline.go:342`), the quarantine
promote (`reprocess.go:332`) and the stored-body reprocess (`reprocess.go:548`).
Putting the guardrail anywhere else would have needed it repeated three times or
would have left a path that still auto-trusts. `TestReprocessKeepsTheWitnessed
ExceptionStable` asserts the reprocess outcome directly rather than the plumbing.

It is *inside* the winning-template branch rather than beside
`unsignedDecoding := o.UnsignedDecoding != ""` above the loop, because the
witness is a property of the definition that won and of the string it read, and
neither exists until then.

### The three conditions

```go
func decodeWitnessed(o origin.Origin, def tmpl.Definition, decoded string) bool {
    if !o.TransferDecodingSigned() { return false }
    witnesses := def.DecodeWitnesses()
    if len(witnesses) == 0 { return false }
    for _, w := range witnesses {
        if !strings.Contains(decoded, w) { return false }
    }
    return true
}
```

**1. The transfer decoding was signed.** This is the condition that keeps the
`Amount =31=30=30.00` construction in review, and it is the one that took the
most thought, so the reasoning in full:

The two decoding headers are not equally dangerous. `Content-Type` chooses the
MIME leaf and the charset; every charset a mail decoder accepts agrees with
US-ASCII on the low 128, so rewriting it cannot change what a run of ASCII
digits *says* — it can only change how non-ASCII bytes read, or which bytes are
text at all. `Content-Transfer-Encoding` chooses the transfer decoding, and that
**does** rewrite ASCII: flipping `7bit` to `quoted-printable` turns the signed
text `=31=30=30.00` into `100.00`.

And a non-ASCII literal is **no defence at all** against that flip. Go's
`mime/quotedprintable` reader consumes `=` and copies everything else, so raw
UTF-8 Arabic passes through a spurious quoted-printable decode completely
intact. Measured directly:

```
in : "إشعار مشتريات\r\nAmount =31=30=30.00\r\nAmount 900.00\r\n"
out: "إشعار مشتريات\r\nAmount 100.00\r\nAmount 900.00\r\n"   err=<nil>
```

The witness survives; the amount changes. No choice of literal fixes this, which
is why it is a separate condition rather than a stronger witness. It is also why
the exception exists at all: **d=dib.ae signs `Content-Transfer-Encoding` and
omits `Content-Type`** — verified against the real fixture, not assumed, in
`TestRealBankFixturesAnswerTheTransferDecodingQuestion`.

**2. The definition declares a witness literal** — a `body_contains` entry with
a non-ASCII rune in it. Fails closed: a template with nothing to check keeps
going to review, which is every published template except `dib.card.v1`.

Only `body_contains` is eligible. `subject_contains` is checked against the
effective *subject*, a different string from the one an extraction reads.
`body_not_contains` is an **absence**, and an absence is exactly what a
mis-decode manufactures — treating it as evidence would read the attack as proof
that no attack happened.

**3. Every declared witness is present in `decoded`** — which is `res.Text`, the
same variable handed to `c.Execute` two lines earlier. Not the raw bytes, not
`res.Subject`, not a re-normalization.

## 2. General, not DIB-specific

Nothing in the mechanism names a bank, a domain or a template id. It is
expressed as *a template that declares a gate literal capable of witnessing a
decode* + *a signature that covered the transfer decoding but not the leaf*.
`internal/v2/origin` and `internal/v2/ingest` contain no reference to `dib.ae`.

The one place DIB appears by name is `internal/v2/tmpl/seed/witness_test.go`,
which is documentation of which published templates *happen* to qualify today
— see §5.

`DecodeWitnesses` lives on `tmpl.Definition` but has **no TypeScript mirror**,
deliberately. The dual-executor contract (spec §3.5) is about what the two
executors *extract*; this feeds only the server's auto-trust decision, and the
client reads `needs_review` off the op payload rather than re-deriving it
(`client/src/replay/replay.ts:718`). Conformance is unaffected.

## 3. On condition 3 being redundant with the template gate

It is redundant today, and this is worth stating plainly because it is exactly
the shape of "a check true by construction" that this project has been bitten by.

`tmpl.Compiled.gate` already refuses a message whose body lacks a
`body_contains` literal, so a definition **cannot** win with its witness
missing. Condition 3 therefore cannot fail at the pipeline call site.

That is deliberate and it is **not where the safety lives** — conditions 1 and 2
are, and both are genuinely falsifiable (mutations M1, M4 and M5 below each kill
tests). Condition 3 is there so the function states its own precondition rather
than inheriting it from a gate two packages away, which is what would silently
widen auto-trust if `body_contains` ever became advisory.

Because it cannot be falsified through the pipeline, it is pinned as a **unit**:
`TestDecodeWitnessedChecksTheTextItWasGiven` hands `decodeWitnessed` the base64
*source* form of the same message and requires a refusal — an implementation
that read the raw bytes rather than the decoded text fails it.

## 4. A hole my own test found, and closed

`TestZeroOriginTransferDecodingIsUnsigned` failed on first run.

`Origin.UnsignedDecoding` is the empty string when every decoding header is
covered. It is *also* the empty string on a zero-valued `Origin` — and two
production sites reconstruct an `Origin` from stored facts that do not include
coverage (`ingest.storedOrigin`, `ingest.recordedOrigin`). Both already
re-derive the field from a fresh resolve, and both carry a comment saying why,
so nothing was broken; but the safety rested on two callers remembering, and the
pre-existing `o.UnsignedDecoding != ""` test has the same shape.

`TransferDecodingSigned` now also requires `o.DKIM == SigPass`. This excludes
nothing real — `UnsignedDecoding` can only be empty because a DKIM signature
verified and named both headers, and `Coverage` is populated from DKIM alone, so
on any `Origin` the resolver produced the two conditions are inseparable — while
making a hand-built or reconstructed `Origin` fail closed as a property of the
type. Pinned by `TestTransferDecodingSignedNeedsBothAPassAndTheCoverage` and
`TestDecodeWitnessedRefusesAnUnverifiedOrigin`.

## 5. What now auto-trusts that did not before

**DIB card mail** (`dib.card.v1`, gate literal `إشعار مشتريات`), and only that.

`dib.account.v1` gates **only by exclusion** — `body_not_contains` with the same
literal, which is what makes the DIB pair a partition
(`TestDIBSeedsPartitionEveryDIBMessage`). It declares no positive literal, so it
has no witness and **DIB account and transfer mail still needs review on every
message.** The ENBD pair needs no exception: its Proofpoint signer covers both
decoding headers, so it was never flagged.

This is the honest limit of what the operator's decision buys as written, and it
is recorded rather than papered over:
`internal/v2/tmpl/seed/witness_test.go:TestWhichSeedTemplatesCanWitnessTheirOwn
Decode` is a total table over published templates and fails if a new one is
added without an answer.

**Closing the `dib.account.v1` gap is an operator decision, not a code change to
slip in.** It means adding a positive Arabic literal (`المبلغ` and `بتاريخ`
appear in every DIB account body and are already used as extraction anchors) to
a **published** template — a version bump, a re-run of the corpus equivalence
gate, and a new `normalizer_version`/hash for every device. It also has to keep
the partition property intact, which a second positive gate on the account
template currently breaks by construction
(`TestDIBSeedsPartitionEveryDIBMessage` asserts neither template carries a
second content gate). Worth doing; not worth doing silently.

## 6. Mutation score: 7 killed / 7 run

Each mutation applied alone to the shipped source, compiled, then
`go test -count=1 ./internal/v2/ingest/ ./internal/v2/origin/ ./internal/v2/tmpl/...`,
then reverted and byte-compared against a pristine copy. Harness at
`/tmp/fe-mut/mutate.py`.

| # | Mutation | Killed by |
| --- | --- | --- |
| M1 | **Accept when the template declares no witness literal** (drop the `len(witnesses) == 0` guard) | `TestAnASCIIGateLiteralBuysNoAutoTrust`, `TestABodyNotContainsGateBuysNoAutoTrust`, `TestDecodeWitnessedRefusesADefinitionWithNoWitness`, `TestATemplateHitWhoseDecodingHeaderIsUnsignedIsNotAutoTrusted`, `TestReprocessDoesNotClearTheUnsignedDecodingFlag` |
| M2 | **Check the literal against a different decoded string** (`res.Subject` instead of `res.Text`) | `TestADIBShapedHitWhoseArabicGateSurvivedTheDecodeIsAutoTrusted`, `TestReprocessKeepsTheWitnessedExceptionStable` |
| M2raw | **Check the literal against the raw bytes** (thread `d.Raw` / `it.Blob` into `parse` and check that instead of the decoded text) | same two — the DIB-shape fixture is base64, so the literal is absent from the raw form and auto-trust is lost |
| M3 | **Ignore `UnsignedDecoding` entirely** (`needsReview: unattestedForward`) | `TestTheQuotedPrintableConstructionStaysInReviewEvenWithAWitnessPresent`, `TestAnInPlaceEditOfAnUnsignedDecodingHeaderChangesTheAmount`, `TestPromotingMailWhoseKeyIsGoneDoesNotAutoTrustIt`, +4 |
| M4 | **Let the quoted-printable construction through** (drop the `TransferDecodingSigned` condition) | `TestTheQuotedPrintableConstructionStaysInReviewEvenWithAWitnessPresent`, `TestDecodeWitnessedRefusesWhenTheTransferEncodingIsUnsigned`, `TestDecodeWitnessedRefusesAnUnverifiedOrigin` |
| M5 | **Treat an ASCII-only gate literal as a witness** (`hasNonASCII` always true) | `TestAnASCIIGateLiteralBuysNoAutoTrust`, `TestAnASCIIOnlyGateLiteralIsNotAWitness`, `TestDecodeWitnessesFiltersRatherThanAllOrNothing`, `TestOnlyBodyContainsCanWitness`, +3 |
| M6 | **Drop the passing-DKIM requirement** from `TransferDecodingSigned` | `TestZeroOriginTransferDecodingIsUnsigned`, `TestTransferDecodingSignedNeedsBothAPassAndTheCoverage`, `TestDecodeWitnessedRefusesAnUnverifiedOrigin` |

No mutation survived. M2raw failed to compile on its first attempt (wrong
variable name at one call site); it was fixed and re-run rather than counted.

### The mandated case

`TestTheQuotedPrintableConstructionStaysInReviewEvenWithAWitnessPresent`
(`internal/v2/ingest/decodewitness_test.go`).

It is deliberately the *hardest* form: `qpAmbiguousBody` with the Arabic gate
literal added on top, so the witness is genuinely present in both readings and
cannot be what saves it. The signer omits `Content-Transfer-Encoding`; the
honest message reads 900.00 under `7bit` and the in-place edit to
`quoted-printable` reads 100.00; the template **wins on both** (asserted, so the
test cannot pass vacuously via a non-match); the signature still verifies on
both (asserted via `heldCount() == 0`); and **both** land in review — the
tampered one because it is tampered, the honest one because at the point of
decision it is byte-indistinguishable from it.

### Tests that could have passed vacuously, and what stops them

- The charset-rewrite test originally looped over `hotOps()`, which asserts
  nothing when the set is empty. It now uses `onlyPayload()` and additionally
  asserts `tier != template` — i.e. it measures that the Arabic literal was
  genuinely destroyed, not merely that a flag got set downstream. (Probed: the
  rewrite drops the message to the heuristic tier, `needs_review: true`, amount
  still 25000. That is the measurement item 0 describes, reproduced.)
- `TestTheSameArabicMessageFullySignedIsAlsoAutoTrusted` is the control: without
  it, the auto-trust test could be measuring the signature rather than the
  witness.
- `TestDecodeWitnessesFiltersRatherThanAllOrNothing` uses a four-entry mixed
  list. A one-entry fixture cannot tell "filtered" from "returned everything".
- `TestWhichSeedTemplatesCanWitnessTheirOwnDecode` is total over `Seed()` in
  both directions — an unlisted template and a listed-but-unpublished one both
  fail.

## 7. Verification

**`bash scripts/v2-check.sh` at commit `54a86a3`, in a clean `git archive`
export with `client/node_modules` and `app/node_modules` copied in: exit 0.**
(`v2-check: OK (go + client + app + conformance)`.) Exit code captured from the
script itself, not from a pipeline.

In the **working tree** the same script exits 1, in
`app/src/screens/transactions/TransactionsScreen.rn-test.tsx` — another
session's **untracked**, in-progress RN list-windowing test (`?? ` in
`git status`; present in no commit, which is why the export above does not
contain it and does not run it). This change touches no file under `app/` or
`client/`. Even in that run the Go step is fully green — 28 `ok  ledger/...`
packages, no `FAIL` — and the `client/` step reports `0 fail`.

Two notes on the export, so the next person does not lose the time:

- `git archive` output is not a git repository, so `go build` refuses with
  `error obtaining VCS status: exit status 128` and
  `client/test/e2e/roundtrip.test.ts` fails at `boot()`. `git init` + one commit
  in the export directory (or `-buildvcs=false`) fixes it. That failure is the
  export method, not the code — the first export run reported 32 failures, all
  of them this.
- `client/src/replay/fx.test.ts`'s 5s limit did not trip in either run.

Also run separately, all green:

- `go vet ./internal/v2/... ./cmd/ledgerd`
- `go test -count=1 ./internal/v2/... ./cmd/ledgerd` (exit 0)
- `gofmt -l` clean on every file this change touches.
  `internal/v2/ingest/reprocess_test.go` is `gofmt`-unclean **at `14d624b`**,
  untouched by this change and left alone.

## 8. Files

New:

- `internal/v2/tmpl/witness.go`
- `internal/v2/tmpl/witness_test.go`
- `internal/v2/tmpl/seed/witness_test.go`
- `internal/v2/origin/witness_test.go`
- `internal/v2/ingest/decodewitness_test.go`

Modified:

- `internal/v2/origin/dkim.go` — constants only; `DecodingHeaders` is the same
  two names it was, neither widened nor shortened
- `internal/v2/origin/inner.go` — two methods, one separator constant
- `internal/v2/ingest/pipeline.go` — `decodeWitnessed`, its wiring, and the
  comment above `unsignedDecoding`, which claimed "EVERY message needs review"
  and is no longer true
- `docs/superpowers/NEEDS-SALEH.md` — item 0's "I have not built this" is now
  built
