package tmpl

// witness.go answers one question about a definition: which of its own gate
// literals, if any, are evidence of HOW the message it matched was decoded.
//
// # Why a template can answer that at all
//
// A DKIM signature covers the body BYTES. Content-Type and
// Content-Transfer-Encoding decide how those bytes become text, and a signer
// that omits them from h= leaves whoever holds the message free to rewrite one
// IN PLACE — the signature still verifies, and the same signed bytes decode
// into different text (origin.DecodingHeaders says this in full).
//
// A gate literal is checked against the DECODED text. So a literal that
// survives the decode is a measurement of the decode: the bytes really did
// come out as the characters the template's author saw when they wrote it.
// That is only worth anything if the literal could NOT have survived a
// different decode, which is what [Definition.DecodeWitnesses] selects for.
//
// # This is server-side only
//
// The dual-executor contract (spec section 3.5) is about what the two
// executors EXTRACT. Nothing here feeds an extraction: it feeds the ingest
// pipeline's auto-trust decision, which the client reads off the op payload
// rather than re-deriving. There is deliberately no TypeScript mirror.

import "unicode/utf8"

// DecodeWitnesses returns the Match.BodyContains literals that witness the
// decode — the ones whose presence in the decoded text could not have been
// produced by a decode other than the intended one.
//
// The rule is that the literal must contain at least one non-ASCII rune, and
// it is the whole of the security argument, so it is worth stating why nothing
// weaker will do:
//
//   - An ASCII-only literal witnesses NOTHING. Every charset a mail decoder
//     will accept — utf-8, the ISO-8859 family, the Windows code pages —
//     agrees with US-ASCII on the low 128, so "Purchase alert" reads
//     identically under all of them. Rewriting the charset of a message gated
//     on an ASCII literal leaves the gate passing while the text around it
//     changes.
//   - A literal with a non-ASCII rune pins the charset for the bytes that
//     produced it: the same bytes that read as Arabic under utf-8 read as
//     Latin-1 mojibake under iso-8859-1, and there is no second charset in
//     play that maps one to the other. It equally pins the transfer decoding
//     whenever the bank's own encoding is base64 or quoted-printable, because
//     the literal is simply not present in the undecoded form.
//
// Only Match.BodyContains is eligible, and both exclusions are load-bearing:
//
//   - Match.SubjectContains is checked against the effective SUBJECT, a
//     different string from the body text an extraction reads. A witness has
//     to be a measurement of the text that produced the amount.
//   - Match.BodyNotContains is an ABSENCE. Absence is exactly what a mis-decode
//     manufactures, so treating it as evidence would read the attack as proof
//     that no attack happened.
//
// The caller must still check that these literals are present in the text the
// extraction actually read. This function reports what CAN witness, never what
// did; see ingest.decodeWitnessed.
func (d Definition) DecodeWitnesses() []string {
	var out []string
	for _, s := range d.Match.BodyContains {
		if hasNonASCII(s) {
			out = append(out, s)
		}
	}
	return out
}

// hasNonASCII reports whether s contains a byte outside US-ASCII. Bytes rather
// than runes: any rune above U+007F is multi-byte in UTF-8 and every one of
// those bytes is >= utf8.RuneSelf, so the byte scan and the rune scan agree,
// and the byte scan cannot be fooled by invalid UTF-8 into reading a high byte
// as U+FFFD.
func hasNonASCII(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] >= utf8.RuneSelf {
			return true
		}
	}
	return false
}
