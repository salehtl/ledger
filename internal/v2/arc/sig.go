package arc

import (
	"bytes"
	"context"
	"crypto"
	"crypto/ed25519"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"errors"
	"fmt"
	"hash"
	"strings"
)

// LookupTXT resolves DNS TXT records. Tests inject a map recorded at fixture
// extraction time; production injects a real resolver.
type LookupTXT func(ctx context.Context, name string) ([]string, error)

var (
	// ErrNoKey means the key record could not be found or parsed.
	ErrNoKey = errors.New("arc: no usable public key")
	// ErrBadSignature means the cryptographic check failed.
	ErrBadSignature = errors.New("arc: signature does not verify")
)

// sigParams is a parsed DKIM-shaped signature: a DKIM-Signature, an
// ARC-Message-Signature or an ARC-Seal. They share a tag grammar and a signing
// procedure; they differ in which headers they cover and whether a body hash
// is involved at all.
type sigParams struct {
	field    Field
	tags     map[string]string
	algo     string // a=
	domain   string // d=
	selector string // s=
	headers  []string
	headCan  Canonicalization
	bodyCan  Canonicalization
	bodyHash []byte // bh=, absent from an ARC-Seal
	sig      []byte // b=
	// isSeal selects the ARC-Seal rules: a fixed header list, always-relaxed
	// canonicalization, and no body hash.
	isSeal bool
}

func parseSig(f Field) (*sigParams, error) {
	t := ParseTags(f.Value)
	p := &sigParams{
		field:    f,
		tags:     t,
		algo:     t["a"],
		domain:   t["d"],
		selector: t["s"],
		headCan:  Simple,
		bodyCan:  Simple,
	}
	if p.algo == "" || p.domain == "" || p.selector == "" || t["b"] == "" {
		return nil, fmt.Errorf("arc: %s missing a required tag", strings.TrimSpace(f.Name))
	}
	if p.algo != "rsa-sha256" && p.algo != "ed25519-sha256" {
		// rsa-sha1 is deprecated and never appears in the corpus. Refusing it
		// outright is safer than quietly accepting a weak hash.
		return nil, fmt.Errorf("arc: unsupported algorithm %q", p.algo)
	}
	if c, ok := t["c"]; ok {
		head, body, _ := strings.Cut(c, "/")
		p.headCan = canonOrDefault(head, Simple)
		p.bodyCan = canonOrDefault(body, Simple)
	}
	if h, ok := t["h"]; ok {
		for _, n := range strings.Split(h, ":") {
			if n = strings.TrimSpace(n); n != "" {
				p.headers = append(p.headers, n)
			}
		}
	}
	if bh, ok := t["bh"]; ok {
		b, err := base64.StdEncoding.DecodeString(bh)
		if err != nil {
			return nil, fmt.Errorf("arc: bad bh=: %w", err)
		}
		p.bodyHash = b
	}
	b, err := base64.StdEncoding.DecodeString(t["b"])
	if err != nil {
		return nil, fmt.Errorf("arc: bad b=: %w", err)
	}
	p.sig = b
	// l= truncates the signed body. No corpus message uses it, and honouring it
	// would let an attacker append arbitrary content below a valid signature,
	// so it is refused rather than ignored.
	if _, ok := t["l"]; ok {
		return nil, errors.New("arc: l= body-length tag is not supported")
	}
	return p, nil
}

func canonOrDefault(s string, def Canonicalization) Canonicalization {
	switch Canonicalization(strings.TrimSpace(s)) {
	case Relaxed:
		return Relaxed
	case Simple:
		return Simple
	}
	return def
}

// verifyMessageSignature checks a DKIM-style signature that covers the body:
// a DKIM-Signature or an ARC-Message-Signature.
func verifyMessageSignature(ctx context.Context, p *sigParams, h Header, body []byte, lookup LookupTXT) error {
	if p.bodyHash == nil {
		return errors.New("arc: message signature has no bh= tag")
	}
	sum := sha256.Sum256(CanonBody(p.bodyCan, body))
	if !bytes.Equal(sum[:], p.bodyHash) {
		return fmt.Errorf("%w: body hash mismatch", ErrBadSignature)
	}

	hasher := sha256.New()
	picker := NewPicker(h)
	for _, name := range p.headers {
		f, ok := picker.Pick(name)
		if !ok {
			// RFC 6376 3.7: a listed field that is not present contributes
			// nothing at all, not even its name.
			continue
		}
		hasher.Write([]byte(CanonHeader(p.headCan, f)))
	}
	writeSelf(hasher, p)
	return verifyWithDNSKey(ctx, p, hasher, lookup)
}

// verifySeal checks an ARC-Seal, which covers a fixed list of header fields and
// no body at all (RFC 8617 section 5.1.1).
func verifySeal(ctx context.Context, p *sigParams, signed []Field, lookup LookupTXT) error {
	p.isSeal = true
	if p.bodyHash != nil {
		return errors.New("arc: ARC-Seal must not carry a bh= tag")
	}
	if _, ok := p.tags["h"]; ok {
		// RFC 8617 4.1.3: an h= tag on a seal is a protocol error. Accepting
		// one would let a forwarder choose what its seal covers.
		return errors.New("arc: ARC-Seal must not carry an h= tag")
	}
	hasher := sha256.New()
	for _, f := range signed {
		// Seals always use relaxed header canonicalization; there is no c= tag
		// to negotiate it.
		hasher.Write([]byte(CanonHeader(Relaxed, f)))
	}
	writeSelf(hasher, p)
	return verifyWithDNSKey(ctx, p, hasher, lookup)
}

// writeSelf appends the signature's own header field to the hash with its b=
// value emptied and its trailing CRLF removed (RFC 6376 section 3.7).
func writeSelf(hasher hash.Hash, p *sigParams) {
	self := p.field
	self.Value = BlankTag(self.Value, "b")
	self.Raw = self.Name + ":" + self.Value + crlf
	// A seal is always canonicalized relaxed; a message signature follows c=.
	can := p.headCan
	if p.isSeal {
		can = Relaxed
	}
	canon := CanonHeader(can, self)
	hasher.Write([]byte(strings.TrimSuffix(canon, crlf)))
}

func verifyWithDNSKey(ctx context.Context, p *sigParams, hasher hash.Hash, lookup LookupTXT) error {
	pub, err := fetchKey(ctx, p.selector, p.domain, lookup)
	if err != nil {
		return err
	}
	digest := hasher.Sum(nil)
	switch k := pub.(type) {
	case *rsa.PublicKey:
		if p.algo != "rsa-sha256" {
			return fmt.Errorf("%w: %s signature against an RSA key", ErrBadSignature, p.algo)
		}
		if err := rsa.VerifyPKCS1v15(k, crypto.SHA256, digest, p.sig); err != nil {
			return fmt.Errorf("%w: %v", ErrBadSignature, err)
		}
	case ed25519.PublicKey:
		if p.algo != "ed25519-sha256" {
			return fmt.Errorf("%w: %s signature against an Ed25519 key", ErrBadSignature, p.algo)
		}
		if !ed25519.Verify(k, digest, p.sig) {
			return ErrBadSignature
		}
	default:
		return fmt.Errorf("%w: unsupported key type %T", ErrNoKey, pub)
	}
	return nil
}

// fetchKey resolves and parses <selector>._domainkey.<domain>.
func fetchKey(ctx context.Context, selector, domain string, lookup LookupTXT) (crypto.PublicKey, error) {
	name := selector + "._domainkey." + domain
	recs, err := lookup(ctx, name)
	if err != nil {
		return nil, fmt.Errorf("%w: %s: %v", ErrNoKey, name, err)
	}
	var firstErr error
	for _, rec := range recs {
		if !strings.Contains(rec, "p=") {
			// Domains publish unrelated TXT records under the same name.
			continue
		}
		pub, err := parseKeyRecord(rec)
		if err != nil {
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		return pub, nil
	}
	if firstErr != nil {
		return nil, fmt.Errorf("%w: %s: %v", ErrNoKey, name, firstErr)
	}
	return nil, fmt.Errorf("%w: %s", ErrNoKey, name)
}

// parseKeyRecord parses a DKIM key record (RFC 6376 section 3.6.1).
func parseKeyRecord(rec string) (crypto.PublicKey, error) {
	t := ParseTags(rec)
	if v, ok := t["v"]; ok && v != "DKIM1" {
		return nil, fmt.Errorf("unsupported key version %q", v)
	}
	p, ok := t["p"]
	if !ok {
		return nil, errors.New("key record has no p= tag")
	}
	if p == "" {
		return nil, errors.New("key revoked")
	}
	der, err := base64.StdEncoding.DecodeString(p)
	if err != nil {
		return nil, fmt.Errorf("bad p=: %w", err)
	}
	switch t["k"] {
	case "", "rsa":
		if pub, err := x509.ParsePKIXPublicKey(der); err == nil {
			rp, ok := pub.(*rsa.PublicKey)
			if !ok {
				return nil, fmt.Errorf("key is %T, not RSA", pub)
			}
			return rp, nil
		}
		// RFC 6376 is inconsistent about SubjectPublicKeyInfo vs RSAPublicKey;
		// erratum 3017 says accept both.
		rp, err := x509.ParsePKCS1PublicKey(der)
		if err != nil {
			return nil, fmt.Errorf("bad RSA key: %w", err)
		}
		return rp, nil
	case "ed25519":
		if len(der) != ed25519.PublicKeySize {
			return nil, fmt.Errorf("Ed25519 key is %d bytes, want %d", len(der), ed25519.PublicKeySize)
		}
		return ed25519.PublicKey(der), nil
	default:
		return nil, fmt.Errorf("unsupported key type %q", t["k"])
	}
}
