/**
 * The Go/JavaScript ENGINE agreement runner for the template regex dialect.
 *
 * This is not the validator mirror — that is Task 20's `dialect.ts` and its own
 * test, which check that the TypeScript validator rejects the same patterns
 * with the same reason codes. This file checks the thing a validator-parity
 * test structurally cannot see: two validators can agree perfectly that a
 * pattern is legal and the two regex ENGINES can then disagree about what it
 * matches. That disagreement is silent — the server extracts an amount the
 * device does not, or captures different text, and nothing errors.
 *
 * So `conformance/dialect/patterns.json` carries, for every accepted pattern,
 * the exact result Go's RE2 produced on a deliberately hostile probe corpus:
 * matched or not, the full match, and every named group, base64 of the exact
 * bytes. This file re-runs all of it through `new RegExp(js_pattern, flags +
 * "u")` and demands the same answer. The expectations are LITERAL Go output,
 * never recomputed here, because a harness that recomputes its own expectation
 * cannot see a defect in the thing it is checking.
 *
 * The probe corpus contains CR, U+2028, U+2029, U+00A0, U+000B, U+FEFF, the
 * Kelvin sign and long s on purpose: those are the characters each banned
 * construct was MEASURED to diverge on, so an accepted pattern is shown safe on
 * the inputs that break the rejected ones, not merely on a happy path.
 *
 * The `u` flag is not decoration. Without it, `/k/i` does not match U+212A
 * while Go's `(?i)k` does; with it both match. Every compile here goes through
 * the same expression the executor uses.
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const fixturePath = `${import.meta.dir}/../../../conformance/dialect/patterns.json`;

interface Probe {
  input: string;
  match: boolean;
  text: string | null;
  groups: Record<string, string | null>;
}
interface Accepted {
  name: string;
  pattern: string;
  js_pattern: string;
  flags: string[];
  group_names: string[];
  probes: Probe[];
}
interface Rejected {
  code: string;
  pattern: string;
  js_pattern: string;
  flags: string[];
  codes: string[];
  js_syntax_error: boolean;
  why: string;
}
interface Fixture {
  probe_inputs: { name: string; input_base64: string }[];
  rejected: Rejected[];
  accepted: Accepted[];
  to_js: { pattern: string; js: string; why: string }[];
  canonical: { definition_base64: string; canonical_base64: string };
}

const fx = JSON.parse(readFileSync(fixturePath, "utf8")) as Fixture;

const fromB64 = (s: string): string => Buffer.from(s, "base64").toString("utf8");
const inputs = new Map(fx.probe_inputs.map((p) => [p.name, fromB64(p.input_base64)]));

/** The one expression the TypeScript executor is allowed to compile a stored pattern with. */
const compile = (jsPattern: string, flags: string[]): RegExp =>
  new RegExp(jsPattern, flags.join("") + "u");

const show = (s: string): string => JSON.stringify(s);

test("the fixture is present and non-trivial", () => {
  expect(fx.accepted.length).toBeGreaterThan(20);
  expect(fx.rejected.length).toBeGreaterThan(20);
  expect(inputs.size).toBeGreaterThan(10);
});

// ---------------------------------------------------------------------------
// Engine agreement on every accepted pattern
// ---------------------------------------------------------------------------

for (const c of fx.accepted) {
  test(`engine agreement: ${c.name}`, () => {
    let re: RegExp;
    try {
      re = compile(c.js_pattern, c.flags);
    } catch (e) {
      throw new Error(
        `pattern the dialect ACCEPTED does not compile in JavaScript under the u flag: ` +
          `${show(c.pattern)} -> ${show(c.js_pattern)} flags ${JSON.stringify(c.flags)}: ${e}`,
      );
    }

    // Go's named groups must be JavaScript's named groups, or the executor
    // reads a different field out of the same pattern.
    const jsNames = [...c.js_pattern.matchAll(/\(\?<([A-Za-z_][A-Za-z0-9_]*)>/g)].map((m) => m[1]);
    expect(jsNames).toEqual(c.group_names);

    for (const p of c.probes) {
      const input = inputs.get(p.input);
      if (input === undefined) throw new Error(`probe input ${p.input} is not in probe_inputs`);

      // Fresh lastIndex semantics: these patterns carry no g flag, so exec is
      // stateless, but be explicit about it.
      const m = re.exec(input);
      const where = `${c.name} / ${p.input}`;

      expect(m !== null, `${where}: Go matched=${p.match}, JavaScript matched=${m !== null}`).toBe(
        p.match,
      );
      if (m === null) continue;

      expect(m[0], `${where}: full match differs`).toBe(fromB64(p.text!));

      for (const [name, want] of Object.entries(p.groups)) {
        const got = m.groups?.[name];
        if (want === null) {
          // A group that did not participate. undefined in JavaScript, index
          // -1 in Go. Conflating "absent" with "matched the empty string" is
          // exactly how the EmptyGroups diagnostic goes wrong.
          expect(
            got,
            `${where}: group ${name} participated in JavaScript but not in Go`,
          ).toBeUndefined();
        } else {
          expect(got, `${where}: group ${name} differs`).toBe(fromB64(want));
        }
      }
    }
  });
}

// ---------------------------------------------------------------------------
// The u flag as a second, free layer of enforcement
// ---------------------------------------------------------------------------

test("every rejected pattern marked js_syntax_error really is one, and the others really are not", () => {
  for (const c of fx.rejected) {
    let threw = false;
    try {
      compile(c.js_pattern, c.flags);
    } catch {
      threw = true;
    }
    expect(
      threw,
      `${c.code}: ${show(c.pattern)} — fixture says js_syntax_error=${c.js_syntax_error}, ` +
        `JavaScript ${threw ? "threw" : "accepted it"}. If an engine changed its mind, ` +
        `re-measure and regenerate the fixture rather than relaxing this.`,
    ).toBe(c.js_syntax_error);
  }
});

test("the constructs JavaScript accepts are the reason the dialect exists", () => {
  // Half the ban list compiles perfectly well in JavaScript. For those, the
  // validator is the only thing preventing a silent difference, which is worth
  // stating as a number rather than as a claim.
  const silent = fx.rejected.filter((c) => !c.js_syntax_error);
  expect(silent.length).toBeGreaterThan(10);
  for (const c of silent) {
    expect(c.codes.length, `${c.code} must still be rejected by the validator`).toBeGreaterThan(0);
  }
});

// ---------------------------------------------------------------------------
// ToJS
// ---------------------------------------------------------------------------

test("every rewritten pattern compiles in JavaScript", () => {
  // Compiling under u IS the check: a surviving Go-only `(?P<` is a
  // SyntaxError in JavaScript, so this cannot pass with an unrewritten group.
  //
  // A tempting stronger assertion — "the rewritten text must not CONTAIN the
  // substring (?P<" — is wrong, and the `a\(?P<v` row is why: there the
  // parenthesis is escaped, so the four characters are a literal and ToJS is
  // correct to leave them alone. Deciding "escaped or not" needs the scanner,
  // which is Task 20's dialect.ts. The claim that actually matters for that row
  // is engine-level and is made above: `tojs-escaped-paren-not-a-named-group`
  // is in the accepted set, and its group_names assertion demands JavaScript
  // see zero named groups in it, exactly as Go does.
  for (const c of fx.to_js) {
    expect(() => new RegExp(c.js, "u"), `${show(c.pattern)} -> ${show(c.js)}`).not.toThrow();
  }
});

// ---------------------------------------------------------------------------
// Canonical bytes
// ---------------------------------------------------------------------------

/**
 * The canonical encoding, in the form the spec states it: sort every key at
 * every level, emit every key, and let JSON.stringify do the escaping. This is
 * not a re-implementation of something being tested — it IS the claim. Go's
 * encoding/json escapes &, < and > by default and escapes U+2028/U+2029 even
 * with SetEscapeHTML(false); JSON.stringify does neither, so Go was the side
 * that had to move, and this is what it had to move to.
 */
function canonicalize(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canonicalize).join(",") + "]";
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalize(o[k])).join(",") + "}";
}

/** The total shape Canonical() emits: every key present, no omitempty. */
function totalDefinition(d: Record<string, any>): Record<string, unknown> {
  const s = (x: unknown): string => (typeof x === "string" ? x : "");
  const n = (x: unknown): number => (typeof x === "number" ? x : 0);
  const a = (x: unknown): string[] => (Array.isArray(x) ? (x as string[]) : []);
  const m = d["match"] ?? {};
  return {
    bank: s(d["bank"]),
    date_from: s(d["date_from"]),
    default_currency: s(d["default_currency"]),
    extract: a(d["extract"]).map((raw) => {
      const e = raw as unknown as Record<string, unknown>;
      return {
        field: s(e["field"]),
        flags: a(e["flags"]),
        layouts: a(e["layouts"]),
        on_match: (e["on_match"] ?? {}) as Record<string, string>,
        override: e["override"] === true,
        patterns: a(e["patterns"]),
        source: s(e["source"]),
        type: s(e["type"]),
        value: s(e["value"]),
        why: s(e["why"]),
      };
    }),
    id: s(d["id"]),
    match: {
      body_contains: a(m["body_contains"]),
      body_not_contains: a(m["body_not_contains"]),
      sender_domain: a(m["sender_domain"]),
      subject_contains: a(m["subject_contains"]),
    },
    normalizer_version: n(d["normalizer_version"]),
    required: a(d["required"]),
    version: n(d["version"]),
  };
}

test("JavaScript reproduces Go's canonical bytes exactly", () => {
  const def = JSON.parse(fromB64(fx.canonical.definition_base64)) as Record<string, unknown>;
  const want = fromB64(fx.canonical.canonical_base64);
  expect(canonicalize(totalDefinition(def))).toBe(want);
});

test("the canonical form carries & < > and the separators verbatim", () => {
  const s = canonicalize({ p: "A & B <x> \u2028 \u2029" });
  expect(s).toBe('{"p":"A & B <x> \u2028 \u2029"}');
  for (const esc of ["\\u0026", "\\u003c", "\\u003e", "\\u2028", "\\u2029"]) {
    expect(s.includes(esc), `JSON.stringify emitted ${esc}`).toBe(false);
  }
});

// ---------------------------------------------------------------------------
// A known engine difference, pinned rather than discovered later
// ---------------------------------------------------------------------------

test("KNOWN: Bun disagrees with Go, V8 and WebKit on case-insensitive class ranges", () => {
  // Measured 2026-08-01: Go 1.25, V8 151 (Chromium) and WebKit 26.5 all report
  // TRUE for [a-z] with /iu against U+212A (the Kelvin sign folds to "k").
  // Bun 1.3.14 reports FALSE. It is a Bun bug, not a dialect problem: the
  // client ships in a browser, so the engine that actually runs templates
  // agrees with the server, and banning case-insensitive ranges would make the
  // ENBD seed's `(?:[A-Z]{3} )?` under flags ["i"] inexpressible.
  //
  // It is pinned here because `bun test` is this repository's gate: if a probe
  // ever depended on this folding, the gate would fail while the real client
  // was correct, and this test is the thing that says why. When Bun fixes it,
  // this test fails and the note gets updated.
  expect(new RegExp("[a-z]", "iu").test("\u212A")).toBe(false);
  // The same fold through a single-character class member is fine everywhere.
  expect(new RegExp("[k]", "iu").test("\u212A")).toBe(true);
  expect(new RegExp("k", "iu").test("\u212A")).toBe(true);
  // And without the u flag, nothing folds - which is why the u flag is
  // mandatory in `compile` above.
  expect(new RegExp("k", "i").test("\u212A")).toBe(false);
});
