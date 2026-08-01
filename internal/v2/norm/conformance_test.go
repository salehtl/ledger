package norm

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"

	"ledger/internal/v2/corpus"
)

// conformanceDir holds the committed fixtures both executors run against.
const conformanceDir = "../../../conformance/normalizer"

// writeFixturesEnv gates the writer. A test that rewrites its own reference on
// every run pins nothing, so writing is opt-in and the output is committed.
const writeFixturesEnv = "LEDGER_WRITE_CONFORMANCE"

// conformanceCase is one fixture.
//
// expect_text, expect_subject and expect_from are BASE64, not JSON strings. A
// JSON string cannot represent the normalizer's output when charset resolution
// fails and the raw fallback yields bytes that are not valid UTF-8: the fixture
// writer would silently substitute, the TypeScript reader would substitute
// differently, and the suite would be comparing two different corrections to
// the same corruption. Base64 makes the fixture the exact bytes.
type conformanceCase struct {
	Name              string `json:"name"`
	Note              string `json:"note,omitempty"`
	Source            string `json:"source"`
	NormalizerVersion int    `json:"normalizer_version"`
	ReceivedAt        string `json:"received_at"`
	RawBase64         string `json:"raw_base64"`

	ExpectTextBase64    string `json:"expect_text_base64"`
	ExpectPart          string `json:"expect_part"`
	ExpectCharset       string `json:"expect_charset"`
	ExpectSubjectBase64 string `json:"expect_subject_base64"`
	ExpectFromBase64    string `json:"expect_from_base64"`
	ExpectForwarded     bool   `json:"expect_forwarded"`
	ExpectEmailDate     string `json:"expect_email_date"`
	ExpectDateSource    string `json:"expect_date_source"`
}

// resultHasField reports whether Result declares a field with this name. It
// backs the assertion that nothing in Result can be mistaken for a verified
// identity.
func resultHasField(name string) bool {
	_, ok := reflect.TypeOf(Result{}).FieldByName(name)
	return ok
}

// ---------------------------------------------------------------------------
// The runner
// ---------------------------------------------------------------------------

func loadCases(t *testing.T) []conformanceCase {
	t.Helper()
	entries, err := os.ReadDir(conformanceDir)
	if err != nil {
		t.Fatalf("read %s: %v", conformanceDir, err)
	}
	var cases []conformanceCase
	for _, e := range entries {
		// edge-cases.json is the synthetic family (see twin_test.go): a different
		// schema, a single document rather than one file per case, and already
		// executed against Go by TestTwinArtifactsAreFresh, which regenerates
		// every expectation from Normalize and compares the whole file.
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") ||
			e.Name() == "manifest.json" || e.Name() == "edge-cases.json" {
			continue
		}
		b, err := os.ReadFile(filepath.Join(conformanceDir, e.Name()))
		if err != nil {
			t.Fatalf("read %s: %v", e.Name(), err)
		}
		var c conformanceCase
		if err := json.Unmarshal(b, &c); err != nil {
			t.Fatalf("parse %s: %v", e.Name(), err)
		}
		if c.Name == "" {
			t.Fatalf("%s has no name", e.Name())
		}
		cases = append(cases, c)
	}
	sort.Slice(cases, func(i, j int) bool { return cases[i].Name < cases[j].Name })
	return cases
}

func TestNormalizerConformance(t *testing.T) {
	cases := loadCases(t)
	if len(cases) < 30 {
		t.Fatalf("only %d conformance fixtures; the suite is meant to carry at least 30 "+
			"(regenerate with %s=1 LEDGER_CORPUS_DB=... go test ./internal/v2/norm/ -run TestWriteNormalizerFixtures)",
			len(cases), writeFixturesEnv)
	}
	for _, c := range cases {
		t.Run(c.Name, func(t *testing.T) {
			raw := mustB64(t, c.RawBase64)
			recv, err := time.Parse(time.RFC3339, c.ReceivedAt)
			if err != nil {
				t.Fatalf("received_at: %v", err)
			}
			got, err := Normalize(c.NormalizerVersion, raw, recv)
			if err != nil {
				t.Fatalf("Normalize: %v", err)
			}
			if want := string(mustB64(t, c.ExpectTextBase64)); got.Text != want {
				gotWin, wantWin := firstDiff(got.Text, want)
				t.Fatalf("Text mismatch around the first differing byte\n got %q\nwant %q", gotWin, wantWin)
			}
			if got.PartUsed != c.ExpectPart {
				t.Fatalf("PartUsed = %q, want %q", got.PartUsed, c.ExpectPart)
			}
			if got.Charset != c.ExpectCharset {
				t.Fatalf("Charset = %q, want %q", got.Charset, c.ExpectCharset)
			}
			if want := string(mustB64(t, c.ExpectSubjectBase64)); got.Subject != want {
				t.Fatalf("Subject = %q, want %q", got.Subject, want)
			}
			if want := string(mustB64(t, c.ExpectFromBase64)); got.From != want {
				t.Fatalf("From = %q, want %q", got.From, want)
			}
			if got.Forwarded != c.ExpectForwarded {
				t.Fatalf("Forwarded = %v, want %v", got.Forwarded, c.ExpectForwarded)
			}
			if got.DateSource != c.ExpectDateSource {
				t.Fatalf("DateSource = %q, want %q", got.DateSource, c.ExpectDateSource)
			}
			wantDate, err := time.Parse(time.RFC3339, c.ExpectEmailDate)
			if err != nil {
				t.Fatalf("expect_email_date: %v", err)
			}
			if !got.EmailDate.Equal(wantDate) {
				t.Fatalf("EmailDate = %v, want %v", got.EmailDate, wantDate)
			}
		})
	}
}

// TestConformanceCoversTheNamedShapes fails when a fixture the contract depends
// on has been dropped. Coverage that quietly shrinks is the failure mode a
// conformance suite exists to prevent.
func TestConformanceCoversTheNamedShapes(t *testing.T) {
	cases := loadCases(t)
	byName := map[string]conformanceCase{}
	parts := map[string]int{}
	var forwarded, fromHeaderDate, windows1256 int
	for _, c := range cases {
		byName[c.Name] = c
		parts[c.ExpectPart]++
		if c.ExpectForwarded {
			forwarded++
		}
		if c.ExpectDateSource == DateSourceForwardHeader {
			fromHeaderDate++
		}
		if c.ExpectCharset == "windows-1256" {
			windows1256++
		}
	}
	for _, required := range []string{
		"apple-forward-enbd-alert",
		"gmail-forward-1",
		"broken-mime-raw-fallback",
		"mislabelled-utf8-actually-windows-1256",
		"base64-continuation-indent",
		"quoted-forward-recovers-no-headers",
		"apple-forward-feff-line",
	} {
		if _, ok := byName[required]; !ok {
			t.Errorf("fixture %q is missing; it pins a named clause of the contract", required)
		}
	}
	for _, p := range []string{PartHTML, PartPlain, PartRaw} {
		if parts[p] == 0 {
			t.Errorf("no fixture exercises PartUsed=%q", p)
		}
	}
	if forwarded == 0 {
		t.Error("no forwarded fixture")
	}
	if fromHeaderDate == 0 {
		t.Error("no fixture whose EmailDate comes from a forward header")
	}
	if windows1256 == 0 {
		t.Error("no windows-1256 fixture; the charset conversion is unpinned")
	}

	// Whitespace inside a base64 payload must be skipped, not decoded and not
	// fatal, so indenting it changes nothing about the output. Asserting the two
	// texts are equal is what makes that a contract rather than a coincidence.
	plain, ok1 := byName["dib-arabic-01"]
	indented, ok2 := byName["base64-continuation-indent"]
	if ok1 && ok2 && plain.ExpectTextBase64 != indented.ExpectTextBase64 {
		t.Error("base64-continuation-indent must normalize byte-identically to dib-arabic-01; " +
			"embedded whitespace in a base64 payload is skipped, per RFC 2045")
	}

	// The raw fallback must still recover the headers. A message that failed
	// MIME parsing is exactly the message whose Subject the review queue needs.
	if raw, ok := byName["broken-mime-raw-fallback"]; ok {
		if raw.ExpectSubjectBase64 == "" || string(mustB64(t, raw.ExpectSubjectBase64)) == "" {
			t.Error("broken-mime-raw-fallback recovered no Subject; the ENBD alert template reads last4 from there")
		}
	}
}

func mustB64(t *testing.T, s string) []byte {
	t.Helper()
	b, err := base64.StdEncoding.DecodeString(s)
	if err != nil {
		t.Fatalf("base64: %v", err)
	}
	return b
}

// firstDiff trims two strings to a window around their first difference so a
// failure on a 4 KB Arabic body is readable.
func firstDiff(got, want string) (string, string) {
	i := 0
	for i < len(got) && i < len(want) && got[i] == want[i] {
		i++
	}
	lo := i - 40
	if lo < 0 {
		lo = 0
	}
	clip := func(s string) string {
		hi := i + 40
		if hi > len(s) {
			hi = len(s)
		}
		if lo > len(s) {
			return ""
		}
		return s[lo:hi]
	}
	return clip(got), clip(want)
}

// ---------------------------------------------------------------------------
// The writer
// ---------------------------------------------------------------------------

// fixtureSpec names one corpus message to export, and how to mutate it first.
type fixtureSpec struct {
	name   string
	id     int64
	note   string
	derive func([]byte) []byte // nil for a verbatim corpus message
}

// corpusFixtures is an EXPLICIT id list, not a sample stride: the live corpus
// grows every time v1 ingests mail, so "every 200th message" would silently
// re-point at different mail on every regeneration.
var corpusFixtures = []fixtureSpec{
	// --- DIB, the bulk of the corpus: Arabic text/html, base64, utf-8 --------
	{name: "dib-arabic-01", id: 9, note: "DIB credit-card purchase notification, Arabic, text/html base64 utf-8 — the single most common shape in the corpus"},
	{name: "dib-arabic-02", id: 10, note: "as dib-arabic-01, a different merchant and amount"},
	{name: "dib-arabic-03", id: 11, note: "as dib-arabic-01, third sample"},
	{name: "dib-arabic-04", id: 13},
	{name: "dib-arabic-05", id: 15},
	{name: "dib-arabic-06", id: 17},
	{name: "dib-arabic-07", id: 2542, note: "sent from dib.mail@dib.ae rather than DIB.notification@dib.ae"},

	// --- windows-1256: the one charset conversion the corpus exercises -------
	{name: "dib-windows1256-01", id: 2695, note: "declared charset=windows-1256; the bytes are NOT valid UTF-8 and must be converted, not replaced"},
	{name: "dib-windows1256-02", id: 2728},
	{name: "dib-windows1256-03", id: 2882},
	{name: "dib-windows1256-04", id: 2915},
	{name: "dib-windows1256-05", id: 3038},

	// --- ENBD ---------------------------------------------------------------
	{name: "enbd-local-transfer-01", id: 2422, note: "Emirates NBD online-banking transfer advice, quoted-printable"},
	{name: "enbd-local-transfer-02", id: 2423},
	{name: "enbd-telegraphic-transfer", id: 2434},

	// --- Non-bank mail that still has to normalize cleanly ------------------
	{name: "google-quoted-printable-01", id: 1, note: "quoted-printable body with soft line breaks"},
	{name: "google-quoted-printable-02", id: 2},
	{name: "google-notice", id: 8},
	{name: "us-ascii-plain", id: 6, note: "the corpus's ONLY us-ascii part. It is pure ASCII, so the ianaindex/WHATWG disagreement over us-ascii (see the spec) is invisible here"},

	// --- Forwards -----------------------------------------------------------
	{name: "quoted-forward-recovers-no-headers", id: 2484, note: "the shape 50 of the corpus's 56 forwards have: the marker line is unquoted but every header line is '>'-quoted, so Forwarded is true and NOTHING is recovered. v1 behaves identically"},
	{name: "apple-forward-feff-line", id: 2554, note: "THE trim divergence. The line after the forwarded header block is a lone U+FEFF: v1's strings.TrimSpace keeps it, the explicit set drops it. Also carries the Apple-Mail iOS 12-hour-with-seconds date the four closed layouts cannot parse, so DateSource is 'received'"},
	{name: "apple-forward-dib-01", id: 6850, note: "Apple Mail value-on-the-next-line header layout, with multipart/related nested inside multipart/alternative; the inner Date parses"},
	{name: "apple-forward-feff-line-2", id: 6853, note: "second of the three U+FEFF messages"},
	{name: "apple-forward-dib-02", id: 6855, note: "nested multipart/related, inner date parses"},
	{name: "hair-space-lines-survive", id: 6859, note: "THE OTHER DIRECTION of the trim divergence. This body has lines made only of U+200A HAIR SPACE. Go's strings.TrimSpace empties them and v1 drops them; the explicit set does not contain U+200A, so v2 keeps them. It is the only corpus message of its kind, and without it the suite would pin the U+FEFF direction only"},
	{name: "apple-forward-enbd-alert", id: 6973, note: "DECISION 14 IN ONE MESSAGE. An Apple-Mail forward of an Emirates NBD 'Transaction advice'. The account last4 lives ONLY in the subject, and only in the INNER subject: the outer envelope subject is 'Fwd: ...'. Its Subject header is also the corpus's only multi-word RFC 2047 case"},

	// --- More real mail, for breadth ----------------------------------------
	{name: "dib-arabic-08", id: 2425},
	{name: "dib-arabic-09", id: 3102},
	{name: "dib-arabic-10", id: 3230},
	{name: "dib-arabic-11", id: 5000},
	{name: "dib-arabic-12", id: 6000},
	{name: "dib-arabic-13", id: 6852},
	{name: "dib-arabic-14", id: 6867},

	// --- Derived: shapes the corpus does not contain ------------------------
	{
		name: "mislabelled-utf8-actually-windows-1256",
		id:   2695,
		note: "DERIVED from corpus id 2695 by rewriting charset=windows-1256 to charset=utf-8 and nothing else. " +
			"The corpus contains no message whose charset declaration is wrong, so this shape has to be constructed — " +
			"and it is the ONLY test of stage 3's U+FFFD placement against real bank bytes.",
		derive: deriveMislabelCharset,
	},
	{
		name: "broken-mime-raw-fallback",
		id:   9,
		note: "DERIVED from corpus id 9 by prepending one malformed header line, which makes go-message fail at the " +
			"first line and forces the stage-1 raw fallback. The corpus contains no message that fails to parse " +
			"(0 of 6998), so the fallback v2 adds over v1 has no natural sample.",
		derive: deriveBrokenMIME,
	},
	{
		name: "base64-continuation-indent",
		id:   9,
		note: "DERIVED from corpus id 9 by indenting one line of the base64 payload with two spaces. No corpus base64 " +
			"payload contains embedded whitespace, but RFC 2045 permits it; both executors must skip it rather than " +
			"fail the leaf. Text must be byte-identical to dib-arabic-01.",
		derive: deriveBase64Indent,
	},
	{
		name: "gmail-forward-1",
		id:   6973,
		note: "DERIVED. The corpus contains ZERO Gmail forwards — all 56 forwards are Apple Mail — even though Gmail " +
			"forwarding is the primary onboarding path (spec 3.2). This fixture rebuilds corpus id 6973's real ENBD " +
			"alert body under Gmail's dashed marker and same-line header layout. " +
			"WARNING: the ARC header set is copied verbatim from a real message and DOES NOT VERIFY over this body. " +
			"It is here only so the normalizer walks a realistic header block; it must never be used as an ARC fixture.",
		derive: deriveGmailForward,
	},
}

// deriveMislabelCharset rewrites the declared charset to utf-8, leaving the
// bytes it describes untouched.
func deriveMislabelCharset(raw []byte) []byte {
	return bytes.ReplaceAll(raw, []byte("windows-1256"), []byte("utf-8"))
}

// deriveBrokenMIME prepends a line that cannot be a header field.
func deriveBrokenMIME(raw []byte) []byte {
	return append([]byte("!!! this line is not a header field\r\n"), raw...)
}

// deriveBase64Indent indents the second line of the first base64 payload.
func deriveBase64Indent(raw []byte) []byte {
	marker := []byte("Content-Transfer-Encoding: base64\r\n\r\n")
	i := bytes.Index(raw, marker)
	if i < 0 {
		return raw
	}
	start := i + len(marker)
	nl := bytes.Index(raw[start:], []byte("\r\n"))
	if nl < 0 {
		return raw
	}
	at := start + nl + 2
	out := make([]byte, 0, len(raw)+2)
	out = append(out, raw[:at]...)
	out = append(out, ' ', ' ')
	out = append(out, raw[at:]...)
	return out
}

// gmailForwardTemplate is the Gmail inline-forward layout: a dashed marker and
// value-on-the-same-line headers.
const gmailForwardTemplate = "---------- Forwarded message ---------\r\n" +
	"From: Emirates NBD <alert@emiratesnbd.com>\r\n" +
	"Date: Jul 24, 2026 at 4:11 PM\r\n" +
	"Subject: Emirates NBD Transaction advice for account ending with 3701\r\n" +
	"To: <ledger.beta.user@gmail.com>\r\n" +
	"\r\n"

// deriveGmailForward rebuilds a message's normalized body under Gmail's
// forward layout, carrying the ARC headers of the source message along.
func deriveGmailForward(raw []byte) []byte {
	// Re-use the source message's own normalized body as the inner content, so
	// the fixture's text is real bank wording rather than invented copy.
	inner, err := Normalize(CurrentVersion, raw, time.Unix(0, 0).UTC())
	if err != nil {
		return raw
	}
	// Collect the ARC-* header fields with their folded continuation lines, and
	// stop at the first field that is neither. Tracking "am I inside an ARC
	// field" explicitly matters: a continuation line is only a continuation OF
	// SOMETHING, and treating every indented line as one would drag the folded
	// tail of whatever header follows the ARC set into the fixture.
	var arc []string
	inARC := false
	for _, line := range strings.Split(strings.ReplaceAll(string(raw), "\r\n", "\n"), "\n") {
		folded := strings.HasPrefix(line, " ") || strings.HasPrefix(line, "\t")
		switch {
		case strings.HasPrefix(strings.ToLower(line), "arc-"):
			inARC = true
		case folded && inARC:
			// keep going
		default:
			inARC = false
			if len(arc) > 0 {
				// The ARC set has ended.
				continue
			}
		}
		if inARC {
			arc = append(arc, line)
		}
	}
	var b strings.Builder
	b.WriteString("Return-Path: <ledger.beta.user@gmail.com>\r\n")
	for _, l := range arc {
		b.WriteString(l)
		b.WriteString("\r\n")
	}
	b.WriteString("From: Beta User <ledger.beta.user@gmail.com>\r\n")
	b.WriteString("Date: Fri, 24 Jul 2026 18:02:11 +0400\r\n")
	b.WriteString("Subject: Fwd: Emirates NBD Transaction advice for account ending with 3701\r\n")
	b.WriteString("To: ingest@ledger.example\r\n")
	b.WriteString("Content-Type: text/plain; charset=utf-8\r\n")
	b.WriteString("Content-Transfer-Encoding: quoted-printable\r\n")
	b.WriteString("\r\n")
	b.WriteString(quotedPrintableEncode(gmailForwardTemplate + strings.ReplaceAll(inner.Text, "\n", "\r\n") + "\r\n"))
	return []byte(b.String())
}

// quotedPrintableEncode is a minimal RFC 2045 encoder: enough to wrap a UTF-8
// body at 76 columns with soft line breaks, which is what makes this fixture
// exercise the quoted-printable decoder too.
func quotedPrintableEncode(s string) string {
	var out strings.Builder
	col := 0
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c == '\r' && i+1 < len(s) && s[i+1] == '\n' {
			out.WriteString("\r\n")
			col = 0
			i++
			continue
		}
		var tok string
		if c == '=' || c < 32 || c > 126 {
			tok = fmt.Sprintf("=%02X", c)
		} else {
			tok = string(rune(c))
		}
		if col+len(tok) > 73 {
			out.WriteString("=\r\n")
			col = 0
		}
		out.WriteString(tok)
		col += len(tok)
	}
	return out.String()
}

// TestWriteNormalizerFixtures regenerates conformance/normalizer/*.json from a
// scratch .backup copy of the v1 corpus.
//
//	LEDGER_WRITE_CONFORMANCE=1 LEDGER_CORPUS_DB=/scratch/corpus.db \
//	  go test ./internal/v2/norm/ -run TestWriteNormalizerFixtures -v
func TestWriteNormalizerFixtures(t *testing.T) {
	if os.Getenv(writeFixturesEnv) == "" {
		t.Skipf("%s is unset; fixtures are committed and regenerated deliberately", writeFixturesEnv)
	}
	path := os.Getenv("LEDGER_CORPUS_DB")
	if path == "" {
		t.Skip("LEDGER_CORPUS_DB is unset; see internal/v2/corpus for how to make the .backup copy")
	}
	db, err := corpus.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	wanted := map[int64]bool{}
	for _, f := range corpusFixtures {
		wanted[f.id] = true
	}
	rawByID := map[int64][]byte{}
	recvByID := map[int64]time.Time{}
	if err := db.Each(func(m corpus.Message) error {
		if !wanted[m.ID] {
			return nil
		}
		rawByID[m.ID] = append([]byte(nil), m.RawBody...)
		recvByID[m.ID] = m.ReceivedAt
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	for id := range wanted {
		if _, ok := rawByID[id]; !ok {
			t.Fatalf("corpus id %d is not in %s; the fixture list names explicit ids so a "+
				"regeneration cannot silently re-point at different mail", id, path)
		}
	}

	if err := os.MkdirAll(conformanceDir, 0o755); err != nil {
		t.Fatal(err)
	}

	type manifestEntry struct {
		File    string `json:"file"`
		Name    string `json:"name"`
		Source  string `json:"source"`
		Note    string `json:"note,omitempty"`
		Part    string `json:"expect_part"`
		Charset string `json:"expect_charset"`
		Fwd     bool   `json:"expect_forwarded"`
		DateSrc string `json:"expect_date_source"`
	}
	var entries []manifestEntry

	for _, f := range corpusFixtures {
		raw := rawByID[f.id]
		source := fmt.Sprintf("v1 corpus ingest_log id %d, verbatim", f.id)
		if f.derive != nil {
			raw = f.derive(raw)
			source = fmt.Sprintf("v1 corpus ingest_log id %d, DERIVED", f.id)
		}
		recv := recvByID[f.id]
		if recv.IsZero() {
			recv = time.Date(2026, 6, 5, 9, 0, 0, 0, time.UTC)
		}
		recv = recv.UTC()

		got, err := Normalize(CurrentVersion, raw, recv)
		if err != nil {
			t.Fatalf("%s: Normalize: %v", f.name, err)
		}
		c := conformanceCase{
			Name:                f.name,
			Note:                f.note,
			Source:              source,
			NormalizerVersion:   CurrentVersion,
			ReceivedAt:          recv.Format(time.RFC3339),
			RawBase64:           base64.StdEncoding.EncodeToString(raw),
			ExpectTextBase64:    base64.StdEncoding.EncodeToString([]byte(got.Text)),
			ExpectPart:          got.PartUsed,
			ExpectCharset:       got.Charset,
			ExpectSubjectBase64: base64.StdEncoding.EncodeToString([]byte(got.Subject)),
			ExpectFromBase64:    base64.StdEncoding.EncodeToString([]byte(got.From)),
			ExpectForwarded:     got.Forwarded,
			ExpectEmailDate:     got.EmailDate.UTC().Format(time.RFC3339),
			ExpectDateSource:    got.DateSource,
		}
		b, err := json.MarshalIndent(c, "", "  ")
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(conformanceDir, f.name+".json"), append(b, '\n'), 0o644); err != nil {
			t.Fatal(err)
		}
		entries = append(entries, manifestEntry{
			File: f.name + ".json", Name: f.name, Source: source, Note: f.note,
			Part: got.PartUsed, Charset: got.Charset, Fwd: got.Forwarded, DateSrc: got.DateSource,
		})
	}

	manifest := struct {
		Note              string          `json:"note"`
		Spec              string          `json:"spec"`
		NormalizerVersion int             `json:"normalizer_version"`
		Encoding          string          `json:"encoding"`
		Cases             []manifestEntry `json:"cases"`
	}{
		Note: "Written by internal/v2/norm TestWriteNormalizerFixtures. Regenerate with " +
			"LEDGER_WRITE_CONFORMANCE=1 LEDGER_CORPUS_DB=/scratch/corpus.db; do not hand-edit. " +
			"Every case is real mail from the operator's own v1 corpus; the four cases marked DERIVED " +
			"are real messages mutated in one named way, because the corpus contains no natural sample " +
			"of the shape. Nothing is redacted: this is a private repository.",
		Spec:              "docs/superpowers/specs/v2-normalizer-v1.md",
		NormalizerVersion: CurrentVersion,
		Encoding: "expect_text, expect_subject and expect_from are base64 of the exact UTF-8 bytes. " +
			"A JSON string cannot round-trip the raw fallback's output, so the fixture holds bytes, not text.",
		Cases: entries,
	}
	b, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(conformanceDir, "manifest.json"), append(b, '\n'), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Logf("wrote %d fixtures + manifest to %s", len(entries), conformanceDir)
}

// ---------------------------------------------------------------------------
// Corpus-gated equivalence probes
// ---------------------------------------------------------------------------

// TestCorpusHeaderExtractionMatchesV1 checks that reading Subject and From out
// of the raw message reproduces what v1's IMAP ENVELOPE handed the cascade.
// Task 16 owns the full body-equivalence gate; this is the cheap half of it,
// and it is the half most likely to be quietly wrong, because v1 never parsed
// these headers itself.
func TestCorpusHeaderExtractionMatchesV1(t *testing.T) {
	path := os.Getenv("LEDGER_CORPUS_DB")
	if path == "" {
		t.Skip("LEDGER_CORPUS_DB is unset")
	}
	db, err := corpus.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	var checked, subjBad, fromBad int
	err = db.Each(func(m corpus.Message) error {
		subject, from, ok := headersOf(m.RawBody)
		if !ok {
			return nil
		}
		checked++
		if subject != m.Subject {
			if subjBad < 5 {
				t.Errorf("id %d subject: got %q, v1 envelope %q", m.ID, subject, m.Subject)
			}
			subjBad++
		}
		if !strings.EqualFold(from, m.FromAddr) {
			if fromBad < 5 {
				t.Errorf("id %d from: got %q, v1 envelope %q", m.ID, from, m.FromAddr)
			}
			fromBad++
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("checked %d messages: %d subject mismatches, %d from mismatches", checked, subjBad, fromBad)
}

// headersOf exposes the header extraction to the corpus probe above.
func headersOf(raw []byte) (subject, from string, ok bool) {
	_, _, _, subject, from, err := extract(raw)
	return subject, from, err == nil
}
