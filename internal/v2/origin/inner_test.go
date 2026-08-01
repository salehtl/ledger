package origin

import (
	"bytes"
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"fmt"
	"net/mail"
	"os"
	"regexp"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/emersion/go-msgauth/dkim"

	"ledger/internal/v2/arc"
	"ledger/internal/v2/diag"
)

// ---------------------------------------------------------------------------
// The two paths, on real mail
// ---------------------------------------------------------------------------

func TestGmailForwardIsAttestedByDirectInnerDKIMWithoutARC(t *testing.T) {
	raw := mustRead(t, "gmail-forward-inner-dkim.eml")
	got := Resolve(context.Background(), raw, recordedLookup(t))

	if !got.Attested || got.AttestedBy != AttestedByDKIM || got.Inner != "dib.ae" {
		t.Fatalf("%+v", got)
	}
	if got.InnerFrom != "DIB.notification@dib.ae" {
		t.Fatalf("InnerFrom = %q, want the signed From address", got.InnerFrom)
	}
	// The outer origin is the hop that handed us the message, not the bank.
	// Confusing the two is the forwarder-allowlist bypass spec 3.2 forbids.
	if got.Outer != "google.com" {
		t.Fatalf("Outer = %q, want the top ARC seal domain", got.Outer)
	}
	if got.DKIM != SigPass || got.ARC != SigPass {
		t.Fatalf("DKIM = %q, ARC = %q", got.DKIM, got.ARC)
	}
	if got.Reason != "" {
		t.Fatalf("Reason = %q, want empty on an attested origin", got.Reason)
	}
}

// The direct path is load-bearing (see docs/superpowers/specs/v2-arc-spike.md):
// every forwarded message in the corpus keeps a verifiable d=dib.ae signature,
// so ARC is a fallback and not the thing the alpha rests on. If this stops
// holding for the fixtures it has stopped holding for the corpus.
func TestEveryForwardedFixtureIsAttestedByTheDirectPath(t *testing.T) {
	lookup := recordedLookup(t)
	for _, f := range []string{
		"gmail-forward-1.eml", "gmail-forward-2.eml",
		"gmail-forward-3.eml", "gmail-forward-inner-dkim.eml",
	} {
		t.Run(f, func(t *testing.T) {
			got := Resolve(context.Background(), mustRead(t, f), lookup)
			if !got.Attested || got.AttestedBy != AttestedByDKIM || got.Inner != "dib.ae" {
				t.Fatalf("%+v", got)
			}
		})
	}
}

// The forwarder broke (or the bank retired the key behind) the inner signature.
// Finding 1 of the ARC spike makes this the common case, not a hypothetical:
// selector1._domainkey.dib.ae is NXDOMAIN, so 6,389 corpus messages can never
// have their own DKIM verified again — but their ARC chains still verify.
func TestARCIsUsedOnlyWhenDirectInnerDKIMIsAbsent(t *testing.T) {
	recs := loadDNSMap(t)
	delete(recs, "selector2._domainkey.dib.ae")

	got := Resolve(context.Background(), mustRead(t, "gmail-forward-inner-dkim.eml"), staticTXT(recs))
	if got.DKIM != SigFail {
		t.Fatalf("DKIM = %q, want fail with the bank's key withdrawn", got.DKIM)
	}
	if !got.Attested || got.AttestedBy != AttestedByARC || got.Inner != "dib.ae" {
		t.Fatalf("%+v", got)
	}
	if got.InnerFrom != "DIB.notification@dib.ae" {
		t.Fatalf("InnerFrom = %q", got.InnerFrom)
	}
}

// Bank mail nothing verifiably relayed: the signature is the message's own
// identity AND the domain that handed it to us, so there is no forwarder to see
// behind. Both fixtures carry zero ARC sets (testdata/manifest.json), which is
// what makes them the direct case — not the envelope, which is a string the
// sender types.
func TestAlignedSignatureIsOuterNotInner(t *testing.T) {
	lookup := recordedLookup(t)
	for file, want := range map[string]string{
		"dib-dkim-unexpired.eml": "dib.ae",
		"enbd-proofpoint-p.eml":  "emiratesnbd.com",
		"enbd-selector1.eml":     "emiratesnbd.com",
	} {
		t.Run(file, func(t *testing.T) {
			got := Resolve(context.Background(), mustRead(t, file), lookup)
			if got.Outer != want {
				t.Fatalf("Outer = %q, want %q", got.Outer, want)
			}
			if got.Attested || got.Inner != "" || got.AttestedBy != "" {
				t.Fatalf("direct bank mail has no forwarder to see behind: %+v", got)
			}
			if got.Reason == "" {
				t.Fatal("a refusal to attest must say why")
			}
		})
	}
}

// A SEALER IS NOT A FORWARDER. enbd-selector1.eml is direct bank mail carrying
// a one-hop microsoft.com ARC chain, because Microsoft is Emirates NBD's own
// outbound provider — and Microsoft's own instance-1 AAR says
// "dkim=none (message not signed)", because the emiratesnbd.com signature was
// added by that same gateway on the way out.
//
// This is the fixture that decides how "relayed" is defined. Treating any
// passing trusted chain as a forwarder would read HALF of one bank's mail as
// forwarded (this fixture) and half as direct (enbd-proofpoint-p.eml, zero ARC
// sets), splitting one sender across two allowlist scopes and stranding
// whichever half the user did not confirm — which is exactly what the Phase 1
// exit test caught. The corpus states the difference outright, in a field the
// seal authenticates, so that is what relayDomain reads.
func TestASealerThatSawNoSignatureIsNotAForwarder(t *testing.T) {
	raw := mustRead(t, "enbd-selector1.eml")
	got := Resolve(context.Background(), raw, recordedLookup(t))
	if got.ARC != SigPass || got.DKIM != SigPass {
		t.Fatalf("fixture no longer carries both a passing chain and a passing signature: %+v", got)
	}
	// The premise, read out of the fixture rather than assumed: the sealer is
	// trusted, and its report says it saw no signature.
	chain := chainOf(t, raw, recordedLookup(t))
	if untrustedSealer(chain.SealDomains) >= 0 {
		t.Fatalf("premise gone: seals %v are no longer all trusted", chain.SealDomains)
	}
	if claimed, _ := aarDKIMDomains(chain.AARValues[0]); len(claimed) != 0 {
		t.Fatalf("premise gone: instance 1 now claims %v; this fixture's point is that it claims none", claimed)
	}
	if got.Attested || got.Inner != "" {
		t.Fatalf("a sender's own outbound gateway is not a forwarder: %+v", got)
	}
	if got.Outer != "emiratesnbd.com" {
		t.Fatalf("Outer = %q, want the bank that signed it", got.Outer)
	}
}

// The other side of the same rule, on the fixtures that ARE forwards: instance
// 1 reports the bank's signature, so the top seal is a relay and the bank is
// the inner origin.
func TestAForwardIsASealerThatSawTheBanksSignature(t *testing.T) {
	lookup := recordedLookup(t)
	for _, f := range []string{
		"gmail-forward-1.eml", "gmail-forward-2.eml",
		"gmail-forward-3.eml", "gmail-forward-inner-dkim.eml",
	} {
		t.Run(f, func(t *testing.T) {
			chain := chainOf(t, mustRead(t, f), lookup)
			claimed, aarErr := aarDKIMDomains(chain.AARValues[0])
			if !slices.Contains(claimed, "dib.ae") {
				t.Fatalf("premise gone: instance 1 claims %v (%s)", claimed, aarErr)
			}
			if got := relayDomain(chain); got != "google.com" {
				t.Fatalf("relayDomain = %q, want the top seal", got)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// Nothing is attested without cryptography
// ---------------------------------------------------------------------------

func TestResolveDoesNotAttestInnerOriginWithoutAnyVerification(t *testing.T) {
	raw := plainForward()
	got := Resolve(context.Background(), raw, recordedLookup(t))

	if got.Attested || got.Inner != "" || got.AttestedBy != "" || got.InnerFrom != "" {
		t.Fatalf("%+v", got)
	}
	if got.DKIM != SigNone || got.ARC != SigNone {
		t.Fatalf("DKIM = %q, ARC = %q, want none/none", got.DKIM, got.ARC)
	}
	if got.Outer != diag.UnverifiedPrefix+"icloud.com" {
		t.Fatalf("Outer = %q", got.Outer)
	}
	if got.Reason == "" {
		t.Fatal("a refusal to attest must say why")
	}
}

// The unwrap stage reads "Begin forwarded message:" out of the body. Trust must
// not: body text is the one thing in a message an attacker never needs a key to
// write.
func TestForgedForwardHeaderDoesNotBecomeAnInnerOrigin(t *testing.T) {
	raw := []byte("Return-Path: <mallory@evil.test>\r\n" +
		"From: Mallory <mallory@evil.test>\r\n" +
		"To: <u-abc@in.example.test>\r\n" +
		"Subject: Fwd: Transaction Alert\r\n" +
		"Date: Sat, 01 Aug 2026 09:00:00 +0000\r\n" +
		"\r\n" +
		"Begin forwarded message:\r\n" +
		"From: DIB Notification <DIB.notification@dib.ae>\r\n" +
		"Subject: Transaction Alert\r\n" +
		"\r\n" +
		"AED 4,500.00 at SPINNEYS\r\n")

	got := Resolve(context.Background(), raw, recordedLookup(t))
	if got.Attested {
		t.Fatalf("body text is not an attestation: %+v", got)
	}
	if strings.Contains(got.Inner, "dib.ae") || strings.Contains(got.InnerFrom, "dib.ae") ||
		strings.Contains(got.Outer, "dib.ae") {
		t.Fatalf("a bank domain reached the origin from body text alone: %+v", got)
	}
}

func TestUnverifiedOuterIsPrefixed(t *testing.T) {
	raw := []byte("Return-Path: <bounce@example.test>\r\n" +
		"From: Someone <someone@example.test>\r\n" +
		"Subject: hello\r\n\r\nbody\r\n")
	got := Resolve(context.Background(), raw, recordedLookup(t))
	if got.Outer != "unverified:example.test" {
		t.Fatalf("Outer = %q", got.Outer)
	}
}

func TestNoEnvelopeDomainLeavesOuterEmpty(t *testing.T) {
	raw := []byte("From: Someone <someone@example.test>\r\nSubject: hi\r\n\r\nbody\r\n")
	got := Resolve(context.Background(), raw, recordedLookup(t))
	// The From header is not an envelope and is not a signature. With neither,
	// there is nothing to report — least of all example.test.
	if got.Outer != "" {
		t.Fatalf("Outer = %q, want empty when nothing names the sender", got.Outer)
	}
}

// Return-Path is prepended by each delivering MTA, so the topmost is the most
// recent hop's — the one that actually handed the message over. Reading any
// other occurrence would take the relay history's word for who is relaying now.
func TestTopmostReturnPathIsTheRelayingHop(t *testing.T) {
	raw := []byte("Return-Path: <relay@icloud.com>\r\n" +
		"Return-Path: <original@dib.ae>\r\n" +
		"From: <someone@example.test>\r\nSubject: hi\r\n\r\nbody\r\n")
	got := Resolve(context.Background(), raw, recordedLookup(t))
	if got.Outer != diag.UnverifiedPrefix+"icloud.com" {
		t.Fatalf("Outer = %q, want the most recent hop", got.Outer)
	}
}

// Production hands us the SMTP MAIL FROM (smtpd.Message.EnvelopeFrom). It must
// beat the Return-Path header, which at that point has not been written by
// anyone we trust and may simply have been typed by the sender.
func TestCallerSuppliedEnvelopeBeatsAForgedReturnPath(t *testing.T) {
	raw := []byte("Return-Path: <victim@icloud.com>\r\n" +
		"From: Someone <someone@example.test>\r\n" +
		"Subject: hi\r\n\r\nbody\r\n")
	got := ResolveWithEnvelope(context.Background(), raw, "mallory@evil.test", recordedLookup(t))
	if got.Outer != "unverified:evil.test" {
		t.Fatalf("Outer = %q, want the SMTP envelope rather than the header", got.Outer)
	}
}

// ---------------------------------------------------------------------------
// The envelope decides nothing
// ---------------------------------------------------------------------------

// envelopes are the shapes a sender can put in MAIL FROM, including the null
// sender smtpd accepts unconditionally (smtpd.go:895) and which used to send
// this function down its Return-Path fallback — a header the sender also typed.
var envelopes = []string{
	"",
	"<>",
	"bounce@dib.ae",
	"mallory@evil.test",
	"relay@gmail.com",
	"postmaster@microsoft.com",
	"no-at-sign",
	"@",
}

// THE HOLE THIS ROUND EXISTS TO CLOSE. Same bytes, eight envelopes, one answer.
//
// The old rule inferred a forwarder from "the signature does not align with the
// envelope", which handed the sender the question. Measured, on the committed
// fixtures and the committed code:
//
//	dib-dkim-unexpired.eml  MAIL FROM=bounce@dib.ae     -> Outer=dib.ae  Attested=false
//	dib-dkim-unexpired.eml  MAIL FROM=mallory@evil.test -> Inner=dib.ae  Attested=true (direct_dkim)
//
// With a dib.ae|inner row — which is what every alpha confirms, because spec
// section 3.2:47 onboards them through a forwarding rule — the second is
// trusted, the DIB template matches, and the transaction is written at
// needs_review = false.
//
// Resolve is a pure function of the bytes for everything that decides trust.
// The one thing the envelope may still do is NAME an unverified sender, and
// that form carries a prefix Decide refuses.
func TestTheEnvelopeCannotChooseTheScope(t *testing.T) {
	lookup := recordedLookup(t)
	for _, f := range fixtureFiles(t) {
		t.Run(f, func(t *testing.T) {
			raw := mustRead(t, f)
			want := ResolveWithEnvelope(context.Background(), raw, envelopes[0], lookup)
			if want.Outer == "" || strings.HasPrefix(want.Outer, diag.UnverifiedPrefix) {
				t.Fatalf("premise gone: %s no longer has a verified outer origin (%+v)", f, want)
			}
			for _, env := range envelopes[1:] {
				got := ResolveWithEnvelope(context.Background(), raw, env, lookup)
				if got != want {
					t.Fatalf("MAIL FROM %q changed the origin:\n got %+v\nwant %+v", env, got, want)
				}
			}
		})
	}
}

// The same property where it is actually spent: the allowlist decision. A user
// who has confirmed one row must get the same answer for the same bytes however
// the sender addresses the envelope — in BOTH directions, so an attacker can
// neither promote direct mail into the inner lane nor demote a forward out of
// it.
func TestTheEnvelopeCannotChooseTheAllowlistScope(t *testing.T) {
	lookup := recordedLookup(t)
	rows := []string{
		"dib.ae|inner", "dib.ae|outer", "emiratesnbd.com|inner", "emiratesnbd.com|outer",
		"google.com|outer", "microsoft.com|outer", "icloud.com|inner",
	}
	for _, f := range fixtureFiles(t) {
		raw := mustRead(t, f)
		for _, row := range rows {
			var first *Decision
			for _, env := range envelopes {
				o := ResolveWithEnvelope(context.Background(), raw, env, lookup)
				got, err := Decide(context.Background(), allow(row), testUser, o)
				if err != nil {
					t.Fatal(err)
				}
				if first == nil {
					first = &got
					continue
				}
				if got.Trusted != first.Trusted || got.Domain != first.Domain || got.Scope != first.Scope {
					t.Fatalf("%s with %s: MAIL FROM %q changed the decision: %+v vs %+v",
						f, row, env, got, *first)
				}
			}
		}
	}
}

// The direct case, stated as its own rule so that a change to the fixtures
// cannot quietly remove it: bank mail nobody verifiably relayed has no inner
// origin, whatever the envelope says.
func TestDirectBankMailIsNeverAttestedHoweverTheEnvelopeIsAddressed(t *testing.T) {
	lookup := recordedLookup(t)
	for _, f := range []string{"dib-dkim-unexpired.eml", "enbd-proofpoint-p.eml", "enbd-selector1.eml"} {
		for _, env := range envelopes {
			got := ResolveWithEnvelope(context.Background(), mustRead(t, f), env, lookup)
			if got.Attested || got.Inner != "" || got.AttestedBy != "" {
				t.Fatalf("%s with MAIL FROM %q: %+v", f, env, got)
			}
		}
	}
}

// A relay an attacker can BE is not evidence of a relay. Anyone may add an ARC
// set sealed with their own key, or a DKIM signature for a domain they control,
// so if either counted, "this message was forwarded" would again be something
// the sender asserts — the same hole with two more headers.
func TestASelfSealedChainDoesNotMakeDirectBankMailAForward(t *testing.T) {
	raw := mustRead(t, "gmail-forward-inner-dkim.eml")
	honest := Resolve(context.Background(), raw, recordedLookup(t))
	if !honest.Attested {
		t.Fatalf("premise gone: %+v", honest)
	}

	// The attacker's own key, over genuine direct bank mail.
	k := newKeyring(t)
	direct := mustRead(t, "dib-dkim-unexpired.eml")
	signed := k.signDKIM("evil.test", "s1", direct)
	lookup := mergedLookup(t, k.recs)

	got := ResolveWithEnvelope(context.Background(), signed, "mallory@evil.test", lookup)
	if got.Attested || got.Inner != "" {
		t.Fatalf("an attacker's own signature manufactured a forwarder: %+v", got)
	}
	if got.DKIM != SigPass {
		t.Fatalf("premise gone: the added signature must verify, DKIM = %q", got.DKIM)
	}

	// The same attack with an ARC set instead of a signature. This is the one
	// that matters most: a chain an attacker seals with their own key returns
	// "pass" (RFC 8617 section 8.1), so if a passing chain alone counted as
	// relay evidence, one header set over a captured bank message would buy the
	// inner lane — and the AAR inside it says whatever the attacker typed.
	c := synthOver(t, direct, "DIB Notification <DIB.notification@dib.ae>")
	c.seal(1, "evil.test", "arc-1", "evil.test; dkim=pass header.d=dib.ae")
	sealed := c.build()
	lookup = mergedLookup(t, c.recs)

	got = ResolveWithEnvelope(context.Background(), sealed, "mallory@evil.test", lookup)
	if got.ARC != SigPass || got.DKIM != SigPass {
		t.Fatalf("premise gone: both must still verify: %+v", got)
	}
	if got.Attested || got.Inner != "" {
		t.Fatalf("an attacker's own ARC seal manufactured a forwarder: %+v", got)
	}
	// The seal changed nothing at all: the same bytes without it resolve the
	// same way, which is the property the whole round is about.
	if bare := Resolve(context.Background(), direct, recordedLookup(t)); got.Outer != bare.Outer {
		t.Fatalf("Outer = %q with an attacker's seal, %q without it", got.Outer, bare.Outer)
	}
}

// ---------------------------------------------------------------------------
// Adversarial: the trust decision itself
// ---------------------------------------------------------------------------

// THE BYPASS THIS TASK EXISTS TO CLOSE. arc.Verify reports "pass" for a chain
// an attacker sealed with their own key — correctly, because ARC attests chain
// integrity and not sender identity (RFC 8617 section 8.1, and the spike
// document's "three things a passing chain does not mean", item 1). Reading the
// AAR of a passing chain as truth lets anyone claim to be any bank.
func TestAttackerSealedChainDoesNotAttestTheBank(t *testing.T) {
	c := newSynth(t, "DIB Notification <DIB.notification@dib.ae>", "mallory@evil.test")
	c.seal(1, "evil.test", "arc-1",
		"evil.test; dkim=pass header.d=dib.ae header.i=@dib.ae; spf=pass smtp.mailfrom=dib.ae")
	raw := c.build()

	if chain, _ := arc.Verify(context.Background(), raw, c.dns()); chain.Status != arc.StatusPass {
		t.Fatalf("this test is only meaningful if the chain really verifies: %+v", chain)
	}

	got := Resolve(context.Background(), raw, c.dns())
	if got.ARC != SigPass {
		t.Fatalf("ARC = %q, want pass", got.ARC)
	}
	if got.Attested || got.Inner != "" {
		t.Fatalf("a self-sealed chain claiming the bank must not attest it: %+v", got)
	}
	if !strings.Contains(got.Reason, "evil.test") || !strings.Contains(got.Reason, "trusted ARC sealer") {
		t.Fatalf("Reason = %q, want it to name the untrusted sealer", got.Reason)
	}
}

// The positive control for the test above: the same chain, sealed by a domain
// on the trusted-sealer list, DOES attest. Without this, the refusal above
// could be a broken ARC path rather than a trust decision.
func TestTrustedSealerChainAttestsTheInnerOrigin(t *testing.T) {
	c := newSynth(t, "DIB Notification <DIB.notification@dib.ae>", "forwarder@icloud.com")
	c.seal(1, "icloud.com", "arc-test",
		"arc.icloud.com; dkim=pass header.d=dib.ae header.i=@dib.ae; spf=pass smtp.mailfrom=dib.ae")
	raw := c.build()

	got := Resolve(context.Background(), raw, c.dns())
	if !got.Attested || got.AttestedBy != AttestedByARC || got.Inner != "dib.ae" {
		t.Fatalf("%+v", got)
	}
	if got.Outer != "icloud.com" {
		t.Fatalf("Outer = %q, want the sealing forwarder", got.Outer)
	}
	// The direct path's failure is not a finding once the fallback succeeded.
	if got.Reason != "" {
		t.Fatalf("Reason = %q, want empty on an attested origin", got.Reason)
	}
}

// RFC 8617 section 8.1: a chain is only as trustworthy as its least trustworthy
// participant. Nothing verifies the AMS below the top instance, so any hop
// above instance 1 may rewrite the body wholesale and re-sign it under its own
// AMS while the chain still passes. Trusting instance 1's AAR because instance
// 1's sealer is reputable — without looking at who sealed above it — hands an
// attacker a genuine icloud.com attestation over a body they wrote.
func TestUntrustedHopAboveInstanceOneDoesNotAttest(t *testing.T) {
	c := newSynth(t, "DIB Notification <DIB.notification@dib.ae>", "forwarder@icloud.com")
	c.seal(1, "icloud.com", "arc-test",
		"arc.icloud.com; dkim=pass header.d=dib.ae header.i=@dib.ae; spf=pass smtp.mailfrom=dib.ae")
	c.body = "AED 250,000.00 transferred to MALLORY\r\n" // the rewrite
	c.seal(2, "evil.test", "arc-1", "evil.test; arc=pass (i=1); dkim=pass header.d=dib.ae")
	raw := c.build()

	if chain, _ := arc.Verify(context.Background(), raw, c.dns()); chain.Status != arc.StatusPass {
		t.Fatalf("this test is only meaningful if the chain really verifies: %+v", chain)
	}
	got := Resolve(context.Background(), raw, c.dns())
	if got.Attested {
		t.Fatalf("a rewriting hop above a reputable one must void the attestation: %+v", got)
	}
	if !strings.Contains(got.Reason, "evil.test") {
		t.Fatalf("Reason = %q, want it to name the hop that is not trusted", got.Reason)
	}
}

// A trusted sealer's AAR is an honest report, but it is a report about
// whatever it saw — and what it saw may be a message whose From says one thing
// while the signature it validated says another. Attesting the AAR's domain
// regardless would label a message From dib.ae as originating at evil.test, and
// then offer the user "trust evil.test" for mail that renders as their bank's.
func TestARCClaimMustAlignWithTheSignedFrom(t *testing.T) {
	c := newSynth(t, "DIB Notification <DIB.notification@dib.ae>", "forwarder@icloud.com")
	c.seal(1, "icloud.com", "arc-test",
		"arc.icloud.com; dkim=pass header.d=evil.test header.i=@evil.test; spf=pass")
	got := Resolve(context.Background(), c.build(), c.dns())

	if got.Attested {
		t.Fatalf("%+v", got)
	}
	if strings.Contains(got.Inner, "evil.test") {
		t.Fatalf("an AAR claim about an unrelated domain became the inner origin: %+v", got)
	}
	if !strings.Contains(got.Reason, "dib.ae") {
		t.Fatalf("Reason = %q, want it to name the From domain nothing aligned with", got.Reason)
	}
}

// Direct mail that happens to carry an ARC chain — enbd-selector1.eml is a real
// example — has no forwarder to see behind. Reporting an inner origin for it
// would invent a hop, and would offer the user an "inner" confirmation for a
// domain that is already their outer origin.
func TestARCDoesNotInventAForwarderForDirectMail(t *testing.T) {
	c := newSynth(t, "Alerts <alerts@icloud.com>", "alerts@icloud.com")
	c.seal(1, "icloud.com", "arc-test", "arc.icloud.com; dkim=pass header.d=icloud.com; spf=pass")
	got := Resolve(context.Background(), c.build(), c.dns())

	if got.Attested || got.Inner != "" {
		t.Fatalf("the sealer is also the sender; there is nothing behind it: %+v", got)
	}
	if got.Outer != "icloud.com" {
		t.Fatalf("Outer = %q", got.Outer)
	}
}

// "Forwarded" is a relationship between two domains, and the second domain is
// now the one that VERIFIABLY handled the message — a trusted ARC sealer, or a
// forwarder's own signature. An absent envelope is therefore not a reason to
// refuse: it was never the evidence.
func TestARCWithoutAnEnvelopeSenderStillAttests(t *testing.T) {
	c := newSynth(t, "DIB Notification <DIB.notification@dib.ae>", "forwarder@icloud.com")
	c.hdrs = slices.DeleteFunc(c.hdrs, func(f arc.Field) bool {
		return strings.EqualFold(strings.TrimSpace(f.Name), "Return-Path")
	})
	c.seal(1, "icloud.com", "arc-test", "arc.icloud.com; dkim=pass header.d=dib.ae; spf=pass")
	raw := c.build()

	got := Resolve(context.Background(), raw, c.dns())
	if !got.Attested || got.AttestedBy != AttestedByARC || got.Inner != "dib.ae" {
		t.Fatalf("%+v", got)
	}
	if got.Outer != "icloud.com" {
		t.Fatalf("Outer = %q, want the sealing hop even with no envelope at all", got.Outer)
	}
}

// Reason is written to logs. Every domain in it arrives as an attacker-chosen
// tag value and is only a domain because it was formatted into a sentence, so
// it has to be clipped and stripped like any other untrusted string.
func TestReasonIsBoundedAndPrintableFromAHostileSealDomain(t *testing.T) {
	evil := "evil\x01" + strings.Repeat("a", 600) + ".test"
	c := newSynth(t, "DIB Notification <DIB.notification@dib.ae>", "forwarder@icloud.com")
	c.seal(1, evil, "arc-1", "x; dkim=pass header.d=dib.ae")
	got := Resolve(context.Background(), c.build(), c.dns())

	if got.Attested {
		t.Fatalf("%+v", got)
	}
	if len(got.Reason) > maxErrBytes {
		t.Fatalf("Reason is %d bytes", len(got.Reason))
	}
	if strings.ContainsRune(got.Reason, '\x01') {
		t.Fatalf("Reason carries a control character: %q", got.Reason)
	}
	if !strings.Contains(got.Reason, "trusted ARC sealer") {
		t.Fatalf("Reason = %q", got.Reason)
	}
}

// A signature covers the BOTTOM-most instance of a repeated field (RFC 6376
// section 5.4.2), so prepending a second From leaves DKIM and ARC passing while
// net/mail, go-message and anything using Header.Get read the attacker's line.
// Attesting here would be a confused deputy: we would vouch for dib.ae on a
// document every other reader in the pipeline attributes to evil.test.
func TestPrependedFromDoesNotBecomeTheInnerOrigin(t *testing.T) {
	raw := append([]byte("From: DIB Notification <alerts@evil.test>\r\n"),
		mustRead(t, "gmail-forward-inner-dkim.eml")...)

	// The premise: net/mail really is fooled by the prepended line.
	//
	// VerifyDKIM used to be asserted to still return pass here, which was the
	// honest description of it at the time: the signature does still verify,
	// over the bottom-most From. It now refuses a message that carries two of
	// any field RFC 5322 permits once, so the DKIM verdict is a refusal and
	// singleFrom is no longer the only thing standing between a prepended
	// header and an attestation. Both layers are asserted, because either one
	// alone would close this and the other could then rot unnoticed.
	if v := VerifyDKIM(context.Background(), raw, recordedLookup(t)); v.DKIM == SigPass {
		t.Fatalf("a message with two From fields must not verify: %+v", v)
	}
	if m, err := mail.ReadMessage(bytes.NewReader(raw)); err != nil {
		t.Fatal(err)
	} else if !strings.Contains(m.Header.Get("From"), "evil.test") {
		t.Fatal("premise gone: net/mail no longer reads the prepended From")
	}

	got := Resolve(context.Background(), raw, recordedLookup(t))
	if got.Attested {
		t.Fatalf("an ambiguous From must not be attested: %+v", got)
	}
	if strings.Contains(got.Inner, "evil.test") || strings.Contains(got.InnerFrom, "evil.test") {
		t.Fatalf("the attacker's From reached the origin: %+v", got)
	}
	if !strings.Contains(got.Reason, "2 From") {
		t.Fatalf("Reason = %q, want it to name the ambiguity", got.Reason)
	}
}

// A forwarder that re-signs with its own domain proves only that the forwarder
// exists. Spec 3.2:51: the allowlist entry must be the bank, so a message whose
// only surviving signature belongs to the relaying domain has no inner origin
// at all — and Task 27 refuses to allowlist that domain as an outer one.
func TestForwarderOwnSignatureIsNotAnInnerOrigin(t *testing.T) {
	k := newKeyring(t)
	raw := k.signDKIM("relay.example", "s1", []byte(
		"From: DIB Notification <DIB.notification@dib.ae>\r\n"+
			"To: <u-abc@in.example.test>\r\n"+
			"Subject: Fwd: Transaction Alert\r\n"+
			"Date: Sat, 01 Aug 2026 09:00:00 +0000\r\n"+
			"\r\n"+
			"AED 100.00 at SPINNEYS\r\n"))
	raw = append([]byte("Return-Path: <bounces@relay.example>\r\n"), raw...)

	got := Resolve(context.Background(), raw, k.dns())
	if got.DKIM != SigPass {
		t.Fatalf("premise gone: the forwarder's own signature must verify: %+v", got)
	}
	if got.Outer != "relay.example" {
		t.Fatalf("Outer = %q, want the relaying signer", got.Outer)
	}
	if got.Attested || got.Inner != "" {
		t.Fatalf("a relay signing its own forward is not an attestation of the bank: %+v", got)
	}
}

// The other half of that rule: a signature that survives a relay attests only
// the domain it aligns with. Signing your own message with your own key while
// writing the bank into From must produce your domain or nothing — never the
// bank's.
func TestSignatureThatDoesNotAlignWithFromIsNotAnInnerOrigin(t *testing.T) {
	k := newKeyring(t)
	raw := k.signDKIM("evil.test", "s1", []byte(
		"From: DIB Notification <DIB.notification@dib.ae>\r\n"+
			"To: <u-abc@in.example.test>\r\n"+
			"Subject: Transaction Alert\r\n"+
			"Date: Sat, 01 Aug 2026 09:00:00 +0000\r\n"+
			"\r\n"+
			"AED 100.00 at SPINNEYS\r\n"))
	raw = append([]byte("Return-Path: <bounces@relay.example>\r\n"), raw...)

	got := Resolve(context.Background(), raw, k.dns())
	if got.DKIM != SigPass {
		t.Fatalf("premise gone: %+v", got)
	}
	if got.Attested {
		t.Fatalf("a signature misaligned with From must not attest: %+v", got)
	}
	if strings.Contains(got.Inner, "dib.ae") || strings.Contains(got.InnerFrom, "dib.ae") {
		t.Fatalf("the forged From became an origin: %+v", got)
	}
	if !strings.Contains(got.Reason, "evil.test") || !strings.Contains(got.Reason, "dib.ae") {
		t.Fatalf("Reason = %q, want it to name both domains", got.Reason)
	}
}

// A trusted sealer's AAR is an HONEST report, and honest reports routinely say
// a signature did not verify: Gmail and iCloud write `dkim=fail header.d=<bank>`
// and `dkim=permerror header.d=<bank>` into their own AARs whenever a forwarded
// message's original signature no longer checks out. Reading anything but
// `pass` as a claim therefore does not merely loosen a check — it turns the
// sealer's "I could not verify this" into an attestation, which is a bank
// identity available to anyone with an ordinary account at that forwarder and a
// bogus DKIM-Signature header.
func TestATrustedSealersHonestDKIMFailureIsNotAnAttestation(t *testing.T) {
	for _, result := range []string{"fail", "permerror", "temperror", "neutral", "none", "policy"} {
		t.Run(result, func(t *testing.T) {
			c := newSynth(t, "DIB Notification <DIB.notification@dib.ae>", "forwarder@icloud.com")
			c.seal(1, "icloud.com", "arc-test",
				"arc.icloud.com; dkim="+result+" header.d=dib.ae header.i=@dib.ae; spf=pass")
			got := Resolve(context.Background(), c.build(), c.dns())

			if got.ARC != SigPass {
				t.Fatalf("premise gone: the chain must verify, ARC = %q", got.ARC)
			}
			if got.Attested || got.Inner != "" {
				t.Fatalf("dkim=%s became an attestation: %+v", result, got)
			}
			if !strings.Contains(got.Reason, "no passing DKIM") {
				t.Fatalf("Reason = %q", got.Reason)
			}
		})
	}
	// The positive control on the identical shape: only `pass` attests.
	c := newSynth(t, "DIB Notification <DIB.notification@dib.ae>", "forwarder@icloud.com")
	c.seal(1, "icloud.com", "arc-test",
		"arc.icloud.com; dkim=pass header.d=dib.ae header.i=@dib.ae; spf=pass")
	if got := Resolve(context.Background(), c.build(), c.dns()); !got.Attested {
		t.Fatalf("%+v", got)
	}
}

// [TrustedSealers] and [ForwarderDomains] run opposite ways round, and swapping
// them at this call site widens ARC attestation from three exact domains to
// eighteen domains AND their subdomains. Every other ARC test uses a domain on
// both lists (icloud.com) or on neither (evil.test), so the swap is invisible
// to them. yahoo.com is on exactly one.
func TestAForwarderThatIsNotATrustedSealerCannotAttest(t *testing.T) {
	if !IsForwarderDomain("yahoo.com") || IsTrustedSealer("yahoo.com") {
		t.Fatal("premise gone: this test needs a domain that is a forwarder and NOT a sealer")
	}
	c := newSynth(t, "DIB Notification <DIB.notification@dib.ae>", "forwarder@yahoo.com")
	c.seal(1, "yahoo.com", "arc-1", "yahoo.com; dkim=pass header.d=dib.ae header.i=@dib.ae")
	got := Resolve(context.Background(), c.build(), c.dns())

	if got.ARC != SigPass {
		t.Fatalf("premise gone: the chain must verify, ARC = %q", got.ARC)
	}
	if got.Attested || got.Inner != "" {
		t.Fatalf("a forwarder we do not accept seals from attested a bank: %+v", got)
	}
	if !strings.Contains(got.Reason, "yahoo.com") || !strings.Contains(got.Reason, "trusted ARC sealer") {
		t.Fatalf("Reason = %q, want it to name the sealer we do not believe", got.Reason)
	}
}

// Spec section 3.2:51 forbids trusting a domain everyone's mail passes through,
// and the rule is about the DOMAIN, not about the column it lands in. Without
// this, a Gmail user's own signed mail becomes "an identity behind a relay" the
// moment any other forwarder handles it — so a gmail.com|inner row (which
// nothing else refuses) would trust every message anyone sends from Gmail,
// including the "Begin forwarded message" body that o.Attested tells the
// pipeline to believe.
func TestAForwarderIsNeverAnInnerOriginEither(t *testing.T) {
	// The ARC path: a trusted sealer's honest AAR naming a forwarder.
	c := newSynth(t, "A User <user@gmail.com>", "relay@icloud.com")
	c.seal(1, "icloud.com", "arc-test", "arc.icloud.com; dkim=pass header.d=gmail.com; spf=pass")
	if got := Resolve(context.Background(), c.build(), c.dns()); got.Attested {
		t.Fatalf("a forwarder became an inner origin via ARC: %+v", got)
	}

	// The direct path: the forwarder's own aligned signature that really does
	// verify here, behind a genuine relay hop.
	k := newKeyring(t)
	signed := k.signDKIM("gmail.com", "s1", []byte(
		"From: A User <user@gmail.com>\r\n"+
			"To: <u-abc@in.example.test>\r\n"+
			"Subject: Fwd: Transaction Alert\r\n"+
			"Date: Sat, 01 Aug 2026 09:00:00 +0000\r\n"+
			"\r\n"+
			"Begin forwarded message:\r\nFrom: alerts@dib.ae\r\n\r\nAED 99,999.00 at MALLORY\r\n"))
	s := synthOver(t, signed, "user@gmail.com")
	s.seal(1, "icloud.com", "s2", "arc.icloud.com; dkim=pass header.d=gmail.com")
	raw := s.build()
	lookup := staticTXT(mergeRecs(k.recs, s.recs))

	if relayDomain(chainOf(t, raw, lookup)) == "" {
		t.Fatal("premise gone: this test needs a verified relay, or it proves nothing")
	}
	got := ResolveWithEnvelope(context.Background(), raw, "relay@icloud.com", lookup)
	if got.DKIM != SigPass || alignedSigner(VerifyDKIM(context.Background(), raw, lookup), "gmail.com") != "gmail.com" {
		t.Fatalf("premise gone: the forwarder's own aligned signature must verify: %+v", got)
	}
	if got.Attested || got.Inner != "" {
		t.Fatalf("a forwarder became an inner origin via its own signature: %+v", got)
	}
}

func mergeRecs(a, b map[string][]string) map[string][]string {
	out := map[string][]string{}
	for k, v := range a {
		out[k] = v
	}
	for k, v := range b {
		out[k] = v
	}
	return out
}

func chainOf(t *testing.T, raw []byte, lookup LookupTXT) arc.ChainResult {
	t.Helper()
	c, err := arc.Verify(context.Background(), raw, lookup)
	if err != nil {
		t.Fatal(err)
	}
	return c
}

// A tampered body fails the AMS, so the chain fails, so nothing is attested —
// including by the AAR of an otherwise reputable sealer.
func TestTamperedForwardIsNotAttestedByEitherPath(t *testing.T) {
	raw := mustRead(t, "gmail-forward-inner-dkim.eml")
	i := bytes.Index(raw, []byte("\r\n\r\n"))
	if i < 0 {
		t.Fatal("fixture has no body")
	}
	tampered := append([]byte(nil), raw...)
	flipped := false
	for j := i + 4; j < len(tampered); j++ {
		if tampered[j] >= 'a' && tampered[j] <= 'y' {
			tampered[j]++
			flipped = true
			break
		}
	}
	if !flipped {
		t.Fatal("nothing in the body to flip; this test no longer tampers with anything")
	}
	got := Resolve(context.Background(), tampered, recordedLookup(t))
	if got.Attested {
		t.Fatalf("%+v", got)
	}
	if got.DKIM != SigFail || got.ARC != SigFail {
		t.Fatalf("DKIM = %q, ARC = %q, want fail/fail", got.DKIM, got.ARC)
	}
}

// Finding 4 of the spike: a bare LF makes this parser and net/textproto read
// two different documents out of the same bytes. arc.ReadHeader refuses it, so
// Resolve must report nothing rather than fall back to a lenient read.
func TestBareLFMessageIsNotAttested(t *testing.T) {
	raw := append([]byte("X-Junk: a\n\nX-Junk2: b\r\n"), mustRead(t, "gmail-forward-inner-dkim.eml")...)
	got := ResolveWithEnvelope(context.Background(), raw, "forwarder@icloud.com", recordedLookup(t))
	if got.Attested || got.Inner != "" {
		t.Fatalf("%+v", got)
	}
	if got.DKIM != SigFail || got.ARC != SigFail {
		t.Fatalf("DKIM = %q, ARC = %q", got.DKIM, got.ARC)
	}
	if got.Outer != diag.UnverifiedPrefix+"icloud.com" {
		t.Fatalf("Outer = %q, want the envelope the SMTP layer saw and nothing from the headers", got.Outer)
	}
	// Named, so that "no From field" — which is what a lenient second read of
	// these bytes would report — can never stand in for it.
	if !strings.Contains(got.Reason, "unreadable header") {
		t.Fatalf("Reason = %q", got.Reason)
	}
}

// A resolver outage must not permanently demote a bank, and must never be
// mistaken for an attestation.
func TestDNSOutageIsTempErrorAndAttestsNothing(t *testing.T) {
	got := ResolveWithEnvelope(context.Background(), mustRead(t, "gmail-forward-inner-dkim.eml"),
		"forwarder@icloud.com", failingTXT(fmt.Errorf("resolver is down")))
	if got.DKIM != SigTempFail {
		t.Fatalf("DKIM = %q, want temperror", got.DKIM)
	}
	if got.Attested {
		t.Fatalf("%+v", got)
	}
	if got.Outer != diag.UnverifiedPrefix+"icloud.com" {
		t.Fatalf("Outer = %q", got.Outer)
	}
}

// ---------------------------------------------------------------------------
// Storage safety: these values reach columns with SQL CHECK constraints
// ---------------------------------------------------------------------------

// diag's four grammars are enforced in the database, so a value that does not
// fit costs the whole diagnostics row rather than one field. Inner in
// particular lands in inner_origin_domain, whose CHECK is a bounded hostname.
func TestResolveNeverProducesAValueDiagWouldRefuse(t *testing.T) {
	reHostname := regexp.MustCompile(`^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$`)
	// The pattern above is the CHECK constraint verbatim. Asserting it appears
	// in the migration is what stops this test from drifting into agreement
	// with itself while the database keeps its own opinion.
	mig, err := os.ReadFile("../pg/migrations/00006_diagnostics.sql")
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(mig, []byte(reHostname.String())) {
		t.Fatal("this test's hostname grammar is no longer the one 00006_diagnostics.sql enforces")
	}

	dkimOK := []SigResult{SigPass, SigFail, SigNone, SigTempFail}
	arcOK := []SigResult{SigPass, SigFail, SigNone} // no temperror: the column has none

	check := func(t *testing.T, name string, got Origin) {
		t.Helper()
		if !slices.Contains(dkimOK, got.DKIM) {
			t.Errorf("%s: DKIM = %q is not a dkim_result", name, got.DKIM)
		}
		if !slices.Contains(arcOK, got.ARC) {
			t.Errorf("%s: ARC = %q is not an arc_result", name, got.ARC)
		}
		if got.Inner != "" && (!reHostname.MatchString(got.Inner) || len(got.Inner) > 253) {
			// 253 is the other half of the CHECK at 00006_diagnostics.sql:108,
			// and the grammar alone does not enforce it: reHostname permits
			// unlimited labels, so hostname()'s length test is what bounds this.
			t.Errorf("%s: Inner = %q is not a bounded hostname", name, got.Inner)
		}
		if got.Inner != "" && got.DKIM != SigPass && got.ARC != SigPass {
			t.Errorf("%s: inner_origin_domain requires a passing signature: %+v", name, got)
		}
		bare := strings.TrimPrefix(got.Outer, diag.UnverifiedPrefix)
		if got.Outer != "" && (!reHostname.MatchString(bare) || len(got.Outer) > 264) {
			t.Errorf("%s: Outer = %q is not a bounded sender_domain", name, got.Outer)
		}
		if got.AttestedBy != "" && got.AttestedBy != AttestedByDKIM && got.AttestedBy != AttestedByARC {
			t.Errorf("%s: AttestedBy = %q", name, got.AttestedBy)
		}
		if got.Attested != (got.Inner != "") {
			t.Errorf("%s: Attested and Inner disagree: %+v", name, got)
		}
		if len(got.Reason) > maxErrBytes {
			t.Errorf("%s: Reason is %d bytes", name, len(got.Reason))
		}
		for _, r := range got.Reason {
			if r < 0x20 || r == 0x7f {
				t.Errorf("%s: Reason carries a control character %q", name, r)
				break
			}
		}
	}

	lookup := recordedLookup(t)
	for _, f := range fixtureFiles(t) {
		got := Resolve(context.Background(), mustRead(t, f), lookup)
		check(t, f, got)
	}
	for name, raw := range hostileMessages() {
		for _, env := range []string{"", "mallory@evil.test", "no-at-sign", "@", strings.Repeat("x", 300) + "@y.test"} {
			check(t, name+"/"+env, ResolveWithEnvelope(context.Background(), raw, env, lookup))
		}
	}
}

func TestHostileInputNeitherPanicsNorAttests(t *testing.T) {
	lookup := recordedLookup(t)
	// Failures are collected and reported from the TEST goroutine. Calling
	// t.Errorf from the worker means that if the watchdog below ever fires, the
	// worker logs after the test has completed — which is a panic in the test
	// runner rather than the failure message this is trying to produce.
	done := make(chan []string, 1)
	go func() {
		var bad []string
		for name, raw := range hostileMessages() {
			func() {
				defer func() {
					if r := recover(); r != nil {
						bad = append(bad, fmt.Sprintf("%s panicked: %v", name, r))
					}
				}()
				if got := Resolve(context.Background(), raw, lookup); got.Attested {
					bad = append(bad, fmt.Sprintf("%s = %+v, hostile input must never attest", name, got))
				}
			}()
		}
		done <- bad
	}()
	select {
	case bad := <-done:
		for _, s := range bad {
			t.Error(s)
		}
	case <-time.After(60 * time.Second):
		t.Fatal("Resolve did not finish within 60s on hostile input")
	}
}

// mergedLookup serves the recorded fixture DNS plus records a test generated.
func mergedLookup(t *testing.T, extra map[string][]string) LookupTXT {
	t.Helper()
	recs := loadDNSMap(t)
	for k, v := range extra {
		recs[k] = v
	}
	return staticTXT(recs)
}

// ---------------------------------------------------------------------------
// The small guards, each of which is a security property with no other test
// ---------------------------------------------------------------------------

// Alignment is DMARC's relaxed rule, and the dot is the whole rule: without it
// "evildib.ae" ends with "dib.ae" and a lookalike registration aligns with the
// bank it imitates.
func TestAlignmentRequiresALabelBoundary(t *testing.T) {
	for _, p := range [][2]string{
		{"dib.ae", "dib.ae"},
		{"mail.dib.ae", "dib.ae"},
		{"dib.ae", "mail.dib.ae"},
		{"DIB.AE", "dib.ae"},
	} {
		if !aligned(p[0], p[1]) {
			t.Errorf("aligned(%q, %q) = false", p[0], p[1])
		}
	}
	for _, p := range [][2]string{
		{"evildib.ae", "dib.ae"},
		{"dib.ae", "evildib.ae"},
		{"dib.ae.evil.test", "evil.test.dib.ae"},
		{"", "dib.ae"},
		{"dib.ae", ""},
	} {
		if aligned(p[0], p[1]) {
			t.Errorf("aligned(%q, %q) = true", p[0], p[1])
		}
	}
}

// arc_result is a CHECK-constrained column with three values and no temperror
// rung, so an unrecognised status must land on the closed side. The comment
// calls this a deliberate fail-closed default; today arc.Verify returns only
// three statuses, so nothing else pins it.
func TestAnUnknownChainStatusIsAFailure(t *testing.T) {
	for status, want := range map[string]SigResult{
		arc.StatusPass: SigPass,
		arc.StatusNone: SigNone,
		arc.StatusFail: SigFail,
		"temperror":    SigFail,
		"":             SigFail,
		"pass ":        SigFail,
	} {
		if got := arcResult(status); got != want {
			t.Errorf("arcResult(%q) = %q, want %q", status, got, want)
		}
	}
}

// reHostname permits unlimited labels, so the 253-byte cap in hostname() —
// not the grammar — is what keeps Inner inside the CHECK at
// 00006_diagnostics.sql:108. A value that fails it costs the WHOLE diagnostics
// row rather than one field.
func TestHostnameIsBoundedAtTheLengthTheDatabaseEnforces(t *testing.T) {
	long := strings.TrimSuffix(strings.Repeat("ab.", 100), ".") // 299 bytes, grammar-legal
	if len(long) <= 253 || !reHostname.MatchString(long) {
		t.Fatalf("premise gone: %d bytes, grammar match %v", len(long), reHostname.MatchString(long))
	}
	if got := hostname(long); got != "" {
		t.Fatalf("hostname(<299 bytes>) = %q, want it refused", got)
	}
	ok := strings.TrimSuffix(strings.Repeat("ab.", 84), ".") // 251 bytes
	if len(ok) > 253 {
		t.Fatalf("premise gone: %d bytes", len(ok))
	}
	if got := hostname(ok); got != ok {
		t.Fatalf("hostname(<251 bytes>) = %q, want it accepted", got)
	}
}

// The two fields parsed out of a message are bounded BEFORE they reach
// mail.ParseAddress and authres, and the bound is named in the refusal so a
// message refused for size cannot be confused with one refused for content.
func TestOversizedFieldsAreRefusedByTheirBound(t *testing.T) {
	big := strings.Repeat("a", maxFromBytes+1)
	raw := []byte("Return-Path: <bounce@dib.ae>\r\nFrom: <" + big + "@dib.ae>\r\n\r\nbody\r\n")
	got := Resolve(context.Background(), raw, recordedLookup(t))
	if !strings.Contains(got.Reason, "From field is") || !strings.Contains(got.Reason, "too large") {
		t.Fatalf("Reason = %q, want the From bound to be what refused it", got.Reason)
	}

	// ...and the same for an ARC-Authentication-Results, which reaches authres.
	_, aarErr := aarDKIMDomains("i=1; " + strings.Repeat("x", maxAARBytes))
	if !strings.Contains(aarErr, "too large") {
		t.Fatalf("aarDKIMDomains = %q, want the AAR bound to be what refused it", aarErr)
	}
	if _, ok := aarDKIMDomains("i=1; x; dkim=pass header.d=dib.ae"); ok != "" {
		t.Fatalf("premise gone: a normal AAR no longer parses (%q)", ok)
	}
}

func hostileMessages() map[string][]byte {
	huge := strings.Repeat("x", 1<<20)
	return map[string][]byte{
		"empty":              {},
		"crlf only":          []byte("\r\n"),
		"blank header":       []byte("\r\n\r\nbody"),
		"bare lf":            []byte("From: a@b.test\n\nbody"),
		"no colon":           []byte("not a header at all\r\n\r\nbody"),
		"lone continuation":  []byte(" continuation with nothing above\r\n\r\nbody"),
		"nul bytes":          []byte("From: a@\x00b\r\nReturn-Path: <x@\x00.test>\r\n\r\n\x00"),
		"invalid utf8":       []byte("From: \xff\xfe\xfd <a@b.test>\r\nReturn-Path: <\xff@\xfe>\r\n\r\nbody"),
		"giant from":         []byte("From: <" + huge + "@b.test>\r\n\r\nbody"),
		"giant return-path":  []byte("Return-Path: <a@" + huge + ".test>\r\n\r\nbody"),
		"giant aar":          []byte("ARC-Authentication-Results: i=1; " + huge + "\r\nFrom: a@b.test\r\n\r\nbody"),
		"many from":          []byte(strings.Repeat("From: a@b.test\r\n", 10000) + "\r\nbody"),
		"many return-path":   []byte(strings.Repeat("Return-Path: <a@b.test>\r\n", 10000) + "\r\nbody"),
		"many arc sets":      []byte(strings.Repeat("ARC-Seal: i=1; d=x.test\r\n", 10000) + "From: a@b.test\r\n\r\nbody"),
		"from is a group":    []byte("From: undisclosed:;\r\n\r\nbody"),
		"from is a list":     []byte("From: a@b.test, c@d.test\r\n\r\nbody"),
		"deep folding":       []byte("From:" + strings.Repeat("\r\n a@b.test", 20000) + "\r\n\r\nbody"),
		"uppercase domains":  []byte("Return-Path: <A@EXAMPLE.TEST>\r\nFrom: <B@EXAMPLE.TEST>\r\n\r\nbody"),
		"trailing root dot":  []byte("Return-Path: <a@example.test.>\r\nFrom: <b@example.test.>\r\n\r\nbody"),
		"idn-ish domain":     []byte("Return-Path: <a@xn--80ak6aa92e.test>\r\nFrom: <b@xn--80ak6aa92e.test>\r\n\r\nbody"),
		"underscore domain":  []byte("Return-Path: <a@_dmarc.example.test>\r\nFrom: <b@_dmarc.example.test>\r\n\r\nbody"),
		"reason injection":   []byte("Return-Path: <a@b.test>\r\nFrom: <c@d\r\n .test>\r\nARC-Seal: i=1; d=x\r\n\r\nbody"),
		"arc without a from": []byte("ARC-Seal: i=1; cv=none; d=x.test; s=s; b=AA==\r\n\r\nbody"),
	}
}

func fixtureFiles(t *testing.T) []string {
	t.Helper()
	var out []string
	for _, e := range loadManifest(t).Fixtures {
		out = append(out, e.File)
	}
	if len(out) == 0 {
		t.Fatal("no fixtures")
	}
	return out
}

func plainForward() []byte {
	return []byte("Return-Path: <someone@icloud.com>\r\n" +
		"From: Someone <someone@icloud.com>\r\n" +
		"To: <u-abc@in.example.test>\r\n" +
		"Subject: Fwd: Transaction Alert\r\n" +
		"Date: Sat, 01 Aug 2026 09:00:00 +0000\r\n" +
		"\r\n" +
		"---------- Forwarded message ---------\r\n" +
		"AED 100.00 at SPINNEYS\r\n")
}

// ---------------------------------------------------------------------------
// Synthetic signers
//
// The corpus proves the two paths agree with Google, Apple and Microsoft on
// honest mail. It cannot produce a chain sealed by an attacker, because no such
// message exists to extract — and that chain is exactly the input this task's
// trust decision is about. So: generate a key, publish it through the fixture
// resolver under whatever name the test needs, and sign. Every builder
// self-checks against arc.Verify or VerifyDKIM, so a trust test can never pass
// because the builder quietly produced something nothing would have accepted.
// ---------------------------------------------------------------------------

type keyring struct {
	t    *testing.T
	key  *rsa.PrivateKey
	recs map[string][]string
}

func newKeyring(t *testing.T) *keyring {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	return &keyring{t: t, key: key, recs: map[string][]string{}}
}

func (k *keyring) publish(domain, selector string) {
	der, err := x509.MarshalPKIXPublicKey(&k.key.PublicKey)
	if err != nil {
		k.t.Fatal(err)
	}
	k.recs[selector+"._domainkey."+domain] = []string{
		"v=DKIM1; k=rsa; p=" + base64.StdEncoding.EncodeToString(der)}
}

func (k *keyring) dns() LookupTXT { return staticTXT(k.recs) }

// signDKIM prepends a real DKIM-Signature for domain over raw, and asserts the
// result verifies.
func (k *keyring) signDKIM(domain, selector string, raw []byte) []byte {
	k.t.Helper()
	k.publish(domain, selector)
	var out bytes.Buffer
	err := dkim.Sign(&out, bytes.NewReader(raw), &dkim.SignOptions{
		Domain:                 domain,
		Selector:               selector,
		Signer:                 k.key,
		Hash:                   crypto.SHA256,
		HeaderCanonicalization: dkim.CanonicalizationRelaxed,
		BodyCanonicalization:   dkim.CanonicalizationRelaxed,
		HeaderKeys:             []string{"From", "To", "Subject", "Date"},
	})
	if err != nil {
		k.t.Fatal(err)
	}
	signed := out.Bytes()
	if v := VerifyDKIM(context.Background(), signed, k.dns()); v.DKIM != SigPass {
		k.t.Fatalf("builder produced a signature nothing accepts: %+v", v)
	}
	return signed
}

// synth builds ARC chains over a message whose From and envelope the test
// chooses, using arc's own canonicalization primitives rather than a second
// opinion about them.
type synth struct {
	*keyring
	hdrs arc.Header
	body string
	sets [][3]arc.Field
}

func newSynth(t *testing.T, from, envelope string) *synth {
	s := &synth{keyring: newKeyring(t), body: "AED 100.00 at SPINNEYS\r\n"}
	for _, kv := range [][2]string{
		{"Return-Path", " <" + envelope + ">"},
		{"From", " " + from},
		{"To", " <u-abc@in.example.test>"},
		{"Subject", " Transaction Alert"},
		{"Date", " Sat, 01 Aug 2026 09:00:00 +0000"},
	} {
		s.hdrs = append(s.hdrs, arc.Field{Name: kv[0], Value: kv[1], Raw: kv[0] + ":" + kv[1] + "\r\n"})
	}
	return s
}

// synthOver seals a chain over a REAL fixture rather than a message the test
// wrote, so an attacker's ARC set can be added to genuine, still-verifying bank
// mail exactly the way an attacker would add one. The fixture's own signature
// survives: ARC fields are prepended and no DKIM h= names them.
func synthOver(t *testing.T, raw []byte, wantFrom string) *synth {
	t.Helper()
	h, body, err := arc.ReadHeader(raw)
	if err != nil {
		t.Fatal(err)
	}
	if f := h.Get("From"); len(f) != 1 || !strings.Contains(f[0].Value, wantFrom) {
		t.Fatalf("premise gone: fixture From is %v, want one field containing %q", f, wantFrom)
	}
	return &synth{keyring: newKeyring(t), hdrs: h, body: string(body)}
}

func (s *synth) sign(digest []byte) string {
	sig, err := rsa.SignPKCS1v15(rand.Reader, s.key, crypto.SHA256, digest)
	if err != nil {
		s.t.Fatal(err)
	}
	return base64.StdEncoding.EncodeToString(sig)
}

// seal appends one complete, correctly-signed ARC set, the way a real hop does.
func (s *synth) seal(instance int, domain, selector, aarValue string) {
	s.t.Helper()
	s.publish(domain, selector)
	cv := "pass"
	if instance == 1 {
		cv = "none"
	}
	f := func(name, value string) arc.Field {
		return arc.Field{Name: name, Value: value, Raw: name + ":" + value + "\r\n"}
	}

	aar := f("ARC-Authentication-Results", fmt.Sprintf(" i=%d; %s", instance, aarValue))

	hList := []string{"from", "to", "subject", "date"}
	bh := sha256.Sum256(arc.CanonBody(arc.Relaxed, []byte(s.body)))
	amsNoB := fmt.Sprintf(" i=%d; a=rsa-sha256; c=relaxed/relaxed; d=%s; s=%s; h=%s; bh=%s; b=",
		instance, domain, selector, strings.Join(hList, ":"),
		base64.StdEncoding.EncodeToString(bh[:]))
	hasher := sha256.New()
	picker := arc.NewPicker(s.hdrs)
	for _, name := range hList {
		if fld, ok := picker.Pick(name); ok {
			hasher.Write([]byte(arc.CanonHeader(arc.Relaxed, fld)))
		}
	}
	hasher.Write([]byte(strings.TrimSuffix(arc.CanonHeader(arc.Relaxed, f("ARC-Message-Signature", amsNoB)), "\r\n")))
	ams := f("ARC-Message-Signature", amsNoB+s.sign(hasher.Sum(nil)))

	asNoB := fmt.Sprintf(" i=%d; a=rsa-sha256; cv=%s; d=%s; s=%s; b=", instance, cv, domain, selector)
	sealHasher := sha256.New()
	for _, set := range s.sets {
		for _, fld := range set {
			sealHasher.Write([]byte(arc.CanonHeader(arc.Relaxed, fld)))
		}
	}
	sealHasher.Write([]byte(arc.CanonHeader(arc.Relaxed, aar)))
	sealHasher.Write([]byte(arc.CanonHeader(arc.Relaxed, ams)))
	sealHasher.Write([]byte(strings.TrimSuffix(arc.CanonHeader(arc.Relaxed, f("ARC-Seal", asNoB)), "\r\n")))
	as := f("ARC-Seal", asNoB+s.sign(sealHasher.Sum(nil)))

	s.sets = append(s.sets, [3]arc.Field{aar, ams, as})
	s.hdrs = append(arc.Header{as, ams, aar}, s.hdrs...)
}

func (s *synth) build() []byte {
	s.t.Helper()
	var sb strings.Builder
	for _, fld := range s.hdrs {
		sb.WriteString(fld.Raw)
	}
	sb.WriteString("\r\n")
	sb.WriteString(s.body)
	raw := []byte(sb.String())
	got, err := arc.Verify(context.Background(), raw, s.dns())
	if err != nil {
		s.t.Fatalf("builder produced an unparseable chain: %v", err)
	}
	if got.Status != arc.StatusPass || got.Instances != len(s.sets) {
		s.t.Fatalf("builder produced a chain the verifier rejects: %+v", got)
	}
	return raw
}
