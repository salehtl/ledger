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
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"
	"unicode/utf8"

	dkimlib "github.com/emersion/go-msgauth/dkim"

	"ledger/internal/v2/arc"
)

// dnsFixture is the recording Task 2 made. Every test in this file resolves
// keys out of it and never touches a resolver: a DKIM test that queried live
// DNS would start failing on a date nobody chose, for a reason that looks like
// a crypto bug.
const dnsFixture = "testdata/dns.json"

const manifestFixture = "testdata/manifest.json"

// reExtract is the command that redraws the fixtures. It appears in the canary's
// failure message, so it is a constant rather than prose in three places.
const reExtract = "go run ./internal/v2/corpus/cmd/extract-fixtures --out internal/v2/origin/testdata"

// ---------------------------------------------------------------------------
// The two pass cases, chosen for whether they can rot.
// ---------------------------------------------------------------------------

// enbd-proofpoint-p.eml carries NO x= tag, so its signature has no expiry, and
// its key is served from the recording rather than from live DNS, so a rotation
// at Emirates NBD cannot reach it either. It is the one fixture in the set that
// is stable by construction rather than by luck, which is why it is the fixture
// every tamper test below builds on.
func TestVerifyDKIMOnAPermanentlyStableENBDMessage(t *testing.T) {
	got := VerifyDKIM(context.Background(), mustRead(t, "enbd-proofpoint-p.eml"), recordedLookup(t))
	if got.DKIM != SigPass || !slices.Contains(got.DKIMDomains, "emiratesnbd.com") {
		t.Fatalf("VerifyDKIM = %+v, want pass for emiratesnbd.com", got)
	}
	if got.Err != "" {
		t.Errorf("a passing verification reported Err = %q, want empty", got.Err)
	}
}

// enbd-selector1.eml also has no x=, and additionally carries a Microsoft ARC
// set. DKIM verification must be completely indifferent to it: ARC is Task 26's
// problem and reading it here would be reading an unverified header.
func TestVerifyDKIMIgnoresARCHeadersOnTheSameMessage(t *testing.T) {
	got := VerifyDKIM(context.Background(), mustRead(t, "enbd-selector1.eml"), recordedLookup(t))
	if got.DKIM != SigPass || !slices.Contains(got.DKIMDomains, "emiratesnbd.com") {
		t.Fatalf("VerifyDKIM = %+v, want pass for emiratesnbd.com", got)
	}
}

// The DIB fixture is the one that CAN rot: DIB signs with a ~1-year x=. It is
// kept because dib.ae is the sender that matters most, and it is guarded by
// TestFixturesStillVerifyAndHaveNotExpired.
func TestVerifyDKIMOnAnUnexpiredDIBMessage(t *testing.T) {
	got := VerifyDKIM(context.Background(), mustRead(t, "dib-dkim-unexpired.eml"), recordedLookup(t))
	if got.DKIM != SigPass || !slices.Contains(got.DKIMDomains, "dib.ae") {
		t.Fatalf("VerifyDKIM = %+v, want pass for dib.ae", got)
	}
}

// ---------------------------------------------------------------------------
// THE CANARY.
// ---------------------------------------------------------------------------

// TestFixturesStillVerifyAndHaveNotExpired is the reason a rotted fixture shows
// up as a sentence instead of a mystery.
//
// go-msgauth checks x= BEFORE the key lookup and its clock is a package-private
// var an external test cannot stub (dkim/dkim.go:21), so there is no way to
// freeze time around a verification. When a fixture's signature expires, every
// test above turns into a bare "want pass, got fail" with no hint that the cause
// is the calendar. This test checks each cause in the order it is likely, and
// names the command that fixes it.
//
// It also catches the quieter failures a date check alone would miss: an edited
// .eml (sha256), a manifest whose claims have drifted from the file it
// describes (x= re-read from the message itself), and a dns.json that has lost
// the key a fixture needs.
func TestFixturesStillVerifyAndHaveNotExpired(t *testing.T) {
	m := loadManifest(t)
	if len(m.Fixtures) == 0 {
		t.Fatal("manifest lists no fixtures")
	}
	dns := loadDNSMap(t)
	lookup := recordedLookup(t)

	for _, f := range m.Fixtures {
		t.Run(f.File, func(t *testing.T) {
			raw := mustRead(t, f.File)

			sum := sha256.Sum256(raw)
			if got := hex.EncodeToString(sum[:]); got != f.SHA256 {
				t.Fatalf("fixture %s has changed on disk\n  sha256 = %s\n  manifest = %s\nRestore it, or re-record with:\n  %s",
					f.File, got, f.SHA256, reExtract)
			}

			// Re-read x= from the message rather than believing the manifest.
			// A manifest that describes a message it no longer matches is the
			// one input that would make every other check here a lie.
			hasX, expiresAt := signatureExpiry(t, raw)
			if hasX != f.HasXTag {
				t.Fatalf("manifest says has_x_tag=%v for %s but the message says %v; re-record with:\n  %s",
					f.HasXTag, f.File, hasX, reExtract)
			}
			if hasX {
				if f.XExpiresAt == nil {
					t.Fatalf("manifest records has_x_tag for %s but no x_expires_at; re-record with:\n  %s", f.File, reExtract)
				}
				if !expiresAt.Equal(*f.XExpiresAt) {
					t.Fatalf("manifest says %s expires at %s, message says %s; re-record with:\n  %s",
						f.File, f.XExpiresAt, expiresAt, reExtract)
				}
				if time.Now().After(expiresAt) {
					t.Fatalf("FIXTURE EXPIRED: %s's DKIM signature expired on %s.\n"+
						"This is not a bug in the verifier. go-msgauth rejects an expired\n"+
						"signature before it ever looks up a key, so every DKIM test now\n"+
						"fails for this one reason. Draw a fresh unexpired message:\n  %s",
						f.File, expiresAt.UTC().Format(time.RFC3339), reExtract)
				}
				if d := time.Until(expiresAt); d < 90*24*time.Hour {
					t.Logf("HEADS UP: %s expires in %s (%s). Re-record before then:\n  %s",
						f.File, d.Round(time.Hour), expiresAt.UTC().Format(time.RFC3339), reExtract)
				}
			}

			// The key the signature needs must be in the recording. Without
			// this, dropping a record from dns.json reads as a crypto failure.
			name := f.DKIMSelector + "._domainkey." + f.DKIMDomain
			if _, ok := dns[name]; !ok {
				t.Fatalf("%s signs with %s but %s has no record for it; re-record with:\n  %s",
					f.File, name, dnsFixture, reExtract)
			}

			got := VerifyDKIM(context.Background(), raw, lookup)
			if !f.DKIMVerifies {
				if got.DKIM == SigPass {
					t.Fatalf("manifest says %s does not verify, but it does: %+v", f.File, got)
				}
				return
			}
			if got.DKIM != SigPass {
				t.Fatalf("%s no longer verifies: %+v\nIf this is the only failure, re-record with:\n  %s",
					f.File, got, reExtract)
			}
			if !slices.Contains(got.DKIMDomains, f.DKIMDomain) {
				t.Fatalf("%s verified but for %v, manifest says d=%s", f.File, got.DKIMDomains, f.DKIMDomain)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// Absence, and the header that must never be believed.
// ---------------------------------------------------------------------------

func TestNoSignatureIsNone(t *testing.T) {
	raw := []byte("From: a@example.com\r\nSubject: hi\r\n\r\nbody\r\n")
	got := VerifyDKIM(context.Background(), raw, recordedLookup(t))
	if got.DKIM != SigNone {
		t.Fatalf("VerifyDKIM = %+v, want none", got)
	}
	if len(got.DKIMDomains) != 0 {
		t.Fatalf("DKIMDomains = %v, want empty", got.DKIMDomains)
	}
}

// Authentication-Results is attacker-writable: anyone who can send us mail can
// claim dkim=pass for any domain. This layer must not read it at all.
func TestForgedAuthenticationResultsIsIgnored(t *testing.T) {
	raw := []byte("Authentication-Results: mx.ledger.internal; dkim=pass header.d=dib.ae header.i=@dib.ae\r\n" +
		"ARC-Authentication-Results: i=1; mx.example.com; dkim=pass header.d=dib.ae\r\n" +
		"From: DIB Notification <DIB.notification@dib.ae>\r\n" +
		"Subject: AED 9,999.00 debited\r\n\r\nbody\r\n")
	got := VerifyDKIM(context.Background(), raw, recordedLookup(t))
	if got.DKIM != SigNone {
		t.Fatalf("VerifyDKIM = %+v, want none — Authentication-Results must be ignored entirely", got)
	}
	if len(got.DKIMDomains) != 0 {
		t.Fatalf("DKIMDomains = %v, want empty", got.DKIMDomains)
	}
}

// The same rule with a real signature attached: the fixture's own
// Authentication-Results says dkim=pass, and the message is tampered. The
// verifier must contradict the header, not defer to it.
func TestAPassingAuthenticationResultsDoesNotRescueATamperedMessage(t *testing.T) {
	raw := mustRead(t, "enbd-proofpoint-p.eml")
	if !bytes.Contains(raw, []byte("dkim=pass header.d=emiratesnbd.com")) {
		t.Fatal("fixture no longer carries the Authentication-Results this test is about")
	}
	got := VerifyDKIM(context.Background(), mustReplace(t, raw, "4,100.00", "9,100.00"), recordedLookup(t))
	if got.DKIM != SigFail {
		t.Fatalf("VerifyDKIM = %+v, want fail", got)
	}
}

// ---------------------------------------------------------------------------
// Tampering.
// ---------------------------------------------------------------------------

func TestTamperedBodyFailsVerification(t *testing.T) {
	raw := mustReplace(t, mustRead(t, "enbd-proofpoint-p.eml"), "4,100.00", "9,100.00")
	got := VerifyDKIM(context.Background(), raw, recordedLookup(t))
	if got.DKIM != SigFail {
		t.Fatalf("a modified amount must fail DKIM, got %+v", got)
	}
	if !strings.Contains(got.Err, "body hash did not verify") {
		t.Fatalf("Err = %q, want the body hash to be named", got.Err)
	}
}

func TestTamperedSignedHeaderFailsVerification(t *testing.T) {
	// subject is in this signature's h= list, so rewriting it breaks the
	// header hash rather than the body hash.
	raw := mustReplace(t, mustRead(t, "enbd-proofpoint-p.eml"),
		"Subject: Local Bank Transfer", "Subject: Urgent: verify your account")
	got := VerifyDKIM(context.Background(), raw, recordedLookup(t))
	if got.DKIM != SigFail {
		t.Fatalf("a rewritten Subject must fail DKIM, got %+v", got)
	}
	if !strings.Contains(got.Err, "signature did not verify") {
		t.Fatalf("Err = %q, want the signature check to be named", got.Err)
	}
}

// ---------------------------------------------------------------------------
// DNS: what is permanent and what is not.
// ---------------------------------------------------------------------------

// selector1._domainkey.dib.ae is NXDOMAIN in the real world, which is why 6,389
// of the corpus's signatures can never be verified. An authoritative "no such
// record" is a permanent answer and must read as fail, not temperror.
func TestUnknownSelectorIsFailNotTempFail(t *testing.T) {
	got := VerifyDKIM(context.Background(), mustRead(t, "enbd-proofpoint-p.eml"), staticTXT(nil))
	if got.DKIM != SigFail {
		t.Fatalf("VerifyDKIM = %+v, want fail", got)
	}
	if !strings.Contains(got.Err, "no key") {
		t.Fatalf("Err = %q, want the missing key to be named", got.Err)
	}
}

// A resolver that is merely unreachable must not permanently demote a bank to
// "unauthenticated" — that is the difference between a network blip and a
// forgery, and only one of them should change how a message is treated.
func TestDNSFailureIsTempFailNotFail(t *testing.T) {
	for name, lookup := range map[string]LookupTXT{
		"opaque transport error": failingTXT(errors.New("dial udp 1.1.1.1:53: connection refused")),
		"timeout":                failingTXT(&net.DNSError{Err: "i/o timeout", IsTimeout: true}),
		"server misbehaving":     failingTXT(&net.DNSError{Err: "server misbehaving", IsTemporary: true}),
		"context deadline":       failingTXT(context.DeadlineExceeded),
	} {
		t.Run(name, func(t *testing.T) {
			got := VerifyDKIM(context.Background(), mustRead(t, "enbd-proofpoint-p.eml"), lookup)
			if got.DKIM != SigTempFail {
				t.Fatalf("VerifyDKIM = %+v, want temperror", got)
			}
		})
	}
}

// NXDOMAIN as the real resolver reports it.
func TestNXDOMAINIsFail(t *testing.T) {
	lookup := failingTXT(&net.DNSError{Err: "no such host", IsNotFound: true})
	got := VerifyDKIM(context.Background(), mustRead(t, "enbd-proofpoint-p.eml"), lookup)
	if got.DKIM != SigFail {
		t.Fatalf("VerifyDKIM = %+v, want fail for NXDOMAIN", got)
	}
}

// A key that resolves and parses but is not the one that signed. This is the
// silent-rotation case: nothing about the message or the DNS looks broken.
func TestRotatedKeyIsFail(t *testing.T) {
	dns := loadDNSMap(t)
	// Serve Emirates NBD's selector1 key under the proofpoint-p name. It is a
	// valid 2048-bit RSA key; it just did not sign this message.
	dns["proofpoint-p._domainkey.emiratesnbd.com"] = dns["selector1._domainkey.emiratesnbd.com"]
	got := VerifyDKIM(context.Background(), mustRead(t, "enbd-proofpoint-p.eml"), staticTXT(dns))
	if got.DKIM != SigFail {
		t.Fatalf("VerifyDKIM = %+v, want fail for a rotated key", got)
	}
	if !strings.Contains(got.Err, "signature did not verify") {
		t.Fatalf("Err = %q, want the signature check to be named", got.Err)
	}
}

func TestRevokedKeyIsFail(t *testing.T) {
	dns := loadDNSMap(t)
	dns["proofpoint-p._domainkey.emiratesnbd.com"] = []string{"v=DKIM1; k=rsa; p="}
	got := VerifyDKIM(context.Background(), mustRead(t, "enbd-proofpoint-p.eml"), staticTXT(dns))
	if got.DKIM != SigFail {
		t.Fatalf("VerifyDKIM = %+v, want fail for a revoked key", got)
	}
}

// ---------------------------------------------------------------------------
// Expiry.
// ---------------------------------------------------------------------------

// The x= check is the one branch whose outcome depends on the wall clock, so it
// is tested with a timestamp in the fixed past rather than a fixture that has
// to age into the assertion.
func TestExpiredSignatureIsFail(t *testing.T) {
	// 1000000000 is 2001-09-09, and is the same width as the real value, so the
	// header's folding is untouched.
	raw := mustReplace(t, mustRead(t, "dib-dkim-unexpired.eml"), "x=1813560966", "x=1000000000")
	got := VerifyDKIM(context.Background(), raw, recordedLookup(t))
	if got.DKIM != SigFail {
		t.Fatalf("VerifyDKIM = %+v, want fail for an expired signature", got)
	}
	if !strings.Contains(got.Err, "expired") {
		t.Fatalf("Err = %q, want expiry to be named", got.Err)
	}
}

// ---------------------------------------------------------------------------
// Policy refusals on attacker-shaped signatures.
// ---------------------------------------------------------------------------

// l= says "only the first N bytes of the body are signed", which lets anyone
// append whatever they like below a valid signature. It is refused, not ignored.
func TestBodyLengthTagIsRefused(t *testing.T) {
	raw := mustReplace(t, mustRead(t, "enbd-proofpoint-p.eml"),
		"DKIM-Signature: v=1;", "DKIM-Signature: v=1; l=100;")
	got := VerifyDKIM(context.Background(), raw, recordedLookup(t))
	if got.DKIM != SigFail {
		t.Fatalf("VerifyDKIM = %+v, want fail for an l= signature", got)
	}
	// The assertion is not that it failed but that it failed for THIS layer's
	// reason, which is the only part of the outcome this file owns. Two other
	// things would sink this message on their own: splicing a tag into a
	// signature invalidates it, because the DKIM-Signature field is itself
	// signed with b= blanked; and go-msgauth refuses l= before it checks the
	// body hash (dkim/verify.go:352). A genuinely valid l= signature cannot be
	// built against this library at all — its signer will not emit the tag
	// (sign.go:200) — so the policy here is belt to the library's braces, and
	// the braces are what a future upgrade might quietly remove.
	if !strings.Contains(got.Err, "l= body-length tag, which is not accepted") {
		t.Fatalf("Err = %q, want this layer's refusal", got.Err)
	}
	if strings.Contains(got.Err, "insecure body length tag") {
		t.Fatalf("Err = %q is go-msgauth's wording: this layer's refusal must be "+
			"decided before the library's verdict is read", got.Err)
	}
}

// An l= signature must be refused even when the truncated body hash is
// genuinely correct, which is the case the tag exists to create: sign a short
// prefix, append anything.
func TestBodyLengthTagIsRefusedEvenWithAppendedContent(t *testing.T) {
	raw := mustReplace(t, mustRead(t, "enbd-proofpoint-p.eml"),
		"DKIM-Signature: v=1;", "DKIM-Signature: v=1; l=100;")
	raw = append(raw, []byte("\r\nYOUR ACCOUNT IS COMPROMISED, CALL 0800-ATTACKER\r\n")...)
	if got := VerifyDKIM(context.Background(), raw, recordedLookup(t)); got.DKIM == SigPass {
		t.Fatalf("VerifyDKIM = %+v, an l= signature must never pass", got)
	}
}

func TestOversizedSignatureHeaderIsRefused(t *testing.T) {
	raw := []byte("DKIM-Signature: " + strings.Repeat("a", maxSigFieldBytes+1) + "\r\n" +
		"From: a@example.com\r\n\r\nbody\r\n")
	got := VerifyDKIM(context.Background(), raw, recordedLookup(t))
	if got.DKIM != SigFail {
		t.Fatalf("VerifyDKIM = %+v, want fail", got)
	}
	if !strings.Contains(got.Err, "too large") {
		t.Fatalf("Err = %q, want the size limit to be named", got.Err)
	}
}

func TestMalformedSignatureHeaderIsFail(t *testing.T) {
	for name, sig := range map[string]string{
		"empty":               "",
		"not a tag list":      "this is not a tag list",
		"missing tags":        "v=1; a=rsa-sha256",
		"wrong version":       "v=2; a=rsa-sha256; b=AA==; bh=AA==; d=dib.ae; h=from; s=selector2",
		"unsigned From":       "v=1; a=rsa-sha256; b=AA==; bh=AA==; d=dib.ae; h=subject; s=selector2",
		"identifier mismatch": "v=1; a=rsa-sha256; b=AA==; bh=AA==; d=dib.ae; h=from; s=selector2; i=@evil.example",
		"weak hash":           "v=1; a=rsa-sha1; b=AA==; bh=AA==; d=dib.ae; h=from; s=selector2",
	} {
		t.Run(name, func(t *testing.T) {
			raw := []byte("DKIM-Signature: " + sig + "\r\nFrom: a@dib.ae\r\n\r\nbody\r\n")
			got := VerifyDKIM(context.Background(), raw, recordedLookup(t))
			if got.DKIM != SigFail {
				t.Fatalf("VerifyDKIM = %+v, want fail", got)
			}
			if got.Err == "" {
				t.Fatal("a failure reported no reason")
			}
			if len(got.DKIMDomains) != 0 {
				t.Fatalf("DKIMDomains = %v, want empty", got.DKIMDomains)
			}
		})
	}
}

// A signature whose h= omits From cannot be trusted to say who sent the
// message, and go-msgauth refuses it before anything else. Task 26 depends on
// this: every domain in DKIMDomains has signed the message's From.
func TestAPassingDomainAlwaysSignedFrom(t *testing.T) {
	raw := mustRead(t, "enbd-proofpoint-p.eml")
	got := VerifyDKIM(context.Background(), raw, recordedLookup(t))
	if got.DKIM != SigPass {
		t.Fatalf("VerifyDKIM = %+v, want pass", got)
	}
	// Strip From from the h= list; the signature must stop passing.
	stripped := mustReplace(t, raw,
		"h=content-transfer-encoding:content-type:date:from:message-id",
		"h=content-transfer-encoding:content-type:date:message-id")
	if got := VerifyDKIM(context.Background(), stripped, recordedLookup(t)); got.DKIM == SigPass {
		t.Fatalf("VerifyDKIM = %+v, a signature that does not cover From must never pass", got)
	}
}

// The counts here are LITERAL rather than maxSignatures+n. Written in terms of
// the constant, mutating the constant mutates the assertion with it and the
// limit is pinned at nothing at all; TestTheBoundsArePinnedAtTheirValues holds
// the constant itself.
func TestTooManySignaturesIsRefused(t *testing.T) {
	raw := mustRead(t, "enbd-proofpoint-p.eml") // carries one real signature
	extra := bytes.Repeat([]byte("DKIM-Signature: v=1; a=rsa-sha256; b=AA==; bh=AA==; d=x.example; h=from; s=s\r\n"), 9)
	raw = append(extra, raw...)
	got := VerifyDKIM(context.Background(), raw, recordedLookup(t))
	if got.DKIM != SigFail {
		t.Fatalf("VerifyDKIM = %+v, want fail", got)
	}
	// Not merely the word "signatures": go-msgauth's own ErrTooManySignatures
	// contains that too, so a substring assertion on it passes whether this
	// layer's refusal exists or not. The count and the limit are this layer's.
	const want = "carries 10 DKIM signatures, over the limit of 8"
	if !strings.Contains(got.Err, want) {
		t.Fatalf("Err = %q, want %q", got.Err, want)
	}
}

// ---------------------------------------------------------------------------
// Multiple signatures.
// ---------------------------------------------------------------------------

// Only domains whose own signature verified may appear. A second signature
// claiming a domain we have no key for is exactly the forgery this rule stops.
func TestOnlyPassingDomainsAreReported(t *testing.T) {
	raw := mustRead(t, "enbd-proofpoint-p.eml")
	forged := []byte("DKIM-Signature: v=1; a=rsa-sha256; c=relaxed/relaxed; d=dib.ae; " +
		"h=from:subject; s=selector2; bh=HPQS/xHtokqk4T+5uu+KOGAd/3KQUpfp0eOLkQnMuis=; b=AA==\r\n")
	got := VerifyDKIM(context.Background(), append(forged, raw...), recordedLookup(t))
	if got.DKIM != SigPass {
		t.Fatalf("VerifyDKIM = %+v, want pass", got)
	}
	if !slices.Equal(got.DKIMDomains, []string{"emiratesnbd.com"}) {
		t.Fatalf("DKIMDomains = %v, want only emiratesnbd.com", got.DKIMDomains)
	}
}

// A temporary DNS failure on a bogus signature must not hide a real pass.
func TestATempFailOnOneSignatureDoesNotHideAPass(t *testing.T) {
	dns := loadDNSMap(t)
	base := staticTXT(dns)
	lookup := func(ctx context.Context, name string) ([]string, error) {
		if strings.HasSuffix(name, ".example") {
			return nil, &net.DNSError{Err: "i/o timeout", IsTimeout: true}
		}
		return base(ctx, name)
	}
	forged := []byte("DKIM-Signature: v=1; a=rsa-sha256; c=relaxed/relaxed; d=evil.example; " +
		"h=from:subject; s=s; bh=HPQS/xHtokqk4T+5uu+KOGAd/3KQUpfp0eOLkQnMuis=; b=AA==\r\n")
	raw := append(forged, mustRead(t, "enbd-proofpoint-p.eml")...)
	if got := VerifyDKIM(context.Background(), raw, lookup); got.DKIM != SigPass {
		t.Fatalf("VerifyDKIM = %+v, want pass", got)
	}
}

// ---------------------------------------------------------------------------
// The confused deputy.
// ---------------------------------------------------------------------------

// A bare LF makes net/textproto — and therefore go-msgauth's own header
// reader — see a different document than a strict RFC 5322 reader does. The
// verifier must refuse rather than authenticate one document while the rest of
// the pipeline acts on another. arc.ReadHeader is the strict reader, reused
// here rather than reimplemented.
func TestBareLFHeaderIsRefused(t *testing.T) {
	raw := append([]byte("X-Junk: a\n\nX-Junk2: b\r\n"), mustRead(t, "enbd-proofpoint-p.eml")...)
	got := VerifyDKIM(context.Background(), raw, recordedLookup(t))
	if got.DKIM != SigFail {
		t.Fatalf("VerifyDKIM = %+v, want fail for a bare-LF header", got)
	}
	if !strings.Contains(got.Err, "bare LF") {
		t.Fatalf("Err = %q, want the bare LF to be named", got.Err)
	}
}

// ---------------------------------------------------------------------------
// Hostile input.
// ---------------------------------------------------------------------------

// This runs on anything an open SMTP port is handed. Nothing here is expected
// to verify; the assertion is that nothing panics, nothing hangs, and nothing
// is ever reported as pass.
func TestHostileInputNeitherPanicsNorPasses(t *testing.T) {
	lookup := recordedLookup(t)
	cases := map[string][]byte{
		"empty":             {},
		"crlf only":         []byte("\r\n"),
		"blank header":      []byte("\r\n\r\nbody"),
		"nul bytes":         []byte("DKIM-Signature: v=1\x00\x00\x00\r\nFrom: a@b\r\n\r\n\x00\x00"),
		"no colon":          []byte("not a header at all\r\n\r\nbody"),
		"lone continuation": []byte(" continuation with nothing above it\r\n\r\nbody"),
		"no body":           []byte("From: a@b.example\r\nDKIM-Signature: v=1\r\n"),
		"invalid utf8":      []byte("From: \xff\xfe\xfd\r\nDKIM-Signature: v=1; d=\xff\r\n\r\nbody"),
		"cr only":           []byte("From: a@b\rDKIM-Signature: v=1\r\r\nbody"),
		"long single line":  []byte("DKIM-Signature: " + strings.Repeat("x", 1<<20) + "\r\nFrom: a@b\r\n\r\nbody"),
		"deep folding":      []byte("DKIM-Signature: v=1;" + strings.Repeat("\r\n a=b;", 20000) + "\r\nFrom: a@b\r\n\r\nbody"),
		"many crlf":         bytes.Repeat([]byte("\r\n"), 100000),
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		for name, raw := range cases {
			func() {
				defer func() {
					if r := recover(); r != nil {
						t.Errorf("%s panicked: %v", name, r)
					}
				}()
				if got := VerifyDKIM(context.Background(), raw, lookup); got.DKIM == SigPass {
					t.Errorf("%s = %+v, hostile input must never pass", name, got)
				}
			}()
		}
	}()
	select {
	case <-done:
	case <-time.After(30 * time.Second):
		t.Fatal("VerifyDKIM did not finish within 30s on hostile input")
	}
}

// Err is written to diagnostics and to logs, and everything in it ultimately
// derives from attacker-controlled bytes. It must be bounded and free of
// control characters, or a sender can inject fake log lines.
func TestErrIsBoundedAndPrintable(t *testing.T) {
	for name, payload := range map[string]string{
		"forged log line": "boom\r\nAug 01 00:00:00 ledger[1]: dkim=pass header.d=dib.ae\r\n" +
			strings.Repeat("padding ", 5000),
		// Invalid UTF-8 is the case that breaks a truncate-then-clean
		// implementation: each bad byte becomes a three-byte U+FFFD, so a
		// string cut to the limit comes back over it.
		"invalid utf8": strings.Repeat("\xff\xfe", 5000),
		"nul bytes":    strings.Repeat("\x00", 5000),
		"wide runes":   strings.Repeat("é世", 5000),
	} {
		t.Run(name, func(t *testing.T) {
			got := VerifyDKIM(context.Background(), mustRead(t, "enbd-proofpoint-p.eml"), failingTXT(errors.New(payload)))
			if len(got.Err) > maxErrBytes {
				t.Fatalf("Err is %d bytes, over the %d limit", len(got.Err), maxErrBytes)
			}
			if strings.ContainsAny(got.Err, "\r\n\x00") {
				t.Fatalf("Err carries control characters: %q", got.Err)
			}
			if !utf8.ValidString(got.Err) {
				t.Fatalf("Err is not valid UTF-8: %q", got.Err)
			}
		})
	}
}

// A verifier with no way to resolve keys must not convict the sender. It is
// also the one path that must never quietly fall through to live DNS.
func TestAMissingResolverIsTempFail(t *testing.T) {
	got := VerifyDKIM(context.Background(), mustRead(t, "enbd-proofpoint-p.eml"), nil)
	if got.DKIM != SigTempFail {
		t.Fatalf("VerifyDKIM = %+v, want temperror", got)
	}
}

// A failure must always say something. An empty reason on a fail is a dead end
// for whoever is holding the pager.
func TestEveryFailureCarriesAReason(t *testing.T) {
	cases := map[string]Verified{
		"tampered":  VerifyDKIM(context.Background(), mustReplace(t, mustRead(t, "enbd-proofpoint-p.eml"), "4,100.00", "9,100.00"), recordedLookup(t)),
		"no key":    VerifyDKIM(context.Background(), mustRead(t, "enbd-proofpoint-p.eml"), staticTXT(nil)),
		"temp":      VerifyDKIM(context.Background(), mustRead(t, "enbd-proofpoint-p.eml"), failingTXT(errors.New("unreachable"))),
		"no header": VerifyDKIM(context.Background(), []byte("garbage"), recordedLookup(t)),
		"no lookup": VerifyDKIM(context.Background(), mustRead(t, "enbd-proofpoint-p.eml"), nil),
	}
	for name, got := range cases {
		if got.DKIM == SigPass || got.DKIM == SigNone {
			t.Fatalf("%s: expected a non-pass verdict, got %+v", name, got)
		}
		if got.Err == "" {
			t.Errorf("%s: %s carried no reason", name, got.DKIM)
		}
	}
}

// A zero CacheOptions must produce a working, bounded cache rather than one
// that expires everything instantly or grows without limit.
func TestZeroCacheOptionsAreUsable(t *testing.T) {
	var calls atomic.Int64
	base := func(_ context.Context, _ string) ([]string, error) {
		calls.Add(1)
		return []string{"v=DKIM1; p=x"}, nil
	}
	lookup := NewCachingLookup(base, CacheOptions{})
	for range 3 {
		if _, err := lookup(context.Background(), "s._domainkey.dib.ae"); err != nil {
			t.Fatal(err)
		}
	}
	if calls.Load() != 1 {
		t.Fatalf("the resolver was asked %d times, want 1", calls.Load())
	}
}

// A non-positive timeout must not turn into an already-expired context, which
// would make every lookup fail and read as a network outage.
func TestNonPositiveTimeoutFallsBackToTheDefault(t *testing.T) {
	lookup := WithTimeout(func(ctx context.Context, _ string) ([]string, error) {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		return []string{"v=DKIM1; p=x"}, nil
	}, 0)
	if _, err := lookup(context.Background(), "s._domainkey.dib.ae"); err != nil {
		t.Fatalf("a zero timeout broke the lookup: %v", err)
	}
}

// ---------------------------------------------------------------------------
// The production lookup wrapper.
// ---------------------------------------------------------------------------

func TestCacheServesRepeatsWithoutAskingAgain(t *testing.T) {
	var calls atomic.Int64
	base := func(_ context.Context, name string) ([]string, error) {
		calls.Add(1)
		return []string{"v=DKIM1; p=" + name}, nil
	}
	lookup := NewCachingLookup(base, CacheOptions{TTL: time.Minute, NegativeTTL: time.Minute, MaxEntries: 8})
	for range 5 {
		if _, err := lookup(context.Background(), "s._domainkey.dib.ae"); err != nil {
			t.Fatal(err)
		}
	}
	if calls.Load() != 1 {
		t.Fatalf("the resolver was asked %d times, want 1", calls.Load())
	}
}

// An attacker picks the selector, so every message can mint a new cache key. A
// cache that grew for each of them would be a memory leak with a sender behind
// it.
func TestCacheIsBounded(t *testing.T) {
	base := func(_ context.Context, _ string) ([]string, error) { return nil, &net.DNSError{IsNotFound: true} }
	c := newCache(CacheOptions{TTL: time.Minute, NegativeTTL: time.Minute, MaxEntries: 16})
	lookup := c.wrap(base)
	for i := range 10000 {
		_, _ = lookup(context.Background(), "s"+strconv.Itoa(i)+"._domainkey.dib.ae")
	}
	if n := c.len(); n > 16 {
		t.Fatalf("cache holds %d entries, over the 16 limit", n)
	}
}

// A temporary failure must never be cached: doing so would turn a one-second
// network blip into minutes of a bank reading as unauthenticated.
func TestCacheDoesNotRememberTemporaryFailures(t *testing.T) {
	var calls atomic.Int64
	base := func(_ context.Context, _ string) ([]string, error) {
		calls.Add(1)
		return nil, &net.DNSError{Err: "i/o timeout", IsTimeout: true}
	}
	lookup := NewCachingLookup(base, CacheOptions{TTL: time.Minute, NegativeTTL: time.Minute, MaxEntries: 8})
	for range 3 {
		_, _ = lookup(context.Background(), "s._domainkey.dib.ae")
	}
	if calls.Load() != 3 {
		t.Fatalf("the resolver was asked %d times, want 3 — a temporary failure was cached", calls.Load())
	}
}

func TestCacheExpires(t *testing.T) {
	var calls atomic.Int64
	base := func(_ context.Context, _ string) ([]string, error) {
		calls.Add(1)
		return []string{"v=DKIM1; p=x"}, nil
	}
	c := newCache(CacheOptions{TTL: time.Minute, NegativeTTL: time.Minute, MaxEntries: 8})
	now := time.Unix(1_700_000_000, 0)
	c.now = func() time.Time { return now }
	lookup := c.wrap(base)
	if _, err := lookup(context.Background(), "s._domainkey.dib.ae"); err != nil {
		t.Fatal(err)
	}
	now = now.Add(2 * time.Minute)
	if _, err := lookup(context.Background(), "s._domainkey.dib.ae"); err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 2 {
		t.Fatalf("the resolver was asked %d times, want 2 — the entry did not expire", calls.Load())
	}
}

// The timeout is the whole point of the wrapper: a resolver that never answers
// must not hold an SMTP transaction open.
func TestResolverLookupAppliesATimeout(t *testing.T) {
	blocked := make(chan struct{})
	defer close(blocked)
	base := func(ctx context.Context, _ string) ([]string, error) {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-blocked:
			return nil, nil
		}
	}
	lookup := WithTimeout(base, 50*time.Millisecond)
	start := time.Now()
	_, err := lookup(context.Background(), "s._domainkey.dib.ae")
	if err == nil {
		t.Fatal("a blocked lookup returned no error")
	}
	if d := time.Since(start); d > 5*time.Second {
		t.Fatalf("the lookup took %s, the timeout did not apply", d)
	}
	if classifyDNSError(err) != dnsTemporary {
		t.Fatalf("a timed-out lookup classified as permanent: %v", err)
	}
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

func mustRead(t *testing.T, name string) []byte {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// mustReplace fails when the text it was asked to change is absent. A silent
// no-op would leave a tamper test verifying an untampered message, which passes
// for the wrong reason and keeps passing forever.
func mustReplace(t *testing.T, raw []byte, old, new string) []byte {
	t.Helper()
	if !bytes.Contains(raw, []byte(old)) {
		t.Fatalf("fixture does not contain %q; this test no longer tampers with anything", old)
	}
	return bytes.Replace(raw, []byte(old), []byte(new), 1)
}

// recordedLookup is the fixture mechanism Task 2 built for ARC, reused. An
// unrecorded name answers arc.ErrNoKey and never reaches a resolver.
func recordedLookup(t *testing.T) LookupTXT {
	t.Helper()
	lookup, n, err := arc.FixtureLookup(dnsFixture)
	if err != nil {
		t.Fatal(err)
	}
	if n == 0 {
		t.Fatalf("%s holds no records", dnsFixture)
	}
	return lookup
}

// staticTXT serves a map the test has deliberately corrupted. It mirrors
// arc.FixtureLookup's contract — an unknown name is arc.ErrNoKey, never a live
// query — so the only difference from the recording is the content.
func staticTXT(recs map[string][]string) LookupTXT {
	return func(_ context.Context, name string) ([]string, error) {
		if v, ok := recs[name]; ok && len(v) > 0 {
			return v, nil
		}
		return nil, arc.ErrNoKey
	}
}

func failingTXT(err error) LookupTXT {
	return func(context.Context, string) ([]string, error) { return nil, err }
}

func loadDNSMap(t *testing.T) map[string][]string {
	t.Helper()
	b, err := os.ReadFile(dnsFixture)
	if err != nil {
		t.Fatal(err)
	}
	var m map[string][]string
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatal(err)
	}
	return m
}

type fixtureManifest struct {
	GeneratedAt time.Time      `json:"generated_at"`
	CorpusSize  int            `json:"corpus_size"`
	Fixtures    []fixtureEntry `json:"fixtures"`
}

type fixtureEntry struct {
	File         string     `json:"file"`
	Kind         string     `json:"kind"`
	SHA256       string     `json:"sha256"`
	DKIMDomain   string     `json:"dkim_d"`
	DKIMSelector string     `json:"dkim_selector"`
	DKIMVerifies bool       `json:"dkim_verifies"`
	HasXTag      bool       `json:"has_x_tag"`
	XExpiresAt   *time.Time `json:"x_expires_at"`
}

func loadManifest(t *testing.T) fixtureManifest {
	t.Helper()
	b, err := os.ReadFile(manifestFixture)
	if err != nil {
		t.Fatal(err)
	}
	var m fixtureManifest
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatal(err)
	}
	return m
}

// signatureExpiry reads x= straight out of the message, using the same strict
// header reader the verifier does.
func signatureExpiry(t *testing.T, raw []byte) (bool, time.Time) {
	t.Helper()
	h, _, err := arc.ReadHeader(raw)
	if err != nil {
		t.Fatal(err)
	}
	sigs := h.Get("DKIM-Signature")
	if len(sigs) == 0 {
		t.Fatal("fixture has no DKIM-Signature")
	}
	x, ok := arc.ParseTags(sigs[0].Value)["x"]
	if !ok {
		return false, time.Time{}
	}
	secs, err := strconv.ParseInt(x, 10, 64)
	if err != nil {
		t.Fatalf("x=%q is not a timestamp: %v", x, err)
	}
	return true, time.Unix(secs, 0).UTC()
}

// ---------------------------------------------------------------------------
// Coverage: WHAT a signature signed, not merely THAT a domain signed.
//
// A DKIM signature covers the bottom-most occurrence of a repeated field (RFC
// 6376 section 5.4.2). Every reader downstream of this package takes the
// TOP-most: norm.go:165 for Subject, norm.go:214 for Content-Type, and
// go-message's entity.go:39 for Content-Transfer-Encoding all call a Get that
// returns the first field in the file. Prepending a copy of a signed field
// therefore leaves the signature verifying over one document while the rest of
// the pipeline reads another — the confused deputy this package exists to
// prevent, which singleFrom closed for From alone.
// ---------------------------------------------------------------------------

// The exact injection an adversarial review landed on the repo's own passing
// fixture: one prepended line turns a 250.00 transfer alert into a 250,000.00
// one, with DKIM still reporting pass for emiratesnbd.com.
func TestAPrependedSubjectIsRefused(t *testing.T) {
	raw := mustRead(t, "enbd-proofpoint-p.eml")
	inj := append([]byte("Subject: AED 250,000.00 debited from your account\r\n"), raw...)

	if got := VerifyDKIM(context.Background(), raw, recordedLookup(t)); got.DKIM != SigPass {
		t.Fatalf("the untampered fixture must still pass, got %+v", got)
	}
	got := VerifyDKIM(context.Background(), inj, recordedLookup(t))
	if got.DKIM == SigPass {
		t.Fatalf("VerifyDKIM = %+v; a prepended Subject leaves the signature verifying over "+
			"the bottom-most field while norm reads the top-most one", got)
	}
	if !strings.Contains(strings.ToLower(got.Err), "subject") {
		t.Fatalf("Err = %q, want the repeated field named", got.Err)
	}
}

// The same shape against DIB, whose h= omits Content-Type altogether: the
// prepended field is not signed at all, and it decides how the signed body is
// decoded.
func TestAPrependedContentTypeIsRefused(t *testing.T) {
	raw := mustRead(t, "dib-dkim-unexpired.eml")
	inj := append([]byte("Content-Type: text/plain; charset=\"utf-8\"\r\n"), raw...)

	if got := VerifyDKIM(context.Background(), raw, recordedLookup(t)); got.DKIM != SigPass {
		t.Fatalf("the untampered fixture must still pass, got %+v", got)
	}
	got := VerifyDKIM(context.Background(), inj, recordedLookup(t))
	if got.DKIM == SigPass {
		t.Fatalf("VerifyDKIM = %+v; a prepended Content-Type re-decodes the signed body", got)
	}
	if !strings.Contains(strings.ToLower(got.Err), "content-type") {
		t.Fatalf("Err = %q, want the repeated field named", got.Err)
	}
}

// Every field RFC 5322 section 3.6 and RFC 2045 permit at most once, on both
// banks. Whether the field is in h= or not is irrelevant to the refusal: what
// makes it fatal is that two readers of the same bytes disagree about which
// occurrence is the message's.
// The fields are read off each fixture rather than listed here: prepending a
// field the message does not already carry is not a duplicate, and asserting a
// refusal for one would be asserting the wrong rule.
func TestARepeatedSingletonFieldIsRefusedOnEveryFixture(t *testing.T) {
	for _, fixture := range loadManifest(t).Fixtures {
		raw := mustRead(t, fixture.File)
		if got := VerifyDKIM(context.Background(), raw, recordedLookup(t)); got.DKIM != SigPass {
			t.Fatalf("%s: the untampered fixture must pass, got %+v", fixture.File, got)
		}
		h, _, err := arc.ReadHeader(raw)
		if err != nil {
			t.Fatal(err)
		}
		var exercised int
		for name := range singletonFields {
			fields := h.Get(name)
			if len(fields) == 0 {
				continue
			}
			exercised++
			t.Run(fixture.File+"/"+name, func(t *testing.T) {
				// The attacker's copy is a different value from the signed one:
				// an identical duplicate would prove nothing about which
				// occurrence a reader took.
				inj := append([]byte(strings.TrimSpace(fields[0].Name)+": injected\r\n"), raw...)
				got := VerifyDKIM(context.Background(), inj, recordedLookup(t))
				if got.DKIM == SigPass {
					t.Fatalf("VerifyDKIM = %+v, a prepended %s must not leave the message trusted",
						got, name)
				}
				if got.Err == "" {
					t.Fatal("a refusal with no reason")
				}
				if got.Coverage.Covers(name) {
					t.Fatalf("Coverage still claims %s is covered: %+v", name, got.Coverage)
				}
			})
		}
		if exercised < 5 {
			t.Errorf("%s: only %d singleton fields exercised; this test has stopped testing",
				fixture.File, exercised)
		}
	}
}

// The refusal must be scoped to fields that may legitimately appear only once.
// Trace and authentication fields repeat on every relayed message in the corpus
// — the fixtures carry up to 8 Received and 6 Authentication-Results — and a
// rule that refused those would refuse all forwarded mail, which is the traffic
// this receiver exists to read.
func TestLegitimatelyRepeatedFieldsAreNotRefused(t *testing.T) {
	raw := mustRead(t, "enbd-proofpoint-p.eml")
	for _, f := range []string{
		"Received: from evil.example by mx.example; Mon, 1 Jan 2001 00:00:00 +0000",
		"Authentication-Results: mx.example; dkim=pass header.d=dib.ae",
		"Received-SPF: pass (evil.example)",
		"X-Something: repeated",
		"DKIM-Signature: v=1; a=rsa-sha256; b=AA==; bh=AA==; d=x.example; h=from; s=s",
	} {
		t.Run(strings.SplitN(f, ":", 2)[0], func(t *testing.T) {
			inj := append([]byte(f+"\r\n"), raw...)
			if got := VerifyDKIM(context.Background(), inj, recordedLookup(t)); got.DKIM != SigPass {
				t.Fatalf("VerifyDKIM = %+v; %q may repeat and must not cost the message its verdict",
					got, strings.SplitN(f, ":", 2)[0])
			}
		})
	}
}

// The question a downstream reader has to be able to ask.
func TestCoverageAnswersWhatWasSigned(t *testing.T) {
	// h=content-transfer-encoding:content-type:date:from:message-id:mime-version:subject:to
	enbd := VerifyDKIM(context.Background(), mustRead(t, "enbd-proofpoint-p.eml"), recordedLookup(t))
	if enbd.DKIM != SigPass {
		t.Fatalf("%+v", enbd)
	}
	for _, name := range []string{"Subject", "From", "Content-Type", "Content-Transfer-Encoding", "Date", "To"} {
		if !enbd.Coverage.Covers(name) {
			t.Errorf("ENBD: Covers(%q) = false, want true; it is in the signature's h=", name)
		}
	}
	if enbd.Coverage.Covers("X-Not-Signed") {
		t.Error("ENBD: Covers(X-Not-Signed) = true")
	}
	if u := enbd.Coverage.Uncovered(ConsumedHeaders...); len(u) != 0 {
		t.Errorf("ENBD: Uncovered(consumed) = %v, want none", u)
	}

	// h=message-id:mime-version:from:to:reply-to:date:subject:content-transfer-encoding
	// — Content-Type is absent, which is a fact about how Dubai Islamic Bank
	// signs and not something this receiver can repair. It is asserted here so
	// the gap is a recorded property rather than a surprise.
	dib := VerifyDKIM(context.Background(), mustRead(t, "dib-dkim-unexpired.eml"), recordedLookup(t))
	if dib.DKIM != SigPass {
		t.Fatalf("%+v", dib)
	}
	for _, name := range []string{"Subject", "From", "Content-Transfer-Encoding"} {
		if !dib.Coverage.Covers(name) {
			t.Errorf("DIB: Covers(%q) = false, want true", name)
		}
	}
	if dib.Coverage.Covers("Content-Type") {
		t.Error("DIB: Covers(Content-Type) = true, but d=dib.ae does not sign it")
	}
	if u := dib.Coverage.Uncovered(ConsumedHeaders...); !slices.Equal(u, []string{"content-type"}) {
		t.Errorf("DIB: Uncovered(consumed) = %v, want [content-type]", u)
	}
}

// Coverage is a statement about signatures that VERIFIED. A signature that
// failed proves nothing about the fields it claims to cover, and the zero
// Verified — the value every non-pass verdict carries — must cover nothing.
func TestCoverageComesOnlyFromPassingSignatures(t *testing.T) {
	var zero Verified
	if zero.Coverage.Covers("From") {
		t.Error("the zero Verified covers From")
	}
	if u := zero.Coverage.Uncovered("From", "Subject"); !slices.Equal(u, []string{"from", "subject"}) {
		t.Errorf("Uncovered = %v, want everything asked about", u)
	}

	// A forged signature naming a field nobody signed, alongside the real one.
	forged := []byte("DKIM-Signature: v=1; a=rsa-sha256; c=relaxed/relaxed; d=dib.ae; " +
		"h=from:x-evil-header; s=selector2; bh=HPQS/xHtokqk4T+5uu+KOGAd/3KQUpfp0eOLkQnMuis=; b=AA==\r\n")
	raw := append(forged, mustRead(t, "enbd-proofpoint-p.eml")...)
	got := VerifyDKIM(context.Background(), raw, recordedLookup(t))
	if got.DKIM != SigPass {
		t.Fatalf("VerifyDKIM = %+v, want pass from the real signature", got)
	}
	if got.Coverage.Covers("X-Evil-Header") {
		t.Error("a signature that did not verify contributed its h= to Coverage")
	}

	tampered := mustReplace(t, mustRead(t, "enbd-proofpoint-p.eml"), "Subject:", "Subject: x")
	if got := VerifyDKIM(context.Background(), tampered, recordedLookup(t)); got.Coverage.Covers("From") {
		t.Errorf("a failed verification reported coverage: %+v", got)
	}
}

// Oversigning is the signer-side defence RFC 6376 section 5.4.2 describes:
// naming a field in h= more often than it occurs makes an added copy break the
// signature. Coverage must read it correctly in both directions — the field is
// covered, and the addition it defends against is fatal.
func TestOversigningIsUnderstood(t *testing.T) {
	s := newTestSigner(t)
	msg := "From: bank <alerts@" + testSignerDomain + ">\r\n" +
		"Subject: real\r\n" +
		"\r\nbody\r\n"
	signed := s.sign(t, []byte(msg), []string{"From", "From", "Subject", "Subject"})

	got := VerifyDKIM(context.Background(), signed, s.lookup)
	if got.DKIM != SigPass {
		t.Fatalf("VerifyDKIM = %+v, want pass", got)
	}
	if !got.Coverage.Covers("Subject") || !got.Coverage.Covers("From") {
		t.Fatalf("Coverage = %+v, an oversigned field is covered", got.Coverage)
	}
	inj := append([]byte("Subject: injected\r\n"), signed...)
	if got := VerifyDKIM(context.Background(), inj, s.lookup); got.DKIM == SigPass {
		t.Fatalf("VerifyDKIM = %+v, want fail", got)
	}
}

// Covers is arithmetic, not a set membership test: a field named once in h= and
// carried twice by the message is signed at the bottom and unsigned at the top,
// so the value a reader takes is not the value the signature committed to.
//
// It has to be pinned on a field that may legitimately repeat, because the
// refusal above means a repeated SINGLETON never reaches this code at all —
// which would leave the arithmetic asserted by nothing. Received is the field
// that actually behaves this way in the wild: signers cover the bottom-most one
// and every later hop prepends another.
func TestCoverageCountsOccurrencesRatherThanNames(t *testing.T) {
	s := newTestSigner(t)
	msg := func(n int) []byte {
		var b strings.Builder
		for i := range n {
			fmt.Fprintf(&b, "Received: from hop%d.example by mx.example\r\n", i)
		}
		b.WriteString("From: bank <alerts@" + testSignerDomain + ">\r\nSubject: real\r\n\r\nbody\r\n")
		return []byte(b.String())
	}

	// Signed once, carried twice: the top one is the attacker's.
	got := VerifyDKIM(context.Background(), s.sign(t, msg(2), []string{"From", "Received"}), s.lookup)
	if got.DKIM != SigPass {
		t.Fatalf("VerifyDKIM = %+v, want pass", got)
	}
	if got.Coverage.Covers("Received") {
		t.Error("Covers(Received) = true with 2 fields and one named in h=; " +
			"a signature covers the bottom-most occurrence, not the one a reader takes")
	}
	if !got.Coverage.Covers("From") {
		t.Error("Covers(From) = false; the same signature covers it once and it occurs once")
	}

	// Signed twice, carried twice: every occurrence is signed material.
	got = VerifyDKIM(context.Background(),
		s.sign(t, msg(2), []string{"From", "Received", "Received"}), s.lookup)
	if got.DKIM != SigPass {
		t.Fatalf("VerifyDKIM = %+v, want pass", got)
	}
	if !got.Coverage.Covers("Received") {
		t.Errorf("Covers(Received) = false with both occurrences named in h=: %+v", got.Coverage)
	}
}

// ---------------------------------------------------------------------------
// Bounds on folded headers — the quadratic both parsers share.
// ---------------------------------------------------------------------------

// go-msgauth accumulates a folded field with h[len(h)-1] += l + crlf
// (dkim/header.go:32), which is quadratic in the number of continuation lines
// — the number a sender chooses. Fixing arc.ReadHeader was half the path:
// VerifyDKIM hands the same bytes to dkim.VerifyWithOptions immediately
// afterwards. Measured through VerifyDKIM before this bound existed: 20,000
// folds took 2.3s, 40,000 took 9.6s, 80,000 took 35.7s and 160,000 took 1m54s,
// all inside a 60s delivery deadline a pure-CPU loop never checks.
//
// The assertion is on bytes allocated, not on elapsed time: allocation is
// deterministic and load-independent, and quadratic concatenation shows up
// there three orders of magnitude before a wall clock notices.
func TestFoldedHeaderWorkIsBoundedThroughVerifyDKIM(t *testing.T) {
	const maxAllocRatio = 100
	lookup := recordedLookup(t)

	for _, n := range []int{10_000, 40_000} {
		raw := []byte("DKIM-Signature: v=1; a=rsa-sha256; c=relaxed/relaxed; d=x.example; s=s;\r\n" +
			" h=from:subject; bh=AA==; b=AA==\r\n" +
			"From: a@b.example\r\nSubject: s\r\nX-Fold: v" +
			strings.Repeat("\r\n cccc", n) + "\r\n\r\nbody\r\n")

		var before, after runtime.MemStats
		runtime.GC()
		runtime.ReadMemStats(&before)
		got := VerifyDKIM(context.Background(), raw, lookup)
		runtime.ReadMemStats(&after)

		if got.DKIM == SigPass {
			t.Fatalf("n=%d: %+v", n, got)
		}
		if !strings.Contains(got.Err, "folded") && !strings.Contains(got.Err, "too large") {
			t.Fatalf("n=%d: Err = %q, want the fold bound named", n, got.Err)
		}
		allocated := after.TotalAlloc - before.TotalAlloc
		if ratio := float64(allocated) / float64(len(raw)); ratio > maxAllocRatio {
			t.Fatalf("n=%d folds: VerifyDKIM over %d bytes allocated %d bytes (%.0fx the input, "+
				"limit %dx); a folded header is being accumulated quadratically again",
				n, len(raw), allocated, ratio, maxAllocRatio)
		}
	}
}

func TestAnOversizedHeaderBlockIsRefusedBeforeAnyParser(t *testing.T) {
	raw := []byte("DKIM-Signature: v=1; a=rsa-sha256; d=x.example; s=s; h=from; bh=AA==; b=AA==\r\n" +
		"From: a@b.example\r\nX-Big: " + strings.Repeat("x", maxHeaderBytes) + "\r\n\r\nbody\r\n")
	got := VerifyDKIM(context.Background(), raw, recordedLookup(t))
	if got.DKIM != SigFail {
		t.Fatalf("VerifyDKIM = %+v, want fail", got)
	}
	if !strings.Contains(got.Err, "too large") {
		t.Fatalf("Err = %q, want the size limit named", got.Err)
	}
}

// The bound must sit far above real mail. The deepest folded field across the
// seven fixtures is 23 continuation lines and the largest header block is 12.5
// KB; every fixture must still verify.
func TestTheFoldBoundsClearRealMailByAnOrderOfMagnitude(t *testing.T) {
	for _, f := range loadManifest(t).Fixtures {
		raw := mustRead(t, f.File)
		h, _, err := arc.ReadHeader(raw)
		if err != nil {
			t.Fatalf("%s: %v", f.File, err)
		}
		block := len(raw)
		if i := bytes.Index(raw, []byte("\r\n\r\n")); i >= 0 {
			block = i + 2
		}
		if block*8 > maxHeaderBytes {
			t.Errorf("%s: header block is %d bytes, less than 8x under the %d limit",
				f.File, block, maxHeaderBytes)
		}
		for _, field := range h {
			if lines := strings.Count(field.Raw, "\r\n") - 1; lines*8 > maxFieldLines {
				t.Errorf("%s: %s folds %d lines, less than 8x under the %d limit",
					f.File, field.Name, lines, maxFieldLines)
			}
		}
	}
}

// ---------------------------------------------------------------------------
// Limits, and the correspondence the strict split relies on.
// ---------------------------------------------------------------------------

// The bounds are pinned at their values, not merely at "whatever the constant
// says". Every test that builds maxSignatures+1 signatures moves with the
// constant, so mutating it mutates the assertion too, and all three limits
// could be changed to anything at all with a green suite.
func TestTheBoundsArePinnedAtTheirValues(t *testing.T) {
	for _, c := range []struct {
		name string
		got  int
		want int
	}{
		{"maxSignatures", maxSignatures, 8},
		{"maxSigFieldBytes", maxSigFieldBytes, 8192},
		{"maxErrBytes", maxErrBytes, 2048},
		{"maxHeaderBytes", maxHeaderBytes, 128 * 1024},
		{"maxFieldLines", maxFieldLines, 512},
	} {
		if c.got != c.want {
			t.Errorf("%s = %d, want %d; changing a bound is a deliberate act, "+
				"so say so here and in the doc comment", c.name, c.got, c.want)
		}
	}
}

// A policy refusal is decided from the strict split and applied to
// go-msgauth's verdict list by index. Nothing else in the suite has ever had
// two signatures where one is refused and one is not, so the correspondence
// between the two lists — the exact "verdict computed over one document,
// applied to another" shape this file exists to prevent — was untested.
func TestAPolicyRefusalFollowsItsOwnSignature(t *testing.T) {
	real := mustRead(t, "enbd-proofpoint-p.eml")
	// An l= signature is refused by policy before its verdict is read.
	refusable := "DKIM-Signature: v=1; a=rsa-sha256; c=relaxed/relaxed; d=x.example; s=s; " +
		"l=100; h=from:subject; bh=AA==; b=AA==\r\n"

	t.Run("refused signature first", func(t *testing.T) {
		got := VerifyDKIM(context.Background(), append([]byte(refusable), real...), recordedLookup(t))
		if got.DKIM != SigPass || !slices.Equal(got.DKIMDomains, []string{"emiratesnbd.com"}) {
			t.Fatalf("VerifyDKIM = %+v; the refusal belongs to signature 1, not to the real one", got)
		}
	})

	t.Run("refused signature second", func(t *testing.T) {
		// Appended at the foot of the header block, so it is the second
		// DKIM-Signature the strict split finds rather than the first.
		i := bytes.Index(real, []byte("\r\n\r\n"))
		if i < 0 {
			t.Fatal("fixture has no header/body boundary")
		}
		spliced := append(append(append([]byte{}, real[:i+2]...), []byte(refusable)...), real[i+2:]...)
		got := VerifyDKIM(context.Background(), spliced, recordedLookup(t))
		if got.DKIM != SigPass || !slices.Equal(got.DKIMDomains, []string{"emiratesnbd.com"}) {
			t.Fatalf("VerifyDKIM = %+v; the refusal belongs to the l= signature wherever it sits", got)
		}
	})
}

// MaxVerifications is the library-side belt to this layer's braces. Lowering it
// would silently stop verifying signatures the strict split found, which
// surfaces as a parser disagreement rather than as a missing pass — so a
// message carrying exactly the limit, with the only real signature last, pins
// it.
func TestEverySignatureUpToTheLimitIsVerified(t *testing.T) {
	junk := bytes.Repeat([]byte("DKIM-Signature: v=1; a=rsa-sha256; b=AA==; bh=AA==; d=x.example; h=from; s=s\r\n"),
		maxSignatures-1)
	raw := append(junk, mustRead(t, "enbd-proofpoint-p.eml")...)
	got := VerifyDKIM(context.Background(), raw, recordedLookup(t))
	if got.DKIM != SigPass {
		t.Fatalf("VerifyDKIM = %+v; the real signature sits below %d junk ones and must still be verified",
			got, maxSignatures-1)
	}
}

func TestNormalizeDomain(t *testing.T) {
	for in, want := range map[string]string{
		"dib.ae":            "dib.ae",
		"DIB.AE":            "dib.ae",
		"EmiratesNBD.com":   "emiratesnbd.com",
		"dib.ae.":           "dib.ae",
		"  dib.ae.  ":       "dib.ae",
		"":                  "",
		"MiXeD.CaSe.Sub.Ae": "mixed.case.sub.ae",
	} {
		if got := normalizeDomain(in); got != want {
			t.Errorf("normalizeDomain(%q) = %q, want %q; a comparison a change of case "+
				"or a root dot defeats is not a comparison", in, got, want)
		}
	}
}

// A context that is already done must not spend a lookup. The check is what
// stops a cancelled delivery from continuing to resolve keys, and without it
// the verdict would also be a permanent fail rather than a temperror.
func TestACancelledContextIsTempFailAndAsksNothing(t *testing.T) {
	var asked atomic.Int64
	base := recordedLookup(t)
	counting := func(ctx context.Context, name string) ([]string, error) {
		asked.Add(1)
		return base(ctx, name)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	got := VerifyDKIM(ctx, mustRead(t, "enbd-proofpoint-p.eml"), counting)
	if got.DKIM != SigTempFail {
		t.Fatalf("VerifyDKIM = %+v, want temperror on a cancelled context", got)
	}
	if n := asked.Load(); n != 0 {
		t.Fatalf("%d lookups on a cancelled context, want 0", n)
	}
}

// ---------------------------------------------------------------------------
// A signer this test owns, for the cases no recorded fixture can express.
// ---------------------------------------------------------------------------

const (
	testSignerDomain   = "signer.test"
	testSignerSelector = "s1"
)

type testSigner struct {
	key    *rsa.PrivateKey
	lookup LookupTXT
}

// newTestSigner mints a key, publishes it into a copy of the recording, and
// returns a signer for messages the corpus does not contain. The recording is
// still the whole world: the added record is one more name in the same map, and
// nothing here reaches a resolver.
func newTestSigner(t *testing.T) *testSigner {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.MarshalPKIXPublicKey(&key.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	dns := loadDNSMap(t)
	dns[testSignerSelector+"._domainkey."+testSignerDomain] = []string{
		"v=DKIM1; k=rsa; p=" + base64.StdEncoding.EncodeToString(der),
	}
	return &testSigner{key: key, lookup: staticTXT(dns)}
}

func (s *testSigner) sign(t *testing.T, msg []byte, headerKeys []string) []byte {
	t.Helper()
	var b bytes.Buffer
	err := dkimlib.Sign(&b, bytes.NewReader(msg), &dkimlib.SignOptions{
		Domain:                 testSignerDomain,
		Selector:               testSignerSelector,
		Signer:                 s.key,
		Hash:                   crypto.SHA256,
		HeaderCanonicalization: dkimlib.CanonicalizationRelaxed,
		BodyCanonicalization:   dkimlib.CanonicalizationRelaxed,
		HeaderKeys:             headerKeys,
	})
	if err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}
