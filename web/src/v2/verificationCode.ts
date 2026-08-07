/**
 * Reading a forward-confirmation code out of a **held, untrusted** message —
 * ported from `app/src/lib/verificationCode.ts`.
 *
 * # Why this exists at all
 *
 * Plan Decision 7: a mail provider sends its forwarding confirmation from its
 * own domain (Gmail's is `google.com`), §3.2 forbids ever promoting a forwarder
 * domain, so that message quarantines permanently *by design* and onboarding's
 * happy path runs straight through the held lane. `onboarding.ts`'s
 * `QUARANTINE_HELD` is the wording; this module is the reading.
 *
 * **Nothing here knows a provider.** {@link couldBeConfirmation} says only that a
 * held message *could* be the one the user is waiting for; which one it is, is
 * the user's answer to give, for the reason recorded on that function.
 *
 * # This runs a pattern over attacker-controlled content
 *
 * The blob is whatever arrived at a public inbound address. Anyone who knows a
 * user's address can put a megabyte of anything into that lane, and this code
 * runs on the phone during onboarding. The project has already measured
 * **125,744 ms** for one accepted pattern (`dialect-redos.md`), so the bounds
 * are load-bearing rather than belt-and-braces:
 *
 *  1. **A literal anchor.** Every pattern starts with fixed text, so the
 *     engine's first move on a non-matching subject is a literal scan.
 *  2. **No unbounded quantifier anywhere.** Not `+`, not `*`, not `{n,}`. The
 *     widest run in this file is `{0,16}`.
 *  3. **Disjoint adjacent classes.** `[^0-9]{0,16}` is followed by
 *     `[0-9]{4,12}`: the two cannot both match the same character, so once the
 *     gap stops there is exactly ONE way to continue. The match is deterministic
 *     rather than merely bounded — there is no alternative carve-up for a
 *     backtracking engine to explore. The link pattern's subdomain labels obey
 *     the same rule: the label class excludes the dot that terminates it.
 *  4. **An 8 KB slice**, so the linear factor is a constant rather than
 *     whatever the sender chose to send.
 *
 * {@link SCAN_BUDGET_MS} is a **tripwire on top of that**, not the bound: it
 * exists so an edit reintroducing a hazardous pattern shows up as `overBudget`
 * rather than as a frozen tab. The four rules themselves are no longer merely
 * asserted here: `verificationCode.test.ts` walks every pattern in
 * {@link SCAN_PATTERNS} and fails on an unbounded quantifier, a missing literal
 * anchor, or a quantified class adjacent to one it overlaps.
 *
 * # What may be shown to the user
 *
 * A bounded digit run and a URL whose **host is a literal in the pattern**. That
 * is the whole surface. The host is no longer `mail-settings.google.com` in
 * source — it is the message's own verified signing domain, escaped into the
 * pattern by {@link linkPattern} from a value the CALLER supplies out of server
 * data. Scheme and path separator stay fixed text and only the opaque tail is
 * captured, so a held message still cannot send the user anywhere it chooses;
 * it can only offer a link on the domain that signed it.
 *
 * The raw body is still offered as a fallback (never a dead end), returned as
 * {@link CodeScan.body}, labelled untrusted by the screen, capped, and rendered
 * as a React text child — which interpolates no markup.
 */

import { CURRENT_VERSION, normalize } from "@ledger/client/norm/norm";
import { webPlatform } from "@ledger/client/platform.web";

import { UNVERIFIED_PREFIX } from "./onboardingIO";

// ---------------------------------------------------------------------------
// The bounds
// ---------------------------------------------------------------------------

/** At most the first 8 KB of the normalized body. */
export const SCAN_LIMIT_CHARS = 8192;

/**
 * The tripwire. Generous on purpose — a real scan of 8 KB is sub-millisecond,
 * so anything near this is a defect and not a slow device.
 */
export const SCAN_BUDGET_MS = 50;

/**
 * A bare hostname and nothing else: lowercase letters, digits, dots, hyphens.
 *
 * Anchored at both ends and bounded at the DNS maximum, because everything
 * downstream — a pattern built from it, a domain rendered next to the word
 * "verified" — is only as narrow as this. A colon is not in the class, which is
 * what makes `unverified:dib.ae` and `dib.ae:8080` fail here as well as at the
 * explicit prefix check in {@link verifiedOuterDomain}.
 *
 * Declared with the bounds rather than beside its callers because
 * {@link SCAN_PATTERNS} builds a link pattern at module load and would otherwise
 * read it before its initializer had run.
 */
const HOSTNAME = /^[a-z0-9.-]{1,253}$/;

/**
 * The digit runs a confirmation code comes in.
 *
 * Was `9`, because Gmail's is nine digits and the pattern encoded exactly that —
 * which made every other provider's code unreadable (Yahoo's is eight, plenty
 * are six). A RANGE, still bounded at both ends: four because three digits is
 * indistinguishable from a price, twelve because nothing longer is a code and an
 * open end is the thing this file exists to avoid.
 */
export const CODE_DIGITS = { min: 4, max: 12 } as const;

/**
 * Every code pattern this module will run, in order, most specific first.
 *
 * Read them against the four rules in the header before adding one: a `+` or a
 * `*` here is a defect, and so is an adjacent pair of classes that can match the
 * same character. `verificationCode.test.ts` checks all of that mechanically,
 * over `SCAN_PATTERNS`, so a new pattern is measured rather than reviewed.
 *
 * The anchors are a small set of literals rather than one provider's exact
 * sentence. Each is still a literal anchor, so a body that contains none of them
 * costs four literal scans and nothing else.
 */
const CODE_PATTERNS: readonly RegExp[] = [
  /Confirmation code[^0-9]{0,16}([0-9]{4,12})/i,
  /Verification code[^0-9]{0,16}([0-9]{4,12})/i,
  /Security code[^0-9]{0,16}([0-9]{4,12})/i,
  /Confirm your[^0-9]{0,16}([0-9]{4,12})/i,
];

/** RegExp-special characters, escaped so a host is text and never syntax. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Up to four subdomain labels in front of the verified domain.
 *
 * Needed because the verified SIGNING domain is the organisational one
 * (`google.com`) while the link lives on a subdomain (`mail-settings.google.com`).
 *
 * Deterministic despite being a nested quantifier: the inner class excludes the
 * dot and is followed by a literal dot, so there is exactly one way to consume
 * `a.b.` — the partition is forced rather than searched. The outer `{0,4}` then
 * offers at most five carve-ups before the literal host, each settled by a
 * literal comparison. Both bounds are closed, so 4 x 63 characters is the most
 * this can consume.
 *
 * It is also the ANCHOR that makes `evil-google.com` impossible: the host must
 * follow either `//` or a `.`, never the middle of a label.
 */
const SUBDOMAIN_LABELS = "(?:[-A-Za-z0-9]{1,63}\\.){0,4}";

/** The opaque tail. Bounded, and disjoint from nothing that follows it. */
const LINK_TAIL = "[-A-Za-z0-9_.~%+#?&=/]{0,512}";

/**
 * The pattern that will match a link on `host`, or `null` if `host` is not one
 * this module will pin a link to.
 *
 * Replaces a hardcoded `https://mail-settings.google.com/mail/`, which worked
 * for exactly one provider. The generalisation is deliberately NOT "any URL in
 * the body" — that would let a held message send the user anywhere, which is the
 * attack this file is built against. The host comes from the caller, which takes
 * it from the server's verified signature; scheme and path separator stay fixed
 * literals; only the opaque tail is free.
 *
 * The host is validated as a bare hostname AND escaped. Either alone would do
 * today; both, because the day the validation is loosened is the day escaping is
 * the only thing standing between a domain string and the pattern engine.
 */
export function linkPattern(host: string): RegExp | null {
  const h = host.trim().toLowerCase().replace(/\.$/, "");
  if (h === "" || h.startsWith(UNVERIFIED_PREFIX) || !HOSTNAME.test(h)) return null;
  return new RegExp(`https:\\/\\/${SUBDOMAIN_LABELS}${escapeRegExp(h)}\\/${LINK_TAIL}`, "i");
}

/**
 * Every pattern this module will ever run, exported so their SHAPE can be
 * measured rather than asserted in a comment — which the test file now does,
 * mechanically, for all four rules in the header.
 *
 * The link pattern is BUILT, so a representative one has to be in here for that
 * measurement to mean anything. Two hosts, not one: the second carries the
 * characters a hostname is allowed to contain, so a host that reached the
 * pattern unescaped would appear in the measured `source` as syntax.
 */
export const SCAN_PATTERNS: readonly RegExp[] = [
  ...CODE_PATTERNS,
  ...["mail-settings.google.com", "a-b.example"]
    .map((h) => linkPattern(h))
    .filter((p): p is RegExp => p !== null),
];

// ---------------------------------------------------------------------------
// Which held message might be the one the user is waiting for
// ---------------------------------------------------------------------------

/**
 * The outer domain when it is genuinely verified, folded — otherwise `null`.
 *
 * Three refusals, and all three are the same refusal from different directions:
 *
 *  1. `attested` is not `true`. Decoded as `=== true` in `onboardingIO`, so a
 *     field this build failed to read can never read as verified.
 *  2. The domain carries {@link UNVERIFIED_PREFIX} — an envelope-derived name
 *     the SENDER typed and nothing checked. `origin.Resolve` applies that prefix
 *     precisely so it cannot be compared against anything.
 *  3. It is not a hostname. Nothing here needs a URL, a port or a mailbox, and a
 *     value that is not a hostname must not become the pinned host of a link the
 *     user is invited to open.
 *
 * This is a READING of the server's decision, never a decision of its own.
 */
export function verifiedOuterDomain(item: { outerDomain: string; attested: boolean }): string | null {
  if (!item.attested) return null;
  const d = item.outerDomain.trim().toLowerCase().replace(/\.$/, "");
  if (d === "" || d.startsWith(UNVERIFIED_PREFIX)) return null;
  return HOSTNAME.test(d) ? d : null;
}

/**
 * Whether a held item **could** be the confirmation the user is waiting for.
 *
 * # Why this deliberately does not identify a provider
 *
 * Its predecessor, `isForwarderConfirmation`, required a Google domain, and that
 * was a bug the moment anyone used another provider: a Fastmail or Proton
 * confirmation sat in the lane while the screen said "Waiting for Google's
 * confirmation" forever.
 *
 * Dropping the domain list alone does not fix it, and the reason is worth
 * stating because it is the whole design: **a bank that sends DIRECTLY to the
 * inbound address also has no inner domain.** No predicate over this data can
 * tell "my provider's confirmation" from "my bank's first alert" — both are
 * mail whose only signature is the outer one — and they need opposite handling.
 * So this stops classifying and answers only "could this be it", the screen
 * lists every candidate with its verified signing domain, and the user, who
 * knows which message they are waiting for, opens the right one.
 *
 * An attested INNER origin disqualifies: that is content signed by someone the
 * outer hop merely relayed, i.e. a bank behind a forwarder, and it has its own
 * control.
 */
export function couldBeConfirmation(item: { outerDomain: string; innerDomain: string; attested: boolean }): boolean {
  return item.innerDomain.trim() === "" && verifiedOuterDomain(item) !== null;
}

// ---------------------------------------------------------------------------
// The scan
// ---------------------------------------------------------------------------

export interface CodeScan {
  /** A digit run within {@link CODE_DIGITS}, or null. */
  code: string | null;
  /**
   * A URL on the caller's verified host (or a subdomain of it), or null. The
   * host is a literal in the pattern, escaped, and supplied from server data —
   * never read out of the text being scanned.
   */
  link: string | null;
  /** The slice that was scanned. Never longer than {@link SCAN_LIMIT_CHARS}. */
  body: string;
  /** The body was longer than the slice, so a code further in was not sought. */
  truncated: boolean;
  elapsedMs: number;
  /** The tripwire fired and the remaining patterns were not run. */
  overBudget: boolean;
}

export interface ScanOptions {
  /**
   * The host a link may point at: the held item's **verified** outer domain, as
   * the server reported it. A link on this host or on a subdomain of it may be
   * returned; anything else may not, and an empty or non-hostname value means no
   * link is returned at all.
   *
   * Required rather than defaulted, and never derived from `text`. A caller that
   * has no verified domain has to say so.
   */
  linkHost: string;
  now?: () => number;
}

/**
 * Scans at most the first {@link SCAN_LIMIT_CHARS} characters of `text`.
 *
 * `now` is injected so the budget can be *measured* rather than asserted: a
 * clock that jumps past the budget between patterns must stop the scan.
 */
export function scanForCode(text: string, opts: ScanOptions): CodeScan {
  const now = opts.now ?? Date.now;
  const truncated = text.length > SCAN_LIMIT_CHARS;
  const body = truncated ? text.slice(0, SCAN_LIMIT_CHARS) : text;
  const started = now();
  let code: string | null = null;
  let link: string | null = null;
  let overBudget = false;

  for (const pattern of CODE_PATTERNS) {
    if (now() - started > SCAN_BUDGET_MS) {
      overBudget = true;
      break;
    }
    const m = pattern.exec(body);
    if (m !== null && m[1] !== undefined) {
      code = m[1];
      break;
    }
  }

  if (!overBudget) {
    if (now() - started > SCAN_BUDGET_MS) {
      overBudget = true;
    } else {
      // Built from the CALLER's verified host. `null` — no host, or one that is
      // not a bare hostname — means no link is looked for at all.
      link = linkPattern(opts.linkHost)?.exec(body)?.[0] ?? null;
    }
  }

  return { code, link, body, truncated, elapsedMs: now() - started, overBudget };
}

// ---------------------------------------------------------------------------
// Getting from a quarantine blob to text
// ---------------------------------------------------------------------------

export type BodySource = "normalized" | "raw";

export interface HeldBody {
  text: string;
  source: BodySource;
}

/**
 * Turns a base64 quarantine blob into text to scan.
 *
 * Uses the **shared** normalizer (`client/src/norm`) rather than a second MIME
 * reader, because a private one would be a second implementation of the thing
 * the dual-executor conformance suite exists to keep in step.
 *
 * `normalize` throws on a message with no text part, an unknown charset or an
 * unparseable MIME structure — all of which an attacker can arrange. That is not
 * allowed to be a dead end, so the fallback is a lossy UTF-8 decode of the raw
 * bytes: uglier, always available, and still only ever rendered as inert text.
 */
export function heldBody(blobBase64: string, receivedAt: string): HeldBody {
  let raw: Uint8Array;
  try {
    raw = webPlatform.fromBase64(blobBase64);
  } catch {
    return { text: "", source: "raw" };
  }
  try {
    return { text: normalize(CURRENT_VERSION, raw, receivedAt).text, source: "normalized" };
  } catch {
    return { text: new TextDecoder("utf-8", { fatal: false }).decode(raw), source: "raw" };
  }
}

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

/** Said when no code was found. It must never read as a failure of the user's. */
export const NO_CODE_COPY =
  "ledger could not find a confirmation code in this message. The message itself is below, exactly as it arrived " +
  "and not trusted — if there is a code, it is somewhere in it, and copying it from there works just as well.";

export const UNTRUSTED_BODY_LABEL = "Raw message, shown as text. ledger has not verified anything in it.";
