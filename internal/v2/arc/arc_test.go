package arc

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/mail"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/emersion/go-msgauth/authres"
	"github.com/emersion/go-msgauth/dkim"
)

const testdata = "../origin/testdata"

func mustRead(t *testing.T, name string) []byte {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(testdata, name))
	if err != nil {
		t.Fatalf("fixture %s: %v (regenerate with internal/v2/corpus/cmd/extract-fixtures)", name, err)
	}
	return b
}

// staticTXT serves the DNS answers recorded at fixture-extraction time. No test
// in this package touches the network: DKIM and ARC keys get rotated (DIB
// retired selector1 mid-corpus) and a test that depends on a live resolver is a
// test that fails on a plane.
func staticTXT(t *testing.T) LookupTXT {
	t.Helper()
	b := mustRead(t, "dns.json")
	var recs map[string][]string
	if err := json.Unmarshal(b, &recs); err != nil {
		t.Fatal(err)
	}
	return func(_ context.Context, name string) ([]string, error) {
		v, ok := recs[name]
		if !ok {
			return nil, ErrNoKey
		}
		return v, nil
	}
}

type manifestEntry struct {
	File           string   `json:"file"`
	Kind           string   `json:"kind"`
	DKIMDomain     string   `json:"dkim_d"`
	DKIMSelector   string   `json:"dkim_selector"`
	DKIMKeyInDNS   bool     `json:"dkim_key_in_dns"`
	DKIMVerifies   bool     `json:"dkim_verifies"`
	HasXTag        bool     `json:"has_x_tag"`
	XExpiresAt     string   `json:"x_expires_at"`
	ARCInstances   int      `json:"arc_instances"`
	ARCSealDomains []string `json:"arc_seal_domains"`
}

func loadManifest(t *testing.T) []manifestEntry {
	t.Helper()
	var m struct {
		Fixtures []manifestEntry `json:"fixtures"`
	}
	if err := json.Unmarshal(mustRead(t, "manifest.json"), &m); err != nil {
		t.Fatal(err)
	}
	if len(m.Fixtures) == 0 {
		t.Fatal("manifest.json lists no fixtures")
	}
	return m.Fixtures
}

func TestVerifyRealGmailForwardedARCChain(t *testing.T) {
	raw := mustRead(t, "gmail-forward-1.eml")
	got, err := Verify(context.Background(), raw, staticTXT(t))
	if err != nil {
		t.Fatal(err)
	}
	if got.Status != "pass" || got.Instances < 2 {
		t.Fatalf("%+v", got)
	}
	if len(got.SealDomains) != 2 || got.SealDomains[0] != "icloud.com" || got.SealDomains[1] != "google.com" {
		t.Fatalf("SealDomains = %v, want [icloud.com google.com]", got.SealDomains)
	}
	// Instance 1's AAR is what a later task reads to decide whether the
	// forwarder saw a valid bank signature. Carry it out verbatim.
	if len(got.AARValues) != 2 {
		t.Fatalf("AARValues = %d entries, want 2", len(got.AARValues))
	}
	if !strings.Contains(got.AARValues[0], "dkim=pass") || !strings.Contains(got.AARValues[0], "dib.ae") {
		t.Fatalf("instance 1 AAR does not carry the bank's dkim result: %q", got.AARValues[0])
	}
}

func TestVerifyEveryARCFixture(t *testing.T) {
	lookup := staticTXT(t)
	for _, e := range loadManifest(t) {
		if e.ARCInstances == 0 {
			continue
		}
		t.Run(e.File, func(t *testing.T) {
			got, err := Verify(context.Background(), mustRead(t, e.File), lookup)
			if err != nil {
				t.Fatal(err)
			}
			if got.Status != "pass" {
				t.Fatalf("Status = %q, want pass: %+v", got.Status, got)
			}
			if got.Instances != e.ARCInstances {
				t.Fatalf("Instances = %d, want %d", got.Instances, e.ARCInstances)
			}
		})
	}
}

func TestTamperedBodyBreaksTheAMS(t *testing.T) {
	raw := mustRead(t, "gmail-forward-1.eml")
	i := bytes.Index(raw, []byte("\r\n\r\n"))
	if i < 0 {
		t.Fatal("fixture has no body")
	}
	tampered := append([]byte(nil), raw...)
	// Flip one body byte. The highest-instance AMS covers the body hash, so
	// this alone must fail the chain.
	for j := i + 4; j < len(tampered); j++ {
		if tampered[j] >= 'a' && tampered[j] <= 'y' {
			tampered[j]++
			break
		}
	}
	if bytes.Equal(tampered, raw) {
		t.Fatal("failed to tamper with the body")
	}
	got, err := Verify(context.Background(), tampered, staticTXT(t))
	if err != nil {
		t.Fatal(err)
	}
	if got.Status != "fail" {
		t.Fatalf("Status = %q, want fail: %+v", got.Status, got)
	}
	if !strings.Contains(got.Reason, "body hash mismatch") {
		t.Fatalf("Reason = %q, want a body-hash failure", got.Reason)
	}
}

func TestRemovedInstanceBreaksTheChain(t *testing.T) {
	raw := mustRead(t, "gmail-forward-1.eml")
	stripped := dropField(t, raw, "ARC-Seal", 1)
	got, err := Verify(context.Background(), stripped, staticTXT(t))
	if err != nil {
		t.Fatal(err)
	}
	if got.Status != "fail" {
		t.Fatalf("Status = %q, want fail (instance 1 has no seal): %+v", got.Status, got)
	}
	if !strings.Contains(got.Reason, "incomplete") {
		t.Fatalf("Reason = %q, want the incomplete-instance rejection", got.Reason)
	}
}

func TestForgedAARIsNotTrusted(t *testing.T) {
	raw := mustRead(t, "gmail-forward-1.eml")
	// Rewrite instance 1's ARC-Authentication-Results to claim a result it
	// never asserted, leaving every seal byte-for-byte intact. The seals sign
	// the AAR, so the chain must fail rather than report the forged claim.
	forged := replaceField(t, raw, "ARC-Authentication-Results", 1,
		"ARC-Authentication-Results: i=1; arc.icloud.com; arc=none; dmarc=pass header.from=dib.ae; dkim=pass header.d=dib.ae header.i=@attacker.example\r\n")
	if bytes.Equal(forged, raw) {
		t.Fatal("failed to forge the AAR")
	}
	got, err := Verify(context.Background(), forged, staticTXT(t))
	if err != nil {
		t.Fatal(err)
	}
	if got.Status != "fail" {
		t.Fatalf("Status = %q, want fail: %+v", got.Status, got)
	}
	// The seal signature must be what catches this. If it failed on structure
	// instead, the test would pass while proving nothing about the seals.
	if !strings.Contains(got.Reason, "ARC-Seal") || !strings.Contains(got.Reason, "does not verify") {
		t.Fatalf("Reason = %q, want an ARC-Seal signature failure", got.Reason)
	}
}

func TestTamperedLowerAMSBreaksTheSeals(t *testing.T) {
	// Instance 1's AMS is deliberately never verified directly — RFC 8617 only
	// checks the newest one, because earlier signatures cover the message as it
	// was before later hops touched it. The seals are what protect it. Mutating
	// it is therefore the sharpest test of seal verification: nothing else in
	// the implementation looks at these bytes.
	raw := mustRead(t, "gmail-forward-1.eml")
	forged := mutateTag(t, raw, "ARC-Message-Signature", 1, "b")
	got, err := Verify(context.Background(), forged, staticTXT(t))
	if err != nil {
		t.Fatal(err)
	}
	if got.Status != "fail" {
		t.Fatalf("Status = %q, want fail: %+v", got.Status, got)
	}
	if !strings.Contains(got.Reason, "ARC-Seal") || !strings.Contains(got.Reason, "does not verify") {
		t.Fatalf("Reason = %q, want an ARC-Seal signature failure", got.Reason)
	}
}

func TestTamperedSealSignatureBreaksTheChain(t *testing.T) {
	raw := mustRead(t, "gmail-forward-1.eml")
	for _, instance := range []int{1, 2} {
		forged := mutateTag(t, raw, "ARC-Seal", instance, "b")
		got, err := Verify(context.Background(), forged, staticTXT(t))
		if err != nil {
			t.Fatal(err)
		}
		if got.Status != "fail" || !strings.Contains(got.Reason, "ARC-Seal") {
			t.Fatalf("instance %d: %+v, want an ARC-Seal failure", instance, got)
		}
	}
}

func TestFlippedCVIsRejected(t *testing.T) {
	raw := mustRead(t, "gmail-forward-1.eml")
	// cv= is the claim a relay would have to lie about to pass off a broken
	// upstream chain as intact. The structural rule catches it before any
	// signature is checked, which is the cheaper and stricter order.
	forged := bytes.Replace(raw, []byte("cv=none;"), []byte("cv=pass;"), 1)
	if bytes.Equal(forged, raw) {
		t.Fatal("fixture has no cv=none seal to flip")
	}
	// Assert the substring landed on instance 1's seal and nothing else. A
	// bare bytes.Replace is exactly the class of matcher that silently edited
	// the wrong header earlier in this file's history.
	assertOnlyFieldChanged(t, raw, forged, "ARC-Seal", 1)
	got, err := Verify(context.Background(), forged, staticTXT(t))
	if err != nil {
		t.Fatal(err)
	}
	if got.Status != "fail" || !strings.Contains(got.Reason, "cv=") {
		t.Fatalf("%+v, want a cv= rejection", got)
	}
}

func TestNoARCHeadersIsNone(t *testing.T) {
	raw := mustRead(t, "dib-dkim-unexpired.eml")
	got, err := Verify(context.Background(), raw, staticTXT(t))
	if err != nil {
		t.Fatal(err)
	}
	if got.Status != "none" || got.Instances != 0 {
		t.Fatalf("%+v, want status none / 0 instances", got)
	}
}

func TestUnknownKeyDoesNotPass(t *testing.T) {
	raw := mustRead(t, "gmail-forward-1.eml")
	empty := func(context.Context, string) ([]string, error) { return nil, ErrNoKey }
	got, err := Verify(context.Background(), raw, empty)
	if err != nil {
		t.Fatal(err)
	}
	if got.Status == "pass" {
		t.Fatalf("chain passed with no keys available: %+v", got)
	}
	if !strings.Contains(got.Reason, "no usable public key") {
		t.Fatalf("Reason = %q, want a key-lookup failure", got.Reason)
	}
}

func TestARCFixturesCarryNoExpiryTag(t *testing.T) {
	// The whole point of the ARC fixtures is that they cannot rot: no
	// ARC-Message-Signature in the corpus carries an x= tag, so these files
	// verify identically in ten years. This guards that claim.
	var arcFixtures int
	for _, e := range loadManifest(t) {
		if e.ARCInstances == 0 {
			continue
		}
		arcFixtures++
		raw := mustRead(t, e.File)
		h, _, err := ReadHeader(raw)
		if err != nil {
			t.Fatalf("%s: %v", e.File, err)
		}
		amss := h.Get("ARC-Message-Signature")
		if len(amss) != e.ARCInstances {
			t.Fatalf("%s: %d AMS headers, manifest says %d instances", e.File, len(amss), e.ARCInstances)
		}
		for _, f := range amss {
			if x, ok := ParseTags(f.Value)["x"]; ok {
				t.Fatalf("%s: an ARC-Message-Signature carries x=%s, so this fixture will expire", e.File, x)
			}
		}
		for _, f := range h.Get("ARC-Seal") {
			if x, ok := ParseTags(f.Value)["x"]; ok {
				t.Fatalf("%s: an ARC-Seal carries x=%s, so this fixture will expire", e.File, x)
			}
		}
	}
	if arcFixtures < 4 {
		t.Fatalf("only %d ARC fixtures in the manifest, want at least 4", arcFixtures)
	}
}

// dropField removes the ARC header field of the given name and instance.
func dropField(t *testing.T, raw []byte, name string, instance int) []byte {
	t.Helper()
	return rewriteField(t, raw, name, instance, "")
}

// replaceField swaps that field for repl, which must carry its own CRLF.
//
// Matching is on the parsed i= tag, never on a substring: an instance-2 AAR
// routinely contains the text "i=1" inside its arc=pass comment, and a
// substring match silently edits the wrong header — producing a test that goes
// red for a reason it was not written to test.
func replaceField(t *testing.T, raw []byte, name string, instance int, repl string) []byte {
	t.Helper()
	return rewriteField(t, raw, name, instance, repl)
}

func rewriteField(t *testing.T, raw []byte, name string, instance int, repl string) []byte {
	t.Helper()
	h, body, err := ReadHeader(raw)
	if err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	done := false
	for _, f := range h {
		if !done && strings.EqualFold(strings.TrimSpace(f.Name), name) &&
			ParseTags(f.Value)["i"] == strconv.Itoa(instance) {
			done = true
			out.WriteString(repl)
			continue
		}
		out.WriteString(f.Raw)
	}
	if !done {
		t.Fatalf("no %s field with i=%d", name, instance)
	}
	out.WriteString("\r\n")
	out.Write(body)
	return out.Bytes()
}

// mutateTag flips one base64 character of the named tag in an ARC header field,
// leaving the message otherwise byte-identical.
func mutateTag(t *testing.T, raw []byte, name string, instance int, tag string) []byte {
	t.Helper()
	h, _, err := ReadHeader(raw)
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range h {
		if !strings.EqualFold(strings.TrimSpace(f.Name), name) ||
			ParseTags(f.Value)["i"] != strconv.Itoa(instance) {
			continue
		}
		val := ParseTags(f.Value)[tag]
		if len(val) < 4 {
			t.Fatalf("%s i=%d has no %s= to mutate", name, instance, tag)
		}
		// The value is folded in the raw header, so mutate a prefix that is
		// guaranteed to sit on one line.
		old := val[:8]
		var flipped string
		if old[7] == 'A' {
			flipped = old[:7] + "B"
		} else {
			flipped = old[:7] + "A"
		}
		out := bytes.Replace(raw, []byte(old), []byte(flipped), 1)
		if bytes.Equal(out, raw) {
			t.Fatalf("could not find %q in the raw message to mutate", old)
		}
		// "Something changed" is not good enough: an 8-character base64 prefix
		// could occur in another field. Require that the intended field, and
		// only the intended field, differs.
		assertOnlyFieldChanged(t, raw, out, name, instance)
		return out
	}
	t.Fatalf("no %s field with i=%d", name, instance)
	return nil
}

// TestFixtureDKIMStillVerifies is the canary the fixture set needs.
//
// A DKIM fixture can rot in three ways that no amount of care in this package
// prevents: the signature's x= tag passes, the selector leaves DNS, or — the
// quiet one — the key behind an unchanged selector is rotated. dns.json pins
// the key bytes, so rotation and retirement cannot reach a committed fixture;
// expiry still can, because a verifier checks it against the wall clock.
//
// It verifies through go-msgauth, the library the rest of the codebase uses for
// DKIM, rather than through this package's internals. That is deliberate: what
// matters is that the fixtures work for their consumers, not that they work for
// the code that produced them.
func TestFixtureDKIMStillVerifies(t *testing.T) {
	var recs map[string][]string
	if err := json.Unmarshal(mustRead(t, "dns.json"), &recs); err != nil {
		t.Fatal(err)
	}
	lookup := func(name string) ([]string, error) {
		v, ok := recs[name]
		if !ok {
			return nil, fmt.Errorf("no recorded TXT for %s", name)
		}
		return v, nil
	}

	for _, e := range loadManifest(t) {
		if !e.DKIMVerifies {
			continue // the manifest never claimed this one verifies
		}
		t.Run(e.File, func(t *testing.T) {
			vs, err := dkim.VerifyWithOptions(bytes.NewReader(mustRead(t, e.File)),
				&dkim.VerifyOptions{LookupTXT: lookup})
			if err != nil {
				t.Fatal(err)
			}
			for _, v := range vs {
				if !strings.EqualFold(v.Domain, e.DKIMDomain) {
					continue
				}
				if v.Err == nil {
					return
				}
				if e.HasXTag {
					t.Fatalf("%s no longer verifies: %v\n"+
						"The manifest says this signature expires at %s. If that date has passed, "+
						"regenerate the fixtures: LEDGER_CORPUS_DB=... go run ./internal/v2/corpus/cmd/extract-fixtures",
						e.File, v.Err, e.XExpiresAt)
				}
				t.Fatalf("%s no longer verifies: %v (no x= tag, so this is not expiry — "+
					"suspect a bad dns.json or an edited fixture)", e.File, v.Err)
			}
			t.Fatalf("%s: no DKIM signature for %s", e.File, e.DKIMDomain)
		})
	}
}

// TestAARValuesParseWithAuthres proves the values Verify hands out are usable
// by the consumer that will read them.
//
// AARValues carries the ARC-Authentication-Results verbatim rather than
// pre-parsed, because this package deliberately makes no trust decision and
// discarding detail would pre-empt one. That only helps Task 26 if the value
// can actually be parsed — and an AAR is not quite an Authentication-Results:
// RFC 8617 4.1.1 prefixes it with the instance tag, which go-msgauth's authres
// does not expect. This pins both facts: the leading "i=N;" must be stripped,
// and what remains parses.
func TestAARValuesParseWithAuthres(t *testing.T) {
	got, err := Verify(context.Background(), mustRead(t, "gmail-forward-1.eml"), staticTXT(t))
	if err != nil {
		t.Fatal(err)
	}
	if got.Status != StatusPass {
		t.Fatalf("fixture chain did not pass: %+v", got)
	}

	for i, v := range got.AARValues {
		_, rest, ok := strings.Cut(v, ";")
		if !ok {
			t.Fatalf("instance %d AAR has no instance tag: %q", i+1, v)
		}
		identifier, results, err := authres.Parse(rest)
		if err != nil {
			t.Fatalf("instance %d AAR does not parse: %v\nvalue: %q", i+1, err, rest)
		}
		if identifier == "" {
			t.Fatalf("instance %d AAR has no authserv-id", i+1)
		}
		var sawDKIMPass bool
		for _, r := range results {
			d, ok := r.(*authres.DKIMResult)
			if ok && d.Value == authres.ResultPass {
				sawDKIMPass = true
			}
		}
		if !sawDKIMPass {
			t.Fatalf("instance %d AAR (%s) carries no dkim=pass result", i+1, identifier)
		}
	}
}

// TestBareLFInHeaderIsRejected pins the fix for a confused-deputy bug.
//
// Before the fix this exact input verified as a clean two-instance chain with
// instance 1's AAR intact, while net/mail read a completely different document
// out of the same bytes: one header field, no From, no Subject, and a body
// beginning with the whole real message. A caller would have authenticated one
// document and acted on another.
func TestBareLFInHeaderIsRejected(t *testing.T) {
	raw := mustRead(t, "gmail-forward-1.eml")

	// Establish the premise: unmodified, this fixture passes.
	base, err := Verify(context.Background(), raw, staticTXT(t))
	if err != nil || base.Status != StatusPass {
		t.Fatalf("fixture should pass unmodified: %+v %v", base, err)
	}

	poisoned := append([]byte("X-Junk: a\n\nX-Junk2: b\r\n"), raw...)

	// Show that a mainstream parser really is fooled, so this test keeps
	// meaning something if ReadHeader is ever loosened.
	m, err := mail.ReadMessage(bytes.NewReader(poisoned))
	if err != nil {
		t.Fatalf("net/mail could not read the poisoned message at all: %v", err)
	}
	if m.Header.Get("From") != "" || m.Header.Get("Subject") != "" {
		t.Fatal("premise broken: net/mail no longer misreads this input, so the test proves nothing")
	}

	got, err := Verify(context.Background(), poisoned, staticTXT(t))
	if !errors.Is(err, ErrBareLF) {
		t.Fatalf("err = %v, want ErrBareLF", err)
	}
	if got.Status == StatusPass {
		t.Fatalf("a message net/mail reads as a different document verified: %+v", got)
	}
}

func TestBareLFVariants(t *testing.T) {
	raw := mustRead(t, "gmail-forward-1.eml")
	for name, prefix := range map[string]string{
		"lone LF between fields": "X-Junk: a\nX-Junk2: b\r\n",
		"LF LF header break":     "X-Junk: a\n\nX-Junk2: b\r\n",
		"LF inside a value":      "X-Junk: a\nb\r\n",
	} {
		t.Run(name, func(t *testing.T) {
			_, err := Verify(context.Background(), append([]byte(prefix), raw...), staticTXT(t))
			if !errors.Is(err, ErrBareLF) {
				t.Fatalf("err = %v, want ErrBareLF", err)
			}
		})
	}
	// A bare LF in the BODY is not a parser-differential problem — the header
	// block is already delimited — and real MIME bodies contain them, so it
	// must not be rejected.
	t.Run("body LF is fine", func(t *testing.T) {
		h, body, err := ReadHeader([]byte("From: a@b\r\nSubject: x\r\n\r\nline1\nline2\n"))
		if err != nil {
			t.Fatal(err)
		}
		if len(h) != 2 || string(body) != "line1\nline2\n" {
			t.Fatalf("h=%d body=%q", len(h), body)
		}
	})
}

// assertOnlyFieldChanged requires that before and after differ in exactly one
// header field, and that it is the field with the given name and i= instance.
//
// Mutation helpers that match on a substring are how two tests in this file
// once passed for the wrong reason. Every mutation now proves where it landed.
func assertOnlyFieldChanged(t *testing.T, before, after []byte, name string, instance int) {
	t.Helper()
	if err := onlyFieldChanged(before, after, name, instance); err != nil {
		t.Fatal(err)
	}
}

// onlyFieldChanged is the checkable core of assertOnlyFieldChanged. It returns
// an error rather than calling t.Fatal so that TestMutationAssertionIsNotVacuous
// can verify it actually rejects what it claims to.
func onlyFieldChanged(before, after []byte, name string, instance int) error {
	bh, bbody, err := ReadHeader(before)
	if err != nil {
		return err
	}
	ah, abody, err := ReadHeader(after)
	if err != nil {
		return err
	}
	if !bytes.Equal(bbody, abody) {
		return errors.New("mutation changed the body, not just a header field")
	}
	if len(bh) != len(ah) {
		return fmt.Errorf("mutation changed the field count: %d -> %d", len(bh), len(ah))
	}
	var changed []int
	for i := range bh {
		if bh[i].Raw != ah[i].Raw {
			changed = append(changed, i)
		}
	}
	if len(changed) != 1 {
		return fmt.Errorf("mutation changed %d header fields, want exactly 1", len(changed))
	}
	got := bh[changed[0]]
	if !strings.EqualFold(strings.TrimSpace(got.Name), name) {
		return fmt.Errorf("mutation landed on %q, want %q", strings.TrimSpace(got.Name), name)
	}
	if i := ParseTags(got.Value)["i"]; i != strconv.Itoa(instance) {
		return fmt.Errorf("mutation landed on %s i=%s, want i=%d", name, i, instance)
	}
	return nil
}

// TestMutationAssertionIsNotVacuous checks the checker. A mutation assertion
// that never rejects anything gives exactly the false confidence it was added
// to remove.
func TestMutationAssertionIsNotVacuous(t *testing.T) {
	raw := mustRead(t, "gmail-forward-1.eml")

	for name, mutated := range map[string][]byte{
		"landed on the wrong field": bytes.Replace(raw, []byte("Delivered-To:"), []byte("Xelivered-To:"), 1),
		"landed on two fields": bytes.Replace(
			bytes.Replace(raw, []byte("Delivered-To:"), []byte("Xelivered-To:"), 1),
			[]byte("Return-Path:"), []byte("Xeturn-Path:"), 1),
		"changed the body": append(append([]byte{}, raw...), []byte("extra\r\n")...),
		"changed nothing":  append([]byte{}, raw...),
	} {
		t.Run(name, func(t *testing.T) {
			if err := onlyFieldChanged(raw, mutated, "ARC-Seal", 1); err == nil {
				t.Fatal("accepted a mutation it should have rejected")
			}
		})
	}

	t.Run("accepts a correctly-landed mutation", func(t *testing.T) {
		good := mutateTag(t, raw, "ARC-Seal", 1, "b")
		if err := onlyFieldChanged(raw, good, "ARC-Seal", 1); err != nil {
			t.Fatalf("rejected a correctly-landed mutation: %v", err)
		}
	})
}
