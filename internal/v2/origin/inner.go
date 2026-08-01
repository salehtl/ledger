package origin

import (
	"context"
	"fmt"
	"net/mail"
	"regexp"
	"strconv"
	"strings"

	"github.com/emersion/go-msgauth/authres"

	"ledger/internal/v2/arc"
)

// How an inner origin was proved. These are the only two values [Origin]
// .AttestedBy ever takes, and both name a cryptographic check.
const (
	// AttestedByDKIM means the bank's own DKIM signature survived the forward
	// and still verifies over the message as we received it.
	AttestedByDKIM = "direct_dkim"
	// AttestedByARC means the bank's signature did not survive, but a complete
	// RFC 8617 chain — sealed at every hop by a domain on [TrustedSealers] —
	// records that the first hop saw one.
	AttestedByARC = "arc"
)

// Origin is everything this layer is willing to say about where a message came
// from. Every field is either derived from a signature that verified or marked
// as unverified; there is no third category.
type Origin struct {
	// Outer is the verified signing domain of the message AS WE RECEIVED IT —
	// the last hop, which for forwarded mail is the forwarder and not the bank.
	//
	// When nothing signed the message as delivered, it is the envelope domain
	// prefixed with diag.UnverifiedPrefix, or "" when there is no envelope
	// domain either. The prefix is load-bearing: it is what stops an envelope
	// claim from being compared against an allowlist as though it were evidence
	// (see [Decide]).
	Outer string

	// Inner is the bank's domain behind a forwarder. It is set ONLY when
	// Attested, and it is always a bounded hostname, because it is written to
	// parse_diagnostics.inner_origin_domain whose CHECK constraint enforces
	// exactly that.
	Inner string

	// InnerFrom is the original From address — the addr-spec only, never a
	// display name — as covered by the signature that attested Inner. Set only
	// when Attested.
	InnerFrom string

	// Attested is true if and only if Inner rests on a verification this
	// process performed. It is never true because a header said so.
	Attested bool

	// AttestedBy is [AttestedByDKIM], [AttestedByARC], or "".
	AttestedBy string

	// DKIM and ARC are the two message-level verdicts, stored verbatim in
	// parse_diagnostics. ARC is never SigTempFail: that column's CHECK admits
	// only pass, fail and none.
	DKIM, ARC SigResult

	// Reason explains why no inner origin was attested, or why the outer origin
	// is unverified. It is diagnostic text — bounded, control-character free,
	// and NEVER a trust input or a value for a closed-enum column. Empty when
	// Attested.
	Reason string
}

// Resolve decides a message's origin from its bytes alone, taking the envelope
// sender from the Return-Path header.
//
// Production should call [ResolveWithEnvelope] with the SMTP MAIL FROM instead.
// Return-Path is written by the receiving MTA — which, on the inbound path, is
// us — so on a message we have just accepted it is whatever the sender typed.
func Resolve(ctx context.Context, raw []byte, lookupTXT LookupTXT) Origin {
	return ResolveWithEnvelope(ctx, raw, "", lookupTXT)
}

// ResolveWithEnvelope decides a message's origin, using envelopeFrom — the SMTP
// MAIL FROM path — as the envelope sender. An empty envelopeFrom falls back to
// the Return-Path header.
//
// # The decision, in one place
//
// There are exactly three questions, asked in this order:
//
//  1. Did a domain that also RELAYED this message sign it? Then that domain is
//     the outer origin and there is no forwarder to see behind.
//  2. Did a domain OTHER than the relaying one sign this message, over the From
//     address it also signed? Then that domain is the inner origin, proved
//     directly. This is the load-bearing path: every forwarded message in the
//     corpus keeps a verifiable d=dib.ae signature (see
//     docs/superpowers/specs/v2-arc-spike.md).
//  3. Failing that, does a complete ARC chain — sealed at EVERY hop by a domain
//     on [TrustedSealers] — record that the first hop saw such a signature?
//     Then that domain is the inner origin, proved at one remove.
//
// # What a passing ARC chain does not mean
//
// It does not mean the sender is honest. A chain an attacker sealed with their
// own key verifies, correctly, because ARC attests chain integrity and not
// identity (RFC 8617 section 8.1). Reading the AAR of any passing chain as
// truth is the forwarder-allowlist bypass spec section 3.2 exists to forbid:
// anyone could then claim to be any bank. So the chain must additionally be
// sealed by hops we have decided to believe — every one of them, not just the
// first, because nothing verifies an ARC-Message-Signature below the top
// instance and so any hop above the first may rewrite the body wholesale and
// re-sign it while the chain still passes.
//
// It also does not mean every header is authentic. Only the fields named in the
// top AMS h= are covered, and a signature covers the BOTTOM-most occurrence of
// a repeated field (RFC 6376 section 5.4.2), so a prepended From leaves the
// chain passing while net/mail reads the attacker's line. This function refuses
// to attest anything about a message carrying more than one From field, rather
// than vouching for a document the rest of the pipeline will read differently.
//
// # What neither path proves
//
// That the bank sent the mail TO THIS USER. A valid signature on a genuine bank
// alert proves the bank sent it to someone; anyone holding the user's inbound
// address can forward their own bank mail into it. That is a property of the
// mail-slot design, disclosed in spec section 2, and its mitigations are
// address secrecy, rotation and the review queue — not this function.
//
// # Bounds
//
// Every input here is attacker-writable. The header split, the signature count
// and the chain length are bounded by [arc.ReadHeader], [VerifyDKIM] and
// [arc.Verify] respectively; the From and ARC-Authentication-Results fields are
// bounded below before they are parsed. Nothing here allocates in proportion to
// anything the sender controls beyond the message it already accepted.
func ResolveWithEnvelope(ctx context.Context, raw []byte, envelopeFrom string, lookupTXT LookupTXT) Origin {
	o := Origin{DKIM: SigNone, ARC: SigNone}
	var reasons []string
	note := func(format string, args ...any) {
		reasons = append(reasons, fmt.Sprintf(format, args...))
	}

	dk := VerifyDKIM(ctx, raw, lookupTXT)
	o.DKIM = dk.DKIM

	chain, chainErr := arc.Verify(ctx, raw, lookupTXT)
	o.ARC = arcResult(chain.Status)

	envDomain := envelopeDomain(envelopeFrom)

	if chainErr != nil {
		// The header block cannot be read the same way twice — a bare LF, or
		// no header at all. Falling back to a lenient parse to recover a
		// Return-Path would reintroduce exactly the parser disagreement
		// arc.ReadHeader refuses (spike finding 4), so nothing is read out of
		// these bytes at all. Only an envelope the SMTP layer saw survives.
		o.Outer = unverified(envDomain)
		o.Reason = sanitize("unreadable header: " + chainErr.Error())
		return o
	}
	h := chain.Header

	if envDomain == "" {
		envDomain = envelopeDomain(firstValue(h, "Return-Path"))
	}

	// --- outer origin ------------------------------------------------------
	//
	// A signature by the domain that also relayed the message is the strongest
	// statement available about who handed it to us. Failing that, the top ARC
	// seal is a signature by the last hop over this exact message, which is the
	// same claim one step weaker. Failing both, we have only the envelope, and
	// it is marked as the assertion it is.
	outerSig := alignedDomain(dk, envDomain)
	switch {
	case outerSig != "":
		o.Outer = outerSig
	case chain.Status == arc.StatusPass && len(chain.SealDomains) > 0:
		if top := hostname(chain.SealDomains[len(chain.SealDomains)-1]); top != "" {
			o.Outer = top
		} else {
			o.Outer = unverified(envDomain)
		}
	default:
		o.Outer = unverified(envDomain)
	}

	// --- inner origin ------------------------------------------------------

	from, fromErr := singleFrom(h)
	if fromErr != "" {
		o.Reason = sanitize(fromErr)
		return o
	}
	if envDomain == "" {
		o.Reason = "no envelope sender, so a relaying hop cannot be told apart from an originating one"
		return o
	}

	// Path 1: the bank's own signature survived the forward.
	if inner := innerDKIMDomain(dk, from.domain, envDomain); inner != "" {
		o.Inner, o.InnerFrom, o.Attested, o.AttestedBy = inner, from.addr, true, AttestedByDKIM
		return o
	}
	switch {
	case dk.DKIM != SigPass:
		note("no DKIM signature verified (%s)", dk.DKIM)
	case len(dk.DKIMDomains) == 1 && aligned(dk.DKIMDomains[0], envDomain):
		note("the only verified signature (%s) belongs to the relaying domain itself",
			clip(dk.DKIMDomains[0]))
	default:
		note("no verified signature aligns with the From domain %s (verified: %s)",
			clip(from.domain), clip(strings.Join(dk.DKIMDomains, ", ")))
	}

	// Path 2: ARC, which is a statement about the chain and only becomes a
	// statement about the bank once every hop in it is one we believe.
	if chain.Status != arc.StatusPass {
		note("no ARC chain to fall back on (%s)", o.ARC)
		o.Reason = sanitize(strings.Join(reasons, "; "))
		return o
	}
	if len(chain.SealDomains) == 0 || len(chain.AARValues) == 0 {
		// arc.Verify cannot pass a chain with no instances, so this cannot
		// happen — and an index into an empty slice on an inbound path is a
		// panic anyone can post, so it is checked rather than reasoned about.
		note("passing ARC chain carries no instances")
		o.Reason = sanitize(strings.Join(reasons, "; "))
		return o
	}
	if bad := untrustedSealer(chain.SealDomains); bad >= 0 {
		note("ARC instance %d was sealed by %s, which is not a trusted ARC sealer",
			bad+1, clip(chain.SealDomains[bad]))
		o.Reason = sanitize(strings.Join(reasons, "; "))
		return o
	}
	// The From must be one the top hop actually signed, and it must be the same
	// field this function read.
	//
	// This is expected to be UNREACHABLE, and it is kept anyway. RFC 6376
	// section 6.1.1 makes an h= without From a verification failure and arc
	// enforces it, so a passing chain always covers From; and singleFrom has
	// already refused any message with more than one, so the bottom-most pick
	// SignedValue makes is the field read above. Both premises are enforced
	// elsewhere, which is exactly the arrangement that quietly stops holding.
	// The cost of being wrong is not a wrong reason string, it is an
	// attestation computed over one From and reported about another — the
	// confused deputy this whole package is arranged to prevent. Three lines is
	// a cheap way to make a future divergence a refusal instead of a bypass.
	signedFrom, ok := chain.SignedValue("From")
	if !ok || signedFrom != strings.TrimSpace(from.raw) {
		note("the top ARC-Message-Signature does not cover the From field this message carries")
		o.Reason = sanitize(strings.Join(reasons, "; "))
		return o
	}
	claimed, aarErr := aarDKIMDomains(chain.AARValues[0])
	if aarErr != "" {
		note("%s", aarErr)
		o.Reason = sanitize(strings.Join(reasons, "; "))
		return o
	}
	for _, d := range claimed {
		if aligned(d, from.domain) && !aligned(d, envDomain) {
			o.Inner, o.InnerFrom, o.Attested, o.AttestedBy = d, from.addr, true, AttestedByARC
			o.Reason = ""
			return o
		}
	}
	note("instance 1's ARC-Authentication-Results claims no passing DKIM aligned with %s",
		clip(from.domain))
	o.Reason = sanitize(strings.Join(reasons, "; "))
	return o
}

// arcResult maps a chain status onto the closed set parse_diagnostics.arc_result
// admits. There is deliberately no temperror rung: a chain either verifies or it
// does not, and a status this function does not recognise is a failure rather
// than a value smuggled into a CHECK-constrained column.
func arcResult(status string) SigResult {
	switch status {
	case arc.StatusPass:
		return SigPass
	case arc.StatusNone:
		return SigNone
	default:
		return SigFail
	}
}

// innerDKIMDomain returns the verified signing domain of a message that was
// relayed by somebody else, or "".
//
// Two conditions, and dropping either one breaks the trust decision:
//
//   - The domain must ALIGN WITH THE From ADDRESS it signed. go-msgauth
//     guarantees a passing signature covers From (Task 25), but covering it is
//     not the same as belonging to it: an attacker signing their own message
//     with their own key while writing "DIB Notification <alerts@dib.ae>" into
//     From has a perfectly valid signature over a forged header. Requiring
//     alignment makes the attested domain the one the From claims to be, which
//     is the only reading under which "the bank signed this" means anything.
//
//   - The domain must NOT align with the envelope sender. If it does, the
//     signer is also the relay: this is direct mail, the domain is the outer
//     origin, and there is no forwarder to see behind.
func innerDKIMDomain(dk Verified, fromDomain, envDomain string) string {
	if dk.DKIM != SigPass || fromDomain == "" || envDomain == "" {
		return ""
	}
	for _, d := range dk.DKIMDomains {
		if aligned(d, fromDomain) && !aligned(d, envDomain) && hostname(d) != "" {
			return hostname(d)
		}
	}
	return ""
}

// alignedDomain returns the first verified signing domain that aligns with the
// envelope sender, or "".
func alignedDomain(dk Verified, envDomain string) string {
	if dk.DKIM != SigPass || envDomain == "" {
		return ""
	}
	for _, d := range dk.DKIMDomains {
		if aligned(d, envDomain) {
			return hostname(d)
		}
	}
	return ""
}

// untrustedSealer returns the index of the first seal domain that is not on
// [TrustedSealers], or -1.
//
// EVERY hop is checked, not just the first. RFC 8617 section 5.2 verifies only
// the highest-instance ARC-Message-Signature, so the body we hold is the one
// the LAST hop signed — every hop between the bank and that one could have
// rewritten it and re-sealed, and the chain would still pass. A chain is worth
// exactly as much as its least trustworthy participant (RFC 8617 section 8.1).
func untrustedSealer(seals []string) int {
	for i, d := range seals {
		if !IsTrustedSealer(d) {
			return i
		}
	}
	return -1
}

// ---------------------------------------------------------------------------
// header reading
// ---------------------------------------------------------------------------

const (
	// maxFromBytes bounds one From field before it is handed to an address
	// parser. Real From fields run to a hundred bytes or so.
	maxFromBytes = 2048
	// maxAARBytes bounds one ARC-Authentication-Results value before it is
	// handed to authres. Google's run to about 400 bytes.
	maxAARBytes = 8192
	// maxReasonDomain bounds a domain interpolated into a diagnostic string. A
	// d= tag is attacker-written text of unbounded length until it is checked.
	maxReasonDomain = 253
)

type fromAddr struct {
	raw    string // the field value as written, for cross-checking against a signature
	addr   string // addr-spec, domain lowercased, no display name
	domain string // validated hostname
}

// singleFrom reads the message's From, or returns the reason it is unusable.
//
// More than one From field is refused rather than resolved. A signature covers
// the bottom-most occurrence (RFC 6376 section 5.4.2) while net/mail,
// go-message and anything calling Header.Get read the topmost, so picking
// either one and attesting it would vouch for a document the rest of the
// pipeline attributes to somebody else — the confused deputy of spike finding
// 4, wearing a different hat. RFC 5322 section 3.6 permits exactly one.
func singleFrom(h arc.Header) (fromAddr, string) {
	fields := h.Get("From")
	switch {
	case len(fields) == 0:
		return fromAddr{}, "message carries no From field"
	case len(fields) > 1:
		return fromAddr{}, fmt.Sprintf(
			"message carries %d From fields; a signature covers only the bottom-most, "+
				"so no single From is unambiguous", len(fields))
	}
	v := fields[0].Value
	if len(v) > maxFromBytes {
		return fromAddr{}, fmt.Sprintf("From field is %d bytes, too large (limit %d)", len(v), maxFromBytes)
	}
	a, err := mail.ParseAddress(v)
	if err != nil {
		// Groups, address lists and unparseable text all land here. Every one
		// of them means "no single originator", which is not attestable.
		return fromAddr{}, "From is not a single parseable address"
	}
	i := strings.LastIndexByte(a.Address, '@')
	if i < 0 {
		return fromAddr{}, "From carries no domain"
	}
	d := hostname(a.Address[i+1:])
	if d == "" {
		return fromAddr{}, "From domain is not a bounded hostname"
	}
	return fromAddr{raw: v, addr: a.Address[:i+1] + d, domain: d}, ""
}

// firstValue returns the topmost occurrence of a header field, which for
// Return-Path is the one the most recent hop wrote.
func firstValue(h arc.Header, name string) string {
	if f := h.Get(name); len(f) > 0 {
		return f[0].Value
	}
	return ""
}

// aarDKIMDomains returns every domain instance 1's AAR claims a passing DKIM
// signature for.
//
// The value is "i=N; <authentication-results value>" (RFC 8617 section 4.1.1),
// and authres cannot parse the i= tag, so it is stripped first. A parse error
// mid-way is not fatal: authres returns the results it managed, and every one
// of those is a well-formed method/value pair. Partial results can only HIDE a
// claim, never invent one, so using them is safe in the only direction that
// matters.
//
// Nothing here is trusted on its own. These are claims written by whoever
// sealed instance 1, and they mean something only because that seal verified
// against a key belonging to a domain on [TrustedSealers].
func aarDKIMDomains(v string) ([]string, string) {
	if len(v) > maxAARBytes {
		return nil, fmt.Sprintf("ARC-Authentication-Results is %d bytes, too large (limit %d)",
			len(v), maxAARBytes)
	}
	tag, rest, ok := strings.Cut(v, ";")
	if !ok {
		return nil, "instance 1's ARC-Authentication-Results has no instance tag"
	}
	name, num, ok := strings.Cut(tag, "=")
	if !ok || !strings.EqualFold(strings.TrimSpace(name), "i") {
		return nil, "instance 1's ARC-Authentication-Results does not begin with an i= tag"
	}
	if n, err := strconv.Atoi(strings.TrimSpace(num)); err != nil || n != 1 {
		return nil, "instance 1's ARC-Authentication-Results is not tagged i=1"
	}

	_, results, err := authres.Parse(rest)
	var out []string
	for _, r := range results {
		d, ok := r.(*authres.DKIMResult)
		if !ok || d.Value != authres.ResultPass {
			continue
		}
		if hd := hostname(d.Domain); hd != "" && !contains(out, hd) {
			out = append(out, hd)
		}
	}
	if len(out) == 0 {
		if err != nil {
			return nil, "instance 1's ARC-Authentication-Results did not parse"
		}
		return nil, "instance 1's ARC-Authentication-Results claims no passing DKIM"
	}
	return out, ""
}

func contains(s []string, v string) bool {
	for _, x := range s {
		if x == v {
			return true
		}
	}
	return false
}

// ---------------------------------------------------------------------------
// domains
// ---------------------------------------------------------------------------

// reHostname is the grammar parse_diagnostics enforces in SQL for
// sender_domain and inner_origin_domain (00006_diagnostics.sql). It is
// duplicated here rather than imported because diag does not export it, and
// TestResolveNeverProducesAValueDiagWouldRefuse asserts this pattern still
// appears verbatim in that migration — a copy that checks itself.
//
// A value that fails it costs the WHOLE diagnostics row, not one field, so
// anything that could reach those columns is filtered here first.
var reHostname = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$`)

// hostname lowercases a domain, drops a trailing root dot, and returns "" if
// what is left is not a bounded hostname.
func hostname(d string) string {
	d = normalizeDomain(d)
	if len(d) > 253 || !reHostname.MatchString(d) {
		return ""
	}
	return d
}

// envelopeDomain extracts the domain of a return path, accepting both the bare
// form the SMTP layer hands over and the <angle-bracketed> form a Return-Path
// header carries. A null sender is normal for a bounce and yields "".
func envelopeDomain(path string) string {
	path = strings.TrimSpace(path)
	path = strings.TrimSuffix(strings.TrimPrefix(path, "<"), ">")
	i := strings.LastIndexByte(path, '@')
	if i < 0 {
		return ""
	}
	return hostname(path[i+1:])
}

// aligned reports whether two domains belong to the same organization, in the
// relaxed sense DMARC uses: equal, or one a subdomain of the other.
//
// It is an approximation. The exact rule compares organizational domains, which
// needs the public suffix list; this binary does not carry one, and adding a
// list that must be kept current to a path that decides trust is its own
// hazard. The approximation errs in a bounded way: both arguments have already
// passed [hostname], so each has at least two labels, and a two-label public
// suffix is not something anyone can register underneath the way this rule
// would require.
func aligned(a, b string) bool {
	if a == "" || b == "" {
		return false
	}
	a, b = normalizeDomain(a), normalizeDomain(b)
	return a == b || strings.HasSuffix(a, "."+b) || strings.HasSuffix(b, "."+a)
}

// unverified marks an envelope domain as the assertion it is. "" stays "":
// there is nothing to mark.
func unverified(envDomain string) string {
	if envDomain == "" {
		return ""
	}
	return unverifiedPrefix + envDomain
}

// unverifiedPrefix is diag.UnverifiedPrefix. It is a literal here so that this
// package, which sits on the inbound path, does not depend on the diagnostics
// package; TestResolveNeverProducesAValueDiagWouldRefuse pins the two together.
const unverifiedPrefix = "unverified:"

// clip bounds a domain that is about to be interpolated into a diagnostic
// string. Until hostname() has accepted it, a d= tag is text of the sender's
// choosing and any length.
//
// It bounds the INTERMEDIATE string only. What makes Reason safe to store and
// to log is [sanitize] at the end of the path, which is what
// TestReasonIsBoundedAndPrintableFromAHostileSealDomain actually pins; clip
// exists so a megabyte-long d= is not first formatted into a sentence and then
// thrown away.
func clip(s string) string {
	if len(s) > maxReasonDomain {
		return s[:maxReasonDomain] + "..."
	}
	return s
}
