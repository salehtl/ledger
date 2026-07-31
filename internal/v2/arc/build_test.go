package arc

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"fmt"
	"strings"
	"testing"
)

// A synthetic chain builder.
//
// The corpus proves the verifier agrees with Google, Apple and Microsoft on
// well-formed chains. It cannot prove anything about chains those three would
// never emit — a seal that claims an h= tag, an instance numbered 51, a
// duplicate instance — because no such message exists to extract. Every one of
// those is a rule the verifier enforces, and a rule with no test is a rule that
// can be deleted without anything going red.
//
// So: generate a key, publish it through a fake resolver, and sign chains that
// are correct except in the one way each test cares about. The builder
// self-checks — a chain it believes is valid must verify — so a fault-injection
// test can never pass because the builder quietly produced garbage.

type sealSpec struct {
	instance int
	cv       string
	// hList overrides the AMS h= list. Nil means the default, which includes
	// From as RFC 6376 6.1.1 requires.
	hList []string
	// amsExtra and asExtra inject tags immediately before b=.
	amsExtra string
	asExtra  string
	// alg overrides a= on both the AMS and the seal.
	alg string
}

type chainBuilder struct {
	t        *testing.T
	key      *rsa.PrivateKey
	domain   string
	selector string
	hdrs     Header // current header list, top first
	body     string
	sets     []instance
}

func newChain(t *testing.T) *chainBuilder {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	b := &chainBuilder{
		t:        t,
		key:      key,
		domain:   "sealer.example",
		selector: "test",
		body:     "Hello, this is a synthetic message.\r\n",
	}
	for _, kv := range [][2]string{
		{"From", " Bank <alerts@bank.example>"},
		{"To", " Customer <customer@example.com>"},
		{"Subject", " Your statement"},
		{"Date", " Mon, 01 Jan 2026 00:00:00 +0000"},
	} {
		b.hdrs = append(b.hdrs, field(kv[0], kv[1]))
	}
	return b
}

func field(name, value string) Field {
	return Field{Name: name, Value: value, Raw: name + ":" + value + crlf}
}

// dns serves the builder's generated public key for any selector/domain.
func (b *chainBuilder) dns() LookupTXT {
	der, err := x509.MarshalPKIXPublicKey(&b.key.PublicKey)
	if err != nil {
		b.t.Fatal(err)
	}
	rec := "v=DKIM1; k=rsa; p=" + base64.StdEncoding.EncodeToString(der)
	return func(context.Context, string) ([]string, error) { return []string{rec}, nil }
}

// dnsRecord serves an arbitrary key record, for testing key-record parsing.
func (b *chainBuilder) dnsRecord(rec string) LookupTXT {
	return func(context.Context, string) ([]string, error) { return []string{rec}, nil }
}

func (b *chainBuilder) sign(digest []byte) string {
	sig, err := rsa.SignPKCS1v15(rand.Reader, b.key, crypto.SHA256, digest)
	if err != nil {
		b.t.Fatal(err)
	}
	return base64.StdEncoding.EncodeToString(sig)
}

// seal appends one complete ARC set, signed correctly except where spec says
// otherwise. Sets are prepended to the header list the way a real hop does.
func (b *chainBuilder) seal(spec sealSpec) {
	b.t.Helper()
	if spec.cv == "" {
		if spec.instance == 1 {
			spec.cv = "none"
		} else {
			spec.cv = "pass"
		}
	}
	alg := spec.alg
	if alg == "" {
		alg = "rsa-sha256"
	}
	hList := spec.hList
	if hList == nil {
		hList = []string{"from", "to", "subject", "date"}
	}

	aar := field("ARC-Authentication-Results",
		fmt.Sprintf(" i=%d; %s; dkim=pass header.d=bank.example; spf=pass", spec.instance, b.domain))

	// ARC-Message-Signature: a DKIM signature under a different field name.
	bh := sha256.Sum256(CanonBody(Relaxed, []byte(b.body)))
	amsNoB := fmt.Sprintf(" i=%d; a=%s; c=relaxed/relaxed; d=%s; s=%s; h=%s; bh=%s;%s b=",
		spec.instance, alg, b.domain, b.selector, strings.Join(hList, ":"),
		base64.StdEncoding.EncodeToString(bh[:]), spec.amsExtra)

	hasher := sha256.New()
	picker := NewPicker(b.hdrs)
	for _, name := range hList {
		if f, ok := picker.Pick(name); ok {
			hasher.Write([]byte(CanonHeader(Relaxed, f)))
		}
	}
	self := field("ARC-Message-Signature", amsNoB)
	hasher.Write([]byte(strings.TrimSuffix(CanonHeader(Relaxed, self), crlf)))
	ams := field("ARC-Message-Signature", amsNoB+b.sign(hasher.Sum(nil)))

	// ARC-Seal: covers every ARC field of instances 1..i, no body.
	asNoB := fmt.Sprintf(" i=%d; a=%s; cv=%s; d=%s; s=%s;%s b=",
		spec.instance, alg, spec.cv, b.domain, b.selector, spec.asExtra)

	sealHasher := sha256.New()
	for _, s := range b.sets {
		sealHasher.Write([]byte(CanonHeader(Relaxed, s.aar)))
		sealHasher.Write([]byte(CanonHeader(Relaxed, s.ams)))
		sealHasher.Write([]byte(CanonHeader(Relaxed, s.as)))
	}
	sealHasher.Write([]byte(CanonHeader(Relaxed, aar)))
	sealHasher.Write([]byte(CanonHeader(Relaxed, ams)))
	selfSeal := field("ARC-Seal", asNoB)
	sealHasher.Write([]byte(strings.TrimSuffix(CanonHeader(Relaxed, selfSeal), crlf)))
	as := field("ARC-Seal", asNoB+b.sign(sealHasher.Sum(nil)))

	b.sets = append(b.sets, instance{n: spec.instance, aar: aar, ams: ams, as: as})
	b.hdrs = append(Header{as, ams, aar}, b.hdrs...)
}

// drop removes the most recent set's field of the given name, for building
// structurally broken chains.
func (b *chainBuilder) drop(name string) {
	b.t.Helper()
	var out Header
	dropped := false
	for _, f := range b.hdrs {
		if !dropped && strings.EqualFold(strings.TrimSpace(f.Name), name) {
			dropped = true
			continue
		}
		out = append(out, f)
	}
	if !dropped {
		b.t.Fatalf("no %s to drop", name)
	}
	b.hdrs = out
}

func (b *chainBuilder) build() []byte {
	var sb strings.Builder
	for _, f := range b.hdrs {
		sb.WriteString(f.Raw)
	}
	sb.WriteString(crlf)
	sb.WriteString(b.body)
	return []byte(sb.String())
}

// valid builds an n-instance chain and asserts the verifier accepts it.
//
// Every fault-injection test starts from this, so if the builder is wrong the
// failure surfaces here rather than as a fault test that "passes" against a
// chain that was never valid to begin with.
func (b *chainBuilder) valid(n int) []byte {
	b.t.Helper()
	for i := 1; i <= n; i++ {
		b.seal(sealSpec{instance: i})
	}
	raw := b.build()
	got, err := Verify(context.Background(), raw, b.dns())
	if err != nil {
		b.t.Fatalf("builder produced an unparseable chain: %v", err)
	}
	if got.Status != StatusPass || got.Instances != n {
		b.t.Fatalf("builder produced a chain the verifier rejects: %+v", got)
	}
	return raw
}

func TestSyntheticChainBuilderProducesValidChains(t *testing.T) {
	for _, n := range []int{1, 2, 3} {
		t.Run(fmt.Sprintf("%d-instance", n), func(t *testing.T) {
			newChain(t).valid(n)
		})
	}
}

// mustFail builds the message, verifies it, and requires a fail whose reason
// mentions want.
func mustFail(t *testing.T, raw []byte, lookup LookupTXT, want string) ChainResult {
	t.Helper()
	got, err := Verify(context.Background(), raw, lookup)
	if err != nil && got.Status != StatusFail {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.Status != StatusFail {
		t.Fatalf("Status = %q, want fail: %+v", got.Status, got)
	}
	if !strings.Contains(got.Reason, want) {
		t.Fatalf("Reason = %q, want it to mention %q", got.Reason, want)
	}
	return got
}

func TestSealMayNotClaimAHeaderList(t *testing.T) {
	// An h= on a seal would let a hop choose which of the ARC fields below it
	// its signature actually covers — i.e. opt out of the cumulative coverage
	// that makes the chain tamper-evident. RFC 8617 4.1.3 forbids the tag.
	b := newChain(t)
	b.seal(sealSpec{instance: 1, asExtra: " h=from:subject;"})
	mustFail(t, b.build(), b.dns(), "must not carry an h= tag")
}

func TestSealMayNotCarryABodyHash(t *testing.T) {
	b := newChain(t)
	b.seal(sealSpec{instance: 1, asExtra: " bh=47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=;"})
	mustFail(t, b.build(), b.dns(), "must not carry a bh= tag")
}

func TestBodyLengthTagIsRefused(t *testing.T) {
	// l= signs only the first l octets, leaving anything appended below the
	// signature unsigned but apparently verified. Refused rather than ignored.
	b := newChain(t)
	b.seal(sealSpec{instance: 1, amsExtra: " l=10;"})
	mustFail(t, b.build(), b.dns(), "l= body-length tag is not supported")
}

func TestUnknownAlgorithmIsRefused(t *testing.T) {
	b := newChain(t)
	b.seal(sealSpec{instance: 1, alg: "rsa-sha1"})
	mustFail(t, b.build(), b.dns(), "unsupported algorithm")
}

func TestAMSMustCoverFrom(t *testing.T) {
	// RFC 6376 6.1.1. Without this the chain verifies while From — half the
	// identity the trusted lane keys on — is unsigned and rewritable.
	b := newChain(t)
	b.seal(sealSpec{instance: 1, hList: []string{"subject", "date"}})
	mustFail(t, b.build(), b.dns(), "does not cover the From header")
}

func TestRewritingAnUnsignedHeaderIsNotDetected(t *testing.T) {
	// The other half of the From rule, stated as a fact rather than a wish:
	// a header outside h= is simply not protected. Subject is dropped from the
	// list here, rewritten afterwards, and the chain still passes — which is
	// correct ARC behaviour and exactly why SignedHeaders exists.
	b := newChain(t)
	b.seal(sealSpec{instance: 1, hList: []string{"from", "to", "date"}})
	raw := b.build()

	got, err := Verify(context.Background(), raw, b.dns())
	if err != nil {
		t.Fatal(err)
	}
	if got.Status != StatusPass {
		t.Fatalf("baseline chain did not pass: %+v", got)
	}
	if _, ok := got.SignedValue("subject"); ok {
		t.Fatal("SignedValue reported an unsigned Subject as signed")
	}
	if v, ok := got.SignedValue("from"); !ok || !strings.Contains(v, "bank.example") {
		t.Fatalf("SignedValue(from) = %q, %v", v, ok)
	}

	tampered := []byte(strings.Replace(string(raw),
		"Subject: Your statement", "Subject: URGENT act now", 1))
	got2, err := Verify(context.Background(), tampered, b.dns())
	if err != nil {
		t.Fatal(err)
	}
	if got2.Status != StatusPass {
		t.Fatalf("expected the unsigned rewrite to go undetected, got %+v", got2)
	}
	if _, ok := got2.SignedValue("subject"); ok {
		t.Fatal("SignedValue vouched for a header the signature never covered")
	}
}

func TestInstanceGapIsRejected(t *testing.T) {
	b := newChain(t)
	b.seal(sealSpec{instance: 1})
	b.seal(sealSpec{instance: 3})
	mustFail(t, b.build(), b.dns(), "not 1..")
}

func TestDuplicateInstanceIsRejected(t *testing.T) {
	for _, name := range []string{"ARC-Seal", "ARC-Message-Signature", "ARC-Authentication-Results"} {
		t.Run(name, func(t *testing.T) {
			b := newChain(t)
			b.seal(sealSpec{instance: 1})
			b.seal(sealSpec{instance: 2})
			// Re-add one field of instance 1 so the set is duplicated.
			var dup Field
			for _, f := range b.hdrs {
				if strings.EqualFold(strings.TrimSpace(f.Name), name) &&
					ParseTags(f.Value)["i"] == "1" {
					dup = f
					break
				}
			}
			if dup.Raw == "" {
				t.Fatalf("no %s i=1 found", name)
			}
			b.hdrs = append(Header{dup}, b.hdrs...)
			mustFail(t, b.build(), b.dns(), "two "+name)
		})
	}
}

func TestInstanceCeilingIsEnforced(t *testing.T) {
	// RFC 8617 5.1.2 caps a chain at 50 instances. Without the cap, a message
	// carrying thousands of sets is thousands of RSA verifications.
	b := newChain(t)
	b.seal(sealSpec{instance: 51})
	mustFail(t, b.build(), b.dns(), "outside 1..50")
}

func TestIncompleteSetIsRejected(t *testing.T) {
	for _, name := range []string{"ARC-Seal", "ARC-Message-Signature", "ARC-Authentication-Results"} {
		t.Run(name, func(t *testing.T) {
			b := newChain(t)
			b.seal(sealSpec{instance: 1})
			b.drop(name)
			mustFail(t, b.build(), b.dns(), "incomplete")
		})
	}
}

// --- single-instance adversarial cases -------------------------------------
//
// 1,082 of the corpus's 1,222 chains are single-instance, but every fixture
// adversarial test mutates the one two-instance message. These cover the
// shape that actually dominates real traffic, where there is no chain below
// to notice a problem.

func TestSingleInstanceChainTampering(t *testing.T) {
	t.Run("body", func(t *testing.T) {
		b := newChain(t)
		raw := b.valid(1)
		tampered := []byte(strings.Replace(string(raw), "synthetic", "synthesis", 1))
		mustFail(t, tampered, b.dns(), "body hash mismatch")
	})

	t.Run("signed header", func(t *testing.T) {
		b := newChain(t)
		raw := b.valid(1)
		tampered := []byte(strings.Replace(string(raw),
			"From: Bank <alerts@bank.example>", "From: Bank <evil@attacker.example>", 1))
		mustFail(t, tampered, b.dns(), "ARC-Message-Signature")
	})

	t.Run("prepended From", func(t *testing.T) {
		// The attack SignedValue exists to defeat: add a second From above the
		// signed one. The chain still passes — the signed From is untouched —
		// so a consumer reading the topmost From attributes it to the attacker.
		b := newChain(t)
		raw := b.valid(1)
		tampered := append([]byte("From: Evil <evil@attacker.example>\r\n"), raw...)
		got, err := Verify(context.Background(), tampered, b.dns())
		if err != nil {
			t.Fatal(err)
		}
		if got.Status != StatusPass {
			t.Fatalf("expected pass (the signed From is intact): %+v", got)
		}
		v, ok := got.SignedValue("from")
		if !ok {
			t.Fatal("From should be signed")
		}
		if strings.Contains(v, "attacker.example") {
			t.Fatalf("SignedValue returned the attacker's prepended From: %q", v)
		}
		if !strings.Contains(v, "alerts@bank.example") {
			t.Fatalf("SignedValue = %q, want the bottom-most signed From", v)
		}
	})

	t.Run("cv must be none at instance 1", func(t *testing.T) {
		b := newChain(t)
		b.seal(sealSpec{instance: 1, cv: "pass"})
		mustFail(t, b.build(), b.dns(), `cv="pass", want "none"`)
	})

	t.Run("seal signature", func(t *testing.T) {
		b := newChain(t)
		raw := b.valid(1)
		s := string(raw)
		i := strings.Index(s, "ARC-Seal:")
		j := strings.Index(s[i:], "b=") + i + 2
		tampered := []byte(s[:j] + flipB64(s[j:j+1]) + s[j+1:])
		mustFail(t, tampered, b.dns(), "ARC-Seal")
	})
}

func flipB64(s string) string {
	if s == "A" {
		return "B"
	}
	return "A"
}

// --- key record parsing ----------------------------------------------------

func TestKeyRecordFailures(t *testing.T) {
	b := newChain(t)
	raw := b.valid(1)

	der, err := x509.MarshalPKIXPublicKey(&b.key.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	good := base64.StdEncoding.EncodeToString(der)

	for name, rec := range map[string]string{
		"revoked":           "v=DKIM1; k=rsa; p=",
		"wrong version":     "v=DKIM2; k=rsa; p=" + good,
		"unknown key type":  "v=DKIM1; k=elgamal; p=" + good,
		"no p tag":          "v=DKIM1; k=rsa",
		"bad base64":        "v=DKIM1; k=rsa; p=!!!not base64!!!",
		"not a key at all":  "v=DKIM1; k=rsa; p=" + base64.StdEncoding.EncodeToString([]byte("nonsense")),
		"ed25519 too short": "v=DKIM1; k=ed25519; p=" + base64.StdEncoding.EncodeToString([]byte("short")),
	} {
		t.Run(name, func(t *testing.T) {
			mustFail(t, raw, b.dnsRecord(rec), "no usable public key")
		})
	}
}

func TestKeyRecordAcceptsPKCS1AndOmittedVersion(t *testing.T) {
	b := newChain(t)
	raw := b.valid(1)

	// RFC 6376 erratum 3017: RSA keys appear both as SubjectPublicKeyInfo and
	// as bare PKCS#1. Both must work, and v= is optional (Google's ARC key
	// records omit it entirely).
	pkcs1 := base64.StdEncoding.EncodeToString(x509.MarshalPKCS1PublicKey(&b.key.PublicKey))
	for name, rec := range map[string]string{
		"pkcs1":           "v=DKIM1; k=rsa; p=" + pkcs1,
		"pkcs1 no v=":     "k=rsa; p=" + pkcs1,
		"no v= and no k=": "p=" + pkcs1,
	} {
		t.Run(name, func(t *testing.T) {
			got, err := Verify(context.Background(), raw, b.dnsRecord(rec))
			if err != nil {
				t.Fatal(err)
			}
			if got.Status != StatusPass {
				t.Fatalf("Status = %q, want pass: %s", got.Status, got.Reason)
			}
		})
	}
}

func TestUnrelatedTXTRecordsAreSkipped(t *testing.T) {
	// A _domainkey name can carry records that are not key records at all.
	b := newChain(t)
	raw := b.valid(1)
	der, _ := x509.MarshalPKIXPublicKey(&b.key.PublicKey)
	lookup := func(context.Context, string) ([]string, error) {
		return []string{
			"v=spf1 include:example.com ~all",
			"some-unrelated-verification-token",
			"v=DKIM1; k=rsa; p=" + base64.StdEncoding.EncodeToString(der),
		}, nil
	}
	got, err := Verify(context.Background(), raw, lookup)
	if err != nil {
		t.Fatal(err)
	}
	if got.Status != StatusPass {
		t.Fatalf("Status = %q, want pass: %s", got.Status, got.Reason)
	}
}
