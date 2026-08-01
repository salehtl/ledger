package arc

import (
	"bytes"
	"errors"
	"fmt"
	"strings"
)

const crlf = "\r\n"

// Canonicalization is an RFC 6376 section 3.4 canonicalization algorithm.
type Canonicalization string

const (
	Simple  Canonicalization = "simple"
	Relaxed Canonicalization = "relaxed"
)

// Field is one header field, kept byte-exact.
//
// Simple canonicalization emits the field unchanged, so nothing may be
// normalised on the way in: folding, tabs and trailing whitespace are all
// signed material.
type Field struct {
	Name  string // text before the colon, exactly as written (may end in space)
	Value string // text after the colon up to but not including the final CRLF
	Raw   string // Name + ":" + Value + CRLF
}

// Header is a message's header fields in file order, top first.
type Header []Field

// ErrNoHeader is returned when the input has no parseable header block.
var ErrNoHeader = errors.New("arc: message has no header block")

// ErrBareLF is returned when the header block contains an LF that is not part
// of a CRLF.
var ErrBareLF = errors.New("arc: header block contains a bare LF")

// ReadHeader splits a raw RFC822 message into its header fields and its body.
//
// The input must use CRLF line endings — which real delivered mail does, and
// which the v1 corpus preserves byte-exactly. Bare-LF input is rejected rather
// than silently repaired, because repairing it would change the bytes that
// every signature is computed over.
//
// # Why a bare LF is fatal rather than tolerated
//
// This is a parser-differential problem, and it is the reason this function is
// strict where a lenient reader would be friendlier.
//
// RFC 5322 terminates header lines with CRLF, but Go's net/textproto — and
// therefore net/mail, go-message, and most of the mail ecosystem — also accepts
// a bare LF as a line terminator, and a bare LF LF as the end of the header
// block. This parser does not. Two readers that disagree about where the header
// block ends do not disagree politely: they read two different documents out of
// the same bytes.
//
// Prepending "X-Junk: a\n\nX-Junk2: b\r\n" to a validly sealed message is
// enough. This parser sees one extra header field and a chain that still
// verifies; net/mail sees a one-field header, no From, no Subject, and a body
// that begins with the entire real message. A caller that trusted the verified
// chain and then re-parsed the message would be authenticating one document and
// acting on another — a confused deputy on any path where the message bytes are
// attacker-influenced, which is every inbound path.
//
// Rejecting the ambiguity outright is the only fix that does not depend on
// every downstream parser agreeing with this one. See
// TestBareLFInHeaderIsRejected.
func ReadHeader(raw []byte) (Header, []byte, error) {
	i := bytes.Index(raw, []byte(crlf+crlf))
	var block, body []byte
	if i < 0 {
		// A message may legitimately be all header and no body. Scanning the
		// whole input for a bare LF then also catches a header block that a
		// lenient parser would terminate at an "\n\n" we cannot see.
		block, body = raw, nil
	} else {
		block, body = raw[:i+len(crlf)], raw[i+2*len(crlf):]
	}
	if len(block) == 0 {
		return nil, nil, ErrNoHeader
	}
	if j := bareLF(block); j >= 0 {
		return nil, nil, fmt.Errorf("%w at offset %d", ErrBareLF, j)
	}

	// A folded field is accumulated in byte buffers and turned into strings
	// once, when the next field starts. Appending to the Field's strings in
	// place instead — last.Value += ... — is quadratic in the number of
	// continuation lines, because every += copies the whole value again. That
	// is not a style point on an inbound path: a 350 KB header of six-byte
	// folds measured 8.8s before this change and grows with the square, so a
	// message a sender is free to construct is a way to spend the receiver's
	// CPU. See TestFoldedHeaderCostIsLinearInItsInput.
	var (
		h      Header
		name   string
		valBuf []byte
		rawBuf []byte
		open   bool
	)
	flush := func() {
		if open {
			h = append(h, Field{Name: name, Value: string(valBuf), Raw: string(rawBuf)})
			valBuf, rawBuf, open = nil, nil, false
		}
	}
	for len(block) > 0 {
		j := bytes.Index(block, []byte(crlf))
		if j < 0 {
			// Trailing bytes with no CRLF: treat as a final line.
			j = len(block)
		}
		line := block[:j]
		adv := j + len(crlf)
		if adv > len(block) {
			adv = len(block)
		}
		block = block[adv:]

		if len(line) > 0 && (line[0] == ' ' || line[0] == '\t') {
			if !open {
				return nil, nil, ErrNoHeader // continuation with nothing to continue
			}
			valBuf = append(append(valBuf, crlf...), line...)
			rawBuf = append(append(rawBuf, line...), crlf...)
			continue
		}
		flush()
		n, v, ok := strings.Cut(string(line), ":")
		if !ok {
			return nil, nil, ErrNoHeader
		}
		// flush() has just cleared both buffers, so these start fresh. The
		// exact capacity covers an unfolded field — the overwhelming majority
		// — without a single growth.
		name, valBuf, open = n, []byte(v), true
		rawBuf = make([]byte, 0, len(line)+len(crlf))
		rawBuf = append(append(rawBuf, line...), crlf...)
	}
	flush()
	if len(h) == 0 {
		return nil, nil, ErrNoHeader
	}
	return h, body, nil
}

// bareLF returns the offset of the first LF not preceded by CR, or -1.
func bareLF(b []byte) int {
	for i, ch := range b {
		if ch == '\n' && (i == 0 || b[i-1] != '\r') {
			return i
		}
	}
	return -1
}

// CanonHeader canonicalizes one header field per RFC 6376 section 3.4.1/3.4.2.
// The result includes its terminating CRLF.
func CanonHeader(c Canonicalization, f Field) string {
	if c == Simple {
		return f.Raw
	}
	name := strings.TrimSpace(strings.ToLower(f.Name))
	// Unfold, squeeze every WSP run to one space, drop leading and trailing WSP.
	value := strings.Join(strings.FieldsFunc(f.Value, func(r rune) bool {
		return r == ' ' || r == '\t' || r == '\r' || r == '\n'
	}), " ")
	return name + ":" + value + crlf
}

// CanonBody canonicalizes a message body per RFC 6376 section 3.4.3/3.4.4.
func CanonBody(c Canonicalization, body []byte) []byte {
	if c == Simple {
		// RFC 6376 3.4.3: every trailing empty line collapses to one CRLF, and
		// a body that does not end in CRLF gains one. Both fall out of trimming
		// the trailing CR/LF run and appending a single CRLF. An empty body is
		// the same single CRLF, so it needs no special case beyond not
		// depending on body being non-nil.
		b := bytes.TrimRight(body, "\r\n")
		out := make([]byte, 0, len(b)+len(crlf))
		return append(append(out, b...), crlf...)
	}

	out := make([]byte, 0, len(body))
	var wsp bool
	for _, ch := range body {
		switch ch {
		case ' ', '\t':
			wsp = true
		case '\r':
			// Trailing WSP on a line is deleted, so a pending run is dropped.
			wsp = false
			out = append(out, ch)
		case '\n':
			wsp = false
			out = append(out, ch)
		default:
			if wsp {
				out = append(out, ' ')
				wsp = false
			}
			out = append(out, ch)
		}
	}
	out = bytes.TrimRight(out, "\r\n")
	if len(out) == 0 {
		return nil
	}
	return append(out, crlf...)
}

// ParseTags parses a DKIM/ARC tag list (RFC 6376 section 3.2) into a map,
// stripping all folding whitespace from every value.
//
// Tag values may not contain a semicolon, so splitting on ";" is exact.
func ParseTags(v string) map[string]string {
	out := make(map[string]string)
	for _, seg := range strings.Split(v, ";") {
		name, value, ok := strings.Cut(seg, "=")
		if !ok {
			continue
		}
		name = strings.TrimSpace(name)
		if name == "" {
			continue
		}
		out[name] = stripWSP(value)
	}
	return out
}

func stripWSP(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	for _, r := range s {
		switch r {
		case ' ', '\t', '\r', '\n':
		default:
			b.WriteRune(r)
		}
	}
	return b.String()
}

// BlankTag returns the tag list with the named tag's value emptied and every
// other byte left alone.
//
// This is how a DKIM, ARC-Message-Signature or ARC-Seal signature covers its
// own header field: the field is canonicalized with b= empty. It is done by
// tag position rather than by pattern, so neither "bh=" nor a base64 blob that
// happens to contain "b=" can be mistaken for the tag.
func BlankTag(v, tag string) string {
	segs := strings.Split(v, ";")
	for i, seg := range segs {
		name, _, ok := strings.Cut(seg, "=")
		if !ok || strings.TrimSpace(name) != tag {
			continue
		}
		// Keep the segment up to and including the "=" so leading folding
		// whitespace and the tag name survive untouched.
		eq := strings.Index(seg, "=")
		segs[i] = seg[:eq+1]
	}
	return strings.Join(segs, ";")
}

// Picker selects header fields for an h= tag.
//
// RFC 6376 section 5.4.2: when a field name repeats, signers and verifiers
// consume occurrences from the bottom of the header block upward, so that a
// field prepended by a later hop is never mistaken for the signed one.
type Picker struct {
	h      Header
	picked map[string]int
}

// NewPicker returns a Picker over h.
func NewPicker(h Header) *Picker {
	return &Picker{h: h, picked: make(map[string]int)}
}

// Pick returns the next unconsumed field with the given name, scanning upward
// from the bottom of the header block. It reports false when the name is
// exhausted, which RFC 6376 treats as an empty (but still signed) field.
func (p *Picker) Pick(name string) (Field, bool) {
	name = strings.ToLower(name)
	skip := p.picked[name]
	for i := len(p.h) - 1; i >= 0; i-- {
		if !strings.EqualFold(strings.TrimSpace(p.h[i].Name), name) {
			continue
		}
		if skip == 0 {
			p.picked[name]++
			return p.h[i], true
		}
		skip--
	}
	p.picked[name]++
	return Field{}, false
}

// Get returns every field with the given name, in file order.
func (h Header) Get(name string) []Field {
	var out []Field
	for _, f := range h {
		if strings.EqualFold(strings.TrimSpace(f.Name), name) {
			out = append(out, f)
		}
	}
	return out
}
