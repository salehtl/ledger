/**
 * The client-side template executor — the mirror of internal/v2/tmpl/exec.go.
 *
 * # What it is running on
 *
 * The body is ATTACKER-WRITABLE: anyone who learns a user's inbound address can
 * send mail whose text is chosen to maximise the cost of matching, and this
 * copy runs on the user's phone with a backtracking regex engine. Three things
 * hold the line, and each is separate:
 *
 *  1. The dialect (`dialect.ts`), applied at LOAD time by `compileDefinition`.
 *     It is what refuses the polynomial shapes RE2 is immune to and this engine
 *     is not.
 *  2. `MAX_BODY_BYTES` / `MAX_SUBJECT_BYTES` bound the input. Over the bound
 *     the message is REFUSED, never truncated: a truncated body is a different
 *     message from the one that arrived.
 *  3. `MAX_CAPTURE_RUNES` bounds what a single group may hand back, so a
 *     `[^\n]+` merchant anchor pointed at a 400 KB line yields a conversion
 *     failure rather than a 400 KB merchant in the store.
 *
 * # Two executors, one behaviour
 *
 * Go runs the same stored template on the server and must reach the same
 * answer. Every place where Go and JavaScript would otherwise differ BY DEFAULT
 * is pinned explicitly here rather than left to each language's library, and
 * each one is a case in `conformance/templates/synthetic-*.json`:
 *
 *   - trimming. `String.prototype.trim()` removes U+00A0 and U+FEFF and Go's
 *     `strings.Trim(s, " \t\n\v\f\r")` does not. The cutset is spelled out.
 *   - case folding. `toUpperCase()` maps U+00DF to "SS"; Go's does not. Only
 *     ASCII a-z is folded, and a currency code is ASCII by definition.
 *   - counting. `s.length` is UTF-16 units; Go counts runes. 512 Arabic runes
 *     is 512 in both, and 512 emoji is 1,024 units.
 *   - numbers. `Number("")` is 0, `parseInt("12abc")` is 12, and neither is a
 *     conversion failure. Money is BigInt from a digit string that has already
 *     passed a shape check.
 *   - dates. `Date.parse` is implementation-defined for every shape in this
 *     format. The three layouts are parsed by hand, reproducing what Go's
 *     `time.Parse` decides: month names fold case but the AM/PM marker does
 *     not, numeric fields need exactly two digits, calendar ranges are checked,
 *     trailing text is an error, and there is no zone so the result is UTC.
 *
 * The sender-domain gate is NOT applied here. It belongs to the trusted-lane
 * check on the verified signing domain, and giving this function a domain would
 * invite a caller to hand it the body's own From line, which is content anyone
 * can author.
 */

import { compile, groupNames, validatePattern } from "./dialect.ts";

// ---------------------------------------------------------------------------
// bounds — part of the cross-executor contract; different numbers extract
// different values from the same message
// ---------------------------------------------------------------------------

/** Bounds the normalized text, in UTF-8 BYTES (2x the raw SMTP cap, because normalization can inflate). */
export const MAX_BODY_BYTES = 2_000_000;
/** Bounds the effective subject, in UTF-8 BYTES. */
export const MAX_SUBJECT_BYTES = 64_000;
/** Bounds one captured group, in RUNES. */
export const MAX_CAPTURE_RUNES = 512;
/** Bounds the empty-group diagnostic; more would make the diagnostics row unstorable, losing the WHOLE diagnostic. */
export const MAX_EMPTY_GROUPS = 32;

// ---------------------------------------------------------------------------
// the format
// ---------------------------------------------------------------------------

export interface Match {
  sender_domain: string[];
  subject_contains?: string[];
  body_contains?: string[];
  body_not_contains?: string[];
}

export interface Extract {
  field: string;
  type: string;
  source: string;
  patterns?: string[];
  flags?: string[];
  layouts?: string[];
  value?: string;
  override?: boolean;
  why?: string;
  on_match?: Record<string, string>;
}

export interface Definition {
  id: string;
  version: number;
  bank: string;
  normalizer_version: number;
  match: Match;
  default_currency: string;
  date_from: string;
  extract: Extract[];
  required: string[];
}

export const Field = {
  Amount: "amount",
  Date: "date",
  Merchant: "merchant",
  Last4: "last4",
  Direction: "direction",
  IsTransfer: "is_transfer",
} as const;

export const Type = {
  Amount: "amount",
  Date: "date",
  Text: "text",
  Last4: "last4",
  Const: "const",
  Flag: "flag",
} as const;

/** The three date layouts. A CLOSED enum: a layout one executor understands and the other does not is a silent per-device date difference. */
export const Layout = {
  DDMMYYYY: "DD-MM-YYYY",
  DDMonYYYYHHMMA: "DD/Mon/YYYY hh:mm A",
  DDMonYYYY: "DD/Mon/YYYY",
} as const;

/** The legal (field, type) pairings, as a table rather than two enums: "amount extracted as text" would pass two enum checks and then never produce a number. */
const FIELD_TYPES: Record<string, string[]> = {
  [Field.Amount]: [Type.Amount],
  [Field.Date]: [Type.Date],
  [Field.Merchant]: [Type.Text, Type.Const],
  [Field.Last4]: [Type.Last4, Type.Const],
  [Field.Direction]: [Type.Const],
  [Field.IsTransfer]: [Type.Flag],
};

/** The executor's contract with the pattern author: it reads exactly these group names and no others. */
const GROUPS_BY_TYPE: Record<string, { required: string[]; optional: string[] }> = {
  [Type.Amount]: { required: ["amt"], optional: ["ccy"] },
  [Type.Date]: { required: ["d"], optional: [] },
  [Type.Text]: { required: ["v"], optional: [] },
  [Type.Last4]: { required: ["v"], optional: [] },
  [Type.Const]: { required: [], optional: [] },
  [Type.Flag]: { required: [], optional: [] },
};

const CURRENCY_RE = /^[A-Z]{3}$/;
const LAST4_RE = /^[0-9]{1,4}$/;
/** diag's own group-name grammar, duplicated rather than imported because it is what makes a label storable at all. */
const EMPTY_GROUP_LABEL_RE = /^[A-Za-z_][A-Za-z0-9_]{0,31}$/;

// ---------------------------------------------------------------------------
// results
// ---------------------------------------------------------------------------

/**
 * Why an execution produced no transaction.
 *
 * These are separate values because the pipeline treats them differently:
 * `no_match` is routine (this mail is not for this template) and
 * `missing_field` is the DRIFT SIGNAL (this template should have handled it and
 * could not). Collapsing them turns a fixable bug report into "unparsed, cause
 * unknown", which is the failure the whole diagnostics ledger exists to avoid —
 * which is why this field is here even though the brief's `Extraction` did not
 * name it.
 */
export type ExecError = "" | "no_match" | "missing_field" | "too_large";

/**
 * What one template read out of one message.
 *
 * Presence is derived from the VALUES, never from a separate mask, because Go
 * derives it that way and a mask is one more thing for the two to disagree
 * about. In particular `currency`, not `amount_minor`, is what says an amount
 * was extracted: a genuine 0.00 is a value, and 0n is not distinguishable from
 * "nothing ran".
 */
export interface Extraction {
  amount_minor: bigint;
  currency: string;
  direction: "debit" | "credit" | "";
  /** RFC3339 in UTC, or "" when no body date was produced (including `date_from: "email"`). */
  posted_at: string;
  merchant: string;
  last4: string;
  is_transfer: boolean;
  /** The capture groups that MATCHED and captured nothing, as `<field>_<group>`, sorted and deduplicated. */
  empty_groups: string[];
  /** True if and only if the template matched and every required field was produced. */
  matched: boolean;
  error: ExecError;
}

/** A definition this executor cannot run. The publish gate refuses these, so one here means a template reached the device without passing it. */
export class DefinitionError extends Error {
  override readonly name = "DefinitionError";
}

/** A pattern that violates the dialect. Thrown at LOAD time, which is the whole point of validating on the client. */
export class DialectError extends Error {
  override readonly name = "DialectError";
  readonly codes: string[];
  constructor(message: string, codes: string[]) {
    super(message);
    this.codes = codes;
  }
}

function zeroExtraction(error: ExecError): Extraction {
  return {
    amount_minor: 0n,
    currency: "",
    direction: "",
    posted_at: "",
    merchant: "",
    last4: "",
    is_transfer: false,
    empty_groups: [],
    matched: false,
    error,
  };
}

// ---------------------------------------------------------------------------
// compile
// ---------------------------------------------------------------------------

interface CompiledEntry {
  x: Extract;
  res: RegExp[];
}

/** A definition with its patterns compiled once. Immutable after construction. */
export class Compiled {
  readonly definition: Definition;
  private readonly entries: CompiledEntry[];

  constructor(definition: Definition, entries: CompiledEntry[]) {
    this.definition = definition;
    this.entries = entries;
  }

  /**
   * Runs the compiled template over one message.
   *
   * The returned Extraction is meaningful even when it did not match: on
   * `missing_field` it carries everything that DID extract, including
   * `empty_groups`, which is the case the diagnostics ledger exists for. On
   * `no_match` it is the zero value, because nothing was attempted.
   */
  execute(subject: string, normalizedBody: string): Extraction {
    if (utf8Length(normalizedBody) > MAX_BODY_BYTES) return zeroExtraction("too_large");
    if (utf8Length(subject) > MAX_SUBJECT_BYTES) return zeroExtraction("too_large");
    if (!this.gate(subject, normalizedBody)) return zeroExtraction("no_match");

    const st = new ExecState();
    for (const ce of this.entries) {
      // Rule 3: the first entry that produces a value for a field wins, and
      // later entries for that field are SKIPPED — not evaluated and discarded.
      // Skipping is also what keeps the cost of a hostile body proportional to
      // the number of fields rather than to the number of entries.
      if (st.isSet(ce.x.field) && ce.x.override !== true) continue;
      const src = ce.x.source === "subject" ? subject : normalizedBody;
      if (!this.runEntry(st, ce, src)) continue;
      // Rule 4: on_match sets additional fields only if not already set.
      // Sorted, so two executors apply them in the same order even though
      // on_match is a map.
      const onMatch = ce.x.on_match ?? {};
      for (const f of Object.keys(onMatch).sort(byCodeUnit)) {
        if (st.isSet(f)) continue;
        st.setLiteral(f, onMatch[f]!);
      }
    }

    const out = st.finish();
    const err = validateExtraction(out, this.definition);
    if (err !== "") {
      out.error = err;
      return out;
    }
    out.matched = true;
    return out;
  }

  /** The content half of Match. Every listed condition must hold and body_not_contains must match none. */
  private gate(subject: string, body: string): boolean {
    for (const s of this.definition.match.subject_contains ?? []) if (!subject.includes(s)) return false;
    for (const s of this.definition.match.body_contains ?? []) if (!body.includes(s)) return false;
    for (const s of this.definition.match.body_not_contains ?? []) if (body.includes(s)) return false;
    return true;
  }

  /**
   * Evaluates one entry and reports whether it produced a value.
   *
   * Rule 3 in full: a pattern that does not match moves to the next pattern; a
   * pattern that matches but whose capture fails typed conversion ALSO moves to
   * the next pattern; an entry whose patterns are exhausted produces nothing. A
   * conversion failure is never a zero value and never aborts the run.
   */
  private runEntry(st: ExecState, ce: CompiledEntry, src: string): boolean {
    const x = ce.x;
    // A const or flag entry with no patterns at all is an unconditional
    // default. Placed last, that is how a conditional default is expressed —
    // the shape of v1's four-way DIB direction cascade.
    if (ce.res.length === 0) {
      st.setLiteral(x.field, x.value ?? "");
      return true;
    }
    for (const re of ce.res) {
      const m = re.exec(src);
      if (m === null) continue;
      st.recordEmptyGroups(x.field, m);

      switch (x.type) {
        case Type.Const:
        case Type.Flag:
          st.setLiteral(x.field, x.value ?? "");
          return true;

        case Type.Amount: {
          const amt = m.groups?.["amt"];
          if (amt === undefined) continue;
          const got = convertAmount(amt, m.groups?.["ccy"], this.definition.default_currency);
          if (got === null) continue;
          st.setAmount(got.minor, got.currency);
          return true;
        }

        case Type.Date: {
          const text = m.groups?.["d"];
          if (text === undefined) continue;
          const when = convertDate(text, x.layouts ?? []);
          if (when === null) continue;
          st.setDate(when);
          return true;
        }

        case Type.Text: {
          const text = m.groups?.["v"];
          if (text === undefined) continue;
          const value = convertText(text);
          if (value === null) continue;
          st.setLiteral(x.field, value);
          return true;
        }

        case Type.Last4: {
          const text = m.groups?.["v"];
          if (text === undefined) continue;
          const value = convertLast4(text);
          if (value === null) continue;
          st.setLiteral(x.field, value);
          return true;
        }

        default:
          throw new DefinitionError(`type ${JSON.stringify(x.type)} has no conversion`);
      }
    }
    return false;
  }
}

/**
 * Checks everything EXECUTION depends on, runs the dialect gate over every
 * pattern, and compiles them.
 *
 * The dialect check is the reason this function exists on the client at all: a
 * template arrives over a network, and the only moment a device can refuse a
 * backtracking bomb is before it compiles one.
 */
export function compileDefinition(d: Definition): Compiled {
  if (!CURRENCY_RE.test(d.default_currency)) {
    throw new DefinitionError(
      `default_currency ${JSON.stringify(d.default_currency)} is not three upper-case letters, so no amount could carry a currency`,
    );
  }
  if (d.date_from !== "body" && d.date_from !== "email") {
    throw new DefinitionError(`date_from ${JSON.stringify(d.date_from)} is neither "body" nor "email"`);
  }
  for (const f of d.required ?? []) {
    if (FIELD_TYPES[f] === undefined) throw new DefinitionError(`required names ${JSON.stringify(f)}, which is not a field`);
    if (f === Field.IsTransfer) {
      throw new DefinitionError(
        "is_transfer cannot be required — a flag that is false is indistinguishable from one that was never set",
      );
    }
  }

  const entries: CompiledEntry[] = [];
  let dates = 0;
  for (const [i, x] of (d.extract ?? []).entries()) {
    entries.push(compileEntry(i, x));
    if (x.field === Field.Date) dates++;
  }
  // date_from is a promise about where the date comes from, and both ways of
  // breaking it are silent: a "body" template with no date entry can never
  // produce one, and an "email" template with a date entry produces a body date
  // the caller has been told to overwrite.
  if (d.date_from === "body" && dates === 0) {
    throw new DefinitionError(`date_from is "body" but no extract entry produces a date`);
  }
  if (d.date_from === "email" && dates > 0) {
    throw new DefinitionError(`date_from is "email" but ${dates} extract entries produce a date`);
  }
  return new Compiled(d, entries);
}

function compileEntry(i: number, x: Extract): CompiledEntry {
  const fail = (msg: string): never => {
    throw new DefinitionError(`extract[${i}]: ${msg}`);
  };
  const types = FIELD_TYPES[x.field];
  if (types === undefined) fail(`field ${JSON.stringify(x.field)} is not a field name`);
  const spec = GROUPS_BY_TYPE[x.type];
  if (spec === undefined) fail(`type ${JSON.stringify(x.type)} is not a type`);
  if (!types!.includes(x.type)) fail(`field ${JSON.stringify(x.field)} cannot be extracted as type ${JSON.stringify(x.type)}`);
  if (x.source !== "body" && x.source !== "subject") fail(`source ${JSON.stringify(x.source)} is neither "body" nor "subject"`);

  const patterns = x.patterns ?? [];
  const isConst = x.type === Type.Const || x.type === Type.Flag;
  if (isConst) {
    const err = checkLiteral(x.field, x.value ?? "");
    if (err !== "") fail(err);
  } else if (patterns.length === 0) {
    fail(`a ${x.type} entry with no patterns can never produce a value`);
  }
  for (const [f, v] of Object.entries(x.on_match ?? {})) {
    const err = checkLiteral(f, v);
    if (err !== "") fail(`on_match: ${err}`);
  }
  if (x.type === Type.Date) {
    const layouts = x.layouts ?? [];
    if (layouts.length === 0) fail("a date entry with no layouts can never convert its capture");
    for (const l of layouts) {
      if (l !== Layout.DDMMYYYY && l !== Layout.DDMonYYYYHHMMA && l !== Layout.DDMonYYYY) {
        fail(`layout ${JSON.stringify(l)} is not one of the three supported layouts`);
      }
    }
  }

  const flags = x.flags ?? [];
  const res: RegExp[] = [];
  for (const [j, p] of patterns.entries()) {
    // The load-time dialect gate. Before new RegExp, never after.
    const codes = validatePattern(p, flags);
    if (codes.length > 0) {
      throw new DialectError(`extract[${i}].patterns[${j}] violates the template dialect: ${codes.join(", ")}`, codes);
    }
    const names = groupNames(p);
    for (const want of spec!.required) {
      if (!names.includes(want)) {
        fail(`patterns[${j}] does not capture (?P<${want}>...), so a ${x.type} entry could never read a value from it`);
      }
    }
    // Every named group becomes a potential diagnostics label, and diag refuses
    // a label that is not a bounded identifier — refusing it there would drop
    // the whole row, so it is refused here instead.
    for (const n of names) {
      if (!EMPTY_GROUP_LABEL_RE.test(emptyGroupLabel(x.field, n))) {
        fail(`patterns[${j}] group ${JSON.stringify(n)} would produce a diagnostics label that is not a bounded identifier`);
      }
    }
    res.push(compile(p, flags));
  }
  return { x, res };
}

/**
 * Validates a value written into a field verbatim. `amount` and `date` are
 * absent on purpose: neither has an unambiguous literal spelling both executors
 * would parse identically, so they may only come from a typed conversion.
 */
function checkLiteral(field: string, value: string): string {
  switch (field) {
    case Field.Direction:
      return value === "debit" || value === "credit" ? "" : `direction ${JSON.stringify(value)} is neither debit nor credit`;
    case Field.IsTransfer:
      return value === "true" || value === "false" ? "" : `is_transfer ${JSON.stringify(value)} is neither true nor false`;
    case Field.Merchant:
    case Field.Last4:
      if (value === "") {
        return `${field} cannot be set to the empty string: an unset field and a field set to "" are the same thing to every reader`;
      }
      return runeCountExceeds(value, MAX_CAPTURE_RUNES) ? `${field} literal is longer than ${MAX_CAPTURE_RUNES} runes` : "";
    default:
      return `${field} cannot be set from a literal value`;
  }
}

/** Compiles `d` and runs it. The convenience form; hold a `Compiled` to compile the patterns once per template rather than once per message. */
export function execute(d: Definition, subject: string, normalizedBody: string): Extraction {
  return compileDefinition(d).execute(subject, normalizedBody);
}

// ---------------------------------------------------------------------------
// execution state
// ---------------------------------------------------------------------------

/** The RFC3339 rendering of Go's zero time. A date that parses to it is not a date, and Go's `Time.IsZero` says so. */
const ZERO_TIME = "0001-01-01T00:00:00Z";

class ExecState {
  private amountMinor = 0n;
  private currency = "";
  private direction: "debit" | "credit" | "" = "";
  /** The raw RFC3339 value, which may be ZERO_TIME. `finish` is what turns that into "". */
  private postedAt = "";
  private merchant = "";
  private last4 = "";
  private isTransfer = false;
  private readonly set = new Set<string>();
  private readonly empty = new Set<string>();

  isSet(field: string): boolean {
    return this.set.has(field);
  }

  setAmount(minor: bigint, currency: string): void {
    this.amountMinor = minor;
    this.currency = currency;
    this.set.add(Field.Amount);
  }

  setDate(rfc3339: string): void {
    this.postedAt = rfc3339;
    this.set.add(Field.Date);
  }

  /** Writes a value that needs no conversion: a const/flag entry's value, an on_match entry, or an already-converted capture. */
  setLiteral(field: string, value: string): void {
    switch (field) {
      case Field.Direction:
        this.direction = value === "credit" ? "credit" : value === "debit" ? "debit" : "";
        break;
      case Field.Merchant:
        this.merchant = value;
        break;
      case Field.Last4:
        this.last4 = value;
        break;
      case Field.IsTransfer:
        this.isTransfer = value === "true";
        break;
      default:
        // Unreachable for a compiled definition: checkLiteral refuses these at
        // compile time. Kept because "unreachable" is a claim about today's
        // callers, not a property of this function.
        throw new DefinitionError(`${field} cannot be set from the literal ${JSON.stringify(value)}`);
    }
    this.set.add(field);
  }

  /**
   * Appends the groups that MATCHED and captured nothing.
   *
   * The distinction that matters: a group that did not participate at all (an
   * optional currency prefix that was absent) is `undefined` here and index -1
   * in Go, and is NOT empty; a group that participated and captured "" IS.
   * Conflating them is precisely how this diagnostic goes wrong.
   */
  recordEmptyGroups(field: string, m: RegExpExecArray): void {
    const groups = m.groups;
    if (groups === undefined) return;
    for (const name of Object.keys(groups)) {
      if (groups[name] === "") this.empty.add(emptyGroupLabel(field, name));
    }
  }

  finish(): Extraction {
    // Sorted and deduplicated, which is the form diag stores: the order an
    // executor happened to evaluate its entries in is not a fact worth
    // carrying, and carrying it would make two identical failures look
    // different. Labels are ASCII by construction (EMPTY_GROUP_LABEL_RE), so
    // code-unit order is Go's byte order.
    let labels = [...this.empty].sort(byCodeUnit);
    if (labels.length > MAX_EMPTY_GROUPS) labels = labels.slice(0, MAX_EMPTY_GROUPS);
    return {
      amount_minor: this.amountMinor,
      currency: this.currency,
      direction: this.direction,
      posted_at: this.postedAt === ZERO_TIME ? "" : this.postedAt,
      merchant: this.merchant,
      last4: this.last4,
      is_transfer: this.isTransfer,
      empty_groups: labels,
      matched: false,
      error: "",
    };
  }
}

function emptyGroupLabel(field: string, group: string): string {
  return `${field}_${group}`;
}

/** Byte-order string comparison. Go sorts strings by byte; for the ASCII identifiers this is used on, UTF-16 code-unit order is the same order. */
function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Whether the named field was extracted.
 *
 * `is_transfer` is ALWAYS false: a flag that is false looks exactly like a flag
 * that was never set, so a template requiring it could never be satisfied.
 * Returning false makes that fail closed, and `compileDefinition` refuses to
 * load such a template in the first place.
 */
export function produced(e: Extraction, field: string): boolean {
  switch (field) {
    case Field.Amount:
      return e.currency !== "";
    case Field.Date:
      return e.posted_at !== "";
    case Field.Merchant:
      return e.merchant !== "";
    case Field.Last4:
      return e.last4 !== "";
    case Field.Direction:
      return e.direction !== "";
    default:
      return false;
  }
}

/**
 * The second gate: whether an extraction is a transaction.
 *
 * Two separate things. First, that every field in `required` was produced —
 * that is the drift signal, and it is why a template that stops matching
 * reports WHICH field went missing. Second, that the extraction is internally
 * coherent; a state no correct executor produces means something upstream is
 * wrong and the transaction must not be written.
 */
export function validateExtraction(e: Extraction, d: Definition): ExecError {
  for (const f of d.required ?? []) {
    if (FIELD_TYPES[f] === undefined) throw new DefinitionError(`required names ${JSON.stringify(f)}, which is not a field`);
    if (f === Field.IsTransfer) throw new DefinitionError("is_transfer cannot be required");
    if (!produced(e, f)) return "missing_field";
  }
  if (e.amount_minor < 0n) {
    throw new DefinitionError(`amount ${e.amount_minor} is negative; amounts are always positive and direction carries the sign`);
  }
  if (e.amount_minor !== 0n && e.currency === "") throw new DefinitionError("an amount was extracted with no currency");
  if (e.currency !== "" && !CURRENCY_RE.test(e.currency)) {
    throw new DefinitionError(`currency ${JSON.stringify(e.currency)} is not three upper-case letters`);
  }
  if (e.last4 !== "" && !LAST4_RE.test(e.last4)) throw new DefinitionError(`last4 ${JSON.stringify(e.last4)} is not one to four digits`);
  if (runeCountExceeds(e.merchant, MAX_CAPTURE_RUNES)) throw new DefinitionError(`merchant is longer than ${MAX_CAPTURE_RUNES} runes`);
  if (d.date_from === "email" && e.posted_at !== "") {
    throw new DefinitionError(`date_from is "email" but a date was extracted from the message body`);
  }
  return "";
}

// ---------------------------------------------------------------------------
// typed conversion
// ---------------------------------------------------------------------------

/**
 * The executor's OWN whitespace set, spelled out rather than delegated to
 * `String.prototype.trim()`. The two disagree — Go trims U+0085 and the Unicode
 * separators but not U+FEFF, JavaScript trims both U+00A0 and U+FEFF — and a
 * difference in what gets trimmed off a capture is a difference in the
 * extracted value.
 */
const TRIM_CUTSET = " \t\n\v\f\r";

function trimCapture(s: string): string {
  let lo = 0;
  let hi = s.length;
  while (lo < hi && TRIM_CUTSET.includes(s[lo]!)) lo++;
  while (hi > lo && TRIM_CUTSET.includes(s[hi - 1]!)) hi--;
  return s.slice(lo, hi);
}

/** The shape an amount must have AFTER commas are removed: exactly two decimals, no sign. */
const AMOUNT_SHAPE_RE = /^[0-9]+\.[0-9]{2}$/;

/** 2^63 - 1. An amount an int64 cannot hold is not an amount, because the server's is one. */
const INT64_MAX = 9223372036854775807n;

/**
 * Rule 5.
 *
 * The `amt` group must contain the NUMBER ONLY. A pattern whose `amt` group
 * also swallows a currency prefix ("AED 250.00") is a conversion failure by
 * design: the format gives the amount type an optional `ccy` group for exactly
 * that, and accepting two spellings of the same thing would mean two
 * implementations of it in two languages.
 */
export function convertAmount(
  amt: string,
  ccy: string | undefined,
  defaultCurrency: string,
): { minor: bigint; currency: string } | null {
  const trimmed = trimCapture(amt);
  if (runeCountExceeds(trimmed, MAX_CAPTURE_RUNES)) return null;
  const digits = trimmed.split(",").join("");
  if (!AMOUNT_SHAPE_RE.test(digits)) return null;
  // Removing the point rather than scaling by 100 keeps this integer-only: the
  // digit string goes straight to BigInt and no float is ever constructed.
  const minor = BigInt(digits.replace(".", ""));
  if (minor > INT64_MAX) return null;
  let currency = defaultCurrency;
  const c = asciiUpper(trimCapture(ccy ?? ""));
  if (c !== "") {
    if (!CURRENCY_RE.test(c)) return null;
    currency = c;
  }
  return { minor, currency };
}

/** Upper-cases a-z and nothing else. `toUpperCase()` maps U+00DF to "SS" and Go's `ToUpper` does not; a currency code is ASCII by definition. */
function asciiUpper(s: string): string {
  let out = "";
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    out += c >= 97 && c <= 122 && ch.length === 1 ? String.fromCharCode(c - 32) : ch;
  }
  return out;
}

/**
 * Rule 6: for each declared layout in order, try the whole trimmed string, then
 * the text up to the first U+0020. The first success wins. The second attempt
 * reproduces v1's `strings.Fields(s)[0]` fallback without needing a second
 * extract entry.
 *
 * Every layout failing on both attempts is a conversion failure — never a zero
 * time presented as a date.
 */
export function convertDate(text: string, layouts: string[]): string | null {
  const trimmed = trimCapture(text);
  if (runeCountExceeds(trimmed, MAX_CAPTURE_RUNES)) return null;
  for (const l of layouts) {
    const got = parseLayout(trimmed, l);
    if (got !== null) return got;
  }
  return null;
}

/** The whole-string-then-first-token attempt for one layout. */
function parseLayout(text: string, layout: string): string | null {
  const whole = parseExact(text, layout);
  if (whole !== null) return whole;
  // The first U+0020 specifically, not "any whitespace": one code point that
  // both languages find the same way.
  const i = text.indexOf(" ");
  return i >= 0 ? parseExact(text.slice(0, i), layout) : null;
}

const SHORT_MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/**
 * One layout, whole string, no trailing text — the hand-written mirror of Go's
 * `time.Parse` for exactly the three layouts this format allows.
 *
 * The decisions Go makes for us, each of which a naive parser would get wrong
 * and each of which is a case in conformance/templates/synthetic-dates.json:
 *
 *   - month NAMES fold case ("jun" parses) but the AM/PM marker does not
 *     ("pm" is an error, and the date-only layout catches it via the
 *     first-token attempt).
 *   - numeric fields written "02"/"01"/"03"/"04" require exactly two digits;
 *     "5/Jun/2026" does not parse.
 *   - the year requires exactly four digits; "05-06-26" does not parse.
 *   - calendar ranges are checked: "31-02-2026" is an error, not 2 March, and
 *     "29-02-2024" is valid while "29-02-2026" is not.
 *   - a 12-hour field accepts 0 through 12. PM adds 12 below 12; AM maps 12 to
 *     0. "13:25 PM" is a range error.
 *   - there is no zone in any layout, so the result is UTC.
 *   - trailing text is an error, which is what makes the whole-string attempt
 *     genuinely whole-string and the first-token fallback necessary.
 */
function parseExact(s: string, layout: string): string | null {
  let i = 0;
  const num = (n: number): number | null => {
    if (i + n > s.length) return null;
    let v = 0;
    for (let k = 0; k < n; k++) {
      const c = s.charCodeAt(i + k);
      if (c < 48 || c > 57) return null;
      v = v * 10 + (c - 48);
    }
    i += n;
    return v;
  };
  const lit = (c: string): boolean => {
    if (s[i] !== c) return false;
    i++;
    return true;
  };

  let day: number | null;
  let month: number | null;
  let year: number | null;
  let hour = 0;
  let min = 0;

  if (layout === Layout.DDMMYYYY) {
    day = num(2);
    if (day === null || !lit("-")) return null;
    month = num(2);
    if (month === null || !lit("-")) return null;
    year = num(4);
    if (year === null) return null;
  } else {
    day = num(2);
    if (day === null || !lit("/")) return null;
    // Go's lookup(shortMonthNames, value): a THREE-CHARACTER prefix, matched
    // ASCII-case-insensitively. It consumes exactly three characters, so
    // "June/2026" leaves "e/2026" and then fails on the separator.
    const name = s.slice(i, i + 3).toLowerCase();
    const idx = SHORT_MONTHS.indexOf(name);
    if (name.length < 3 || idx < 0) return null;
    i += 3;
    month = idx + 1;
    if (!lit("/")) return null;
    year = num(4);
    if (year === null) return null;
    if (layout === Layout.DDMonYYYYHHMMA) {
      if (!lit(" ")) return null;
      const h = num(2);
      if (h === null || !lit(":")) return null;
      const m = num(2);
      if (m === null || !lit(" ")) return null;
      // The marker is matched EXACTLY, upper case only. Go's stdPM takes two
      // characters and accepts only "AM" and "PM".
      const marker = s.slice(i, i + 2);
      if (marker !== "AM" && marker !== "PM") return null;
      i += 2;
      hour = h;
      min = m;
      if (hour < 0 || hour > 12) return null;
      if (min < 0 || min > 59) return null;
      if (marker === "PM" && hour < 12) hour += 12;
      if (marker === "AM" && hour === 12) hour = 0;
    }
  }

  if (i !== s.length) return null; // trailing text
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysIn(month, year)) return null;
  return (
    pad(year, 4) + "-" + pad(month, 2) + "-" + pad(day, 2) + "T" + pad(hour, 2) + ":" + pad(min, 2) + ":00Z"
  );
}

function daysIn(month: number, year: number): number {
  if (month === 2) return isLeap(year) ? 29 : 28;
  return [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
}

function isLeap(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, "0");
}

/** Trims a capture and refuses an empty or oversized one. An empty capture is not a value: it falls through to the next pattern. */
export function convertText(s: string): string | null {
  const t = trimCapture(s);
  return t === "" || runeCountExceeds(t, MAX_CAPTURE_RUNES) ? null : t;
}

/**
 * Rule 7: drop every non-digit, keep the last four. Fewer than one digit is a
 * conversion failure.
 *
 * "Digit" is ASCII 0-9 and nothing else. This corpus is Arabic, and
 * Arabic-Indic digits (U+0660-U+0669) are digits to Unicode but are not what a
 * card number is written in here; treating them as digits would also make the
 * two executors' notions of a digit the difference between one card and
 * another.
 */
export function convertLast4(s: string): string | null {
  if (runeCountExceeds(s, MAX_CAPTURE_RUNES)) return null;
  let digits = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 48 && c <= 57) {
      digits += s[i]!;
      if (digits.length > 4) digits = digits.slice(1);
    }
  }
  return digits === "" ? null : digits;
}

// ---------------------------------------------------------------------------
// counting
// ---------------------------------------------------------------------------

/**
 * Whether `s` is longer than `max` RUNES (Unicode code points), the mirror of
 * Go's `utf8.RuneCountInString(s) > max`.
 *
 * Not `[...s].length > max`: that allocates an array as long as the string, and
 * this is called on captures that a hostile body can make 400 KB. Not
 * `s.length > max` either — that is UTF-16 units, so 512 emoji would count as
 * 1,024 and the two executors would disagree about the bound.
 */
function runeCountExceeds(s: string, max: number): boolean {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) i++;
    }
    if (++n > max) return true;
  }
  return false;
}

/**
 * The UTF-8 byte length of `s`, the mirror of Go's `len(string)`.
 *
 * Computed rather than encoded: `new TextEncoder().encode(s).length` allocates
 * a two-megabyte array to answer a comparison, once per template per message.
 */
function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && s.charCodeAt(i + 1) >= 0xdc00 && s.charCodeAt(i + 1) <= 0xdfff) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}
