/**
 * Stage 10 of the normalizer: inline-forward unwrapping.
 *
 * Gmail forwarding is the primary onboarding path, so almost every message a
 * new user contributes arrives wrapped in a forwarding client's preamble, and
 * the transaction is described by the INNER message. Three things follow, none
 * of them cosmetic:
 *
 *   - The inner Subject is the effective subject. The ENBD "Transaction advice"
 *     template reads the account last4 ONLY from the subject, because the body
 *     masks the account number.
 *   - The inner Date is the effective date, or a forward that arrives days late
 *     dates the transaction to the forward.
 *   - The inner From is CONTENT, never trust. Everything below reads
 *     attacker-authored body text.
 *
 * Every regexp here spells out `" *"` rather than `\s*`. Go's RE2 `\s` is
 * `[\t\n\f\r ]` while JavaScript's is a much larger Unicode set that includes
 * U+00A0 and U+FEFF, so `\s` is exactly the kind of silent cross-language
 * disagreement this contract exists to prevent. There is no `\s` in this file.
 */

/**
 * The explicit trim set: U+0009, U+000A, U+000B, U+000C, U+000D, U+0020,
 * U+00A0, U+FEFF.
 *
 * Deliberately neither Go's strings.TrimSpace (which also trims U+0085,
 * U+2000-U+200A and U+202F but NOT U+FEFF) nor JavaScript's String.trim (which
 * trims U+2000-U+200A, U+202F and U+FEFF). Naming the set is the only thing
 * that makes the two implementations byte-identical, and both directions of the
 * difference occur in the real corpus.
 */
const TRIM_SET = new Set([
  "\u0009", "\u000a", "\u000b", "\u000c", "\u000d", "\u0020", "\u00a0", "\ufeff",
]);

/** Trims the explicit set from both ends. Never String.prototype.trim. */
export function trimExplicit(s: string): string {
  let i = 0;
  let n = s.length;
  while (i < n && TRIM_SET.has(s[i]!)) i++;
  while (n > i && TRIM_SET.has(s[n - 1]!)) n--;
  return s.slice(i, n);
}

/** Apple Mail's and Gmail's forward markers. */
const forwardMarkerRe = /^ *(begin forwarded message:|-+ *forwarded message *-+) *$/i;
/** A leading Fwd:/FW:/Fw: on a subject. */
const fwdSubjectRe = /^ *(fwd?|fw) *: */i;
/** A forwarded-header line, capturing the label and any same-line value. */
const fwdHeaderLineRe = /^ *(from|to|subject|date|reply-to|cc|sent) *: *(.*)$/i;

export interface Forward {
  /** Inner From when recovered, else the message's own. Content, never trust. */
  from: string;
  /** Inner Subject when recovered, else the message's own with Fwd: stripped. */
  subject: string;
  /** The raw inner Date value; "" when none was recovered. */
  date: string;
  /** The text with the preamble and header block removed. */
  body: string;
  /**
   * A forward MARKER line was present. NOT that inner headers were recovered:
   * 50 of the 56 forwards in the v1 corpus are ">"-quoted text/plain, where the
   * marker is unquoted but every header line is, so `found` is true and
   * from/subject/date all stay at their defaults.
   */
  found: boolean;
}

/** Runs stage 10 over the joined, normalized text. */
export function unwrapForward(from: string, subject: string, body: string): Forward {
  const lines = body.split("\n");

  let marker = -1;
  for (let i = 0; i < lines.length; i++) {
    if (forwardMarkerRe.test(lines[i]!)) {
      marker = i;
      break;
    }
  }
  if (marker === -1) {
    // Not a forward. Strip a leading Fwd:/FW: so a template's SubjectContains
    // still matches; the body is untouched.
    return { from, subject: subject.replace(fwdSubjectRe, ""), date: "", body, found: false };
  }

  let recFrom = "";
  let recSubject = "";
  let recDate = "";
  let end = marker + 1;
  let sawHeader = false;
  for (let i = marker + 1; i < lines.length; ) {
    const m = fwdHeaderLineRe.exec(lines[i]!);
    if (m === null) {
      if (sawHeader) break; // the header block ended; the original body starts here
      i++; // preamble noise between the marker and the first header
      continue;
    }
    sawHeader = true;
    const label = m[1]!.toLowerCase();
    let value = trimExplicit(m[2]!);
    if (value === "") {
      // Apple Mail puts the value on the next non-empty line.
      let j = i + 1;
      while (j < lines.length && trimExplicit(lines[j]!) === "") j++;
      if (j < lines.length) {
        value = trimExplicit(lines[j]!);
        i = j;
      }
    }
    if (label === "from") recFrom = value;
    else if (label === "subject") recSubject = value;
    else if (label === "date") recDate = value;
    i++;
    end = i;
  }

  const out: Forward = { from, subject, date: recDate, body, found: true };
  if (recFrom !== "") out.from = recFrom;
  if (recSubject !== "") out.subject = recSubject;
  else out.subject = subject.replace(fwdSubjectRe, "");
  if (sawHeader && end < lines.length) out.body = trimExplicit(lines.slice(end).join("\n"));
  return out;
}

// ---------------------------------------------------------------------------
// Forward dates
// ---------------------------------------------------------------------------

const MONTHS_LONG = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];
const MONTHS_SHORT = MONTHS_LONG.map((m) => m.slice(0, 3));
const WEEKDAYS_SHORT = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

const isLeap = (y: number): boolean => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const daysIn = (month: number, year: number): number =>
  month === 2 ? (isLeap(year) ? 29 : 28) : [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;

/**
 * The four CLOSED layouts forwarding clients emit, reimplemented as explicit
 * patterns over an explicit month table.
 *
 * `Date.parse` is not used and must not be: an earlier dual-executor task in
 * this repository found real divergences between Go's time.Parse and
 * Date.parse, and Date.parse is explicitly implementation-defined for anything
 * outside the ISO 8601 subset.
 *
 * The list notably does NOT cover the 12-hour WITH-seconds shape the Apple Mail
 * iOS app emits ("18 June 2026 at 7:33:38 PM GST"), which three corpus messages
 * use and which therefore falls back to the arrival time. That defect is ported
 * deliberately: adding a layout changes which messages get a body-derived date,
 * and is a normalizer VERSION bump, not a bug fix.
 */
const LAYOUTS: readonly RegExp[] = [
  // Jan 2, 2006 at 3:04 PM
  /^([A-Za-z]{3}) (\d{1,2}), (\d{4}) at (\d{1,2}):(\d{2}) (AM|PM)$/,
  // Mon, Jan 2, 2006 at 3:04 PM
  /^([A-Za-z]{3}), ([A-Za-z]{3}) (\d{1,2}), (\d{4}) at (\d{1,2}):(\d{2}) (AM|PM)$/,
  // 2 January 2006 at 15:04:05
  /^(\d{1,2}) ([A-Za-z]+) (\d{4}) at (\d{1,2}):(\d{2}):(\d{2})$/,
  // 2 January 2006 at 15:04
  /^(\d{1,2}) ([A-Za-z]+) (\d{4}) at (\d{1,2}):(\d{2})$/,
];

/** Builds a naive UTC timestamp, or null when any field is out of range. */
function makeUTC(year: number, month: number, day: number, hour: number, min: number, sec: number): Date | null {
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysIn(month, year)) return null;
  if (min < 0 || min >= 60) return null;
  if (sec < 0 || sec >= 60) return null;
  if (hour < 0 || hour >= 24) return null;
  return new Date(Date.UTC(year, month - 1, day, hour, min, sec));
}

function applyLayout(idx: number, m: RegExpExecArray): Date | null {
  const num = (s: string): number => Number.parseInt(s, 10);
  // Go's time.Parse matches month, weekday and AM/PM tokens case-insensitively
  // for names, but stdPM ("PM") accepts only the upper-case forms — which is why
  // AM|PM above is not /i.
  const twelveHour = (h: number, ampm: string): number | null => {
    if (h < 0 || h > 12) return null; // Go's stdHour12 range check
    if (ampm === "PM" && h < 12) return h + 12;
    if (ampm === "AM" && h === 12) return 0;
    return h;
  };
  switch (idx) {
    case 0: {
      const month = MONTHS_SHORT.indexOf(m[1]!.toLowerCase()) + 1;
      if (month === 0) return null;
      const h = twelveHour(num(m[4]!), m[6]!);
      if (h === null) return null;
      return makeUTC(num(m[3]!), month, num(m[2]!), h, num(m[5]!), 0);
    }
    case 1: {
      // Go does not check that the weekday agrees with the date, only that the
      // token is a known abbreviation.
      if (!WEEKDAYS_SHORT.includes(m[1]!.toLowerCase())) return null;
      const month = MONTHS_SHORT.indexOf(m[2]!.toLowerCase()) + 1;
      if (month === 0) return null;
      const h = twelveHour(num(m[5]!), m[7]!);
      if (h === null) return null;
      return makeUTC(num(m[4]!), month, num(m[3]!), h, num(m[6]!), 0);
    }
    case 2: {
      const month = MONTHS_LONG.indexOf(m[2]!.toLowerCase()) + 1;
      if (month === 0) return null;
      return makeUTC(num(m[3]!), month, num(m[1]!), num(m[4]!), num(m[5]!), num(m[6]!));
    }
    case 3: {
      const month = MONTHS_LONG.indexOf(m[2]!.toLowerCase()) + 1;
      if (month === 0) return null;
      return makeUTC(num(m[3]!), month, num(m[1]!), num(m[4]!), num(m[5]!), 0);
    }
    default:
      return null;
  }
}

/**
 * Parses a forwarded-header Date value. The result is NAIVE: read as UTC, no
 * zone applied, exactly as Go's time.Parse does for a layout with no zone.
 */
export function parseForwardDate(s: string): Date | null {
  // U+202F (Apple Mail's narrow no-break space before AM/PM on recent OSes) and
  // U+00A0 both become plain spaces so the layouts can match.
  const normalized = trimExplicit(s).replaceAll("\u202f", " ").replaceAll("\u00a0", " ");
  const candidates = [normalized];
  const lastSpace = normalized.lastIndexOf(" ");
  // Retry once with the final space-delimited token removed: that is how a
  // trailing zone name ("GST", "GMT+4") is dropped.
  if (lastSpace > 0) candidates.push(trimExplicit(normalized.slice(0, lastSpace)));
  for (const c of candidates) {
    for (let i = 0; i < LAYOUTS.length; i++) {
      const m = LAYOUTS[i]!.exec(c);
      if (m === null) continue;
      const d = applyLayout(i, m);
      if (d !== null) return d;
    }
  }
  return null;
}
