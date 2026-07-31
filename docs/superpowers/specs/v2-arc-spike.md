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

Every message in the corpus was run through `arc.Verify` against live DNS:

```
scanned 6998 messages in 1.56s
status: map[none:5776 pass:1222]
  1-instance pass          1082
  2-instance pass          140
negative control (1 body byte flipped): map[fail:1222]
failure reasons:            (none)
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
- Highest-instance AMS verified as a DKIM signature with the header field name substituted: `bh=` over the canonicalized body, `h=` header selection bottom-up per RFC 6376 §5.4.2, self-inclusion with `b=` emptied and the trailing CRLF removed.
- Every ARC-Seal from instance 1 upward, over the cumulative AAR/AMS/AS triples of instances `1..i` in instance order, relaxed header canonicalization, no body hash.
- DKIM key records: `v=`/`k=`/`p=`, RSA as both SubjectPublicKeyInfo and PKCS#1 (erratum 3017), Ed25519, revocation (`p=`), multi-string TXT.
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

Task 26 must **not** assume that a passing chain means the AAR is true. Verify
proves the chain was not tampered with after instance 1 sealed it; it proves
nothing about whether instance 1 was honest. Task 26 owns that judgement, and
`§3.2:51`'s refusal to allowlist forwarder domains still stands.

Task 26 should also assume the direct-DKIM path is the primary one and build it
first, with ARC consulted only when the inner signature fails.

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
**replaces the key behind the unchanged selector name**. Only messages from
2026-04 onward verify against today's key.

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

---

## Reproducing the evidence

The corpus-wide runs are not part of the committed suite: they need the corpus
snapshot and live DNS, and every committed test is deliberately offline. To
reproduce:

```bash
S=/path/to/scratch
sudo sqlite3 "file:/var/lib/ledger/ledger.db?mode=ro" ".backup '$S/corpus.db'"
sudo chown "$(id -un)" "$S/corpus.db"
LEDGER_CORPUS_DB=$S/corpus.db go run ./internal/v2/corpus/cmd/extract-fixtures \
  --out internal/v2/origin/testdata
go test ./internal/v2/arc/ ./internal/v2/corpus/ -v
```

The corpus grows as v1 keeps ingesting — 6,994 when the plan was written, 6,998
at extraction. Nothing asserts an exact count.
