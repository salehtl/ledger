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

const (
	// maxSignatures bounds the fan-out. go-msgauth hashes the body once per
	// signature, in parallel, so an unbounded count is an unbounded amount of
	// work bought with one message. Real mail carries one to three.
	maxSignatures = 8

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

	h, _, err := arc.ReadHeader(raw)
	if err != nil {
		// Not "no signature": we cannot tell what this message says, and a
		// bare LF specifically is an attack shape rather than an absence. Fail
		// is the verdict that grants nothing and records that we saw something.
		return failed("unreadable header: %v", err)
	}

	sigs := h.Get(dkimHeaderField)
	if len(sigs) == 0 {
		return Verified{DKIM: SigNone}
	}
	if len(sigs) > maxSignatures {
		return failed("message carries %d DKIM signatures, over the limit of %d", len(sigs), maxSignatures)
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
		return Verified{DKIM: SigPass, DKIMDomains: domains}
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
