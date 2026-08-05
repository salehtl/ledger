// Package origin decides what a message's headers are allowed to claim about
// where it came from.
//
// Everything here operates on the wire bytes of a received message, before
// normalization: DKIM and ARC sign what the sender transmitted, not what a
// normalizer later makes of it.
//
// # The rule this package exists to enforce
//
// A header field is never trusted unverified. Anyone who can open a TCP
// connection to the receiver can write any header they like, including
// Authentication-Results claiming dkim=pass for a bank. [VerifyDKIM] therefore
// does not read Authentication-Results at all — not to cross-check, not to log.
// The only statement about origin this layer will make is one it recomputed
// from a signature and a DNS key.
package origin

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net"
	"slices"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/emersion/go-msgauth/dkim"

	"ledger/internal/v2/arc"
)

// SigResult is an authentication verdict. The values are exactly the closed
// enum internal/v2/diag stores in parse_diagnostics.dkim_result; nothing else
// may ever be assigned to one.
type SigResult string

const (
	// SigPass means at least one signature verified against a DNS key.
	SigPass SigResult = "pass"
	// SigFail means signatures were present and none of them verified, for a
	// reason that will not change on its own.
	SigFail SigResult = "fail"
	// SigNone means the message carried no DKIM-Signature at all.
	SigNone SigResult = "none"
	// SigTempFail means the answer is unknown right now — a DNS lookup did not
	// complete. It is deliberately distinct from SigFail: a resolver blip must
	// not permanently demote a bank to "unauthenticated".
	SigTempFail SigResult = "temperror"
)

// Verified is what this layer is willing to say about a message.
type Verified struct {
	// DKIM is the message-level verdict.
	DKIM SigResult

	// DKIMDomains holds the d= of every signature that verified, lowercased,
	// deduplicated, in header order. It is empty unless DKIM is SigPass.
	//
	// Every domain here has signed the message's From header. go-msgauth
	// refuses a signature whose h= omits From before it does anything else
	// (dkim/verify.go:239-251), so this is a property of the list rather than
	// something a caller has to re-derive.
	DKIMDomains []string

	// Coverage says WHAT the passing signatures signed, as opposed to merely
	// that somebody signed. It is empty unless DKIM is SigPass, and an empty
	// Coverage covers nothing — see [Coverage].
	Coverage Coverage

	// Err explains why DKIM is not SigPass. It is diagnostic text and never a
	// trust input, and it must never be written to a closed-enum column.
	//
	// It is empty when DKIM is SigPass. Its content ultimately derives from
	// attacker-controlled bytes, so it is stripped of control characters and
	// truncated before it is set — a reason string is not an opportunity to
	// forge a log line.
	Err string
}

// LookupTXT resolves DNS TXT records.
//
// It is an alias for [arc.LookupTXT] rather than a second identical type, so
// one recorded-DNS fixture and one production resolver serve both verifiers.
type LookupTXT = arc.LookupTXT

// ConsumedHeaders are the header fields this pipeline reads out of a message
// once it has been let through, in the form [Coverage.Covers] wants.
//
// The list is short because the reading is: norm takes Subject (norm.go:165)
// and From (norm.go:166) through go-message's Get, and go-message chooses the
// leaf, the charset and the transfer decoding from Content-Type (norm.go:214,
// entity.go:170) and Content-Transfer-Encoding (entity.go:39). Subject is then
// both an extraction source and a template SELECTOR (tmpl/def.go:47), so it
// decides which template runs as well as what it produces.
//
// It is exported so a caller can ask [Coverage.Uncovered] what a message's
// signatures failed to cover, and it is a var rather than prose so that the
// question has one answer instead of one per caller.
var ConsumedHeaders = []string{
	"From",
	"Subject",
	"Content-Type",
	"Content-Transfer-Encoding",
}

// DecodingHeaders are the [ConsumedHeaders] that decide how the signed body
// BYTES become the text everything downstream reads. They are the ones whose
// value an attacker holding a genuinely signed message can edit IN PLACE —
// without duplicating anything, so nothing here or in [Coverage] can see it —
// to make the same signed bytes decode into different text.
//
// Between them, these two choose the MIME leaf, the charset it is decoded
// with, and the transfer decoding applied to it (go-message entity.go:39 and
// entity.go:170, reached from norm.go:214). Nothing else in [ConsumedHeaders]
// has that power:
//
//   - From is excluded because it is covered by construction. go-msgauth
//     refuses a signature whose h= omits From before it checks anything else
//     (dkim/verify.go:239-251), and a repeated From is refused outright, so a
//     branch on From being uncovered is dead on every passing message.
//   - Subject is excluded because it is not a decode input. It selects a
//     template and feeds an extraction — which is a real thing to steer — but
//     it cannot make the same body bytes render as different text, and it is
//     covered by every signature in the corpus, so putting it here would buy
//     nothing at the price of blurring what this list means.
//
// The list is deliberately short. Every name added to it sends every message
// whose signer omits that name to the review queue, so widening it trades the
// review queue's usefulness for coverage, and that trade is a product decision
// rather than a verification one.
var DecodingHeaders = []string{
	HeaderContentType,
	HeaderContentTransferEncoding,
}

// The [DecodingHeaders] by name. They are constants rather than string
// literals at each use because the two are not interchangeable and a caller
// has to be able to say which one it means: Content-Transfer-Encoding decides
// the transfer decoding, which is the ONLY lever that can turn one run of
// signed ASCII bytes into a different run of ASCII characters, and
// Content-Type decides the leaf and the charset, which can only change how
// NON-ASCII bytes read. See [Origin.TransferDecodingSigned].
const (
	HeaderContentType             = "Content-Type"
	HeaderContentTransferEncoding = "Content-Transfer-Encoding"
)

// Coverage records what the signatures that VERIFIED actually signed.
//
// # Why a verdict alone is not enough
//
// "d=emiratesnbd.com signed this" is not the same statement as "this Subject is
// the bank's". A signature covers the fields named in its h=, and where a field
// name repeats it covers the BOTTOM-most occurrence (RFC 6376 section 5.4.2) —
// while go-message, net/mail and every reader downstream of this package take
// the TOP-most. A signature can therefore verify over one document while the
// pipeline acts on another, which is the confused deputy this package exists to
// prevent and which [VerifyDKIM] previously closed for From alone.
//
// The zero Coverage covers nothing, which is the answer a caller should get
// from any verdict that is not SigPass.
type Coverage struct {
	// signed is the highest number of times a field name appears in the h= of a
	// signature that verified. Highest rather than summed: two signatures make
	// two independent claims, and the stronger one is not weakened by the other.
	signed map[string]int
	// present is how often the field actually occurs in the message.
	present map[string]int
}

// Covers reports whether every occurrence of a field is signed material — that
// is, whether the value a reader takes off this message is one a passing
// signature committed to.
//
// The test is that the signature named the field at least as many times as the
// message carries it. That is exactly RFC 6376 section 5.4.2's arithmetic: a
// verifier consumes occurrences from the bottom up, so h= naming a field n
// times covers the bottom-most n, and anything above those n is unsigned text
// that a later hop — or an attacker — added. It also gets oversigning right in
// the other direction: a signer who names a field more often than it occurs
// commits to its ABSENCE, so an added copy breaks the signature and the field
// is covered even though it is not there.
func (c Coverage) Covers(name string) bool {
	n := fieldKey(name)
	signed := c.signed[n]
	return signed >= c.present[n] && signed >= 1
}

// Uncovered returns the given field names, folded, that [Coverage.Covers]
// rejects. It returns them in the order asked, so a diagnostic reads the same
// way twice.
func (c Coverage) Uncovered(names ...string) []string {
	var out []string
	for _, n := range names {
		if !c.Covers(n) {
			out = append(out, fieldKey(n))
		}
	}
	return out
}

func fieldKey(name string) string {
	return strings.ToLower(strings.TrimSpace(name))
}

const (
	// maxSignatures bounds the fan-out. go-msgauth hashes the body once per
	// signature, in parallel, so an unbounded count is an unbounded amount of
	// work bought with one message. Real mail carries one to three.
	maxSignatures = 8

	// maxHeaderBytes and maxFieldLines bound the folded-header work BEFORE
	// either header parser runs.
	//
	// go-msgauth accumulates a folded field with h[len(h)-1] += l + crlf
	// (dkim/header.go:32): every continuation line copies the whole field again,
	// so one field costs bytes x lines and both terms are the sender's to
	// choose. Measured through VerifyDKIM with no bound: 20,000 folds took 2.3s,
	// 40,000 took 9.6s, 80,000 took 35.7s and 160,000 — inside the 1 MB a cold
	// mail blob is allowed — took 1m54s, all of it inside a 60s delivery
	// deadline that a pure-CPU loop never looks at. Fixing arc.ReadHeader's own
	// quadratic did not touch this: VerifyDKIM hands the same bytes to
	// dkim.VerifyWithOptions immediately afterwards.
	//
	// The product of the two is the bound that matters: 128 KB x 512 lines caps
	// the accumulation at about 33 MB of copying, tens of milliseconds. Both
	// clear real mail by an order of magnitude — across the seven fixtures the
	// largest header block is 12.5 KB and the deepest folded field is 23 lines
	// (TestTheFoldBoundsClearRealMailByAnOrderOfMagnitude holds that margin).
	maxHeaderBytes = 128 * 1024
	maxFieldLines  = 512

	// maxSigFieldBytes bounds one DKIM-Signature field. A 4096-bit RSA
	// signature with a long h= list runs to roughly 1.5 KB; 8 KB is generous
	// and still refuses a field built to be expensive to parse.
	maxSigFieldBytes = 8192

	// maxErrBytes bounds the diagnostic string.
	maxErrBytes = 2048
)

// VerifyDKIM verifies every DKIM signature on a raw RFC822 message.
//
// It never returns an error. A message that cannot be parsed, a signature that
// does not verify and a resolver that will not answer are all answers, and the
// caller needs to record them rather than retry them.
//
// # Why the header block is read twice
//
// arc.ReadHeader splits the message first, and go-msgauth splits it again
// internally to compute the hashes. That is deliberate. go-msgauth reads
// headers with net/textproto, which accepts a bare LF as a line terminator;
// arc.ReadHeader refuses one. Two readers that disagree about where the header
// block ends read two different documents out of the same bytes, and a caller
// that verified one while acting on the other is a confused deputy — the exact
// bug an earlier review found in the ARC verifier. Running the strict reader
// first means a message that could be read two ways is refused before any
// signature is checked, and the field count the two readers arrive at is
// compared before any verdict is believed.
//
// The strict reader is [arc.ReadHeader] rather than a second implementation of
// it. There is one header splitter in this repo on purpose.
//
// # Bounds
//
// The signature count and the size of one signature field are bounded here.
// The size of raw is NOT: the caller already holds those bytes and already has
// a limit for them (the receiver's MaxMessageBytes), and a second, different
// limit at this layer would reject mail the receiver had already accepted,
// which is worse than the problem it solves.
func VerifyDKIM(ctx context.Context, raw []byte, lookupTXT LookupTXT) Verified {
	if lookupTXT == nil {
		// A misconfigured verifier must not be able to convict a sender. This
		// is temperror, not fail: the message is fine, we are not.
		return Verified{DKIM: SigTempFail, Err: "no DNS resolver configured"}
	}

	// Bounded before either parser reads a byte of it: arc.ReadHeader is linear
	// now, but go-msgauth's reader is not, and this function hands it the same
	// bytes a few lines below.
	if n := headerBlockLen(raw); n > maxHeaderBytes {
		return failed("header block is %d bytes, too large (limit %d)", n, maxHeaderBytes)
	}

	h, _, err := arc.ReadHeader(raw)
	if err != nil {
		// Not "no signature": we cannot tell what this message says, and a
		// bare LF specifically is an attack shape rather than an absence. Fail
		// is the verdict that grants nothing and records that we saw something.
		return failed("unreadable header: %v", err)
	}
	if name, lines := deepestFold(h); lines > maxFieldLines {
		return failed("%s is folded across %d lines, too many (limit %d)",
			clipFieldName(name), lines, maxFieldLines)
	}

	sigs := h.Get(dkimHeaderField)
	if len(sigs) == 0 {
		return Verified{DKIM: SigNone}
	}
	if len(sigs) > maxSignatures {
		return failed("message carries %d DKIM signatures, over the limit of %d", len(sigs), maxSignatures)
	}
	if name, n := repeatedSingleton(h); n > 1 {
		// The whole message is refused, not one signature: the ambiguity is a
		// property of the document. See [Coverage] — a signature covers the
		// bottom-most occurrence and every reader downstream takes the top-most,
		// so there is no reading of these bytes that this receiver could verify
		// and the pipeline would then act on.
		return failed("message carries %d %s fields; a signature covers only the bottom-most "+
			"(RFC 6376 5.4.2) while every reader here takes the top-most, so no single value is "+
			"attributable", n, name)
	}

	// Policy refusals, decided from the strict split so they cannot be dodged
	// by a field the lenient reader groups differently. An index that is
	// refused here keeps its reason no matter what go-msgauth concludes.
	refused := make([]string, len(sigs))
	for i, f := range sigs {
		switch {
		case len(f.Raw) > maxSigFieldBytes:
			refused[i] = fmt.Sprintf("DKIM-Signature field is %d bytes, too large (limit %d)", len(f.Raw), maxSigFieldBytes)
		case hasBodyLengthTag(f):
			// l= says only the first N bytes of the body are signed, which
			// lets anyone append anything below a valid signature. RFC 6376
			// permits it; this receiver does not. Refused rather than ignored,
			// because ignoring it would verify the truncated prefix and call
			// the whole message authentic.
			refused[i] = "signature carries an l= body-length tag, which is not accepted"
		}
	}

	rec := &dnsProbe{ctx: ctx, lookup: lookupTXT}
	verifs, verr := dkim.VerifyWithOptions(bytes.NewReader(raw), &dkim.VerifyOptions{
		LookupTXT:        rec.lookupNoContext,
		MaxVerifications: maxSignatures,
	})
	if verr != nil {
		// go-msgauth could not get as far as a per-signature verdict — an
		// unterminated header block, or an I/O fault. Nothing here is
		// recoverable by retrying. dkim.ErrTooManySignatures lands here too,
		// though the count check above means it cannot be reached.
		return failed("cannot verify: %v", verr)
	}

	// The two readers must have found the same signatures.
	//
	// This is expected to be unreachable: with bare LFs refused, the strict
	// reader and net/textproto agree about where fields begin and end. It is
	// kept because the cost of being wrong is not a wrong count, it is a
	// verdict computed over one document and applied to another, and this
	// codebase has already had that bug once. Four lines is a cheap way to
	// make a future divergence loud instead of exploitable.
	if len(verifs) != len(sigs) {
		return failed("header parsers disagree: %d DKIM-Signature fields by strict split, %d by the verifier",
			len(sigs), len(verifs))
	}

	var (
		domains  []string
		reasons  []string
		tempSeen bool
		signed   = make(map[string]int)
	)
	for i, v := range verifs {
		if reason := refused[i]; reason != "" {
			reasons = append(reasons, fmt.Sprintf("signature %d: %s", i+1, reason))
			continue
		}
		if v.Err == nil {
			d := normalizeDomain(v.Domain)
			if d == "" {
				// Unreachable via go-msgauth, which cannot resolve a key
				// without a d=. Recorded rather than dropped, so that a
				// signature which verified but names nobody can never leave
				// the switch below with no domains and no reason.
				reasons = append(reasons, fmt.Sprintf("signature %d: verified but carries no d= domain", i+1))
				continue
			}
			if !slices.Contains(domains, d) {
				domains = append(domains, d)
			}
			// Only a signature that VERIFIED contributes coverage. A failed one
			// can name any field it likes in h= and has proved nothing about
			// any of them.
			for name, n := range tally(v.HeaderKeys) {
				signed[name] = max(signed[name], n)
			}
			continue
		}
		if dkim.IsTempFail(v.Err) {
			tempSeen = true
		}
		reasons = append(reasons, fmt.Sprintf("signature %d: %v", i+1, v.Err))
	}

	switch {
	case len(domains) > 0:
		// A signature verified. Another one failing says nothing about this
		// one — signatures are independent claims, and a forged extra
		// signature must not be able to suppress a real one.
		return Verified{
			DKIM:        SigPass,
			DKIMDomains: domains,
			Coverage:    Coverage{signed: signed, present: fieldCounts(h)},
		}
	case tempSeen:
		return Verified{DKIM: SigTempFail, Err: sanitize(strings.Join(reasons, "; "))}
	default:
		return Verified{DKIM: SigFail, Err: sanitize(strings.Join(reasons, "; "))}
	}
}

const dkimHeaderField = "DKIM-Signature"

func failed(format string, args ...any) Verified {
	return Verified{DKIM: SigFail, Err: sanitize(fmt.Sprintf(format, args...))}
}

func hasBodyLengthTag(f arc.Field) bool {
	_, ok := arc.ParseTags(f.Value)["l"]
	return ok
}

// headerBlockLen is the size of the header block, computed without parsing it.
// A message with no blank line is all header.
func headerBlockLen(raw []byte) int {
	if i := bytes.Index(raw, []byte("\r\n\r\n")); i >= 0 {
		return i + 2
	}
	return len(raw)
}

// deepestFold returns the field with the most continuation lines, and how many.
func deepestFold(h arc.Header) (string, int) {
	var worst string
	var most int
	for _, f := range h {
		// Raw is Name + ":" + Value + CRLF, so one CRLF per line and the last
		// one is the field's own terminator.
		if n := strings.Count(f.Raw, crlf) - 1; n > most {
			worst, most = f.Name, n
		}
	}
	return worst, most
}

const crlf = "\r\n"

// clipFieldName bounds a field name before it is interpolated into a
// diagnostic. The name is the sender's text until something checks it, and
// sanitize bounds the whole string but only after this one has been built.
func clipFieldName(name string) string {
	name = strings.TrimSpace(name)
	const limit = 64
	if len(name) > limit {
		return name[:limit] + "..."
	}
	return name
}

// singletonFields are the header fields that may appear at most once: the
// max-1 rows of RFC 5322 section 3.6, plus the MIME fields of RFC 2045 that
// decide how a body is read.
//
// The list is a whitelist of what MUST NOT repeat rather than a check that
// nothing repeats, because plenty of fields legitimately do. Every message that
// has been relayed carries several Received, every one that has been
// authenticated carries several Authentication-Results, and an ARC chain
// carries one of each of its three fields per hop — the fixtures here run to 8
// Received and 6 Authentication-Results. A rule that refused those would refuse
// all forwarded mail, which is the traffic this receiver exists to read.
//
// Return-Path is included although RFC 5322 files it under trace: it is the
// envelope sender inner.go falls back to when the SMTP layer did not give it
// one, so a prepended copy changes which domain counts as the relaying hop.
var singletonFields = map[string]string{
	"date":                      "Date",
	"from":                      "From",
	"sender":                    "Sender",
	"reply-to":                  "Reply-To",
	"to":                        "To",
	"cc":                        "Cc",
	"bcc":                       "Bcc",
	"message-id":                "Message-ID",
	"in-reply-to":               "In-Reply-To",
	"references":                "References",
	"subject":                   "Subject",
	"return-path":               "Return-Path",
	"mime-version":              "MIME-Version",
	"content-type":              "Content-Type",
	"content-transfer-encoding": "Content-Transfer-Encoding",
	"content-id":                "Content-ID",
	"content-description":       "Content-Description",
	"content-disposition":       "Content-Disposition",
}

// repeatedSingleton returns the first field that may appear at most once and
// does not, with its count. The name returned is this package's spelling of it,
// never the sender's, so nothing attacker-written reaches the diagnostic.
func repeatedSingleton(h arc.Header) (string, int) {
	counts := fieldCounts(h)
	// Iterated over the header rather than over the map, so the field reported
	// is the first one in the message and the message does not change between
	// two runs on the same input.
	for _, f := range h {
		k := fieldKey(f.Name)
		if canonical, ok := singletonFields[k]; ok && counts[k] > 1 {
			return canonical, counts[k]
		}
	}
	return "", 0
}

func fieldCounts(h arc.Header) map[string]int {
	counts := make(map[string]int, len(h))
	for _, f := range h {
		counts[fieldKey(f.Name)]++
	}
	return counts
}

// tally counts an h= list, which may name a field more than once: RFC 6376
// section 5.4.2's oversigning, where a signer commits to a field appearing no
// more often than it did at signing time.
func tally(names []string) map[string]int {
	out := make(map[string]int, len(names))
	for _, n := range names {
		if k := fieldKey(n); k != "" {
			out[k]++
		}
	}
	return out
}

// normalizeDomain lowercases a d= and drops a trailing root dot.
//
// DNS names are case-insensitive, so d=DIB.AE and d=dib.ae are the same domain.
// Callers compare this list against a configured set of trusted senders, and a
// comparison that a change of case defeats is not a comparison.
func normalizeDomain(d string) string {
	return strings.TrimSuffix(strings.ToLower(strings.TrimSpace(d)), ".")
}

// sanitize makes a diagnostic string safe to log and to store.
//
// Reason text reaches here from DNS errors and from go-msgauth, both of which
// quote bytes the sender chose. Newlines would let a sender write their own log
// lines; unbounded length would let them write a lot of them.
//
// The budget is spent as the string is built rather than by slicing first.
// Truncating first is wrong twice over: it can cut a rune in half, and every
// invalid byte then expands to a three-byte U+FFFD, so a "truncated" string can
// come out three times the limit.
func sanitize(s string) string {
	const ellipsis = "..."
	budget := maxErrBytes - len(ellipsis)
	var b strings.Builder
	b.Grow(min(len(s), maxErrBytes))
	for _, r := range s {
		if r < 0x20 || r == 0x7f {
			r = ' '
		}
		if b.Len()+utf8.RuneLen(r) > budget {
			b.WriteString(ellipsis)
			break
		}
		b.WriteRune(r)
	}
	return strings.TrimSpace(b.String())
}

// ---------------------------------------------------------------------------
// DNS
// ---------------------------------------------------------------------------

// dnsProbe adapts a context-aware [LookupTXT] to the signature go-msgauth
// wants, and translates error classification on the way through.
//
// The translation is the point. go-msgauth calls a DNS failure temporary only
// when the error is a net.Error whose Temporary reports true (dkim/query.go:75)
// and permanent otherwise, so an injected resolver's context deadline, or any
// error type it does not recognise, would be recorded as a permanent
// authentication failure. Handing it an error that already answers Temporary
// correctly puts the decision here, where the taxonomy is written down, instead
// of relying on a library's default.
type dnsProbe struct {
	ctx    context.Context
	lookup LookupTXT
}

func (p *dnsProbe) lookupNoContext(name string) ([]string, error) {
	if err := p.ctx.Err(); err != nil {
		return nil, temporaryDNSError{err}
	}
	recs, err := p.lookup(p.ctx, name)
	if err != nil && classifyDNSError(err) == dnsTemporary {
		return nil, temporaryDNSError{err}
	}
	return recs, err
}

type dnsClass int

const (
	dnsPermanent dnsClass = iota
	dnsTemporary
)

// classifyDNSError decides whether a lookup failure is an answer or an absence
// of one.
//
// The default is deliberately dnsTemporary. Getting it wrong in that direction
// costs a retry; getting it wrong in the other direction marks a bank
// permanently unauthenticated because a resolver hiccuped, which is the failure
// this distinction exists to prevent. Only errors that are positively known to
// be final — NXDOMAIN, and the fixture loader's "this name is not in the
// recording" — are treated as permanent.
func classifyDNSError(err error) dnsClass {
	switch {
	case err == nil:
		return dnsPermanent
	case errors.Is(err, arc.ErrNoKey):
		// A recorded-DNS lookup that has no such name. Authoritative by
		// construction: the recording is the whole world.
		return dnsPermanent
	}
	var dnsErr *net.DNSError
	if errors.As(err, &dnsErr) {
		if dnsErr.IsNotFound {
			return dnsPermanent
		}
		return dnsTemporary
	}
	return dnsTemporary
}

// temporaryDNSError presents an error to go-msgauth as a net.Error that is
// explicitly temporary, which is the only signal its query path reads.
type temporaryDNSError struct{ err error }

func (e temporaryDNSError) Error() string   { return e.err.Error() }
func (e temporaryDNSError) Timeout() bool   { return true }
func (e temporaryDNSError) Temporary() bool { return true }
func (e temporaryDNSError) Unwrap() error   { return e.err }

var _ net.Error = temporaryDNSError{}

// DefaultLookupTimeout is the per-lookup deadline when none is given.
const DefaultLookupTimeout = 5 * time.Second

// WithTimeout bounds how long one key lookup may take.
//
// An SMTP transaction is held open while this runs, so an unresponsive resolver
// is a way to hold connections. The deadline is per lookup rather than per
// message: a message with two signatures gets two chances, not half a chance
// each.
//
// A non-positive d means [DefaultLookupTimeout]. Passing it through to
// context.WithTimeout would produce an already-expired context and turn every
// bank into a temperror — a misconfiguration wearing the costume of a network
// outage.
func WithTimeout(lookup LookupTXT, d time.Duration) LookupTXT {
	if d <= 0 {
		d = DefaultLookupTimeout
	}
	return func(ctx context.Context, name string) ([]string, error) {
		ctx, cancel := context.WithTimeout(ctx, d)
		defer cancel()
		return lookup(ctx, name)
	}
}

// ResolverLookup is the production [LookupTXT]: real DNS, with a deadline.
func ResolverLookup(r *net.Resolver, timeout time.Duration) LookupTXT {
	if r == nil {
		r = net.DefaultResolver
	}
	return WithTimeout(func(ctx context.Context, name string) ([]string, error) {
		return r.LookupTXT(ctx, name)
	}, timeout)
}

// CacheOptions configures [NewCachingLookup]. Every zero value takes the
// corresponding default, so the zero CacheOptions is usable.
type CacheOptions struct {
	// TTL is how long a successful answer is reused.
	TTL time.Duration
	// NegativeTTL is how long an authoritative "no such record" is reused.
	NegativeTTL time.Duration
	// MaxEntries bounds the cache.
	MaxEntries int
}

const (
	defaultMaxEntries  = 512
	defaultTTL         = 5 * time.Minute
	defaultNegativeTTL = 1 * time.Minute
)

// NewCachingLookup memoizes key lookups.
//
// Banks send in bursts and every message in a burst asks for the same selector,
// so the cache turns a batch of arrivals into one query. Two properties matter
// more than the hit rate:
//
//   - It is BOUNDED. The selector is chosen by the sender, so an attacker can
//     mint a fresh cache key with every message. An unbounded cache is a memory
//     leak with a stranger holding the tap.
//
//   - Temporary failures are NOT cached. Caching one would take a resolver
//     hiccup that lasted a second and make it last a TTL, during which every
//     message from that bank reads as unauthenticated. Only successes and
//     authoritative absences are worth remembering.
func NewCachingLookup(lookup LookupTXT, opts CacheOptions) LookupTXT {
	return newCache(opts).wrap(lookup)
}

type cacheEntry struct {
	recs    []string
	err     error
	expires time.Time
}

type dnsCache struct {
	opts CacheOptions
	now  func() time.Time

	mu      sync.Mutex
	entries map[string]cacheEntry
}

func newCache(opts CacheOptions) *dnsCache {
	if opts.MaxEntries <= 0 {
		opts.MaxEntries = defaultMaxEntries
	}
	if opts.TTL <= 0 {
		opts.TTL = defaultTTL
	}
	if opts.NegativeTTL <= 0 {
		opts.NegativeTTL = defaultNegativeTTL
	}
	return &dnsCache{opts: opts, now: time.Now, entries: make(map[string]cacheEntry)}
}

func (c *dnsCache) wrap(lookup LookupTXT) LookupTXT {
	return func(ctx context.Context, name string) ([]string, error) {
		if e, ok := c.get(name); ok {
			return e.recs, e.err
		}
		recs, err := lookup(ctx, name)
		switch {
		case err == nil:
			c.put(name, cacheEntry{recs: recs, expires: c.now().Add(c.opts.TTL)})
		case classifyDNSError(err) == dnsPermanent:
			c.put(name, cacheEntry{err: err, expires: c.now().Add(c.opts.NegativeTTL)})
		}
		return recs, err
	}
}

func (c *dnsCache) get(name string) (cacheEntry, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.entries[name]
	if !ok {
		return cacheEntry{}, false
	}
	if c.now().After(e.expires) {
		delete(c.entries, name)
		return cacheEntry{}, false
	}
	return e, true
}

func (c *dnsCache) put(name string, e cacheEntry) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.entries) >= c.opts.MaxEntries {
		c.evictLocked()
	}
	c.entries[name] = e
}

// evictLocked drops expired entries, and if that frees nothing, an arbitrary
// one. Arbitrary is enough: the cache exists to collapse bursts, and a burst is
// still collapsed by a cache that occasionally forgets the wrong name. Anything
// smarter would be per-entry bookkeeping bought with no measured benefit.
func (c *dnsCache) evictLocked() {
	now := c.now()
	for k, e := range c.entries {
		if now.After(e.expires) {
			delete(c.entries, k)
		}
	}
	for len(c.entries) >= c.opts.MaxEntries {
		for k := range c.entries {
			delete(c.entries, k)
			break
		}
	}
}

func (c *dnsCache) len() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.entries)
}
