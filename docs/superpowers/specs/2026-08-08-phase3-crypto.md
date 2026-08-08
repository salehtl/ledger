# Phase 3 — at-rest encryption, for the web client

**Date:** 2026-08-08
**Status:** Decided, pre-implementation. Amends `2026-07-31-multi-user-beta-design.md` §3.4 and §3.9 for a browser client rather than an Expo one.
**Decided by:** the assistant, at the operator's instruction to decide alone and record what needs aligning.

## The decision that overrides the request

The operator asked for onboarding copy saying we encrypt their data and **"only they can access it."**

**That sentence will not be written, because it is not true**, and §2 of the beta design forbids it in as many words:

> The claim is "encrypted at rest with a plaintext ingest window" — not "zero-access", not "we can't see it."

Bank mail arrives over SMTP **in plaintext**. It must: the bank sends it that way. The server parses it in memory and seals it to the user's public key, and only ciphertext is stored — but there is a window, on our machine, where the plaintext exists. Further, §2 states plainly that a live, actively compromised server could log the plaintext of *future* mail as it arrives, and can fabricate server-ingested transactions. That is the same residual trust Proton Mail carries for external mail.

Writing "only you can access it" would be a false privacy claim, made to people who sign a consent document, at the moment they are deciding whether to trust us. It is also exactly the defect class this branch has spent two days removing from the UI — a sentence the code does not honour — and this is the worst possible instance of it.

**What onboarding will say instead** is strong, specific and true:

- Your transactions and bank emails are **encrypted before they are stored**, with a key only your devices hold.
- **We cannot read what is stored.** A stolen disk, a stolen backup or a subpoena of our database yields ciphertext.
- **We do see each email for the moment it arrives**, because your bank sends it to us unencrypted. We read it to extract the transaction, seal it, and discard the original.
- **If you lose your recovery phrase and your devices, your history is gone.** We cannot restore it.

That is a stronger claim than most products make and it survives scrutiny. **ALIGNMENT ITEM 1 for the operator: this reverses an explicit instruction. If you want the shorter sentence, it needs the qualification, and I would argue against it.**

## What already exists

- **`blob.Sealer` is the one interface Phase 3 replaces** (`internal/v2/blob/blob.go:266`). The swap point was built in.
- **`encv2.go`** is a benchmark instrument carrying the sealed envelope shape — `[1B version=2][2B aadLen][aad][32B enc][12B nonce][sealed][16B tag]`, where `enc` is the per-record ephemeral X25519 public key. Explicitly not wired to production.
- **Per-device Ed25519 identity keys, the key-history log, TOFU pinning and the cross-device comparison code all shipped** with second-device enrolment on 2026-08-08. Phase 3 does not need to build them.

## Decisions

1. **Framing version 2, the `enc` slot.** `encv2.go` records the choice between bumping the framing version and adopting a per-user static ephemeral; it benchmarked the bump. Take it. A static ephemeral trades forward secrecy per record for 32 bytes, which is the wrong trade for a financial log.
2. **The AEAD binds the whole cleartext header**, not the embedded AAD alone — `blob.go`'s package doc argues this and notes the two cost the same. Strictly stronger; take it.
3. **Migrate, do not wipe** (NEEDS-SALEH §6). There is one real user with a handful of ops. Migration is cheap today, proves the path for every later alpha, and wiping would mean telling people the beta's data is disposable. **ALIGNMENT ITEM 2: this commits us to keeping a re-sealing path working.**
4. **The recovery phrase is mandatory, not optional.** §3.4 designed for iOS, where iCloud Keychain syncs a device wrap key and the phrase is a backstop. **A browser has no Keychain.** If the user clears site data with no phrase written down, the account is unrecoverable — by design, since we hold no key. So the phrase is generated and confirmed during onboarding, not offered later. **ALIGNMENT ITEM 3: this adds friction to signup that the native design did not have, and it is not optional friction.**
5. **Key storage: non-extractable `CryptoKey` in IndexedDB.** The private key material is never exposed to JavaScript once stored. This is weaker than a Keychain — any XSS can *use* the key even if it cannot read it — and §2's breach inventory must say so.
6. **Order of work is chosen so a partial stop is safe.** Key material and wrapping first (no data path changes), then sealing, then migration. If work halts midway the system is still plaintext and working. **There must never be a half-encrypted log.**

## What §2 must gain

- Browser key storage replaces iOS Keychain custody: Apple leaves the threat model, XSS enters it.
- The recovery phrase is the only recovery path on web.
- The declared bank list, budget split and categories are in the op log and therefore sealed — they are not in the plaintext inventory.

## Out of scope

Blob padding to size buckets and jittered upload timing (§2's metadata mitigations) are listed in §5's Phase 3 but are independent of correctness and can follow. Rich push via a Notification Service Extension is native-only and does not apply.
