package diag

import (
	"crypto/sha256"
	"encoding/hex"
	"strings"
	"unicode"
	"unicode/utf8"
)

// shapeLimit bounds how much of a body can influence the fingerprint. It
// applies to the SHAPE, not to the input: a 1 MB body whose layout repeats
// still fingerprints on its first 4 KB of structure, and a hostile sender
// cannot make the digest expensive.
const shapeLimit = 4 << 10

// The four class symbols. Everything the shape emits is one of these, a
// punctuation/symbol rune kept verbatim, a newline, or a single space.
const (
	symDigit  = '0'
	symASCII  = 'A'
	symArabic = 'B'
	symOther  = 'C'
)

// StructureSig returns a content-free fingerprint of a normalized body's
// LAYOUT: 32 lower-case hex characters, the first 16 bytes of the SHA-256 of
// the shape string.
//
// Two emails of the same layout with different amounts and different merchants
// produce the same signature; a different layout produces a different one. That
// is the whole contract, and it is what makes the signature useful for "every
// message from this bank changed shape on the 3rd" without it being useful for
// "what did this person buy".
//
// # Why it is safe to store
//
// The digest commits to shape(), which by construction contains no letter and
// no digit from the input — see [shape]. Even that shape string is not
// recoverable from the stored value, because what is stored is a 128-bit
// truncated hash; only equality between two signatures is observable. A
// preimage search over the shape space recovers, at most, the layout, which is
// exactly what spec §2 discloses this column reveals.
func StructureSig(normalized string) string {
	sum := sha256.Sum256([]byte(shape(normalized)))
	return hex.EncodeToString(sum[:16])
}

// shape reduces text to its structure. It is unexported and tested in-package
// because the content-free property is asserted directly against its output —
// a test that could only see the digest could not tell a leak from a hash.
//
// The rules, and why each one is drawn where it is:
//
//   - A run of digits, INCLUDING internal thousands/decimal separators between
//     digit groups, becomes a single "0". "250.00" and "9,912.45" are the same
//     token, because the number of digit groups in an amount is a property of
//     the amount, not of the template.
//   - A run of ASCII letters becomes "A", of Arabic-script letters "B", and of
//     letters in any other script "C". The catch-all matters: without it a
//     Cyrillic or CJK merchant name would fall through to "keep verbatim" and
//     survive into the hashed string, which is exactly the leak this function
//     exists to prevent.
//   - ADJACENT RUNS OF THE SAME CLASS SEPARATED ONLY BY SPACES COLLAPSE.
//     "CARREFOUR" and "SPINNEYS ABU DHABI" both become "A". Word count is a
//     content signal — it tracks how long a merchant's name is — and it is not
//     a layout signal worth keeping. Runs separated by punctuation or a newline
//     do NOT collapse, because that separation IS the layout.
//   - Punctuation and symbols are kept verbatim, and line structure is kept.
//     These carry the template's skeleton ("Amount:", the line breaks between
//     labels and values) and carry no content.
//   - Combining marks and bidi/format controls are dropped. Arabic harakat and
//     RLM/LRM are invisible decorations that differ between mailers; keeping
//     them would make the same template fingerprint differently depending on
//     the sender's client.
//   - Line endings are normalized and leading/trailing whitespace is trimmed,
//     so CRLF, CR and trailing padding do not move the signature.
func shape(s string) string {
	var b strings.Builder
	rs := []rune(s)
	// last is the most recently emitted rune: a class symbol, a punctuation
	// rune, or '\n'. It is what makes the collapse rule "same class across
	// spaces only" rather than "same class ever".
	var last rune
	pendingSpace := false

	// writeSpace emits the deferred space, unless it would be leading on the
	// whole shape or leading on a line.
	writeSpace := func() {
		if pendingSpace && b.Len() > 0 && last != '\n' {
			b.WriteByte(' ')
		}
		pendingSpace = false
	}
	emit := func(class rune) {
		if last == class {
			pendingSpace = false // same class across spaces: collapse
			return
		}
		writeSpace()
		b.WriteRune(class)
		last = class
	}
	newline := func() {
		pendingSpace = false
		b.WriteByte('\n')
		last = '\n'
	}

	for i := 0; i < len(rs); {
		r := rs[i]
		switch {
		case r == '\r':
			i++
			if i < len(rs) && rs[i] == '\n' {
				i++
			}
			newline()
		case r == '\n':
			i++
			newline()
		case skippable(r):
			i++
		case unicode.IsSpace(r):
			pendingSpace = true
			i++
		case unicode.IsDigit(r):
			i = consumeNumber(rs, i)
			emit(symDigit)
		default:
			class, ok := letterClass(r)
			if !ok {
				// Punctuation or a symbol: kept verbatim, and it breaks any
				// collapse run because the separation is layout.
				writeSpace()
				b.WriteRune(r)
				last = r
				i++
				continue
			}
			i = consumeRun(rs, i, class)
			emit(class)
		}
	}

	out := strings.TrimSpace(b.String())
	if len(out) > shapeLimit {
		out = out[:shapeLimit]
		// Punctuation is kept verbatim and may be multi-byte, so the cut can
		// land mid-rune. Back off until the tail decodes.
		for len(out) > 0 {
			if r, size := utf8.DecodeLastRuneInString(out); r == utf8.RuneError && size <= 1 {
				out = out[:len(out)-1]
				continue
			}
			break
		}
	}
	return out
}

// consumeNumber consumes a whole number token starting at a digit: digit runs
// joined by separators that sit BETWEEN digits. A trailing '.' at the end of a
// sentence is not swallowed, because the character after it is not a digit.
func consumeNumber(rs []rune, i int) int {
	j := i
	for j < len(rs) && unicode.IsDigit(rs[j]) {
		j++
	}
	for j+1 < len(rs) && numSep(rs[j]) && unicode.IsDigit(rs[j+1]) {
		j++
		for j < len(rs) && unicode.IsDigit(rs[j]) {
			j++
		}
	}
	return j
}

// numSep is the set of characters that can sit inside a number: ASCII comma and
// full stop, the apostrophe used as a group separator in some locales, and the
// Arabic decimal and thousands separators.
func numSep(r rune) bool {
	switch r {
	case ',', '.', '\'', '٫', '٬':
		return true
	}
	return false
}

// consumeRun consumes a maximal run of one letter class, absorbing the marks
// and format controls that decorate it.
func consumeRun(rs []rune, i int, class rune) int {
	j := i
	for j < len(rs) {
		if skippable(rs[j]) {
			j++
			continue
		}
		c, ok := letterClass(rs[j])
		if !ok || c != class {
			break
		}
		j++
	}
	return j
}

// letterClass maps a letter (or a non-decimal numeric like ½) to its class.
// Decimal digits never reach here; they are consumed as number tokens first.
func letterClass(r rune) (rune, bool) {
	if !unicode.IsLetter(r) && !unicode.IsNumber(r) {
		return 0, false
	}
	if r < utf8.RuneSelf {
		return symASCII, true
	}
	if unicode.Is(unicode.Arabic, r) {
		return symArabic, true
	}
	// Every other script shares one class. A script this function does not name
	// must still be classed, never passed through verbatim.
	return symOther, true
}

// skippable reports runes that are dropped outright: combining marks and
// bidi/format controls (invisible content decoration), and stray control
// characters. Tab, CR and LF are whitespace or structure and are handled by the
// caller before this is consulted.
func skippable(r rune) bool {
	switch r {
	case '\t', '\n', '\r':
		return false
	}
	if unicode.In(r, unicode.Mn, unicode.Mc, unicode.Me, unicode.Cf) {
		return true
	}
	return unicode.IsControl(r)
}
