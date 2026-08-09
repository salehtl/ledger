/**
 * A held message the trust model cannot verify, read by the person it belongs to.
 *
 * # What this lane is, and what it is emphatically not
 *
 * A manual forward destroys the bank's DKIM, so `Decide` refuses the message and
 * it sits in quarantine until it expires. Lane 2 gives it one action: **the user
 * reads it and types the transaction**. The parse below is a form PREFILL and
 * nothing else — no machine believes it, the human is the verifier, and the op
 * that results carries exactly the authority typing carries.
 *
 * So this module:
 *
 *   - **never writes `sender_allowlist`** and never promotes anything. The
 *     message stays held. `Decide` is untouched, and the
 *     forwarder-is-never-an-outer-origin rule stands.
 *   - **authors the same op manual entry authors** — `txn_ingested`, through
 *     {@link manualTxnOps}, with `entry_method: "reviewed_forward"` as an
 *     optional label. No new op type, so `SCHEMA_VERSION` stays 3; a v3 device
 *     meeting a v4 op would halt its whole sync.
 *   - **reads `entry_method` for nothing.** Provenance comes from the writer.
 *
 * # The promise it must not make
 *
 * There is **no heuristic on the TypeScript side.** `client/src` has `norm` and
 * `tmpl` and nothing else, so a message from a bank with no published template
 * prefills NOTHING. {@link prefillFromHeld} says so in words
 * ({@link Prefill.reason}) and the screen degrades to plain manual entry with
 * the raw text shown. Advertising autofill this cannot deliver would be worse
 * than not offering it.
 *
 * # Matching, and why it is only a filter
 *
 * The Go pipeline picks templates by the VERIFIED sender domain. Nothing here is
 * verified — that is the entire premise of the lane — so the domains compared
 * below (the held item's outer and inner domains, and the `From:` the normalizer
 * recovered from inside the forward) are all *claims*. They are used to narrow
 * which templates to try, so a wrong template does not prefill a plausible wrong
 * number; they are never used to decide that anything is true. If no template
 * matches, the answer is "nothing was filled in", never a guess.
 */

import { normalize, CURRENT_VERSION, type NormalizeResult } from "@ledger/client/norm/norm";
import { platform } from "@ledger/client/platform";
import { compileDefinition, produced, validateExtraction, type Definition, type Extraction } from "@ledger/client/tmpl/exec";

import type { QuarantineItem } from "../onboardingIO";
import type { ManualDraft } from "./transactions";

/** The `entry_method` a transaction read off a held message carries. A label. */
export const REVIEWED_ENTRY_METHOD = "reviewed_forward";

/** Held mail is capped at 1 MB on the server; a blob past that is refused rather than parsed. */
export const MAX_BLOB_BYTES = 1_048_576;

export interface Prefill {
  /**
   * The message body as TEXT, normalized and unwrapped. Rendered as React text
   * children and never as markup — see the screen.
   */
  body: string;
  /** The effective subject. Content the sender wrote, never a trust signal. */
  subject: string;
  /** The `From:` the message CLAIMS. Never checked by anything. */
  claimedFrom: string;
  /** The prefilled form, or `null` when nothing could be read out. */
  draft: ManualDraft | null;
  /** Which template produced the draft, for the screen to name. */
  templateId: string | null;
  /** Plain words for what happened. Always set, prefilled or not. */
  reason: string;
}

/** The blob, decoded. Throws on anything that is not base64 or is too big. */
export function decodeBlob(base64: string): Uint8Array {
  const bytes = platform().fromBase64(base64);
  if (bytes.length > MAX_BLOB_BYTES) throw new Error("that message is larger than ledger stores");
  return bytes;
}

/** The domain half of an address, lower-cased. `""` when there is not one. */
function domainOf(address: string): string {
  const at = address.lastIndexOf("@");
  return at < 0 ? "" : address.slice(at + 1).trim().toLowerCase().replace(/[>\s]+$/, "");
}

/**
 * Whether `claim` is `want` or a subdomain of it.
 *
 * Suffix matching mirrors what the Go pipeline does with a verified domain
 * (`alerts.dib.ae` is `dib.ae`'s). Here it decides only which templates to TRY.
 */
function domainMatches(claim: string, want: string): boolean {
  return claim === want || claim.endsWith(`.${want}`);
}

const UNVERIFIED_PREFIX = "unverified:";

/** The domains this message claims, from the envelope and from inside the forward. */
export function claimedDomains(item: QuarantineItem, from: string): string[] {
  const out = new Set<string>();
  for (const raw of [item.innerDomain, item.outerDomain, domainOf(from)]) {
    const d = raw.trim().toLowerCase();
    // An `unverified:`-prefixed name is the envelope's assertion with the
    // server's own warning attached; the prefix is stripped for MATCHING and
    // nothing else, because matching is not believing.
    const bare = d.startsWith(UNVERIFIED_PREFIX) ? d.slice(UNVERIFIED_PREFIX.length) : d;
    if (bare !== "") out.add(bare);
  }
  return [...out];
}

/** The templates whose `sender_domain` list names a domain this message claims. */
export function candidateTemplates(templates: readonly Definition[], domains: readonly string[]): Definition[] {
  return templates.filter((d) =>
    (d.match?.sender_domain ?? []).some((want) => domains.some((claim) => domainMatches(claim, want.toLowerCase()))),
  );
}

/** `2026-08-03T21:00:00Z` → `2026-08-03`, the shape a date field speaks. */
function dayOf(instant: string): string {
  return instant.slice(0, 10);
}

/** `1250n` → `"12.50"`: a digit-string slice, never a float. */
function minorToText(minor: bigint): string {
  const digits = minor.toString(10).padStart(3, "0");
  return `${digits.slice(0, -2)}.${digits.slice(-2)}`;
}

/**
 * The draft one successful extraction becomes.
 *
 * The amount, currency and direction come from the template. Everything the
 * template did not produce is left EMPTY rather than defaulted: a merchant
 * quietly filled in with the subject line, or a direction defaulted to
 * "Spending", is the screen inventing a fact the user will confirm without
 * noticing.
 */
export function draftFromExtraction(e: Extraction, fallbackDate: string): ManualDraft {
  return {
    amount: produced(e, "amount") ? minorToText(e.amount_minor) : "",
    currency: e.currency,
    direction: e.direction === "" ? "debit" : e.direction,
    merchant: e.merchant,
    date: dayOf(e.posted_at !== "" ? e.posted_at : fallbackDate),
    category: null,
  };
}

export interface PrefillArgs {
  item: QuarantineItem;
  /** The decoded raw RFC822 message, from {@link decodeBlob}. */
  raw: Uint8Array;
  /** Published definitions, from `readTemplateDefinitions`. */
  templates: readonly Definition[];
}

/**
 * Reads a held message as far as this device honestly can.
 *
 * Never throws for a message it cannot read: an unreadable body is a `reason`
 * and an empty form, because the fallback for this whole lane is plain manual
 * entry and a screen that crashed would take that away too.
 */
export function prefillFromHeld({ item, raw, templates }: PrefillArgs): Prefill {
  let norm: NormalizeResult;
  try {
    norm = normalize(CURRENT_VERSION, raw, item.receivedAt);
  } catch {
    return {
      body: "",
      subject: "",
      claimedFrom: "",
      draft: null,
      templateId: null,
      reason: "ledger could not read this message's text. You can still add the transaction yourself.",
    };
  }

  const base: Omit<Prefill, "draft" | "templateId" | "reason"> = {
    body: norm.text,
    subject: norm.subject,
    claimedFrom: norm.from,
  };
  const candidates = candidateTemplates(templates, claimedDomains(item, norm.from));
  if (candidates.length === 0) {
    return {
      ...base,
      draft: null,
      templateId: null,
      // The honest sentence. See the header: there is no heuristic tier here.
      reason: "ledger has no reader for this sender, so nothing was filled in. The message is below — copy the details across.",
    };
  }

  for (const definition of candidates) {
    let extraction: Extraction;
    try {
      extraction = compileDefinition(definition).execute(norm.subject, norm.text);
      if (!extraction.matched) continue;
      if (validateExtraction(extraction, definition) !== "") continue;
    } catch {
      // A definition this build cannot run, or a pattern outside the dialect.
      // Skipping it keeps the rest of the set usable.
      continue;
    }
    return {
      ...base,
      draft: draftFromExtraction(extraction, norm.emailDate),
      templateId: definition.id,
      reason: "Filled in from the message below. Check every field before you add it.",
    };
  }

  return {
    ...base,
    draft: null,
    templateId: null,
    reason: "ledger could not read the details out of this message, so nothing was filled in. The message is below.",
  };
}
