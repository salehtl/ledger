# ARC verification spike — verdict

**Date:** 2026-07-31
**Task:** Phase 1, Task 2 (risk-first)
**Question:** can we implement RFC 8617 ARC chain verification in-repo, given that no Go library provides it?

## Verdict: **GO**

RFC 8617 chain verification is implemented in `internal/v2/arc` and validates
**1,222 of 1,222** real ARC chains in the v1 mail corpus, sealed by three
independent providers across six different keys. The work took well under the
one-session timebox the brief allowed. No part of the algorithm had to be
weakened or stubbed.

The scope guard in the brief — "if the AS-over-header-set signing input proves
larger than one working session, ship `Status = "none"` with a `TODO(arc)`" —
was not needed and has not been used.

---

## What was verified, against what

### Corpus-wide validation

Every message in the corpus is run through `arc.Verify` against live DNS by
`internal/v2/corpus/cmd/arc-corpus-scan`, which exits non-zero if either of the
verdict's two claims stops holding — so this is an assertion, not a report:

```
$ LEDGER_CORPUS_DB=$S/corpus.db go run ./internal/v2/corpus/cmd/arc-corpus-scan
scanned:     6998 messages in 1.341s
chain status:    5776 none / 1222 pass
by shape:        1082 1-instance pass / 140 2-instance pass
NEGATIVE CONTROL — one mid-body byte flipped:   1222 fail
failure reasons: none
OK: 1222/1222 ARC chains verify, and all 1222 fail when one body byte is flipped.
```

Every chain passes. Nothing fails, and nothing was skipped.

**The negative control is the load-bearing half of that result.** A verifier
that silently short-circuits — one that resolves no key, or hashes an empty
input, or never reaches the seal loop — would also report 1,222 passes. So the
same 1,222 messages were re-verified with a single byte of body flipped, in the
middle of the body, well clear of trailing whitespace that canonicalization
legitimately discards, with the mutation asserted to have landed. **All 1,222
then fail.** The passes are therefore doing real work.

### Interoperability breadth

The 1,222 chains are sealed by six distinct keys belonging to three
independently-implemented sealers:

| Sealer | Selector | Chains |
| --- | --- | ---: |
| google.com | arc-20160816 | 879 |
| google.com | arc-20260327 | 149 |
| google.com | arc-20240605 | 134 |
| icloud.com | arc-0513 | 140 |
| microsoft.com | arcselector10001 | 55 |
| microsoft.com | arcselector9901 | 5 |

Agreeing with Google, Apple and Microsoft simultaneously — on canonicalization,
on the seal's cumulative header ordering, on the `b=`-blanking rule and on the
trailing-CRLF rule — is not something a subtly wrong implementation does. This
is genuine interop evidence, not self-consistency.

### Adversarial cases (`internal/v2/arc/arc_test.go`)

Each of these mutates a real chain and requires a specific rejection, checked
against the reported reason rather than just the status — a test that fails for
the wrong reason proves nothing:

| Test | Mutation | Must be caught by |
| --- | --- | --- |
| `TestTamperedBodyBreaksTheAMS` | one body byte | top AMS body hash |
| `TestTamperedLowerAMSBreaksTheSeals` | instance 1's AMS `b=` | seal signature |
| `TestTamperedSealSignatureBreaksTheChain` | each seal's `b=` | seal signature |
| `TestForgedAARIsNotTrusted` | instance 1's AAR rewritten to claim `dkim=pass` | seal signature |
| `TestRemovedInstanceBreaksTheChain` | instance 1's seal deleted | structural completeness |
| `TestFlippedCVIsRejected` | `cv=none` → `cv=pass` | `cv=` rule |
| `TestUnknownKeyDoesNotPass` | no keys resolvable | key lookup |
| `TestNoARCHeadersIsNone` | unsigned-by-ARC message | reports `none`, not `pass` |
| `TestBareLFInHeaderIsRejected` | `X-Junk: a\n\nX-Junk2: b\r\n` prepended | header parse (finding 4) |

Every mutation now asserts *where* it landed (`onlyFieldChanged`), and
`TestMutationAssertionIsNotVacuous` checks that assertion rejects what it claims
to. Two of these tests were originally green for the wrong reason: they selected
headers by the substring `"i=1"`, which also occurs inside an instance-2 AAR's
`arc=pass (i=1 ...)` comment, so they edited the wrong field and were caught by
a structural rule rather than the signature rule they named.

Synthetic chains (`internal/v2/arc/build_test.go`) cover the rules the corpus
cannot reach — seal `h=`, seal `bh=`, `l=`, `rsa-sha1`, instance gaps, duplicate
instances, the 50-instance ceiling, `h=` without `From`, and every key-record
failure mode — plus single-instance tampering, which is the shape 1,082 of the
1,222 corpus chains actually have. See finding 5.

`TestTamperedLowerAMSBreaksTheSeals` is the sharpest of these. RFC 8617
deliberately does *not* verify any AMS below the highest instance, so nothing in
the implementation reads those bytes except the seal hash. If seal verification
were wrong or absent, that test — and only that test — would still pass. It
fails correctly.

Canonicalization is pinned separately against the worked example published in
RFC 6376 §3.4.5, for all four algorithms, rather than against our own output.

---

## What is implemented, and what is not

Implemented, per RFC 8617 §5.2:

- Instance assembly with a strict `1..N`, no-gaps, no-duplicates, exactly-one-of-each rule, and the §5.1.2 ceiling of 50.
- `cv=none` required at instance 1, `cv=pass` at every later instance.
- RFC 6376 §6.1.1: a signature whose `h=` omits `From` is a verification failure.
- Bare LF in the header block is a hard rejection — see finding 4.
- Highest-instance AMS verified as a DKIM signature with the header field name substituted: `bh=` over the canonicalized body, `h=` header selection bottom-up per RFC 6376 §5.4.2, self-inclusion with `b=` emptied and the trailing CRLF removed.
- Every ARC-Seal from instance 1 upward, over the cumulative AAR/AMS/AS triples of instances `1..i` in instance order, relaxed header canonicalization, no body hash.
- DKIM key records: `v=`/`k=`/`p=`, RSA as both SubjectPublicKeyInfo and PKCS#1 (erratum 3017), Ed25519, and revocation (`p=`). Where a name carries several TXT records, the first one containing `p=` that parses is used, so unrelated records under `_domainkey` are skipped. Multi-string TXT records need no handling here: Go's resolver already joins the character-strings within a single RR.
- Both `simple` and `relaxed` canonicalization for headers and bodies.

Deliberately not implemented:

- **`l=` (body length) is refused, not ignored.** Honouring it would let anyone append arbitrary content below a valid signature. No corpus message uses it.
- **`rsa-sha1` is refused.** Deprecated, and absent from the corpus.
- **No trust decision.** `Verify` reports whether the chain is cryptographically intact and hands out instance 1's AAR verbatim. A chain sealed by an attacker's domain is a valid chain; deciding whether a sealer is worth believing is Task 26/27's problem, and this package does not have an opinion.
- **No DKIM API is exported.** The package verifies DKIM-shaped signatures internally because an AMS *is* one, but exposing that would invite Task 26 to adopt a verifier that has no expiry policy. Task 26 should use `go-msgauth/dkim` and decide expiry deliberately.
- **`ed25519-sha256` is implemented but untested against real mail** — nothing in the corpus uses it.

---

## Which path is load-bearing

**The direct-DKIM inner-origin path is load-bearing. ARC is the fallback.**

This was measured, not assumed. For every one of the 140 two-hop forwarded
messages in the corpus, the original `d=dib.ae` DKIM signature **still verifies
cryptographically** on the message as delivered through iCloud and then Gmail —
not merely a matching body hash, but a full signature check against the
published key:

```
FORWARDED (2-hop ARC) messages only:
    140  verify-ok [selector2._domainkey.dib.ae]
```

So bank identity can be established for the common forwarding case without ARC
at all. ARC earns its place only for forwarders that *modify* the message and
thereby break the original signature — which this operator's path does not do.

That ordering matters for what a future ARC regression costs. It is not "the
alpha cannot run"; it is "forwarders that rewrite bodies stop working", with the
direct path unaffected.

### What Task 26 may now assume

Task 26 may assume that `arc.Verify(ctx, raw, lookupTXT)` returns
`Status == "pass"` exactly when a message carries a complete, unbroken,
correctly-sealed RFC 8617 chain, and that on a pass, `AARValues[0]` is the
byte-exact ARC-Authentication-Results the first hop wrote — including its
`dkim=pass header.d=...` claim about the bank. It may assume this holds for
chains sealed by Google, Apple and Microsoft, at one and two hops, because all
1,222 in the corpus do.

It should also assume the direct-DKIM path is the primary one and build it
first, with ARC consulted only when the inner signature fails.

**Three things a passing chain does not mean.** Each of these is a way to read
`Status == "pass"` as more than it says, and the third is the one that reads as
a bug report against ARC itself rather than against the caller.

**1. It does not mean the AAR is true.** Verify proves the chain was not
tampered with after instance 1 sealed it. It proves nothing about whether
instance 1 was honest. A chain sealed end-to-end by an attacker's own domain is
a perfectly valid chain. Task 26 owns that judgement, and `§3.2:51`'s refusal to
allowlist forwarder domains still stands.

**2. It does not mean `From` and `Subject` are authentic.** Only the header
fields named in the top ARC-Message-Signature's `h=` are covered. Anything
outside that list is unsigned and may have been added or rewritten by anyone
after sealing. `ChainResult.SignedHeaders` reports exactly which fields were
covered, and `ChainResult.SignedValue(name)` returns a value only for those.

`From` is guaranteed present in that list — RFC 6376 §6.1.1 makes its absence a
verification failure and this package enforces it (`TestAMSMustCoverFrom`).
Nothing else is guaranteed, `Subject` included. `TestRewritingAnUnsignedHeaderIsNotDetected`
demonstrates a chain that passes while its Subject is rewritten.

**3. Read the BOTTOM-most occurrence of any header you treat as verified.**
A signature covers the bottom-most instance of a repeated field (RFC 6376
§5.4.2), because later hops prepend their copies above it. Prepending a second
`From:` to a validly sealed message leaves the chain passing while a naive
reader — `net/mail`, `go-message`, anything using `Header.Get` — hands back the
attacker's line. This is inherent to DKIM and ARC, not specific to this
implementation; `go-msgauth`'s DKIM verifier behaves identically.

Use `ChainResult.SignedValue`, which does the bottom-most pick and refuses
unsigned names, rather than re-reading the raw message.
`TestSingleInstanceChainTampering/prepended_From` pins this.

**And use the parse Verify gives you.** `ChainResult.Header` and
`ChainResult.Body` are the exact split the verification was computed over.
Re-parsing the raw bytes with a second parser invites the two to disagree about
where the header block ends — which is precisely the bug found in this
package's own first implementation and recorded in finding 4 below.

---

## Findings that change other tasks

These came out of the spike and contradict facts the plan was written against.
They are the reason the fixture extractor is stricter than the brief specified.

### 1. `selector1._domainkey.dib.ae` is gone — NXDOMAIN, authoritatively

The brief records "DIB signs `d=dib.ae` with selectors `selector1` and
`selector2`, **both live in DNS**". `selector1` no longer resolves; confirmed
NXDOMAIN at DIB's own nameserver `ns1.dib.ae`, not just at public resolvers.

**6,389 of the corpus's 6,998 DKIM signatures name that selector.** They can
never be verified again by anyone. Only the 479 `selector2` messages remain
checkable. This is not recoverable and not our fault — it is what key retirement
means.

*Consequence:* any task selecting a DIB DKIM fixture must select `selector2`.
Roughly 91% of the corpus is unusable as a DKIM fixture source.

### 2. DKIM fixtures rot by **rotation**, not just expiry — and rotation is silent

The brief anticipated one decay mode, `x=` expiry, and concluded that "the 62
ENBD messages carry no `x=` tag at all and are the only permanently stable DKIM
fixtures in the corpus."

**48 of those 62 do not verify.** Not expiry — they have no `x=`. Not
retirement — `selector1._domainkey.emiratesnbd.com` resolves fine. The body hash
matches. The key record parses. The signature simply fails, because
emiratesnbd.com publishes that selector as a CNAME into Microsoft 365, which
**replaces the key behind the unchanged selector name**. The rotation lands cleanly between 2025-12-15 and
2026-01-25: every ENBD message on or before the first date fails, every one on
or after the second verifies.

This is the finding that matters most for fixture hygiene, because every cheap
check says these fixtures are healthy:

| Check | Says |
| --- | --- |
| `has_x_tag` | fine, no expiry |
| selector resolves | fine |
| key record parses | fine |
| body hash | fine |
| **signature verifies** | **fails** |

The brief's `has_x_tag` canary would have declared all 48 sound.

*Consequence:* the extractor now verifies every candidate with
`go-msgauth/dkim` against the DNS answers it is about to record, and refuses to
emit a fixture that does not pass. The manifest carries `dkim_verifies`.
`TestFixtureDKIMStillVerifies` re-checks all seven fixtures against recorded
DNS on every run.

*The good news:* because `dns.json` pins the key bytes that were correct at
extraction time, retirement and rotation **cannot reach a committed fixture**.
Only expiry can, since a verifier evaluates `x=` against the wall clock. So the
one canary still needed is the expiry one, and `x_expires_at` in the manifest
feeds it.

### 3. ARC fixtures are genuinely permanent — confirmed

Zero ARC-Message-Signatures and zero ARC-Seals in the corpus carry an `x=` tag
(`TestARCFixturesCarryNoExpiryTag` guards this). Combined with recorded DNS and
the fact that `arc.Verify` implements no expiry policy of its own, the four ARC
fixtures verify identically forever. The ARC test suite cannot rot.

The DIB DKIM fixture expires **2027-06-21**; the two ENBD fixtures never do.

### 4. A verified chain is not a verified *document* — the bare-LF hole

Found in review, after the first version of this document was written, and the
most serious defect in the spike. It is recorded here rather than quietly fixed
because the lesson generalises past this package.

The first implementation split the header block on `\r\n\r\n` and header lines
on `\r\n`, and its own doc comment claimed bare-LF input was rejected. It was
not. Go's `net/textproto` — and therefore `net/mail`, `go-message`, and most of
the mail ecosystem — also accepts a bare LF as a line terminator and a bare
`LF LF` as the end of the header block. This parser did not.

Prepending 22 bytes to a genuinely sealed fixture was enough:

```
X-Junk: a\n\nX-Junk2: b\r\n
```

`arc.Verify` reported `Status=pass, Instances=2, SealDomains=[icloud.com
google.com]` with instance 1's AAR intact. `net/mail`, reading the same bytes,
saw **one** header field, no `From`, no `Subject`, and a body beginning with the
entire real message.

Every individual signature check was correct. The chain really was intact — over
the document *this parser* saw. The vulnerability was that a caller would
authenticate that document and then act on a different one, which is a confused
deputy on any path where message bytes are attacker-influenced. That is every
inbound path, and v2's whole premise is an SMTP endpoint anyone can send to.

*Fix:* `ReadHeader` rejects any bare LF in the header block outright
(`ErrBareLF`). Repairing the input was never an option — rewriting bytes changes
what every signature is computed over. Body LFs are untouched, since the header
block is already delimited by then and real MIME bodies contain them.
`TestBareLFInHeaderIsRejected` uses the exact 22-byte prepend and first asserts
that `net/mail` really is fooled, so the test keeps its meaning if `ReadHeader`
is ever loosened.

*Also fixed:* `ChainResult` now carries `Header` and `Body` — the exact split
the verification was computed over — so a caller has no reason to re-parse and
no way to disagree.

**The generalisable lesson:** a signature verifier is only as trustworthy as the
agreement between its parser and every other parser that will touch the same
bytes. Correct crypto over a differently-framed document proves nothing. Where
strictness and leniency disagree, strictness is the only safe side, because the
alternative is depending on every downstream library to share your
interpretation.

### 5. Two safety rules had no coverage until a synthetic builder existed

The corpus can only demonstrate rules that Google, Apple and Microsoft actually
exercise. Rules that exist to reject chains no honest sealer emits — a seal
carrying `h=` or `bh=`, an instance numbered 51, a duplicated instance, `l=`,
`rsa-sha1` — had no test at all, and a rule with no test can be deleted without
anything going red.

`internal/v2/arc/build_test.go` generates a key, publishes it through a fake
resolver, and signs chains that are valid except in one chosen way. It
self-checks: any chain it claims is valid must verify, so a fault-injection test
cannot pass because the builder silently produced garbage. That covers all seven
rules, every key-record failure mode, and — importantly — single-instance
adversarial cases, which are 1,082 of the corpus's 1,222 chains but were
previously untested because every fixture-based adversarial test mutated the one
two-instance message.

---

## Reproducing the evidence

The corpus-wide runs are not part of the committed suite: they need the corpus
snapshot and live DNS, and every committed test is deliberately offline. To
reproduce:

```bash
S=/path/to/scratch
sudo sqlite3 "file:/var/lib/ledger/ledger.db?mode=ro" ".backup '$S/corpus.db'"
sudo chown "$(id -un)" "$S/corpus.db"

# The GO verdict's headline evidence: every chain verifies, and every one of
# them fails when a body byte is flipped. Exits non-zero if either stops being
# true, so this is an assertion and not just a report.
LEDGER_CORPUS_DB=$S/corpus.db go run ./internal/v2/corpus/cmd/arc-corpus-scan

# Regenerate the committed fixtures, and run the offline suite.
LEDGER_CORPUS_DB=$S/corpus.db go run ./internal/v2/corpus/cmd/extract-fixtures \
  --out internal/v2/origin/testdata
go test ./internal/v2/arc/ ./internal/v2/corpus/ -v
```

`arc-corpus-scan` output as of 2026-07-31:

```
scanned:     6998 messages in 1.341s
chain status:    5776 none / 1222 pass
by shape:        1082 1-instance pass / 140 2-instance pass
NEGATIVE CONTROL — one mid-body byte flipped:   1222 fail
failure reasons: none
OK: 1222/1222 ARC chains verify, and all 1222 fail when one body byte is flipped.
```

The corpus grows as v1 keeps ingesting — 6,994 when the plan was written, 6,998
at extraction. Nothing asserts an exact count.
