// Package arc verifies RFC 8617 Authenticated Received Chains.
//
// # Why this exists
//
// go-msgauth v0.7.0 — the library this repo already uses for DKIM — ships
// authres, dkim and dmarc packages and no ARC package. No other maintained Go
// implementation exists either, so the chain verifier lives here.
//
// # What ARC is for
//
// DKIM breaks when a message is forwarded through anything that touches it: a
// mailing list that appends a footer, a forwarder that rewrites MIME. ARC lets
// each hop record what it saw — "when this reached me, the bank's DKIM
// signature was valid" — and seal that record so a later hop can tell the
// difference between a genuine relay of a signed message and a forgery.
//
// A chain is a set of instances numbered 1..N. Each instance has three header
// fields:
//
//   - ARC-Authentication-Results (AAR): what that hop observed.
//   - ARC-Message-Signature (AMS): a DKIM signature over the message as that
//     hop received it.
//   - ARC-Seal (AS): a signature over every ARC header of every instance up to
//     and including this one, which is what makes the chain tamper-evident.
//
// # What Verify decides, and what it does not
//
// [Verify] reports whether the chain is cryptographically intact. It does not
// decide whether to trust what the chain says: a valid chain sealed by an
// attacker's domain is still a valid chain. Deciding that instance 1's AAR
// actually came from a forwarder worth believing is the caller's job, and the
// raw AAR values are carried out for exactly that purpose.
package arc

import (
	"context"
	"fmt"
	"sort"
	"strconv"
	"strings"
)

// Chain status values.
const (
	StatusPass = "pass"
	StatusFail = "fail"
	StatusNone = "none"
)

// maxInstances is the ceiling RFC 8617 section 5.1.2 puts on chain length.
const maxInstances = 50

// ChainResult is the outcome of verifying one message's chain.
type ChainResult struct {
	Status      string   // "pass" | "fail" | "none"
	Instances   int      // number of ARC sets found
	SealDomains []string // d= of each ARC-Seal, in instance order
	AARValues   []string // raw ARC-Authentication-Results value per instance
	// Reason explains a "fail". It is diagnostic text, never a trust input.
	Reason string
}

// instance is one ARC set.
type instance struct {
	n   int
	aar Field
	ams Field
	as  Field
}

// Verify checks a message's ARC chain against DNS-published keys.
//
// It returns an error only when the input is not a parseable message. Every
// chain-level problem — a missing instance, a bad signature, an unresolvable
// key — is reported as Status "fail" with a Reason, because "this chain does
// not verify" is an answer, not a failure to answer.
func Verify(ctx context.Context, raw []byte, lookupTXT LookupTXT) (ChainResult, error) {
	h, body, err := ReadHeader(raw)
	if err != nil {
		return ChainResult{Status: StatusFail, Reason: err.Error()}, err
	}

	aars := h.Get("ARC-Authentication-Results")
	amss := h.Get("ARC-Message-Signature")
	seals := h.Get("ARC-Seal")
	if len(aars) == 0 && len(amss) == 0 && len(seals) == 0 {
		return ChainResult{Status: StatusNone}, nil
	}

	insts, err := assemble(aars, amss, seals)
	if err != nil {
		// The count is still worth reporting even when the chain is malformed.
		return ChainResult{
			Status:    StatusFail,
			Instances: max(len(aars), len(amss), len(seals)),
			Reason:    err.Error(),
		}, nil
	}

	res := ChainResult{Instances: len(insts)}
	for _, in := range insts {
		res.SealDomains = append(res.SealDomains, ParseTags(in.as.Value)["d"])
		res.AARValues = append(res.AARValues, strings.TrimSpace(in.aar.Value))
	}

	fail := func(format string, args ...any) (ChainResult, error) {
		res.Status = StatusFail
		res.Reason = fmt.Sprintf(format, args...)
		return res, nil
	}

	// cv= is the chain's own claim about its history. Instance 1 saw no chain
	// before it; every later instance must have validated the one below it.
	for _, in := range insts {
		cv := ParseTags(in.as.Value)["cv"]
		want := "pass"
		if in.n == 1 {
			want = "none"
		}
		if cv != want {
			return fail("instance %d has cv=%q, want %q", in.n, cv, want)
		}
	}

	// Only the newest ARC-Message-Signature is checked. Earlier ones cover the
	// message as it was before later hops modified it, so they are expected to
	// fail and RFC 8617 section 5.2 does not check them.
	top := insts[len(insts)-1]
	amsSig, err := parseSig(top.ams)
	if err != nil {
		return fail("instance %d ARC-Message-Signature: %v", top.n, err)
	}
	if err := verifyMessageSignature(ctx, amsSig, h, body, lookupTXT); err != nil {
		return fail("instance %d ARC-Message-Signature: %v", top.n, err)
	}

	// Each seal covers every ARC header of every instance at or below it, in
	// instance order, AAR then AMS then AS. That cumulative coverage is what
	// stops a hop from deleting or reordering the instances beneath it.
	for i, in := range insts {
		sealSig, err := parseSig(in.as)
		if err != nil {
			return fail("instance %d ARC-Seal: %v", in.n, err)
		}
		var signed []Field
		for _, lower := range insts[:i+1] {
			signed = append(signed, lower.aar, lower.ams, lower.as)
		}
		// The seal being verified is the last field, and writeSelf re-adds it
		// with b= emptied.
		signed = signed[:len(signed)-1]
		if err := verifySeal(ctx, sealSig, signed, lookupTXT); err != nil {
			return fail("instance %d ARC-Seal: %v", in.n, err)
		}
	}

	res.Status = StatusPass
	return res, nil
}

// assemble groups ARC header fields into instances and rejects any chain that
// is not a complete, gapless 1..N.
//
// A chain with a hole in it is not a weaker chain, it is a forged one: the
// whole guarantee is that instance N's seal covers everything below it, and
// that guarantee is void the moment "everything below it" is negotiable.
func assemble(aars, amss, seals []Field) ([]instance, error) {
	byN := map[int]*instance{}
	add := func(f Field, kind string) error {
		n := tagInt(f, "i")
		if n < 1 || n > maxInstances {
			return fmt.Errorf("%s has i=%q, outside 1..%d", kind, ParseTags(f.Value)["i"], maxInstances)
		}
		in := byN[n]
		if in == nil {
			in = &instance{n: n}
			byN[n] = in
		}
		switch kind {
		case "ARC-Authentication-Results":
			if in.aar.Raw != "" {
				return fmt.Errorf("instance %d has two ARC-Authentication-Results", n)
			}
			in.aar = f
		case "ARC-Message-Signature":
			if in.ams.Raw != "" {
				return fmt.Errorf("instance %d has two ARC-Message-Signatures", n)
			}
			in.ams = f
		case "ARC-Seal":
			if in.as.Raw != "" {
				return fmt.Errorf("instance %d has two ARC-Seals", n)
			}
			in.as = f
		}
		return nil
	}
	for _, f := range aars {
		if err := add(f, "ARC-Authentication-Results"); err != nil {
			return nil, err
		}
	}
	for _, f := range amss {
		if err := add(f, "ARC-Message-Signature"); err != nil {
			return nil, err
		}
	}
	for _, f := range seals {
		if err := add(f, "ARC-Seal"); err != nil {
			return nil, err
		}
	}

	out := make([]instance, 0, len(byN))
	for _, in := range byN {
		out = append(out, *in)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].n < out[j].n })
	for i, in := range out {
		if in.n != i+1 {
			return nil, fmt.Errorf("instance numbers are not 1..%d (found %d at position %d)", len(out), in.n, i+1)
		}
		if in.aar.Raw == "" || in.ams.Raw == "" || in.as.Raw == "" {
			return nil, fmt.Errorf("instance %d is incomplete (aar=%v ams=%v seal=%v)",
				in.n, in.aar.Raw != "", in.ams.Raw != "", in.as.Raw != "")
		}
	}
	return out, nil
}

func tagInt(f Field, tag string) int {
	n, err := strconv.Atoi(ParseTags(f.Value)[tag])
	if err != nil {
		return -1
	}
	return n
}
