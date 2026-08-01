# v2 Normalizer, version 1 — the written contract

**Status:** frozen. **Implementations:** `internal/v2/norm` (Go, this task);
a TypeScript twin follows. **Fixtures:** `conformance/normalizer/*.json`.

Extraction templates match **normalized** text. That makes this algorithm, not
the templates, the place where template behaviour actually lives: change how a
`<br>` becomes a newline, or which characters count as trimmable, and every
template in the system silently starts matching something else — including
templates written months earlier against the old behaviour.

So the algorithm is versioned. `Normalize(version, raw, receivedAt)` takes the
version explicitly, a stored transaction records the version that produced its
text, and **any** change to the stages below is a version bump, never an
in-place edit. That includes changes that look like bug fixes; §9 lists two
known defects that were deliberately ported rather than fixed for this reason.

Two implementations must produce **byte-identical** output. Every decision
below that could plausibly differ between Go and JavaScript is called out with
the reason, because the failure mode is silent: the two executors agree on
6,997 messages and disagree on the one that matters.

---

## 0. Interface

```go
const CurrentVersion = 1
func Versions() []int
func Normalize(version int, raw []byte, receivedAt time.Time) (Result, error)

type Result struct {
    Text       string    // the normalized, unwrapped body templates match against
    PartUsed   string    // "html" | "plain" | "raw"
    Charset    string    // chosen leaf's declared charset, lowercased; "" when none
    Subject    string    // EFFECTIVE subject — inner when forwarded
    From       string    // EFFECTIVE From — inner when forwarded. CONTENT ONLY.
    Forwarded  bool      // a forward marker line was found
    EmailDate  time.Time // inner forwarded Date when parseable, else receivedAt
    DateSource string    // "forward_header" | "received"
}
```

An unknown version is an error (`ErrUnknownVersion`). Old versions are never
removed from `Versions()`: a transaction normalized at v1 must stay
reproducible after v2 ships, or its template match cannot be re-verified.

### Trust

`Result.From` and `Result.Subject` are **content, not identity**. When a message
is an inline forward they are read out of the forwarded header block, which is
body text anyone can author — "Begin forwarded message: / From: alerts@dib.ae"
is four seconds of typing. They exist for diagnostics and template authorship.

The trusted-lane gate and `Match.SenderDomain` read the **cryptographically
verified signing domain** from the ARC/DKIM verifier and nothing from this
package. A reviewer should treat any use of `Result.From` in a trust decision
as a defect. `Result` deliberately carries no field that could be mistaken for
a verified identity, and a test asserts it stays that way.

---

## The ten stages, in order

### Stage 1 — Parse the message; fall back to raw on failure

Parse with an RFC 5322/2045 MIME parser. On an **unrecoverable parse error**
(a malformed header field, not merely an unknown charset or unknown transfer
encoding), do not fail. Instead:

- `PartUsed = "raw"`, `Charset = ""`.
- The body is everything after the first `\r\n\r\n`, or the first `\n\n`,
  whichever **starts earlier**. When the message contains neither, the body is
  the **entire message** — recording too much beats recording nothing.
- The body is treated as `text/plain` with no charset conversion, and goes
  straight to stage 3.
- `Subject` and `From` are recovered by the header scan in §"Headers" below.

> **This fallback is new in v2.** v1's `BodyText` returns an error and the
> message becomes `unparsed` with no body recorded at all. §2's drop policy
> makes "we could not parse the MIME, so we recorded nothing about the body"
> unacceptable. It is one of the two deliberate divergences from v1.
>
> The same reasoning extends one step further: if the MIME tree breaks apart
> *mid-walk* (stage 2) and **no** text leaf was collected, the raw fallback is
> used as well. If at least one leaf was already collected, that leaf is used
> and the structural error is ignored. v1 aborts the whole message in both
> cases.

### Stage 2 — Walk the MIME tree

Depth-first, descending **every** `multipart/*` container (mixed, alternative
and related nest arbitrarily deep once inline images are involved). Record the
**first non-empty** `text/html` leaf and the **first non-empty** `text/plain`
leaf, each with its declared `charset` parameter.

For each leaf, decode its `Content-Transfer-Encoding`, then convert its charset
to UTF-8. An undecodable leaf is **skipped, not fatal**; its partial bytes are
discarded.

#### base64

Skip **every** ASCII whitespace byte (space, tab, CR, LF) anywhere in the
payload, then decode. RFC 2045 permits whitespace inside a base64 body and real
mailers emit it; both implementations must skip it rather than fail the leaf.

*No corpus message has embedded whitespace in base64, so this rule is pinned by
the derived fixture `base64-continuation-indent`, whose output must be
byte-identical to `dib-arabic-01`.*

#### quoted-printable — the leniency rules matter

Go's `mime/quotedprintable` reader is lenient in specific ways. A strict TS
decoder would throw where Go silently passes text through, so the rules are
enumerated:

| Input | Output |
|---|---|
| `=` + two hex digits (either case) | that byte |
| `=` + CRLF, or `=` + LF | soft line break: **removed** |
| `=` + anything else | the `=` **and** the following characters, **literally** |
| `=` at end of input | **dropped** |
| whitespace before a **hard** line break | **stripped** |
| whitespace before a **soft** line break (`=` CRLF) | **preserved** |

So `A=ZZB` → `A=ZZB`, `AB=` → `AB`, `A  =\r\nB` → `A  B`, `A  \r\nB` →
`A\r\nB`.

#### charset

The declared label is resolved through the **WHATWG Encoding Standard's label
table**, which is what a TypeScript `TextDecoder` implements natively and what
`golang.org/x/text/encoding/htmlindex` is a copy of. Decoding is in
**replacement mode** (never `fatal: true`).

`Result.Charset` is the leaf's **declared** label, lowercased and trimmed —
not the resolved canonical name — so an operator can see what the bank claimed.
It is `""` when no charset parameter was present, and `""` on the raw fallback.

**Known boundary.** v1 resolves labels through Go's `ianaindex.MIME` first and
only falls back to the WHATWG table. The two disagree for exactly two labels
that matter:

| label | ianaindex (v1) | WHATWG (v2, TS) |
|---|---|---|
| `us-ascii` | strict US-ASCII: bytes ≥ 0x80 → U+FFFD | windows-1252 |
| `iso-8859-1` | true Latin-1 | windows-1252 (differs at 0x80–0x9F) |

The corpus contains **one** `us-ascii` part (id 6) and **zero** `iso-8859-1`
parts, and the `us-ascii` part is pure ASCII, so the disagreement is invisible
today and produces zero divergences. The WHATWG table is chosen anyway because
it is the only one both languages can implement without hand-porting Go's
three-step alias chain. **If a real `iso-8859-1` message with bytes in
0x80–0x9F ever arrives, this is where it will differ from v1.**

### Stage 3 — Validate UTF-8 and substitute (WHATWG)

After charset decoding — and **unconditionally** on the raw-fallback path —
replace every invalid byte sequence using the **WHATWG UTF-8 decoder error
handling**: one U+FFFD per *maximal subpart*.

This is deliberately **not** Go's `strings.ToValidUTF8` (one U+FFFD per
contiguous invalid run) and **not** a `utf8.DecodeRune` loop (one per byte).
The algorithm, byte by byte:

```
codepoint = 0; bytesNeeded = 0; bytesSeen = 0; lower = 0x80; upper = 0xBF
for each byte c:
  if bytesNeeded == 0:
    if c <= 0x7F:              emit c
    elif 0xC2 <= c <= 0xDF:    bytesNeeded = 1; codepoint = c & 0x1F
    elif 0xE0 <= c <= 0xEF:    if c == 0xE0: lower = 0xA0
                               if c == 0xED: upper = 0x9F
                               bytesNeeded = 2; codepoint = c & 0x0F
    elif 0xF0 <= c <= 0xF4:    if c == 0xF0: lower = 0x90
                               if c == 0xF4: upper = 0x8F
                               bytesNeeded = 3; codepoint = c & 0x07
    else:                      emit U+FFFD
    continue
  if c < lower or c > upper:
    reset all state; emit U+FFFD; REPROCESS c as a fresh lead byte; continue
  lower = 0x80; upper = 0xBF
  codepoint = (codepoint << 6) | (c & 0x3F); bytesSeen += 1
  if bytesSeen == bytesNeeded: emit codepoint; reset
at end of input: if bytesNeeded != 0: emit U+FFFD
```

Pinned vectors (all in `norm_test.go`):

| input | output |
|---|---|
| `41 E2 82` | `A` + 1×U+FFFD |
| `41 F0 9F 92` | `A` + 1×U+FFFD |
| `E2 82 41 42` | 1×U+FFFD + `AB` |
| `41 80 42` | `A` + 1×U+FFFD + `B` |
| `41 C0 80 42` | `A` + 2×U+FFFD + `B` |
| `41 ED A0 80 42` | `A` + 3×U+FFFD + `B` |
| `41 F5 80 80 80 42` | `A` + 4×U+FFFD + `B` |
| `EF BB BF 41` | U+FEFF + `A` — **the BOM is not stripped** |

**A leading BOM is never stripped here.** BOM removal belongs to the stage-8
trim set, which removes U+FEFF wherever it lands. A TypeScript twin must
therefore construct `new TextDecoder(label, { ignoreBOM: true, fatal: false })`
— whose confusingly-named option means "pass the BOM through".

### Stage 4 — Choose the part

Use the HTML leaf when it is non-empty; otherwise the plain leaf; otherwise
fail with `ErrNoTextPart`. `PartUsed` is `"html"`, `"plain"` or `"raw"`.

### Stage 5 — Strip HTML (only when the HTML leaf was chosen)

In **exactly this order**:

1. `(?is)<script[^>]*>.*?</script>` → `" "` (a single space)
2. `(?is)<style[^>]*>.*?</style>` → `" "`
3. the literals `<br>`, `<br/>`, `</p>`, `</tr>`, `</div>` → `"\n"`
   (case-**sensitive**, exactly these five, each a full pass)
4. `(?s)<[^>]+>` → `"\n"`

A `text/plain` leaf and the raw fallback skip this stage entirely and reach
stage 6 as-is.

*JS note: `[^>]` and `[^?]` already match newlines in JavaScript, so the `s`
flag is redundant there but harmless. Use `gi` / `gs` as appropriate and make
the replacement global.*

### Stage 6 — Decode exactly six entities

`&nbsp;`→U+0020, `&amp;`→`&`, `&lt;`→`<`, `&gt;`→`>`, `&quot;`→`"`,
`&#39;`→`'`. **No others**: `&copy;` survives verbatim.

**This is ONE left-to-right pass that never rescans what it just emitted.** At
each position, if any of the six sequences starts there, emit its replacement
and continue scanning *after* the consumed input. (No sequence is a prefix of
another, so the order of the six is immaterial.)

> The obvious TypeScript spelling — six sequential `.replace(/&x;/g, …)` calls
> — is **wrong**, and wrong in a way no small test catches. `&amp;lt;` must
> normalize to `&lt;`; sequential replacement produces `<`, because the second
> pass sees the `&` the first pass emitted. Go's `strings.Replacer` has the
> required single-pass semantics; a TS twin needs one regex alternation with a
> lookup function, not a chain.

### Stage 7 — Collapse horizontal whitespace

Every run of characters in `{U+0009, U+0020, U+00A0}` collapses to a single
U+0020. Regex: `[ \t ]+` → `" "`. Note U+00A0 is in this set, so a
non-breaking space never survives to stage 8.

### Stage 8 — Split and trim with the EXPLICIT set

Split on `"\n"`. Trim each line, both ends, of exactly:

```
U+0009  U+000A  U+000B  U+000C  U+000D  U+0020  U+00A0  U+FEFF
```

**Not** `strings.TrimSpace` and **not** JavaScript's `String.prototype.trim()`.
The three sets differ, and the differences are observable in real mail:

| character | Go `TrimSpace` | JS `.trim()` | **this contract** |
|---|---|---|---|
| U+0085 NEXT LINE | trims | no | **no** |
| U+2000–U+200A (incl. U+200A HAIR SPACE) | trims | trims | **no** |
| U+202F NARROW NBSP | trims | trims | **no** |
| U+FEFF | no | trims | **yes** |

Naming the set explicitly is the only thing that makes the two implementations
byte-identical. It is the other deliberate divergence from v1 — see §9.

### Stage 9 — Drop empty lines and join

Drop every line that is empty after stage 8. Join the rest with `"\n"`. There
is no trailing newline.

### Stage 10 — Unwrap an inline forward

Gmail forwarding is the primary onboarding path (spec §3.2), so most messages
a new user contributes arrive wrapped in a forwarding client's preamble. The
transaction is described by the **inner** message.

Operate on the stage-9 text. **Every regex here spells out `" *"`, never
`\s*`**: Go's RE2 `\s` is `[\t\n\f\r ]` while JavaScript's `\s` is a much
larger Unicode set including U+00A0 and U+FEFF — exactly the class of silent
disagreement this contract exists to prevent.

**Find the marker.** The first line matching

```
(?i)^ *(begin forwarded message:|-+ *forwarded message *-+) *$
```

(Apple Mail and Gmail respectively).

**No marker.** `Forwarded = false`. `Subject` is the message's own `Subject:`
with a leading `Fwd:`/`FW:`/`Fw:` stripped by
`(?i)^ *(fwd?|fw) *: *`. `From` is the message's own. `Text` is unchanged.

**Marker found.** `Forwarded = true`. Scan forward from the marker with

```
(?i)^ *(from|to|subject|date|reply-to|cc|sent) *: *(.*)$
```

- A matching line whose captured value is non-empty is Gmail's same-line
  layout: take it.
- A matching line whose captured value is **empty** is Apple Mail's
  next-line layout: take the next line that is non-empty after trimming with
  the stage-8 set, and advance the cursor to it.
- A **non**-matching line **before** any header has been seen is preamble
  noise ("Sent from my iPhone"): skip it and keep scanning.
- A **non**-matching line **after** at least one header has been seen ends the
  block. The original body starts there.

`Subject` and `From` take the recovered inner values **when non-empty**;
otherwise `From` keeps the message's own and `Subject` falls back to the
Fwd-stripped own subject. `Text` becomes the remainder, trimmed with the
**stage-8 explicit set** (not `TrimSpace`).

> `Forwarded = true` means **a marker line was present**, not that inner
> headers were recovered. 50 of the 56 forwards in the v1 corpus are
> `>`-quoted `text/plain`, where the marker line is unquoted but every header
> line is prefixed `> `. `>` is not whitespace, so no header matches, nothing
> is recovered, and the body is returned **unchanged**. See §9.

**`EmailDate`.** Parse the recovered inner `Date:` value:

1. Trim with the stage-8 set.
2. Replace U+202F and U+00A0 with U+0020. (Apple Mail inserts a narrow
   no-break space before AM/PM on recent OSes.)
3. Build two candidates: the whole string, and — when it contains a space at
   index > 0 — the string with everything from the **last** space onward
   removed, then trimmed. That drops a trailing zone token such as `GST` or
   `GMT+4`.
4. Try each candidate against these **four closed layouts**, in order, first
   match wins:

   - `Jan 2, 2006 at 3:04 PM`
   - `Mon, Jan 2, 2006 at 3:04 PM`
   - `2 January 2006 at 15:04:05`
   - `2 January 2006 at 15:04`

   Month names are matched case-insensitively; `AM`/`PM` must be **uppercase**;
   day and 12-hour hour accept 1 or 2 digits; minutes and seconds are exactly
   2 digits. The result is **naive** — read as UTC, no zone applied.

On success `EmailDate` is that time and `DateSource = "forward_header"`.
Otherwise `EmailDate = receivedAt` and `DateSource = "received"`.

> **TypeScript must not use `Date.parse` here.** An earlier dual-executor task
> found real divergences between Go's `time.Parse` and `Date.parse`. These four
> layouts must be reimplemented as explicit patterns over an explicit
> month-name table, and pinned by the fixtures.

---

## Headers

`Subject` is the message's `Subject:` field, RFC 2047-decoded. Adjacent encoded
words join with **no separator** — the corpus's ENBD alert forward is exactly
this shape (`=?utf-8?B?…?= =?utf-8?B?…?=`), and inserting a space there breaks
the last4 match. Encoded-word charsets resolve through the same WHATWG table as
stage 2. When decoding fails, the raw field value is used.

`From` is reduced to the **bare address** (`a@b.c`, no display name), which is
what v1's IMAP `ENVELOPE` supplied to the parse cascade. Parse as an address
list and take the first; then as a single address; then recover an angle-addr
by hand; then fall back to the trimmed raw value.

*Verified: this reproduces v1's envelope `Subject` and `From` on **all 6,998**
corpus messages — 0 mismatches (`TestCorpusHeaderExtractionMatchesV1`).*

**On the raw-fallback path only**, headers are recovered by an explicit scan of
everything before the first blank line: split on `\n` after normalizing CRLF,
join a continuation line (one starting with space or tab) to its predecessor
with a **single U+0020** after trimming, then take the **first** `Subject:` and
`From:` field, case-insensitively. This keeps adjacent RFC 2047 words adjacent.

---

## 9. Divergences from v1 — all measured, none accidental

Measured over the full 6,998-message v1 corpus by
`TestCorpusDivergenceFromV1IsOnlyTheTrimSet`:

> `corpus 6998 messages: 0 v1 parse failures, 4 text differences
> [2554 6853 6854 6859], 0 subject differences, 0 NOT explained by the trim set`

### D1 — The explicit trim set (4 messages, both directions)

- ids **2554, 6853, 6854**: the line immediately after the forwarded header
  block is a lone **U+FEFF**. v1's `TrimSpace` keeps it as a line; the explicit
  set empties it and stage 9 drops it. *v2 drops a line v1 keeps.*
- id **6859**: a Google notice whose HTML yields lines made only of **U+200A**
  HAIR SPACE. `TrimSpace` empties them and v1 drops them; U+200A is not in the
  explicit set, so v2 keeps them. *v2 keeps lines v1 drops.*

Both directions are pinned by fixtures (`apple-forward-feff-line`,
`hair-space-lines-survive`).

### D2 — The raw-body fallback (0 messages)

v1 records nothing when MIME parsing fails; v2 records the raw body and still
recovers `Subject`/`From`. **Zero** corpus messages fail to parse, so this
contributes nothing to the numbers above — which is exactly why it needs the
derived fixture `broken-mime-raw-fallback`.

### D3 — WHATWG U+FFFD substitution (0 messages)

v1 lets invalid bytes through untouched; stage 3 substitutes. **Zero** corpus
leaves decode to invalid UTF-8. Mandated by the brief, pinned by the derived
fixture `mislabelled-utf8-actually-windows-1256`.

### D4 — Charset label resolution (0 messages)

WHATWG rather than v1's `ianaindex`-first chain. Differs only for `us-ascii`
and `iso-8859-1` with bytes ≥ 0x80; see stage 2.

---

## 10. Known defects, deliberately ported

These are v1 behaviours that are **wrong** but were reproduced exactly, because
"fix" and "keep the equivalence gate clean" are in conflict and the gate wins
for this task. Each is a candidate for **normalizer v2**, not a patch to v1.

**K1 — `>`-quoted forwards recover nothing.** `fwdHeaderLineRe` anchors on
optional *spaces*; `>` is not a space. **50 of the corpus's 56 forwards** are
this shape, so they keep the forwarder's envelope `From`, keep the whole
preamble in `Text`, and get **no** inner date. Fix: allow an optional `>` run
before the label. This changes `Text` for 50 messages, so it is a version bump.

**K2 — the Apple Mail iOS date shape does not parse.** The iOS app emits
12-hour **with seconds**: `18 June 2026 at 7:33:38 PM GST`. None of the four
closed layouts covers it (they have either seconds *or* AM/PM, never both), so
stripping the zone token still leaves `7:33:38 PM` unmatched and the
transaction silently dates to the arrival time. **3 corpus messages** (2554,
6853, 6854). Fix: add `2 January 2006 at 3:04:05 PM`.
`TestParseForwardDateRejectsTheiPhoneSecondsWithAMPMShape` asserts the current,
broken behaviour so the change cannot be made by accident.

**K3 — no Gmail forward has ever been seen.** All 56 corpus forwards are Apple
Mail. Gmail's same-line layout is implemented and tested, but **against a
derived fixture**, never against real Gmail output — while spec §3.2 makes
Gmail forwarding the primary onboarding path. This is the largest untested
surface in the normalizer.

---

## 11. Conformance fixtures

`conformance/normalizer/*.json`, 37 cases plus `manifest.json`. Regenerate:

```bash
LEDGER_WRITE_CONFORMANCE=1 LEDGER_CORPUS_DB=/scratch/corpus.db \
  go test ./internal/v2/norm/ -run TestWriteNormalizerFixtures -v
```

Every case is real mail from the operator's own v1 corpus, selected by an
**explicit id list** (never a sample stride — the live corpus grows, so a
stride would silently re-point at different mail on every regeneration). Four
cases are marked `DERIVED`: a real message mutated in exactly one named way,
because the corpus contains no natural sample of the shape.

`expect_text`, `expect_subject` and `expect_from` are **base64, not JSON
strings**. A JSON string cannot round-trip the raw fallback's output when it is
not valid UTF-8: the writer would substitute, the TypeScript reader would
substitute differently, and the suite would compare two different corrections
to the same corruption. Base64 makes the fixture the exact bytes.

> The `gmail-forward-1` fixture carries an ARC header set copied verbatim from
> a real message. It **does not verify** over that fixture's body. It is there
> only so the normalizer walks a realistic header block, and must never be used
> as an ARC fixture.
