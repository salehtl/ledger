package norm

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	gocharset "github.com/emersion/go-message/charset"

	"golang.org/x/text/encoding/htmlindex"
)

// This file generates the two artifacts the TypeScript twin cannot derive for
// itself, and then checks that what is committed is what this build would
// generate today.
//
//   - client/src/norm/charset-tables.ts — the byte tables of every legacy
//     charset the Go normalizer can decode. TypeScript cannot use TextDecoder
//     for this. Bun 1.3's TextDecoder does not implement windows-1256 AT ALL —
//     the corpus's only non-UTF-8 charset, 110 messages — and where both do
//     implement a label they disagree, because TextDecoder follows the WHATWG
//     index and golang.org/x/text/encoding/charmap follows the Unicode
//     consortium's mapping files. Measured, not assumed: windows-1252 differs
//     at 5 of 256 bytes (0x81, 0x8D, 0x8F, 0x90, 0x9D — U+FFFD in Go, the C1
//     control in WHATWG) and iso-8859-6 at 32. Generating the tables from the
//     registry the Go normalizer actually uses is the only way the two
//     executors can be byte-identical by construction rather than by hope.
//
//   - conformance/normalizer/edge-cases.json — Go-authored expectations for the
//     input classes the 7,002-message corpus contains ZERO of: quoted-printable
//     leniency, malformed base64, unknown charsets and transfer encodings,
//     broken MIME trees, header recovery. The corpus fixtures pin what real
//     bank mail does; these pin what the contract says about everything else,
//     which is exactly where two independent implementations drift apart.
//
// Both are regenerated with
//
//	LEDGER_WRITE_CONFORMANCE=1 go test ./internal/v2/norm/ -run TestWriteTwinArtifacts
//
// and both have a freshness test below that runs unconditionally.

const (
	charsetTablesPath = "../../../client/src/norm/charset-tables.ts"
	edgeCasesPath     = conformanceDir + "/edge-cases.json"
)

// ---------------------------------------------------------------------------
// Charset classification
// ---------------------------------------------------------------------------

// charsetKind is how the TypeScript twin must treat a declared charset label.
type charsetKind string

const (
	// kindPassthrough: the bytes reach stage 3 undecoded and NO error is raised.
	// The two labels go-message short-circuits ("utf-8", "us-ascii") and every
	// label whose resolved encoding is UTF-8 anyway.
	kindPassthrough charsetKind = "passthrough"
	// kindUnresolved: the bytes ALSO reach stage 3 undecoded, because go-message
	// leaves the body untouched when its registry cannot resolve the label — but
	// it additionally returns an UnknownCharsetError, and that error is only
	// tolerated on the TOP-LEVEL entity. On a sub-part it comes back out of
	// NextPart and aborts the whole walk, which is why this cannot be folded into
	// kindPassthrough even though the two produce identical text.
	kindUnresolved charsetKind = "unresolved"
	// kindSingleByte: a 256-entry byte table, reproduced exactly in TypeScript.
	kindSingleByte charsetKind = "single-byte"
	// kindUnsupported: Go decodes it with a stateful or multi-byte codec that
	// TypeScript has no byte-identical equivalent for. The twin THROWS rather
	// than guessing — see the contract note in charset.ts.
	kindUnsupported charsetKind = "unsupported"
)

// charsetLabels is the candidate list the tables are generated from.
//
// The corpus needs exactly three of these (utf-8: 6,905 leaves, windows-1256:
// 110, us-ascii: 1). The rest are here so that a bank that switches encoding
// tomorrow lands on a table rather than on the divergence class: every label
// listed resolves through the SAME registry the Go normalizer uses, so whatever
// this generator records is by definition what Go does.
var charsetLabels = []string{
	// what the corpus actually contains
	"utf-8", "us-ascii", "windows-1256",
	// utf-8 aliases and near-misses
	"utf8", "utf_8", "unicode-1-1-utf-8", "ascii", "iso-ir-6", "ansi_x3.4-1968",
	"ansi_x3.4-1986", "cp367", "csascii", "ibm367", "iso646-us", "us",
	// the two go-message quirk labels
	"ansi_x3.110-1983", "x-utf_8j",
	// arabic
	"cp1256", "windows_1256", "x-cp1256", "ms-arab", "iso-8859-6", "iso_8859-6",
	"arabic", "csisolatinarabic", "asmo-708", "ecma-114", "iso-ir-127",
	// western european and the rest of the windows-125x family
	"windows-1250", "windows-1251", "windows-1252", "windows-1253", "windows-1254",
	"windows-1255", "windows-1257", "windows-1258", "cp1250", "cp1251", "cp1252",
	"cp1253", "cp1254", "cp1255", "cp1257", "cp1258", "x-cp1252",
	"iso-8859-1", "iso_8859-1", "iso8859-1", "latin1", "l1", "csisolatin1",
	"iso-ir-100", "cp819", "ibm819",
	"iso-8859-2", "iso-8859-3", "iso-8859-4", "iso-8859-5", "iso-8859-7",
	"iso-8859-8", "iso-8859-9", "iso-8859-10", "iso-8859-13", "iso-8859-14",
	"iso-8859-15", "iso-8859-16", "latin2", "latin3", "latin4", "latin5", "latin6",
	// cyrillic, greek, thai, mac
	"koi8-r", "koi8-u", "macintosh", "mac", "csmacintosh", "x-mac-cyrillic",
	"windows-874", "tis-620", "ibm866", "cp866",
	// ibm code pages that turn up in bank gateways
	"ibm037", "ibm437", "ibm850", "ibm852", "ibm855", "ibm858", "ibm860",
	"ibm862", "ibm863", "ibm865", "cp437", "cp850",
	// multi-byte: listed so the generator can CLASSIFY them as the divergence
	// class rather than silently leaving them to the passthrough default
	"utf-16", "utf-16le", "utf-16be", "unicodefffe", "csunicode", "iso-10646-ucs-2",
	"utf-32", "utf-32le", "utf-32be",
	"gb2312", "gbk", "gb18030", "big5", "big5-hkscs", "euc-jp", "euc-kr",
	"shift_jis", "sjis", "ms_kanji", "iso-2022-jp", "iso-2022-kr", "iso-2022-cn",
	// deliberately unresolvable, to pin the passthrough default
	"x-nope", "unknown-8bit",
}

// utf8ProbeInputs decide whether a resolved encoding is UTF-8 in disguise. A
// label that decodes byte-identically to the stage-3 WHATWG UTF-8 decoder needs
// no table: passthrough already produces the same answer in both executors.
var utf8ProbeInputs = [][]byte{
	[]byte("plain ascii"),
	{0xD8, 0xA7, 0xD9, 0x84, 0xD8, 0xB9}, // arabic, valid utf-8
	{0x41, 0xE2, 0x82},                   // truncated 3-byte
	{0x41, 0xC0, 0x80, 0x42},             // overlong
	{0xEF, 0xBB, 0xBF, 0x41},             // BOM
	{0x41, 0xF5, 0x80, 0x80, 0x80, 0x42}, // out of range
	{0x80, 0x81, 0x82},                   // bare continuations
	{0x41, 0xED, 0xA0, 0x80, 0x42},       // surrogate
	{0xF0, 0x9F, 0x92, 0xA9},             // 4-byte
	{0x00, 0x01, 0x7F, 0x80, 0xFF},       // mixed
}

// classifyDecoder is the shared single-byte / stateful / UTF-8-alike probe. It
// takes the decode function so the two registries below are classified by the
// SAME logic — the body path (go-message's charsetReader) and the RFC 2047 word
// path (htmlindex alone) resolve labels differently, and each has to be
// measured against its own registry rather than assumed to match the other.
func classifyDecoder(dec func([]byte) ([]byte, error)) (kind charsetKind, table []rune, note string) {
	if _, err := dec([]byte("a")); err != nil {
		return kindUnresolved, nil, "registry cannot resolve"
	}
	utf8Like := true
	for _, in := range utf8ProbeInputs {
		got, err := dec(in)
		if err != nil || string(got) != decodeUTF8WHATWG(in) {
			utf8Like = false
			break
		}
	}
	if utf8Like {
		return kindPassthrough, nil, "resolves to UTF-8; identical to passthrough"
	}
	all := make([]byte, 256)
	for i := range all {
		all[i] = byte(i)
	}
	streamOut, err := dec(all)
	if err != nil {
		return kindUnsupported, nil, "stream decode failed"
	}
	streamRunes := []rune(string(streamOut))
	if len(streamRunes) != 256 {
		return kindUnsupported, nil, fmt.Sprintf("stateful or multi-byte: 256 bytes decoded to %d runes", len(streamRunes))
	}
	tab := make([]rune, 256)
	for i := 0; i < 256; i++ {
		one, derr := dec([]byte{byte(i)})
		if derr != nil {
			return kindUnsupported, nil, fmt.Sprintf("byte 0x%02x failed standalone", i)
		}
		rs := []rune(string(one))
		if len(rs) != 1 || rs[0] != streamRunes[i] {
			return kindUnsupported, nil, fmt.Sprintf("byte 0x%02x is context-dependent", i)
		}
		tab[i] = rs[0]
	}
	applyTable := func(b []byte) string {
		var sb strings.Builder
		for _, c := range b {
			sb.WriteRune(tab[c])
		}
		return sb.String()
	}
	var stateProbes [][]byte
	for _, lead := range []byte{0x1B, 0x0E, 0x0F, 0x8E, 0x8F, 0x24, 0x28} {
		for i := 0; i < 256; i++ {
			stateProbes = append(stateProbes, []byte{lead, byte(i)}, []byte{lead, byte(i), byte(255 - i)})
		}
	}
	for _, inter := range []byte{0x24, 0x28, 0x29, 0x2A, 0x2B, 0x2C, 0x2D, 0x2E, 0x2F, 0x4E, 0x4F, 0x6E, 0x6F} {
		for i := 0; i < 256; i++ {
			stateProbes = append(stateProbes,
				[]byte{0x1B, inter, byte(i), 0x41, 0x42},
				[]byte{0x1B, inter, byte(i), 0x30, 0x21, 0x41})
		}
	}
	for i := 0; i < 256; i++ {
		stateProbes = append(stateProbes, []byte{byte(i), byte(i)}, []byte{byte(i), 0x41, byte(255 - i)})
	}
	for _, probe := range stateProbes {
		got, derr := dec(probe)
		if derr != nil {
			return kindUnsupported, nil, fmt.Sprintf("sequence % x failed to decode", probe)
		}
		if string(got) != applyTable(probe) {
			return kindUnsupported, nil, fmt.Sprintf("stateful: sequence % x is not the concatenation of its bytes", probe)
		}
	}
	return kindSingleByte, tab, "single-byte table"
}

// resolveWordCharsetLabel classifies a label for the RFC 2047 WORD path, which
// goes through htmlindex ALONE — norm's mime.WordDecoder is wired straight to
// htmlindex.Get, not to go-message's four-step chain. The two genuinely differ:
// "ansi_x3.110-1983" is an ISO-8859-1 alias for a body and is unknown to a word,
// and every ianaindex-only name (ibm037, iso-8859-16, …) is the same story.
// mime.WordDecoder's own utf-8 / iso-8859-1 / us-ascii branches are handled in
// the TypeScript twin before this map is consulted, exactly as Go handles them
// before calling CharsetReader.
func resolveWordCharsetLabel(label string) (charsetKind, []rune, string) {
	low := strings.ToLower(label)
	return classifyDecoder(func(b []byte) ([]byte, error) {
		enc, err := htmlindex.Get(low)
		if err != nil || enc == nil {
			return nil, fmt.Errorf("norm: unsupported charset %q", low)
		}
		return io.ReadAll(enc.NewDecoder().Reader(bytes.NewReader(b)))
	})
}

// resolveCharsetLabel reproduces go-message's charsetReader dispatch exactly:
// the "utf-8"/"us-ascii" short circuit first, then the registry, then the
// body-untouched behaviour when the registry fails.
func resolveCharsetLabel(label string) (kind charsetKind, table []rune, resolvedNote string) {
	low := strings.ToLower(label)
	if low == "utf-8" || low == "us-ascii" {
		return kindPassthrough, nil, "go-message short-circuit (no conversion)"
	}
	k, t, note := classifyDecoder(func(b []byte) ([]byte, error) {
		r, err := gocharset.Reader(low, bytes.NewReader(b))
		if err != nil {
			return nil, err
		}
		return io.ReadAll(r)
	})
	if k == kindUnresolved {
		note = "registry cannot resolve; body undecoded AND UnknownCharsetError"
	}
	return k, t, note
}

// buildCharsetTablesTS renders the generated TypeScript module.
func buildCharsetTablesTS() string {
	type entry struct {
		label string
		kind  charsetKind
		table []rune
		note  string
	}
	var entries []entry
	seen := map[string]bool{}
	for _, l := range charsetLabels {
		low := strings.ToLower(l)
		if seen[low] {
			continue
		}
		seen[low] = true
		k, tab, note := resolveCharsetLabel(low)
		entries = append(entries, entry{low, k, tab, note})
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].label < entries[j].label })

	// Deduplicate identical tables: many labels alias one encoding.
	tableIndex := map[string]int{} // table contents -> index
	var tables []string
	tableKeyOf := func(t []rune) int {
		var b strings.Builder
		for _, r := range t {
			b.WriteRune(r)
		}
		key := b.String()
		if i, ok := tableIndex[key]; ok {
			return i
		}
		tableIndex[key] = len(tables)
		tables = append(tables, key)
		return len(tables) - 1
	}

	var passthrough, unresolved, unsupported []entry
	byLabelTable := map[string]int{}
	for _, e := range entries {
		switch e.kind {
		case kindPassthrough:
			passthrough = append(passthrough, e)
		case kindUnresolved:
			unresolved = append(unresolved, e)
		case kindUnsupported:
			unsupported = append(unsupported, e)
		case kindSingleByte:
			byLabelTable[e.label] = tableKeyOf(e.table)
		}
	}

	var b strings.Builder
	b.WriteString(`// Code generated by internal/v2/norm TestWriteTwinArtifacts. DO NOT EDIT.
//
// Regenerate with:
//   LEDGER_WRITE_CONFORMANCE=1 go test ./internal/v2/norm/ -run TestWriteTwinArtifacts
//
// These tables are the byte-for-byte behaviour of the charset registry the Go
// normalizer uses (github.com/emersion/go-message/charset, which resolves
// ianaindex.MIME -> "cs"-prefix retry -> htmlindex, plus two hand-added
// quirks). They exist because the platform TextDecoder CANNOT stand in for it:
// Bun 1.3 does not implement windows-1256 at all — the corpus's only non-UTF-8
// charset — and where both implement a label they disagree, because
// TextDecoder follows the WHATWG index while x/text/encoding/charmap follows
// the Unicode consortium's mapping files (windows-1252 differs at 5 of 256
// bytes, iso-8859-6 at 32).
//
// Each table is a 256-character string: table[byte] is the character that byte
// decodes to. U+FFFD marks a byte the encoding leaves undefined.

`)
	b.WriteString("/** How the normalizer must treat a declared charset label. */\n")
	b.WriteString("export type CharsetKind = \"passthrough\" | \"unresolved\" | \"single-byte\" | \"unsupported\";\n\n")

	b.WriteString("/** Byte tables, deduplicated: many labels alias one encoding. */\nconst TABLES: readonly string[] = [\n")
	for _, t := range tables {
		b.WriteString("  \"")
		for _, r := range t {
			b.WriteString(escapeTSRune(r))
		}
		b.WriteString("\",\n")
	}
	b.WriteString("];\n\n")

	b.WriteString("/** Labels decoded through a single-byte table. */\nconst SINGLE_BYTE: Readonly<Record<string, number>> = {\n")
	var sbLabels []string
	for l := range byLabelTable {
		sbLabels = append(sbLabels, l)
	}
	sort.Strings(sbLabels)
	for _, l := range sbLabels {
		fmt.Fprintf(&b, "  %q: %d,\n", l, byLabelTable[l])
	}
	b.WriteString("};\n\n")

	b.WriteString("/**\n * Labels Go decodes with a stateful or multi-byte codec.\n *\n * The twin THROWS for these rather than producing bytes Go would not produce.\n * A loud, deterministic failure is the only honest option: silently passing the\n * bytes through would turn a UTF-16 body into U+FFFD soup that still \"parses\",\n * and guessing with TextDecoder would disagree with Go on the undefined\n * positions. The corpus contains none of them.\n */\nconst UNSUPPORTED: readonly string[] = [\n")
	for _, e := range unsupported {
		fmt.Fprintf(&b, "  %q, // %s\n", e.label, e.note)
	}
	b.WriteString("];\n\n")

	b.WriteString("/**\n * Labels whose bytes reach stage 3 undecoded with NO error raised: the two\n * labels go-message short-circuits, and labels that resolve to UTF-8 anyway.\n */\nconst PASSTHROUGH: readonly string[] = [\n")
	for _, e := range passthrough {
		fmt.Fprintf(&b, "  %q, // %s\n", e.label, e.note)
	}
	b.WriteString("];\n\n")
	b.WriteString("/**\n * Labels the registry cannot resolve. Same undecoded bytes as PASSTHROUGH,\n * but go-message ALSO returns UnknownCharsetError, which is tolerated on the\n * top-level entity and fatal to a sub-part walk. Listed for the record; an\n * unlisted label lands here too, via the default in classifyCharset.\n */\nconst UNRESOLVED: readonly string[] = [\n")
	for _, e := range unresolved {
		fmt.Fprintf(&b, "  %q, // %s\n", e.label, e.note)
	}
	b.WriteString("];\nvoid UNRESOLVED;\n\n")

	// The RFC 2047 word path, classified against htmlindex alone.
	wordSingle := map[string]int{}
	var wordUnsupported []entry
	for _, e := range entries {
		k, tab, note := resolveWordCharsetLabel(e.label)
		switch k {
		case kindSingleByte:
			wordSingle[e.label] = tableKeyOf(tab)
		case kindUnsupported:
			wordUnsupported = append(wordUnsupported, entry{e.label, k, nil, note})
		}
	}
	b.WriteString("/**\n * Labels for the RFC 2047 encoded-word path, which resolves through\n * htmlindex ALONE — the word decoder is wired straight to it, not to the\n * four-step chain the body path uses. The two differ: \"ansi_x3.110-1983\" is an\n * ISO-8859-1 alias for a body and unknown to a word, and every ianaindex-only\n * name behaves the same way.\n *\n * mime.WordDecoder handles utf-8, iso-8859-1 and us-ascii itself, BEFORE this\n * map is reached, and its iso-8859-1 is true Latin-1 while its us-ascii emits\n * one U+FFFD per high byte. Those three are handled in mime.ts, not here.\n */\nconst WORD_SINGLE_BYTE: Readonly<Record<string, number>> = {\n")
	var wordLabels []string
	for l := range wordSingle {
		wordLabels = append(wordLabels, l)
	}
	sort.Strings(wordLabels)
	for _, l := range wordLabels {
		fmt.Fprintf(&b, "  %q: %d,\n", l, wordSingle[l])
	}
	b.WriteString("};\n\n")
	b.WriteString("/** Word-path labels htmlindex resolves to a multi-byte or stateful codec. */\nconst WORD_UNSUPPORTED: readonly string[] = [\n")
	for _, e := range wordUnsupported {
		fmt.Fprintf(&b, "  %q, // %s\n", e.label, e.note)
	}
	b.WriteString("];\n\n")

	b.WriteString(`const WORD_UNSUPPORTED_SET = new Set(WORD_UNSUPPORTED);

/**
 * Classifies a charset named by an RFC 2047 encoded word.
 *
 * "unresolved" here means htmlindex does not know the label, and Go's word
 * decoder then fails the word, which makes decodeWords keep the field's RAW
 * value. That is a different outcome from the body path's "unresolved", where
 * the bytes still flow through undecoded.
 */
export function classifyWordCharset(label: string): { kind: CharsetKind; table?: string } {
  const low = label.toLowerCase();
  if (WORD_UNSUPPORTED_SET.has(low)) return { kind: "unsupported" };
  const idx = WORD_SINGLE_BYTE[low];
  if (idx !== undefined) return { kind: "single-byte", table: TABLES[idx]! };
  return { kind: "unresolved" };
}

const PASSTHROUGH_SET = new Set(PASSTHROUGH);
const UNSUPPORTED_SET = new Set(UNSUPPORTED);

/**
 * Classifies a declared charset label exactly as go-message's charsetReader
 * dispatch does.
 *
 * An unlisted label is "unresolved", not "passthrough". The two produce the
 * same text — go-message leaves the body undecoded either way — but only
 * "unresolved" also raises the UnknownCharsetError that aborts a sub-part walk
 * and sends the message down the raw-body fallback. Defaulting to the quieter
 * of the two would silently disagree with Go on every message carrying an
 * exotic charset in a sub-part.
 */
export function classifyCharset(label: string): { kind: CharsetKind; table?: string } {
  const low = label.toLowerCase();
  if (PASSTHROUGH_SET.has(low)) return { kind: "passthrough" };
  if (UNSUPPORTED_SET.has(low)) return { kind: "unsupported" };
  const idx = SINGLE_BYTE[low];
  if (idx !== undefined) return { kind: "single-byte", table: TABLES[idx]! };
  return { kind: "unresolved" };
}

/** Every label this module knows about, for the freshness test. */
export const KNOWN_LABELS: readonly string[] = [
`)
	for _, e := range entries {
		fmt.Fprintf(&b, "  %q,\n", e.label)
	}
	b.WriteString("];\n")
	return b.String()
}

// escapeTSRune renders one rune as a TypeScript string-literal fragment.
func escapeTSRune(r rune) string {
	switch r {
	case '"':
		return `\"`
	case '\\':
		return `\\`
	case '\n':
		return `\n`
	case '\r':
		return `\r`
	case '\t':
		return `\t`
	}
	if r < 0x20 || r == 0x7F || r > 0x7E {
		return fmt.Sprintf(`\u{%x}`, r)
	}
	return string(r)
}

// ---------------------------------------------------------------------------
// Edge-case fixtures: the input classes the corpus has none of
// ---------------------------------------------------------------------------

type edgeCase struct {
	Name  string `json:"name"`
	Class string `json:"class"`
	Note  string `json:"note,omitempty"`
	Raw   string `json:"raw_base64"`

	ExpectError         string `json:"expect_error"` // "" | "no_text_part"
	ExpectTextBase64    string `json:"expect_text_base64"`
	ExpectPart          string `json:"expect_part"`
	ExpectCharset       string `json:"expect_charset"`
	ExpectSubjectBase64 string `json:"expect_subject_base64"`
	ExpectFromBase64    string `json:"expect_from_base64"`
	ExpectForwarded     bool   `json:"expect_forwarded"`
	ExpectEmailDate     string `json:"expect_email_date"`
	ExpectDateSource    string `json:"expect_date_source"`
}

// edgeInputs are built here rather than loaded, so the file is the record of
// what was asked as well as what was answered.
func edgeInputs() []struct{ Name, Class, Note, Raw string } {
	hdr := "From: a@b.c\r\nSubject: Hi\r\nMIME-Version: 1.0\r\n"
	textPlain := func(cte, body string) string {
		s := hdr + "Content-Type: text/plain; charset=utf-8\r\n"
		if cte != "" {
			s += "Content-Transfer-Encoding: " + cte + "\r\n"
		}
		return s + "\r\n" + body
	}
	withCharset := func(label, b64 string) string {
		return hdr + "Content-Type: text/plain; charset=\"" + label + "\"\r\n" +
			"Content-Transfer-Encoding: base64\r\n\r\n" + b64 + "\r\n"
	}
	mp := func(body string) string {
		return hdr + "Content-Type: multipart/alternative; boundary=\"BND\"\r\n\r\n" + body
	}
	// A short arabic phrase in windows-1256 and in iso-8859-1 high bytes.
	w1256 := base64.StdEncoding.EncodeToString([]byte{0xC7, 0xE1, 0xD9, 0xD1, 0xC8, 0xED})
	high := base64.StdEncoding.EncodeToString([]byte{0x41, 0x80, 0x8D, 0xA0, 0xE9, 0xFF, 0x5A})

	return []struct{ Name, Class, Note, Raw string }{
		// --- quoted-printable leniency ------------------------------------
		{"qp-soft-break-crlf", "quoted-printable", "= CRLF is a soft break: removed", textPlain("quoted-printable", "AAA=\r\nBBB\r\n")},
		{"qp-soft-break-lf", "quoted-printable", "= LF is a soft break too (Go deviation 1)", textPlain("quoted-printable", "AAA=\nBBB\n")},
		{"qp-bad-hex-is-literal", "quoted-printable", "= not followed by two hex digits is a literal = (Go deviation 4)", textPlain("quoted-printable", "A=ZZB\r\n")},
		{"qp-eq-at-eof-dropped", "quoted-printable", "a trailing = at end of input is silently ignored (Go deviation 3)", textPlain("quoted-printable", "AB=")},
		{"qp-eq-alone-at-eof-kills-leaf", "quoted-printable", "but a bare = as the whole final line is an ERROR, and an undecodable leaf is discarded, so the message has no text part at all", textPlain("quoted-printable", "AB\r\n=")},
		{"qp-ws-before-hard-break-stripped", "quoted-printable", "", textPlain("quoted-printable", "A  \r\nB\r\n")},
		{"qp-ws-before-soft-break-kept", "quoted-printable", "", textPlain("quoted-printable", "A  =\r\nB\r\n")},
		{"qp-ws-after-eq-still-soft", "quoted-printable", "spaces between = and CRLF do not break the soft break", textPlain("quoted-printable", "A=  \r\nB\r\n")},
		{"qp-lowercase-hex", "quoted-printable", "", textPlain("quoted-printable", "x=c3=a9y\r\n")},
		{"qp-raw-high-byte-passes", "quoted-printable", "bytes >= 0x80 pass through unescaped (Go issue 22597)", textPlain("quoted-printable", "x\xc3\xa9y\r\n")},
		{"qp-control-byte-kills-leaf", "quoted-printable", "an unescaped control byte is fatal to the leaf", textPlain("quoted-printable", "x\x01y\r\n")},
		{"qp-del-byte-kills-leaf", "quoted-printable", "0x7F counts as an invalid unescaped byte", textPlain("quoted-printable", "x\x7fy\r\n")},
		{"qp-eq-one-hex-at-eof", "quoted-printable", "", textPlain("quoted-printable", "x=4")},
		{"qp-eq-line-alone", "quoted-printable", "a line that is only = followed by CRLF vanishes", textPlain("quoted-printable", "x\r\n=\r\ny\r\n")},

		// --- base64 --------------------------------------------------------
		{"b64-embedded-space", "base64", "RFC 2045 permits whitespace; go-message rewrites space and tab to LF first", textPlain("base64", "SGVsbG8g d29ybGQ=\r\n")},
		{"b64-embedded-tab", "base64", "", textPlain("base64", "SGVsbG8g\td29ybGQ=\r\n")},
		{"b64-continuation-indent", "base64", "", textPlain("base64", "SGVsbG8g\r\n  d29ybGQ=\r\n")},
		{"b64-missing-padding-kills-leaf", "base64", "Go's decoder requires padding; the leaf is discarded, not salvaged", textPlain("base64", "SGVsbG8gd29ybGQ\r\n")},
		{"b64-invalid-char-kills-leaf", "base64", "", textPlain("base64", "SGVsbG8*d29ybGQ=\r\n")},
		{"b64-truncated-kills-leaf", "base64", "", textPlain("base64", "SGVsbG8gd29ybG\r\n")},
		{"b64-trailing-garbage-kills-leaf", "base64", "data after the padding is fatal", textPlain("base64", "SGVsbG8=extra\r\n")},
		{"b64-empty-payload", "base64", "an empty leaf is not recorded, so there is no text part", textPlain("base64", "\r\n")},

		// --- transfer encodings --------------------------------------------
		{"cte-7bit", "transfer-encoding", "", textPlain("7bit", "Hello world\r\n")},
		{"cte-8bit-raw-utf8", "transfer-encoding", "", textPlain("8bit", "H\xc3\xa9llo\r\n")},
		{"cte-absent", "transfer-encoding", "", textPlain("", "Hello world\r\n")},
		{"cte-unknown-top-level-passes", "transfer-encoding", "an unknown CTE on the TOP-LEVEL entity is tolerated and the body passes through undecoded", textPlain("x-uuencode", "Hello world\r\n")},
		{"cte-mixed-case", "transfer-encoding", "", textPlain("Base64", "SGVsbG8gd29ybGQ=\r\n")},

		// --- charset --------------------------------------------------------
		{"charset-windows-1256", "charset", "the corpus's only non-UTF-8 charset", withCharset("windows-1256", w1256)},
		{"charset-cp1256-alias", "charset", "", withCharset("cp1256", w1256)},
		{"charset-iso-8859-1-is-true-latin1", "charset", "ianaindex resolves iso-8859-1 to TRUE Latin-1, where WHATWG/TextDecoder would give windows-1252. The bytes 0x80 and 0x8D are the tell", withCharset("iso-8859-1", high)},
		{"charset-iso8859-1-is-windows-1252", "charset", "the SAME encoding without the hyphen falls through to the WHATWG table and becomes windows-1252, where 0x8D is undefined", withCharset("iso8859-1", high)},
		{"charset-us-ascii-passes-high-bytes", "charset", "us-ascii is short-circuited by go-message: high bytes are NOT replaced at the charset layer, they reach stage 3 and become U+FFFD by the WHATWG rule", withCharset("us-ascii", high)},
		{"charset-unknown-label-passes-through", "charset", "an unresolvable label leaves the body undecoded; stage 3 then substitutes", withCharset("x-nope", high)},
		{"charset-absent", "charset", "", hdr + "Content-Type: text/plain\r\n\r\nHello world\r\n"},
		{"charset-uppercase-label", "charset", "", withCharset("WINDOWS-1256", w1256)},

		// --- MIME structure --------------------------------------------------
		{"mp-html-wins-over-plain", "structure", "", mp("preamble\r\n--BND\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nPLAIN\r\n--BND\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<b>HTML</b>\r\n--BND--\r\nepilogue\r\n")},
		{"mp-first-html-wins", "structure", "", mp("--BND\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<b>ONE</b>\r\n--BND\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<b>TWO</b>\r\n--BND--\r\n")},
		{"mp-first-empty-html-skipped", "structure", "first NON-EMPTY, not first", mp("--BND\r\nContent-Type: text/html; charset=utf-8\r\n\r\n--BND\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<b>TWO</b>\r\n--BND--\r\n")},
		{"mp-nested-related", "structure", "", mp("--BND\r\nContent-Type: multipart/related; boundary=\"IN\"\r\n\r\n--IN\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<b>NESTED</b>\r\n--IN--\r\n--BND--\r\n")},
		{"mp-no-final-boundary-raw-fallback", "structure", "the walk breaks before any leaf is collected, so the raw body is recorded rather than nothing", mp("--BND\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<b>HTML</b>\r\n")},
		{"mp-subpart-unknown-charset-raw-fallback", "structure", "ASYMMETRY: an unknown charset is tolerated on the top-level entity but ABORTS the walk on a sub-part, because NextPart returns it as an error", mp("--BND\r\nContent-Type: text/plain; charset=x-nope\r\n\r\nPLAIN\r\n--BND\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<b>HTML</b>\r\n--BND--\r\n")},
		{"mp-subpart-unknown-cte-raw-fallback", "structure", "same asymmetry for an unknown transfer encoding", mp("--BND\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: x-nope\r\n\r\nPLAIN\r\n--BND\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<b>HTML</b>\r\n--BND--\r\n")},
		{"mp-bad-leaf-then-good-leaf", "structure", "an undecodable leaf is skipped without aborting the walk", mp("--BND\r\nContent-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n!!!!\r\n--BND\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<b>SECOND</b>\r\n--BND--\r\n")},
		{"mp-no-boundary-param", "structure", "", hdr + "Content-Type: multipart/alternative\r\n\r\n--BND\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<b>HTML</b>\r\n--BND--\r\n"},
		{"mp-cte-on-multipart-ignored", "structure", "RFC 2045 forbids it, real mailers do it anyway, go-message ignores it", hdr + "Content-Type: multipart/alternative; boundary=\"BND\"\r\nContent-Transfer-Encoding: base64\r\n\r\n--BND\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<b>HTML</b>\r\n--BND--\r\n"},
		{"mp-boundary-transport-padding", "structure", "", mp("--BND  \r\nContent-Type: text/html; charset=utf-8\r\n\r\n<b>HTML</b>\r\n--BND--  \r\n")},
		{"mp-lf-only-line-endings", "structure", "", hdr + "Content-Type: multipart/alternative; boundary=BND\n\n--BND\nContent-Type: text/html; charset=utf-8\n\n<b>HTML</b>\n--BND--\n"},
		{"mp-part-defaults-to-text-plain", "structure", "a part with no Content-Type is text/plain with no charset", mp("--BND\r\n\r\nDEFAULTED\r\n--BND--\r\n")},
		{"mp-only-octet-stream", "structure", "", mp("--BND\r\nContent-Type: application/octet-stream\r\n\r\nAAA\r\n--BND--\r\n")},
		{"ct-unparseable-skips-leaf", "structure", "a Content-Type mime.ParseMediaType rejects yields the RAW field as the media type, which matches neither text/html nor text/plain", hdr + "Content-Type: text/html (html); charset=utf-8\r\n\r\n<b>hi</b>\r\n"},

		// --- headers and the raw fallback ------------------------------------
		{"hdr-broken-first-line-raw", "headers", "the stage-1 raw fallback, with Subject and From recovered by the explicit scan", "!!! this line is not a header field\r\n" + textPlain("", "hello\r\n")},
		{"hdr-leading-space-first-line-raw", "headers", "a header block may not begin with a folded line", " leading\r\n" + textPlain("", "hello\r\n")},
		{"hdr-colonless-line-raw", "headers", "", "From: a@b.c\r\nNOCOLON\r\nSubject: Hi\r\n\r\nbody\r\n"},
		{"hdr-invalid-key-byte-raw", "headers", "a space inside a header key is invalid per RFC 5322 2.2", "From: a@b.c\r\nBad Key: v\r\nSubject: Hi\r\n\r\nbody\r\n"},
		{"hdr-no-headers-at-all-raw", "headers", "", "just text with no headers\r\n"},
		{"hdr-rfc2047-adjacent-words-join-bare", "headers", "adjacent encoded words join with NO separator; inserting a space breaks the ENBD last4 match", hdr[:len("From: a@b.c\r\n")] + "Subject: =?utf-8?B?QUJD?= =?utf-8?B?REVG?=\r\n" + "Content-Type: text/plain; charset=utf-8\r\n\r\nbody\r\n"},
		{"hdr-rfc2047-folded-words-join-bare", "headers", "", "From: a@b.c\r\nSubject: =?utf-8?B?QUJD?=\r\n =?utf-8?B?REVG?=\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nbody\r\n"},
		{"hdr-rfc2047-q-encoding", "headers", "", "From: a@b.c\r\nSubject: =?utf-8?Q?a=C3=A9b_c?=\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nbody\r\n"},
		{"hdr-rfc2047-latin1-word", "headers", "mime.WordDecoder handles iso-8859-1 itself, as TRUE Latin-1", "From: a@b.c\r\nSubject: =?iso-8859-1?Q?a=E9b?=\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nbody\r\n"},
		{"hdr-rfc2047-windows-1256-word", "headers", "an encoded word in a legacy charset goes through the same registry", "From: a@b.c\r\nSubject: =?windows-1256?B?x+HZ0cjt?=\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nbody\r\n"},
		{"hdr-rfc2047-us-ascii-high-byte", "headers", "the us-ascii branch of mime.WordDecoder emits ONE U+FFFD PER BYTE, not per maximal subpart", "From: a@b.c\r\nSubject: =?us-ascii?B?YcO/Yg==?=\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nbody\r\n"},
		{"hdr-rfc2047-unknown-charset-kept-raw", "headers", "an undecodable word leaves the whole field at its raw value", "From: a@b.c\r\nSubject: =?x-nope?B?QUJD?=\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nbody\r\n"},
		{"hdr-rfc2047-body-only-alias-kept-raw", "headers", "THE TWO REGISTRIES DIFFER. ansi_x3.110-1983 is an ISO-8859-1 alias for a BODY (a go-message quirk) and is unknown to a WORD, because the word decoder is wired to htmlindex alone. Decoding it here would be a divergence", "From: a@b.c\r\nSubject: =?ansi_x3.110-1983?B?QUJD?=\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nbody\r\n"},
		{"hdr-rfc2047-ianaindex-only-name-kept-raw", "headers", "same shape: ibm037 resolves for a body and not for a word", "From: a@b.c\r\nSubject: =?ibm037?B?QUJD?=\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nbody\r\n"},
		{"hdr-rfc2047-bad-base64-kept-raw", "headers", "", "From: a@b.c\r\nSubject: =?utf-8?B?!!!?=\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nbody\r\n"},
		{"hdr-folded-subject-joins-with-space", "headers", "", "From: a@b.c\r\nSubject: One\r\n  Two\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nbody\r\n"},
		{"hdr-duplicate-subject-first-wins", "headers", "", "From: a@b.c\r\nSubject: First\r\nSubject: Second\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nbody\r\n"},
		{"hdr-from-display-name-stripped", "headers", "From is reduced to the bare address", "From: Alice B <a@b.c>\r\nSubject: Hi\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nbody\r\n"},
		{"hdr-from-quoted-display-name", "headers", "", "From: \"B, Alice\" <a@b.c>\r\nSubject: Hi\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nbody\r\n"},
		{"hdr-from-address-list-first-wins", "headers", "", "From: a@b.c, d@e.f\r\nSubject: Hi\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nbody\r\n"},
		{"hdr-from-unparseable-kept-raw", "headers", "a junk From is kept verbatim rather than dropped", "From: not an address\r\nSubject: Hi\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nbody\r\n"},
		{"hdr-from-angle-addr-recovered", "headers", "the by-hand angle-addr recovery", "From: junk <a@b.c> junk\r\nSubject: Hi\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nbody\r\n"},
		{"hdr-from-empty", "headers", "", "From: \r\nSubject: Hi\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nbody\r\n"},
		{"hdr-from-missing", "headers", "", "Subject: Hi\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nbody\r\n"},
		{"hdr-space-before-colon", "headers", "trailing spaces in a key appear in the wild and are trimmed", "From : a@b.c\r\nSubject : Hi\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nbody\r\n"},
		{"hdr-lf-only-line-endings", "headers", "", "From: a@b.c\nSubject: Hi\nContent-Type: text/plain; charset=utf-8\n\nbody\n"},
		{"hdr-lf-blank-beats-later-crlf-blank", "headers", "the body starts at whichever blank line comes FIRST", "From: a@b.c\nSubject: Hi\n\nbody\r\n\r\nmore\r\n"},
		{"hdr-raw-8bit-utf8-subject", "headers", "a Subject carrying raw UTF-8 with no RFC 2047 wrapper. Go's header value IS bytes, so this needs no decoding step at all; a twin that turned header bytes into text too early would emit one code point per byte", "From: a@b.c\r\nSubject: \u0645\u0631\u062d\u0628\u0627 DIB\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nbody\r\n"},
		{"hdr-raw-8bit-nbsp-padding", "headers", "the header trim is over RUNES: the two-byte encoding of U+00A0 is trimmed, and the value keeps its interior spacing", "From: a@b.c\r\nSubject: \u00a0\u00a0Hi there\u00a0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nbody\r\n"},
		{"hdr-raw-8bit-display-name", "headers", "", "From: \u0645\u0631\u062d\u0628\u0627 <a@b.c>\r\nSubject: Hi\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nbody\r\n"},

		// --- stages 5-9 -------------------------------------------------------
		{"html-entities-single-pass", "stages", "&amp;lt; must become &lt; and STOP; a chain of six replaces would produce <", hdr + "Content-Type: text/html; charset=utf-8\r\n\r\n<p>&amp;lt; &amp;amp; &copy; &nbsp;x&#39;y</p>\r\n"},
		{"html-script-and-style-become-space", "stages", "", hdr + "Content-Type: text/html; charset=utf-8\r\n\r\n<div>A<script>var x = '<b>';</script>B<style>p{}</style>C</div>\r\n"},
		{"html-block-tags-become-newlines", "stages", "", hdr + "Content-Type: text/html; charset=utf-8\r\n\r\nA<br>B<br/>C</p>D</tr>E</div>F<BR>G\r\n"},
		{"html-nbsp-collapses", "stages", "U+00A0 is in the collapse set, so it never survives to the trim", hdr + "Content-Type: text/html; charset=utf-8\r\n\r\n<p>A  B \t C</p>\r\n"},
		{"trim-set-keeps-hair-space", "stages", "U+200A is NOT in the explicit trim set: a line of hair spaces survives", hdr + "Content-Type: text/plain; charset=utf-8\r\n\r\nA\r\n\u200a\u200a\r\nB\r\n"},
		{"trim-set-drops-feff-line", "stages", "U+FEFF IS in the explicit trim set: a lone BOM line is dropped", hdr + "Content-Type: text/plain; charset=utf-8\r\n\r\nA\r\n\ufeff\r\nB\r\n"},
		{"trim-set-keeps-narrow-nbsp", "stages", "U+202F is not in the set either, unlike Go's TrimSpace", hdr + "Content-Type: text/plain; charset=utf-8\r\n\r\nA\r\n\u202f\r\nB\r\n"},
		{"trim-set-keeps-next-line", "stages", "U+0085 is trimmed by Go's TrimSpace and not by this contract", hdr + "Content-Type: text/plain; charset=utf-8\r\n\r\nA\r\n\u0085\r\nB\r\n"},
		{"plain-part-is-not-html-stripped", "stages", "a text/plain leaf skips stage 5 entirely, so markup survives", hdr + "Content-Type: text/plain; charset=utf-8\r\n\r\n<b>kept</b> &amp; decoded\r\n"},

		// --- stage 10 ---------------------------------------------------------
		{"fwd-gmail-same-line-headers", "forward", "", hdr + "Content-Type: text/plain; charset=utf-8\r\n\r\n---------- Forwarded message ---------\r\nFrom: Bank <alerts@bank.example>\r\nDate: Jul 24, 2026 at 4:11 PM\r\nSubject: Inner subject\r\nTo: <me@example.com>\r\n\r\nBODY LINE\r\n"},
		{"fwd-apple-next-line-headers", "forward", "", hdr + "Content-Type: text/plain; charset=utf-8\r\n\r\nSent from my iPhone\r\n\r\nBegin forwarded message:\r\n\r\nFrom:\r\nBank <alerts@bank.example>\r\nDate:\r\n24 July 2026 at 16:11:02\r\nSubject:\r\nInner subject\r\nTo:\r\nme@example.com\r\n\r\nBODY LINE\r\n"},
		{"fwd-quoted-recovers-nothing", "forward", "the shape 50 of the corpus's 56 forwards have: the marker is unquoted, every header line is > quoted, so nothing is recovered and the body is unchanged", hdr + "Content-Type: text/plain; charset=utf-8\r\n\r\nBegin forwarded message:\r\n\r\n> From: Bank <alerts@bank.example>\r\n> Subject: Inner subject\r\n\r\n> BODY LINE\r\n"},
		{"fwd-no-marker-strips-fwd-prefix", "forward", "", "From: a@b.c\r\nSubject: Fwd: Real subject\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nbody\r\n"},
		{"fwd-date-iphone-seconds-ampm-unparsed", "forward", "K2: the four closed layouts cover seconds OR AM/PM, never both, so this dates to the arrival time", hdr + "Content-Type: text/plain; charset=utf-8\r\n\r\nBegin forwarded message:\r\n\r\nFrom:\r\nBank <alerts@bank.example>\r\nDate:\r\n18 June 2026 at 7:33:38 PM GST\r\nSubject:\r\nInner\r\n\r\nBODY\r\n"},
		{"fwd-date-narrow-nbsp-before-ampm", "forward", "Apple Mail inserts U+202F before AM/PM on recent OSes", hdr + "Content-Type: text/plain; charset=utf-8\r\n\r\n---------- Forwarded message ---------\r\nFrom: Bank <alerts@bank.example>\r\nDate: Jul 24, 2026 at 4:11\u202fPM\r\nSubject: Inner\r\n\r\nBODY\r\n"},
		{"fwd-marker-but-no-headers", "forward", "Forwarded is true because a MARKER was found, not because headers were recovered", hdr + "Content-Type: text/plain; charset=utf-8\r\n\r\nBegin forwarded message:\r\n\r\nplain body with no header block\r\n"},
		{"fwd-date-zone-token-is-stripped", "forward", "MUTATION GUARD: without the retry that drops the final space-delimited token, this trailing zone name makes the whole value unparseable and the transaction silently dates to its arrival time", hdr + "Content-Type: text/plain; charset=utf-8\r\n\r\n---------- Forwarded message ---------\r\nFrom: Bank <alerts@bank.example>\r\nDate: 24 July 2026 at 16:11:02 GST\r\nSubject: Inner\r\n\r\nBODY\r\n"},
		{"fwd-date-iso8601-is-not-a-layout", "forward", "MUTATION GUARD: Date.parse accepts this and the four closed layouts do not. A twin that reached for Date.parse would date the transaction from the body where Go dates it from arrival", hdr + "Content-Type: text/plain; charset=utf-8\r\n\r\n---------- Forwarded message ---------\r\nFrom: Bank <alerts@bank.example>\r\nDate: 2026-07-24T16:11:00Z\r\nSubject: Inner\r\n\r\nBODY\r\n"},
		{"fwd-date-no-at-keyword-is-not-a-layout", "forward", "MUTATION GUARD: Date.parse accepts \"Jul 24, 2026 4:11 PM\" in the LOCAL zone; every layout here requires the literal \" at \"", hdr + "Content-Type: text/plain; charset=utf-8\r\n\r\n---------- Forwarded message ---------\r\nFrom: Bank <alerts@bank.example>\r\nDate: Jul 24, 2026 4:11 PM\r\nSubject: Inner\r\n\r\nBODY\r\n"},
		{"html-block-tag-pass-precedes-generic-rule", "stages", "MUTATION GUARD: on well-formed HTML the five block tags are inert, because the generic tag rule yields the same newline. They are only observable on MALFORMED markup, where the generic rule swallows the block tag as part of a longer pseudo-tag", hdr + "Content-Type: text/html; charset=utf-8\r\n\r\nA<p</div>B\r\n"},
	}
}

func buildEdgeCases(t *testing.T) []edgeCase {
	t.Helper()
	var out []edgeCase
	recv := time.Date(2026, 8, 1, 12, 0, 0, 0, time.UTC)
	for _, in := range edgeInputs() {
		raw := []byte(in.Raw)
		c := edgeCase{
			Name: in.Name, Class: in.Class, Note: in.Note,
			Raw: base64.StdEncoding.EncodeToString(raw),
		}
		res, err := Normalize(CurrentVersion, raw, recv)
		switch {
		case err == ErrNoTextPart:
			c.ExpectError = "no_text_part"
		case err != nil:
			t.Fatalf("%s: unexpected error %v", in.Name, err)
		default:
			c.ExpectTextBase64 = base64.StdEncoding.EncodeToString([]byte(res.Text))
			c.ExpectPart = res.PartUsed
			c.ExpectCharset = res.Charset
			c.ExpectSubjectBase64 = base64.StdEncoding.EncodeToString([]byte(res.Subject))
			c.ExpectFromBase64 = base64.StdEncoding.EncodeToString([]byte(res.From))
			c.ExpectForwarded = res.Forwarded
			c.ExpectEmailDate = res.EmailDate.UTC().Format(time.RFC3339)
			c.ExpectDateSource = res.DateSource
		}
		out = append(out, c)
	}
	return out
}

func edgeCasesJSON(t *testing.T) []byte {
	t.Helper()
	doc := struct {
		Note              string     `json:"note"`
		Spec              string     `json:"spec"`
		NormalizerVersion int        `json:"normalizer_version"`
		ReceivedAt        string     `json:"received_at"`
		Cases             []edgeCase `json:"cases"`
	}{
		Note: "Code generated by internal/v2/norm TestWriteTwinArtifacts. DO NOT EDIT. " +
			"These are SYNTHETIC inputs, unlike conformance/normalizer/*.json which is real corpus mail. " +
			"They exist because the 7,002-message corpus contains zero examples of any of these classes — " +
			"zero MIME parse failures, zero undecodable leaves, zero unknown charsets — and an untested " +
			"class is where two implementations drift apart. Expectations are whatever the Go normalizer " +
			"produces; the TypeScript twin must reproduce them byte for byte.",
		Spec:              "docs/superpowers/specs/v2-normalizer-v1.md",
		NormalizerVersion: CurrentVersion,
		ReceivedAt:        time.Date(2026, 8, 1, 12, 0, 0, 0, time.UTC).Format(time.RFC3339),
		Cases:             buildEdgeCases(t),
	}
	b, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	return append(b, '\n')
}

// ---------------------------------------------------------------------------
// Writer + freshness
// ---------------------------------------------------------------------------

func TestWriteTwinArtifacts(t *testing.T) {
	if os.Getenv(writeFixturesEnv) == "" {
		t.Skipf("%s is unset; the generated artifacts are committed and regenerated deliberately", writeFixturesEnv)
	}
	if err := os.MkdirAll(filepath.Dir(charsetTablesPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(charsetTablesPath, []byte(buildCharsetTablesTS()), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(edgeCasesPath, edgeCasesJSON(t), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Logf("wrote %s and %s", charsetTablesPath, edgeCasesPath)
}

// TestTwinArtifactsAreFresh is the un-regenerated-generator check.
//
// Both artifacts are produced by Go and consumed by TypeScript. Without this,
// a change to the Go normalizer or to the charset registry would leave the
// TypeScript executor running against a fossil and passing — the exact blind
// spot a one-way generated artifact has.
func TestTwinArtifactsAreFresh(t *testing.T) {
	for _, a := range []struct {
		path string
		want []byte
	}{
		{charsetTablesPath, []byte(buildCharsetTablesTS())},
		{edgeCasesPath, edgeCasesJSON(t)},
	} {
		got, err := os.ReadFile(a.path)
		if err != nil {
			t.Fatalf("%s: %v (regenerate with %s=1 go test ./internal/v2/norm/ -run TestWriteTwinArtifacts)", a.path, err, writeFixturesEnv)
		}
		if !bytes.Equal(got, a.want) {
			t.Errorf("%s is stale: it is not what this build generates.\n"+
				"Regenerate with %s=1 go test ./internal/v2/norm/ -run TestWriteTwinArtifacts",
				a.path, writeFixturesEnv)
		}
	}
}

// TestEveryCorpusCharsetHasATable is the guard on the divergence class.
//
// The TypeScript twin throws for any charset Go decodes with a multi-byte or
// stateful codec. That is only acceptable while no such message exists, so the
// claim is checked rather than asserted — against the corpus when one is
// available, and against the fixture set always.
func TestEveryCorpusCharsetHasATable(t *testing.T) {
	for _, label := range []string{"utf-8", "us-ascii", "windows-1256"} {
		kind, _, note := resolveCharsetLabel(label)
		if kind == kindUnsupported {
			t.Errorf("corpus charset %q classifies as unsupported (%s); the TypeScript twin would throw on real mail", label, note)
		}
	}
}
