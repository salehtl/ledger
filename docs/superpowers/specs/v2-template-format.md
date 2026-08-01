# v2 template definition format and the RE2-safe regex dialect

Status: implemented (Task 18). Consumed by Tasks 19 (Go executor + store), 20
(TypeScript executor), 21 (seed templates, hard gate).

Implementation: `internal/v2/tmpl/def.go`, `internal/v2/tmpl/dialect.go`.
Shared fixtures: `conformance/dialect/patterns.json`.

---

## 1. Why this exists

A bank parser in v2 is **data**, not code. One definition is authored in the
admin console, published once, and then executed by **two independent
engines**: the Go executor on the server and the TypeScript executor on every
device. The pattern text is stored once, and both engines run *that same text*.

That gives two failure modes, and everything in this document is aimed at one
of them:

1. **Silent divergence.** A construct the two engines read differently. Neither
   errors; the server extracts an amount the device does not, or the two
   capture different merchant strings, and the two views of the ledger drift.
   Twenty-four of the twenty-seven regexes in v1's `internal/parse/` contain at
   least one such construct, so this is the normal case, not an edge case.
2. **Cost.** The inbound path is attacker-writable — anyone who learns a user's
   inbound address can choose the body text. Go's RE2 cannot backtrack, but
   JavaScript's engine can, and it runs on the user's phone.

The dialect is the subset of RE2 on which the two engines were **measured** to
agree, with the backtracking shapes removed. `ValidatePattern` is a
**publish-time gate**: an invalid pattern never reaches the store.

Every claim below was measured on 2026-08-01 against Go 1.25, Bun 1.3.14, V8
151 (headless Chromium) and WebKit 26.5 (Playwright). The measurements are
recorded in `conformance/dialect/patterns.json` under `engine_notes`.

---

## 2. The definition format

```jsonc
{
  "id": "dib.card.v1",          // [a-z0-9]+([._-][a-z0-9]+)*
  "version": 1,                  // >= 1
  "bank": "dib",
  "normalizer_version": 1,       // which normalizer contract the patterns were written against
  "match": {
    "sender_domain": ["dib.ae"],           // VERIFIED signing-domain suffixes, at least one
    "subject_contains": [],                 // optional
    "body_contains": ["إشعار مشتريات"],     // optional
    "body_not_contains": []                 // optional
  },
  "default_currency": "AED",     // exactly three upper-case letters
  "date_from": "body",           // "body" | "email"
  "extract": [ /* see below */ ],
  "required": ["amount", "direction"]
}
```

`match.sender_domain` is matched against the **cryptographically verified
signing domain** from the trusted-lane check (Tasks 25–26). It is never matched
against a `From` header and never against `norm.Result.From`, which is
attacker-authored body text. A use of `Result.From` in a trust decision is a
defect.

### `extract` entries

```jsonc
{
  "field": "amount",       // amount | date | merchant | last4 | direction | is_transfer
  "type": "amount",        // amount | date | text | last4 | const | flag
  "source": "body",        // body | subject
  "patterns": ["..."],     // tried in order
  "flags": ["i"],          // only "i" is permitted
  "layouts": ["DD-MM-YYYY"], // date entries only, tried in order
  "value": "debit",        // const/flag entries only
  "override": false,       // see §6
  "why": "",               // mandatory when override is true
  "on_match": {}           // additional fields to set, only if not already set
}
```

Field and type are not independent enums — a pairing table is enforced, because
"amount extracted as text" would pass two enum checks and then never produce an
`int64`:

| field | legal types |
|---|---|
| `amount` | `amount` |
| `date` | `date` |
| `merchant` | `text`, `const` |
| `last4` | `last4`, `const` |
| `direction` | `const` (value must be `debit` or `credit`) |
| `is_transfer` | `flag` (value must be `true` or `false`) |

Other `ValidateDefinition` rules:

- `required` must include **`amount` and `direction`**, and every field it names
  must be produced by some `extract` entry — a `required` field nothing
  produces is a template that can never match.
- A non-`const`/`flag` entry needs at least one pattern; with none it can never
  produce a value.
- A `const`/`flag` entry with **no** patterns is legal and is the unconditional
  default. That is how v1's four-way DIB direction cascade — whose `default`
  branch is itself conditional — is expressed declaratively.
- A `date` entry needs at least one layout; `layouts` on any other type is an
  error.
- Unknown JSON keys are an **error**. A key nobody reads is exactly how a
  template "compiles, validates, publishes and silently matches nothing".

### Named groups

Patterns are stored with Go's spelling, `(?P<name>...)`, and mechanically
rewritten to `(?<name>...)` for JavaScript by `ToJS`. Storing one spelling is
what makes "both engines run the stored text" true.

| type | required groups | optional |
|---|---|---|
| `amount` | `amt` | `ccy` |
| `date` | `d` | — |
| `text`, `last4` | `v` | — |
| `const`, `flag` | none | — |

A pattern that captures under any other name is rejected: the executor reads
only the names above, so a group named anything else has captured something
nothing will ever read.

`ToJS` is a scanner, not a string replace. In `a\(?P<v` the parenthesis is
**escaped**, so those characters are a literal paren, an optional quantifier and
three literals — a `ReplaceAll` would turn them into a named group and silently
change what JavaScript matches.

### Date layouts

A closed enum. Both executors implement exactly these three and nothing else,
because a layout one executor understands and the other does not is a silent
per-device date difference.

```
DD-MM-YYYY
DD/Mon/YYYY hh:mm A
DD/Mon/YYYY
```

---

## 3. The dialect

`ValidatePattern(p, flags) []error`. Each violation carries a stable **reason
code**; the TypeScript mirror must reject the same pattern with the same code,
and `conformance/dialect/patterns.json` pins every pair.

Compilation is fixed on both sides and is not a per-call-site choice:

```
Go:         regexp.Compile(flags has "i" ? "(?i)"+p : p)      // tmpl.CompileGo
JavaScript: new RegExp(toJS(p), flags.join("") + "u")
```

**The `u` flag is mandatory and is load-bearing.** Measured: `/k/i` does **not**
match U+212A (Kelvin sign) while Go's `(?i)k` **does**; with `/k/iu` both match.
Without `u`, case folding, code-point semantics and escape validity all differ.
With it, both engines fold identically, quantifiers count code points rather
than UTF-16 units, and every escape this dialect bans becomes a hard
`SyntaxError` — a second, free layer of enforcement for 15 of the 30 rules.

### The rule table

Every row has a reason code, the measured divergence or cost bound behind it,
and — this is the part the first draft of the plan got wrong — **an accepted
rewrite**. `dialect_test.go` iterates the same table and asserts both
directions for every row, so a ban cannot be added without an expressible
alternative.

| code | rejected | accepted rewrite | why |
|---|---|---|---|
| `empty_pattern` | `` | `a` | an empty pattern matches everything |
| `pattern_too_long` | 513 runes | 512 runes | bounded cost (counted in **runes**, so Arabic anchors get the same limit in both languages) |
| `too_many_capture_groups` | 9 groups | 8 groups | bounded cost |
| `escape_perl_space` | `AED\s+([0-9]+)` | `AED[ \n]{1,4}([0-9]+)` | Go's `\s` is `[\t\n\f\r ]`; JS's also matches **`\v`**, U+00A0, U+FEFF and the Unicode space separators. `\v` is ASCII, so this needs no exotic input |
| `escape_word_boundary` | `\bAED\b` | `AED` | with `i` set, JS's word set gains U+017F and U+212A and Go's does not: `(?i)\bk` vs `/\bk/iu` on U+212A is false in Go, true in JS. Also meaningless around Arabic, which this corpus is |
| `escape_unicode_class` | `\p{Arabic}` | `[\x41-\x5a]` | Go accepts `\p{Arabic}` and rejects `\p{Script=Arabic}`; JS under `u` does the exact opposite |
| `escape_unicode_codepoint` | `\x{0623}` | `\x41` | `\x{...}` is a `SyntaxError` in JS; `\u{...}` does not compile in Go |
| `escape_text_anchor` | `\Ax` | `^x` | `\A`, `\z`, `\Z` compile in Go and are a `SyntaxError` in JS |
| `escape_backreference` | `(a)\1` | `(a)a` | absent from RE2, unbounded cost in JS. Also covers `\k` and octal |
| `escape_not_allowed` | `\a` | `\t` | the escape set is a **whitelist**. `\a` is BEL in Go and a `SyntaxError` in JS, and it is not on the spec's ban list — a blacklist would have missed it |
| `malformed_escape` | `a\` | `a\\` | a trailing backslash is not a pattern. Also `\xZ` |
| `inline_flags` | `(?i)aed` | `aed` + `"flags":["i"]` | JS has no inline flag groups |
| `lookaround` | `(?=x)` | `x` | a backtracking construct; RE2 lacks it |
| `named_group_js_syntax` | `(?<amt>[0-9])` | `(?P<amt>[0-9])` | one stored spelling, so `ToJS` is total |
| `unsupported_group` | `(?P=amt)` | `(?P<amt>[0-9])` | `(?P=`, `(?P>`, `(?#` exist in Go or PCRE and not in JS |
| `invalid_group_name` | `(?P<0a>x)` | `(?P<a0>x)` | Go accepts a leading digit and JS rejects it; JS accepts `$` in a name and Go rejects it. Names must match `[A-Za-z_][A-Za-z0-9_]*` |
| `duplicate_group_name` | `(?P<v>a)(?P<v>b)` | `(?P<v>a)(?P<w>b)` | Go accepts duplicate capture names, JS rejects them |
| `unbalanced_paren` | `(a` | `(a)` | structural |
| `bare_dot` | `Debit Amount:\n(.+)` | `Debit Amount:\n([^\n]+)` | Go's `.` matches `\r`, U+2028 and U+2029; JS's does not. `(.+)` appears in five of the six v1 seed anchors, so this rule is load-bearing |
| `group_unbounded_quantifier` | `(ab)+c` | `(ab)?c`, `(ab){2,3}c` | an unbounded quantifier on a group is the catastrophic-backtracking shape |
| `unbounded_inside_quantified_group` | `([0-9]+)?` | `([0-9]{1,4})?` | the `(a+)+` nesting that turns bounded work exponential |
| `multiple_unbounded_quantifiers` | `[0-9]+[0-9]+z` | `[0-9]{2,}z` | the **polynomial** backtracking shape: `n^k` for `k` unbounded quantifiers that can consume the same characters. At most one per alternation branch. Measured in Bun 1.3.14: 86 ms on 800 characters for two, **88,191 ms on 400** for four, and 31,680 ms on 8,000 for `[^\n]+X[^\n]+Y`, which separates them with a mandatory literal. RE2 does not backtrack, so this is a client-side **cost** rule, not an engine divergence |
| `bound_product_too_large` | `((a{4}){4}){5}` | `((a{4}){4}){4}` | the product of `{n,m}` upper bounds along any nesting path is capped at 64 |
| `malformed_repetition` | `a{,3}` | `a{0,3}` | Go reads `a{,3}` as five literal characters; JS under `u` makes it a `SyntaxError`. A literal brace must be `\{` |
| `empty_character_class` | `[]` | `[a]` | Go rejects `[]`; JS under `u` reads it as a class that never matches |
| `unterminated_character_class` | `[abc` | `[abc]` | structural |
| `class_literal_bracket` | `[[:alpha:]]` | `[a-zA-Z]` | Go compiles `[[:alpha:]]` as a POSIX class; JS under `u` makes it a `SyntaxError`, and **without** `u` it silently means something else entirely. A literal `[` inside a class must be `\[` |
| `flag_not_allowed` | `x` + `["m"]` | `x` + `["i"]` | JS's `m` treats `\r`, U+2028 and U+2029 as line terminators for `^`/`$` and Go's does not. `"mu"` is a perfectly legal JS flag string, so the validator is the *only* thing that catches this |
| `duplicate_flag` | `x` + `["i","i"]` | `x` + `["i"]` | the flag list reaches JS verbatim, and `"iiu"` is a JS error |
| `not_compilable` | `[z-a]` | `[a-z]` | the scanner models the dialect, not the whole grammar; Go's own parser is the backstop |

### Explicitly allowed, and this is a correction

**`?` and `{n,m}` MAY be applied to a group.** They are bounded — `(X)?` tries
`X` at most once and `(X){n,m}` at most `m` times — so neither can backtrack
catastrophically.

The first draft of the plan banned "a quantifier applied directly after `)`"
outright. That was self-contradictory: its own acceptance test required
`المبلغ\n(?P<ccy>[A-Z]{3} )?(?P<amt>…)` to pass. And it propagated —
`internal/parse/dib.go:21`, `enbd_alert.go:25`, `enbd_alert.go:26` and
`fields.go:13` all use exactly that optional-currency-prefix shape, so Task 21's
hard gate would have been unreachable. A blanket "no quantifier nested inside a
quantified group" has the same defect, since `(?P<ccy>[A-Z]{3} )?` nests `{3}`
inside a `?`. Hence the rules ban only **unbounded** quantifiers in both
positions.

Everything else is allowed: literals, character classes, `\d \w \n \t \r \f \v
\\ \. \( \)` and the other whitelisted escapes, `\xHH`, anchors, alternation,
non-greedy suffixes, and **one** unbounded quantifier per alternation branch on
a single character or class.

### The polynomial rule, and what it does not cover

The two nesting rules above stop the *exponential* `(a+)+` shape. Task 19
measured that they do not stop the *polynomial* one — several unbounded
quantifiers in a row that can all consume the same characters — and pinned the
gap with a `KNOWN` test rather than closing it, because a new ban needs a
reason code, a spec row and a sanctioned rewrite. Task 20 closed it. Measured
in Bun 1.3.14, `new RegExp(p, "u").test(input)`:

| pattern | input | Bun | Go RE2 |
|---|---|---|---|
| `[0-9]+[0-9]+z` | `"1"×800` | 86 ms | µs |
| `[0-9]+[0-9]+[0-9]+z` | `"1"×800` | 17,274 ms | µs |
| `[0-9]+[0-9]+[0-9]+[0-9]+z` | `"1"×400` | **88,191 ms** | µs |
| `[^\n]+X[^\n]+Y` | `"aX"×4000` | 31,680 ms | µs |
| `[^\n]+X[^\n]+Y[^\n]+Z` | `"aXbY"×500` | 33,373 ms | µs |

The last two rows are why the rule **counts** unbounded quantifiers instead of
looking for adjacent ones: a mandatory literal between them does not make the
shape cheap, it only decides which input triggers it. The bound is per
*alternation branch*, because a backtracking engine explores one branch at a
time — `[0-9]+z|[a-z]+q` costs what `[0-9]+z` costs. Every seed anchor in this
corpus has exactly one, and two adjacent ones always collapse:
`[0-9]+[0-9]+` **is** `[0-9]{2,}`.

Binding one of the two instead of collapsing them is not a fix and the rule
does not accept it: `[0-9]{1,64}[0-9]+z` is still quadratic, with the bound as
its constant — 73,810 ms on 51,200 characters.

**What is still not bounded** is the cost of the one remaining unbounded
quantifier, which is quadratic in any backtracking engine whenever the match
fails: `[0-9]+z` took 17,935 ms on 200,000 digits. `MaxBodyBytes` is 2,000,000,
so the dialect alone does not make a template cheap.

What does is a property of the **templates**, and there are two ways to have it:
a mandatory literal prefix, so the engine's prefix scan discards almost every
start position, or a bounded run, so each start position is cheap.

The ENBD alert anchor as v1 wrote it had **neither**, and Task 20 found it by
timing the seed templates in the client engine rather than by reasoning about
them:

| anchor | hostile 1 MB body | Bun | Go RE2 |
|---|---|---|---|
| `الدفع الى\n(?P<v>[^\n]+)` | `"الدفع الى\n"+"x"×1,000,000` | 1.8 ms | µs |
| `المبلغ\n…(?P<amt>[0-9][0-9,]{0,24}\.[0-9]{2})` | `"المبلغ\n"+"1,"×500,000` | 3.5 ms | µs |
| `(?P<amt>…[0-9][0-9,]*\.[0-9]{2})[ \n]has been…` | `"AED "+"1,"×500,000` | **333,859 ms** | µs |
| the same, with `[0-9,]{0,24}` | the same body | 15.6 ms | µs |

The third row's first mandatory atom is `[0-9]`, so the engine tries every digit
in the body and the unbounded run backtracks at each one. The fix is the fourth
row: `{0,24}` covers every amount an `int64` can hold — 2^63-1 minor units is
`92,233,720,368,547,758.07`, 22 characters before the point — and a longer one
is a conversion failure either way. All 13,798 (template, corpus message) pairs
produce **byte-identical** extractions before and after, so the bound costs
nothing on real mail.

The dialect cannot express "must have a literal prefix": `DEBIT$` is a seed with
no leading literal at all, and the ENBD amount anchor begins with an optional
currency group, so such a rule would make a shipping seed inexpressible — the
exact defect the accept/reject table exists to prevent. The bound is therefore
enforced where it can be measured rather than in the validator:
`client/src/tmpl/cost.test.ts` times every published template against ten
hostile bodies with a 2-second budget against a measured 20 ms, and
`TestKNOWNASingleUnboundedQuantifierIsStillQuadraticInJavaScript` records why
that file has to exist.

### How the three nesting rules are decided

The validator is a hand-written scanner over the pattern's runes, tracking
character-class state (so `[.]` and `\.` are not mistaken for a bare `.`) and a
stack of group frames. Each frame carries:

- `hasUnbounded` — a `*`, `+` or `{n,}` appears anywhere inside, at any depth.
  It propagates to the parent when the group closes, so `((a+))?` is caught.
- `best` — the largest product of `{n,m}` upper bounds along any path inside.
  A group's own quantifier multiplies it on the way out, so
  `((a{4}){4}){4}` is exactly 64 and passes while `{5}` at the top is 80 and
  does not.
- `branchUnbounded` / `maxUnbounded` — how many unbounded quantifiers the
  current branch holds, and the worst branch seen so far. A `|` ends a branch;
  a closing `)` adds the group's *worst* branch to the enclosing one, so
  `(a+|b+)c` counts one and `(a+|b)c+` counts two.

Offsets in errors are **rune indices**, so the TypeScript mirror can reproduce
them from `[...p]` with no knowledge of UTF-8.

---

## 4. `Canonical()` — the hashing form

`Canonical()` is not the storage form. It is a **total, key-sorted** encoding
used for hashing and signing, and its one requirement is that Go and TypeScript
produce identical bytes for identical templates.

1. **Keys sorted lexicographically at every level**, including `on_match`. Go
   marshals a struct in field-declaration order and JavaScript stringifies in
   insertion order; neither is reproducible from the other, but both can sort.
2. **Every key always present.** No `omitempty`; nil slices render as `[]`, the
   empty string as `""`, absent booleans as `false`. A TypeScript mirror
   therefore never has to reproduce Go's emptiness rules.
3. **Strings escaped exactly as `JSON.stringify` escapes them**: only `"`, `\`
   and the C0 controls, with the short forms where they exist and `\u00xx`
   (lower-case hex) otherwise.

Point 3 is where Go's `encoding/json` is wrong **twice**, and the second one is
not in the plan's brief:

- By default it escapes `&`, `<` and `>` as `&`, `<`, `>`. A
  merchant anchor containing `&` would hash differently in the two languages.
  `SetEscapeHTML(false)` fixes this one.
- **Even with `SetEscapeHTML(false)` it still escapes U+2028 and U+2029**,
  which `JSON.stringify` emits raw. Measured:

  ```text
  input:  A & B <x> <U+2028> <U+2029>

  go   json.Marshal:            "A \u0026 B \u003cx\u003e \u2028 \u2029"
  go   SetEscapeHTML(false):    "A & B <x> \u2028 \u2029"   <- still escaped
  js   JSON.stringify:          "A & B <x> <U+2028> <U+2029>"  <- raw
  go   tmpl.canonicalString:    "A & B <x> <U+2028> <U+2029>"  <- matches JS
  ```

  So the brief's prescribed mechanism — "a `json.Encoder` with
  `SetEscapeHTML(false)`" — is **not sufficient**, and following it literally
  would have reintroduced the exact class of bug it was written to prevent, on
  the exact two characters this dialect is otherwise obsessed with.

`Canonical()` therefore hand-rolls the string quoting to match
`JSON.stringify`'s fixed algorithm. `JSON.stringify` is specified by ECMA-262
and cannot move; Go's encoder is configurable, so Go is the side that moves.
`Canonical()` returns an error on invalid UTF-8, because Go would silently
substitute U+FFFD and JavaScript would not.

The bytes are pinned in `conformance/dialect/patterns.json` under `canonical`
and reproduced from Bun by `client/src/tmpl/agreement.test.ts`.

---

## 5. What is proven, and how

`conformance/dialect/patterns.json` carries three different kinds of claim.

**Validator parity** — every rejected pattern with its reason codes. Task 20's
TypeScript validator must reject the same patterns with the same codes.

**Engine parity** — the stronger claim, and the one a validator-parity check
structurally cannot make. Two validators can agree perfectly that a pattern is
legal while the two regex *engines* then disagree about what it matches. So for
every accepted pattern the fixture records what **Go's engine actually did** on
a hostile probe corpus: matched or not, the full match, and every named group,
as base64 of the exact bytes. `client/src/tmpl/agreement.test.ts` re-runs all
of it through `new RegExp(js_pattern, flags + "u")` and demands the same answer
— over 38 accepted patterns × 20 inputs.

The probe corpus contains CR, U+2028, U+2029, U+00A0, U+000B, U+FEFF, the
Kelvin sign and long s **on purpose**: those are the characters each banned
construct was measured to diverge on, so an accepted pattern is shown safe on
the inputs that break the rejected ones rather than on a happy path. One probe
is specifically `الدفع الى\nCARREFOUR\rDUBAI\n…`, so the sanctioned replacement
for the banned bare dot, `[^\n]+`, is proven to capture `CARREFOUR\rDUBAI` in
*both* engines — which is precisely what `(.+)` would not have done.

**Canonical bytes** — a full definition and the exact bytes `Canonical()`
produces for it, reproduced in TypeScript with a sort and a `JSON.stringify`.

A Go test regenerates the fixture and a second Go test re-reads it and fails if
this build no longer produces it, so the file cannot go stale while TypeScript
keeps checking itself against a snapshot of a validator that no longer exists.

### A known engine difference, pinned

Bun 1.3.14 reports `false` for `/[a-z]/iu.test("K")`. Go 1.25, V8 151 and
WebKit 26.5 all report `true` (the Kelvin sign simple-case-folds to `k`).

This is a **Bun bug, not a dialect problem**. The client ships in a browser, so
the engine that actually runs templates agrees with the server; and banning
case-insensitive character-class ranges would make the ENBD seed's
`(?:[A-Z]{3} )?` under `"flags":["i"]` inexpressible and Task 21's gate
unreachable. No rule was added.

It matters only because `bun test` **is** this repository's gate: a conformance
probe that depended on folding a class *range* into a non-ASCII code point
would fail in CI while the real client was correct. It is pinned by a test in
`client/src/tmpl/agreement.test.ts` so that a Bun fix is noticed rather than
silently changing what the gate means.

---

## 6. `override`

`override: true` on an entry means "set this field even if an earlier entry
already set it". It exists for exactly one case.

v1's `dib.go:79-83` re-derives `direction` from the uppercased description
suffix (`strings.HasSuffix(up, "DEBIT")`) *after* the four-way cascade has
already set it. Executor rule 4 — "`on_match` sets additional fields only if not
already set" — and rule 3's "first entry to produce a value wins" both forbid
that, so without an explicit override flag the `dib.account` template cannot
reproduce v1 and Task 21's gate is unreachable.

Two constraints, both enforced by `ValidateDefinition`:

- an entry with `override` **must** carry a `why` string — it suspends the
  first-entry-wins rule, so the reason has to survive in the template rather
  than in a commit message;
- **more than one** override in a definition is an error. A second use means the
  ordering rule is being worked around rather than expressed.

---

## 7. Worked example — `dib.card.v1`

Transcribed from `internal/parse/dib.go`. The normalizer has already collapsed
runs of `{tab, space, U+00A0}` to one space, trimmed every line and dropped
empty lines, so `\s*\n\s*` becomes exactly `\n`.

```json
{
  "id": "dib.card.v1",
  "version": 1,
  "bank": "dib",
  "normalizer_version": 1,
  "match": {
    "sender_domain": ["dib.ae"],
    "body_contains": ["إشعار مشتريات"]
  },
  "default_currency": "AED",
  "date_from": "body",
  "extract": [
    {"field":"amount","type":"amount","source":"body",
     "patterns":["المبلغ\\n(?P<ccy>[A-Z]{3} )?(?P<amt>[0-9][0-9,]*\\.[0-9]{2})"]},
    {"field":"date","type":"date","source":"body",
     "patterns":["بتاريخ (?P<d>[0-9]{2}-[0-9]{2}-[0-9]{4})"],
     "layouts":["DD-MM-YYYY"]},
    {"field":"merchant","type":"text","source":"body",
     "patterns":["الدفع الى\\n(?P<v>[^\\n]+)"]},
    {"field":"last4","type":"last4","source":"body",
     "patterns":["رقم البطاقة\\n(?P<v>[^ \\n]+)"]},
    {"field":"direction","type":"const","source":"body","value":"debit"},
    {"field":"is_transfer","type":"flag","source":"body","value":"false"}
  ],
  "required": ["amount","direction"]
}
```

Note four things:

- `(?P<ccy>[A-Z]{3} )?` — the shape the first draft's rule made illegal. `{3}`
  nested inside `?` is bounded (product 3) and is allowed.
- `[^\n]+` where v1 wrote `(.+)`, and `[^ \n]+` where v1 wrote `(\S+)`. On
  normalized text those are the *exact* meanings, not approximations.
- `\n` where v1 wrote `\s*\n\s*`, because the normalizer already trimmed.
- **The Arabic anchors are byte-for-byte from `dib.go`.** One is spelled
  without the hamza — `الدفع الى`, not `الدفع إلى` — because that is how DIB
  actually writes it. A well-meaning spelling fix while copying produces a
  template that compiles, validates, publishes and silently matches nothing
  across all 6,864 DIB messages.
