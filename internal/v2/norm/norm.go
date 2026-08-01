// Package norm is the v2 normalizer: it turns a raw RFC822 message into the
// single canonical string that extraction templates match against.
//
// # Why this is a versioned contract
//
// Templates match NORMALIZED text, so the normalizer is where template
// behavior actually lives. A change to how a <br> becomes a newline, or to
// which characters count as trimmable whitespace, silently changes what every
// template in the system matches — including templates written months earlier
// against the old behavior. The algorithm is therefore frozen per version:
// [Normalize] takes the version explicitly, [CurrentVersion] names the newest,
// and a stored transaction records which version produced its text.
//
// The written contract is docs/superpowers/specs/v2-normalizer-v1.md, and
// conformance/normalizer/*.json pins it against real bank mail. A TypeScript
// twin must reproduce the same bytes; every decision that could plausibly
// diverge between the two languages is called out in the spec and pinned by a
// fixture rather than left to each platform's defaults.
//
// # Trust
//
// [Result.From] and [Result.Subject] are CONTENT, not identity. When a message
// is an inline forward they are read out of the forwarded header block, which
// is body text anyone can author. They exist for diagnostics and template
// authorship. Trust decisions read the cryptographically verified signing
// domain from the ARC/DKIM verifier and nothing from this package.
package norm

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/mail"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/emersion/go-message"
	_ "github.com/emersion/go-message/charset" // registers message.CharsetReader

	"golang.org/x/text/encoding/htmlindex"
)

// CurrentVersion is the newest normalizer algorithm.
const CurrentVersion = 1

// Versions lists every normalizer version this build can run, oldest first.
// Old versions are never removed: a transaction normalized at v1 must stay
// reproducible after v2 ships, or its template match cannot be re-verified.
func Versions() []int { return []int{1} }

// PartUsed values.
const (
	PartHTML  = "html"
	PartPlain = "plain"
	PartRaw   = "raw"
)

// DateSource values.
const (
	DateSourceForwardHeader = "forward_header"
	DateSourceReceived      = "received"
)

var (
	// ErrUnknownVersion is returned for a version this build cannot run.
	ErrUnknownVersion = errors.New("norm: unknown normalizer version")
	// ErrNoTextPart is returned when a well-formed message carries neither a
	// text/html nor a text/plain leaf.
	ErrNoTextPart = errors.New("norm: no text/html or text/plain part found")
)

// Result is everything the normalizer recovers from a message.
//
// Subject, From and EmailDate are the EFFECTIVE values: for an inline forward
// they are the INNER message's, because that is what the transaction is
// actually about. See the package doc on trust before using From.
type Result struct {
	Text       string    // the normalized, unwrapped body templates match against
	PartUsed   string    // PartHTML | PartPlain | PartRaw
	Charset    string    // the chosen leaf's declared charset, lowercased; "" when none was declared
	Subject    string    // EFFECTIVE subject — inner when forwarded
	From       string    // EFFECTIVE From — inner when forwarded. CONTENT ONLY, never trust.
	Forwarded  bool      // a forward marker line was found in the body
	EmailDate  time.Time // inner forwarded Date when parseable, else receivedAt
	DateSource string    // DateSourceForwardHeader | DateSourceReceived
}

// Normalize runs the given normalizer version over a raw RFC822 message.
//
// receivedAt is the mailbox arrival time, used as EmailDate whenever no inner
// forwarded Date is recoverable.
func Normalize(version int, raw []byte, receivedAt time.Time) (Result, error) {
	if version != CurrentVersion {
		return Result{}, fmt.Errorf("%w: %d (supported: %v)", ErrUnknownVersion, version, Versions())
	}

	body, part, charset, subject, from, err := extract(raw)
	if err != nil {
		return Result{}, err
	}

	// Stages 5-9. Only an HTML leaf is stripped; a text/plain leaf reaches the
	// entity decoder as-is, exactly as v1 does.
	if part == PartHTML {
		body = stripHTML(body)
	}
	text := collapse(body)

	// Stage 10.
	fwd := unwrapForward(from, subject, text)

	res := Result{
		Text:       fwd.Body,
		PartUsed:   part,
		Charset:    charset,
		Subject:    fwd.Subject,
		From:       fwd.From,
		Forwarded:  fwd.Found,
		EmailDate:  receivedAt,
		DateSource: DateSourceReceived,
	}
	if t, derr := parseForwardDate(fwd.Date); derr == nil {
		res.EmailDate = t
		res.DateSource = DateSourceForwardHeader
	}
	return res, nil
}

// ---------------------------------------------------------------------------
// Stages 1-4: MIME walk, transfer decoding, charset, UTF-8 validation, choice
// ---------------------------------------------------------------------------

// extract performs stages 1-4 and returns the chosen leaf's text along with
// the message's own Subject and From.
func extract(raw []byte) (body, part, charset, subject, from string, err error) {
	ent, rerr := message.Read(bytes.NewReader(raw))
	if rerr != nil && !message.IsUnknownCharset(rerr) && !message.IsUnknownEncoding(rerr) {
		// Stage 1: unrecoverable MIME parse error. v1 gives up here and the
		// message becomes `unparsed` with no body recorded at all; §2's drop
		// policy makes that unacceptable, so v2 falls back to the raw body.
		subject, from = scanRawHeaders(raw)
		return decodeUTF8WHATWG(rawBodyAfterHeaders(raw)), PartRaw, "", subject, from, nil
	}

	subject = decodeWords(ent.Header.Get("Subject"))
	from = bareAddress(decodeWords(ent.Header.Get("From")))

	var w walker
	werr := w.walk(ent)

	switch {
	case w.html != "":
		return w.html, PartHTML, w.htmlCharset, subject, from, nil
	case w.plain != "":
		return w.plain, PartPlain, w.plainCharset, subject, from, nil
	case werr != nil:
		// The tree broke apart before any text leaf was reached. Same reasoning
		// as stage 1: record the raw body rather than nothing.
		s, f := scanRawHeaders(raw)
		return decodeUTF8WHATWG(rawBodyAfterHeaders(raw)), PartRaw, "", s, f, nil
	default:
		return "", "", "", "", "", ErrNoTextPart
	}
}

// walker collects the first non-empty text/html and text/plain leaves of a
// depth-first walk.
type walker struct {
	html, plain               string
	htmlCharset, plainCharset string
}

func (w *walker) walk(e *message.Entity) error {
	if mr := e.MultipartReader(); mr != nil {
		for {
			part, perr := mr.NextPart()
			if perr == io.EOF {
				return nil
			}
			if perr != nil {
				// Abandon the walk, but note that anything already collected
				// STANDS: extract only falls back to the raw body when this
				// error left it with no text leaf at all. A truncated multipart
				// usually still carries a usable first leaf, and v1's "abort the
				// whole message" throws that away.
				return fmt.Errorf("norm: next part: %w", perr)
			}
			if werr := w.walk(part); werr != nil {
				return werr
			}
		}
	}

	ct, params, _ := e.Header.ContentType()
	if ct != "text/html" && ct != "text/plain" {
		return nil
	}
	b, rerr := io.ReadAll(e.Body)
	if rerr != nil {
		// An undecodable leaf (bad base64, truncated part) is skipped, not
		// fatal. Partial bytes are discarded, as in v1.
		return nil
	}
	// Stage 3, applied per leaf.
	text := decodeUTF8WHATWG(b)
	cs := strings.ToLower(trimExplicit(params["charset"]))
	switch ct {
	case "text/html":
		if w.html == "" {
			w.html, w.htmlCharset = text, cs
		}
	case "text/plain":
		if w.plain == "" {
			w.plain, w.plainCharset = text, cs
		}
	}
	return nil
}

// rawBodyAfterHeaders returns everything after the first blank line, or the
// whole message when it has none.
func rawBodyAfterHeaders(raw []byte) []byte {
	crlf := bytes.Index(raw, []byte("\r\n\r\n"))
	lf := bytes.Index(raw, []byte("\n\n"))
	switch {
	case crlf >= 0 && (lf < 0 || crlf < lf):
		return raw[crlf+4:]
	case lf >= 0:
		return raw[lf+2:]
	default:
		return raw
	}
}

// ---------------------------------------------------------------------------
// Stage 3: the WHATWG UTF-8 decoder
// ---------------------------------------------------------------------------

// decodeUTF8WHATWG decodes UTF-8 with the WHATWG Encoding Standard's error
// handling: one U+FFFD per maximal subpart.
//
// This is deliberately neither strings.ToValidUTF8 (one U+FFFD per contiguous
// invalid run) nor a utf8.DecodeRune loop (one per byte). It is what
// TextDecoder does, so the Go and TypeScript normalizers agree on every
// message whose charset declaration is wrong — a class of disagreement that is
// invisible until the first such message arrives.
//
// A leading U+FEFF is NOT stripped: BOM handling belongs to the stage-8 trim
// set, which removes it wherever it lands. A TypeScript twin must therefore
// construct its decoder with {ignoreBOM: true}, whose confusing name means
// "pass the BOM through".
func decodeUTF8WHATWG(b []byte) string {
	// Fast path: already valid, and the overwhelming majority of real mail.
	if utf8.Valid(b) {
		return string(b)
	}
	var out strings.Builder
	out.Grow(len(b))

	var codepoint, needed, seen int
	lower, upper := byte(0x80), byte(0xBF)

	for i := 0; i < len(b); i++ {
		c := b[i]
		if needed == 0 {
			switch {
			case c <= 0x7F:
				out.WriteByte(c)
			case c >= 0xC2 && c <= 0xDF:
				needed, codepoint = 1, int(c&0x1F)
			case c >= 0xE0 && c <= 0xEF:
				if c == 0xE0 {
					lower = 0xA0
				}
				if c == 0xED {
					upper = 0x9F
				}
				needed, codepoint = 2, int(c&0x0F)
			case c >= 0xF0 && c <= 0xF4:
				if c == 0xF0 {
					lower = 0x90
				}
				if c == 0xF4 {
					upper = 0x8F
				}
				needed, codepoint = 3, int(c&0x07)
			default:
				out.WriteRune('�')
			}
			continue
		}
		if c < lower || c > upper {
			codepoint, needed, seen = 0, 0, 0
			lower, upper = 0x80, 0xBF
			out.WriteRune('�')
			i-- // reprocess this byte as a fresh lead
			continue
		}
		lower, upper = 0x80, 0xBF
		codepoint = codepoint<<6 | int(c&0x3F)
		seen++
		if seen < needed {
			continue
		}
		out.WriteRune(rune(codepoint))
		codepoint, needed, seen = 0, 0, 0
	}
	if needed != 0 {
		out.WriteRune('�')
	}
	return out.String()
}

// ---------------------------------------------------------------------------
// Stages 5-9: HTML strip, entities, whitespace, trim, join
// ---------------------------------------------------------------------------

var (
	scriptRe = regexp.MustCompile(`(?is)<script[^>]*>.*?</script>`)
	styleRe  = regexp.MustCompile(`(?is)<style[^>]*>.*?</style>`)
	tagRe    = regexp.MustCompile(`(?s)<[^>]+>`)
	wsRe     = regexp.MustCompile(`[ \t\x{00a0}]+`)
)

// blockTags are the five closing/void tags that become a newline BEFORE the
// generic tag rule runs. The list is exactly v1's; it is short because it was
// grown from real bank mail, not from the HTML spec.
var blockTags = []string{"<br>", "<br/>", "</p>", "</tr>", "</div>"}

func stripHTML(s string) string {
	s = scriptRe.ReplaceAllString(s, " ")
	s = styleRe.ReplaceAllString(s, " ")
	for _, t := range blockTags {
		s = strings.ReplaceAll(s, t, "\n")
	}
	return tagRe.ReplaceAllString(s, "\n")
}

// entities decodes exactly six named references and no others.
//
// strings.Replacer makes ONE left-to-right pass and never rescans what it just
// emitted, which is the behavior the contract requires: "&amp;lt;" becomes
// "&lt;" and stops. Six sequential replacements — the obvious TypeScript
// spelling — would go on to produce "<".
var entities = strings.NewReplacer(
	"&nbsp;", " ",
	"&amp;", "&",
	"&lt;", "<",
	"&gt;", ">",
	"&quot;", `"`,
	"&#39;", "'",
)

// trimCut is the explicit trim set: U+0009, U+000A, U+000B, U+000C, U+000D,
// U+0020, U+00A0, U+FEFF.
//
// It is deliberately neither Go's strings.TrimSpace (which also trims U+0085,
// U+2000-U+200A and U+202F, but NOT U+FEFF) nor JavaScript's String.trim()
// (which trims U+2000-U+200A and U+FEFF, but not U+0085 the same way). Naming
// the set explicitly is what makes the two implementations byte-identical.
const trimCut = "\t\n\v\f\r \u00a0\ufeff"

func trimExplicit(s string) string { return strings.Trim(s, trimCut) }

// trimmer is the line trim used by stages 8 and 10.
//
// Production ALWAYS uses trimExplicit; nothing outside a test may pass anything
// else. It exists so the corpus equivalence gate can establish its central
// claim — "the only way v2 differs from v1 on real mail is the trim set" — by
// running v2's own code with one character set swapped, instead of
// re-implementing the trim-bearing stages in the test. That distinction is not
// stylistic: a test-local re-implementation shares no code with the stage it
// stands in for, so a defect introduced into the real stage is reproduced by
// neither side of the substitution and gets absorbed into the "expected"
// bucket. Measured, not theorised — deleting the stage-6 entity decode altered
// 6,808 of 7,002 corpus messages and the re-implementing version of the gate
// classified every one as a trim-set difference and passed.
type trimmer func(string) string

// collapse runs stages 6-9.
func collapse(s string) string { return collapseWith(s, trimExplicit) }

// collapseWith is stages 6-9 with the line trim as a parameter. See [trimmer].
func collapseWith(s string, trim trimmer) string {
	s = entities.Replace(s)
	s = wsRe.ReplaceAllString(s, " ")
	var lines []string
	for _, l := range strings.Split(s, "\n") {
		if t := trim(l); t != "" {
			lines = append(lines, t)
		}
	}
	return strings.Join(lines, "\n")
}

// ---------------------------------------------------------------------------
// Headers
// ---------------------------------------------------------------------------

// wordDecoder decodes RFC 2047 encoded words. Its charset lookup is the WHATWG
// Encoding Standard's label table (golang.org/x/text/encoding/htmlindex is that
// table), which is exactly what a TypeScript TextDecoder resolves, so an
// encoded word in a legacy charset decodes the same in both.
var wordDecoder = mime.WordDecoder{
	CharsetReader: func(label string, input io.Reader) (io.Reader, error) {
		enc, err := htmlindex.Get(label)
		if err != nil || enc == nil {
			return nil, fmt.Errorf("norm: unsupported charset %q", label)
		}
		return enc.NewDecoder().Reader(input), nil
	},
}

// decodeWords applies RFC 2047 decoding, falling back to the raw value when the
// header is not decodable. Adjacent encoded words join with no separator, which
// is what splits a long Subject across two words in real mail.
func decodeWords(v string) string {
	v = trimExplicit(v)
	if v == "" {
		return ""
	}
	if out, err := wordDecoder.DecodeHeader(v); err == nil {
		return out
	}
	return v
}

// bareAddress reduces a From header to the address alone ("a@b.c"), which is
// what v1's IMAP envelope supplied to the parse cascade.
func bareAddress(v string) string {
	v = trimExplicit(v)
	if v == "" {
		return ""
	}
	if list, err := mail.ParseAddressList(v); err == nil && len(list) > 0 {
		return list[0].Address
	}
	if a, err := mail.ParseAddress(v); err == nil {
		return a.Address
	}
	// Junk header: recover an angle-addr by hand rather than losing it.
	if i := strings.LastIndex(v, "<"); i >= 0 {
		if j := strings.Index(v[i:], ">"); j > 0 {
			return trimExplicit(v[i+1 : i+j])
		}
	}
	return v
}

// scanRawHeaders recovers Subject and From from a message whose MIME structure
// did not parse. It is used ONLY on the raw-fallback path; the normal path
// reads them from the parsed header.
//
// Folding is undone by joining a continuation line to its predecessor with a
// single U+0020 after trimming, which keeps adjacent RFC 2047 words adjacent.
func scanRawHeaders(raw []byte) (subject, from string) {
	head := raw
	if b := rawBodyAfterHeaders(raw); len(b) < len(raw) {
		head = raw[:len(raw)-len(b)]
	}
	s := strings.ReplaceAll(string(head), "\r\n", "\n")

	var fields []string
	for _, line := range strings.Split(s, "\n") {
		if line == "" {
			continue
		}
		if (line[0] == ' ' || line[0] == '\t') && len(fields) > 0 {
			fields[len(fields)-1] += " " + trimExplicit(line)
			continue
		}
		fields = append(fields, line)
	}
	for _, f := range fields {
		i := strings.Index(f, ":")
		if i < 0 {
			continue
		}
		name := strings.ToLower(trimExplicit(f[:i]))
		value := f[i+1:]
		switch name {
		case "subject":
			if subject == "" {
				subject = decodeWords(value)
			}
		case "from":
			if from == "" {
				from = bareAddress(decodeWords(value))
			}
		}
	}
	return subject, from
}
