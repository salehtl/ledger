/**
 * Reading Gmail's forward-confirmation code out of a **held, untrusted**
 * message — ported from `app/src/lib/verificationCode.ts`.
 *
 * # Why this exists at all
 *
 * Plan Decision 7: Gmail sends its forwarding confirmation from `google.com`,
 * §3.2 forbids ever promoting a forwarder domain, so that message quarantines
 * permanently *by design* and onboarding's happy path runs straight through the
 * held lane. `onboarding.ts`'s `QUARANTINE_HELD` is the wording; this module is
 * the reading.
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
 *  3. **Disjoint adjacent classes.** `[^0-9]{0,16}` is followed by `[0-9]{9}`:
 *     the two cannot both match the same character, so once the gap stops there
 *     is exactly ONE way to continue. The match is deterministic rather than
 *     merely bounded — there is no alternative carve-up for a backtracking
 *     engine to explore.
 *  4. **An 8 KB slice**, so the linear factor is a constant rather than
 *     whatever the sender chose to send.
 *
 * {@link SCAN_BUDGET_MS} is a **tripwire on top of that**, not the bound: it
 * exists so an edit reintroducing a hazardous pattern shows up as `overBudget`
 * rather than as a frozen tab.
 *
 * # What may be shown to the user
 *
 * A nine-digit run and a URL whose **host is a literal in the pattern**. That is
 * the whole surface — a link this module returns can only ever point at
 * `mail-settings.google.com`, because scheme, host and path prefix are fixed
 * text and only the opaque tail is captured.
 *
 * The raw body is still offered as a fallback (never a dead end), returned as
 * {@link CodeScan.body}, labelled untrusted by the screen, capped, and rendered
 * as a React text child — which interpolates no markup.
 */

import { CURRENT_VERSION, normalize } from "@ledger/client/norm/norm";
import { webPlatform } from "@ledger/client/platform.web";

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

/** Gmail's code is a nine-digit run. Pinned, because the pattern encodes it. */
export const CODE_DIGITS = 9;

/**
 * Every pattern this module will run, in order, most specific first. Read them
 * against the four rules in the header before adding one: a `+` or a `*` here is
 * a defect, and so is an adjacent pair of classes that can match the same
 * character.
 */
const CODE_PATTERNS: readonly RegExp[] = [
  /Confirmation code[^0-9]{0,8}([0-9]{9})/,
  /confirmation code[^0-9]{0,16}([0-9]{9})/i,
];

/** Scheme, host and path prefix as literal text; only the tail is captured. */
const LINK_PATTERN = /https:\/\/mail-settings\.google\.com\/mail\/[-A-Za-z0-9_.~%+#?&=/]{1,512}/;

/**
 * Every pattern this module will ever run, exported so their SHAPE can be
 * measured rather than asserted in a comment.
 */
export const SCAN_PATTERNS: readonly RegExp[] = [...CODE_PATTERNS, LINK_PATTERN];

// ---------------------------------------------------------------------------
// Which held message is Gmail's
// ---------------------------------------------------------------------------

/**
 * The forwarder domains Google seals as.
 *
 * Deliberately narrow, and deliberately not the server's `origin.ForwarderDomains`:
 * this is a UI filter answering "which held message is the one I am waiting
 * for", not a trust decision. Trust is the server's, and it has already refused
 * every one of these as an outer origin.
 */
const GOOGLE_DOMAINS = ["google.com", "googlemail.com", "gmail.com"] as const;

function isGoogleDomain(d: string): boolean {
  const s = d.trim().toLowerCase().replace(/\.$/, "");
  return GOOGLE_DOMAINS.some((g) => s === g || s.endsWith(`.${g}`));
}

/**
 * Whether a held item is Google's own confirmation rather than a bank's mail.
 *
 * Matched on the **outer** domain — the one that signed the envelope this server
 * received — because that is what Gmail's forwarder seals as. An `innerDomain`
 * naming Google would mean the *content* claimed to be from Google, which is
 * exactly the claim this product does not act on.
 */
export function isForwarderConfirmation(item: { outerDomain: string; innerDomain: string }): boolean {
  return item.innerDomain.trim() === "" && isGoogleDomain(item.outerDomain);
}

// ---------------------------------------------------------------------------
// The scan
// ---------------------------------------------------------------------------

export interface CodeScan {
  /** Exactly {@link CODE_DIGITS} digits, or null. */
  code: string | null;
  /** A URL on `mail-settings.google.com`, or null. Host is a pattern literal. */
  link: string | null;
  /** The slice that was scanned. Never longer than {@link SCAN_LIMIT_CHARS}. */
  body: string;
  /** The body was longer than the slice, so a code further in was not sought. */
  truncated: boolean;
  elapsedMs: number;
  /** The tripwire fired and the remaining patterns were not run. */
  overBudget: boolean;
}

/**
 * Scans at most the first {@link SCAN_LIMIT_CHARS} characters of `text`.
 *
 * `now` is injected so the budget can be *measured* rather than asserted: a
 * clock that jumps past the budget between patterns must stop the scan.
 */
export function scanForCode(text: string, now: () => number = Date.now): CodeScan {
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
      link = LINK_PATTERN.exec(body)?.[0] ?? null;
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
  "ledger could not find a nine-digit code in this message. The message itself is below, exactly as it arrived and " +
  "not trusted — the code is somewhere in it, and copying it from there works just as well.";

export const UNTRUSTED_BODY_LABEL = "Raw message, shown as text. ledger has not verified anything in it.";
