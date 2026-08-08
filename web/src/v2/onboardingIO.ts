/**
 * The four HTTP routes onboarding needs and nothing else owns.
 *
 * `Client` deliberately does not wrap them: its surface is the protocol —
 * `/api/v1/sync`, `/api/v1/writers/*`, the blob routes — and widening its
 * private `request` to make four ad-hoc GETs reachable would put every future
 * one-off call on the protocol client's surface. `address.ts` made the same
 * decision for `GET /api/v1/address` and this module follows it, down to reading
 * the bearer token from the same place and throwing the same two error types, so
 * `boot.ts`'s `401`/`410 account_deleted` classification keeps working on
 * anything raised here.
 *
 * # The response shapes are the server's, decoded once
 *
 * Every field name below was read off the Go handler rather than off a summary:
 * `TemplateResponse` (`internal/v2/api/templates.go`), the 204-or-`invalid_bank`
 * of `handleWaitlist` (`waitlist.go`), `QuarantineResponse`/`QuarantineItem`
 * (`quarantine.go`). The wire is snake_case and the app is camelCase, and the
 * conversion happens HERE, once — a screen reading `item.outer_domain` directly
 * is a screen that silently renders `undefined` the day a field is renamed.
 *
 * # What the quarantine lane may be asked for, and why `include_blob=1`
 *
 * Gmail's forwarding confirmation is signed by `google.com`, spec §3.2 forbids
 * ever promoting a forwarder domain, and `quarantine.go`'s own header records
 * the consequence: onboarding reads the confirmation link out of a quarantined
 * message, which is the one thing `?include_blob=1` exists for. It is opt-in per
 * request because the raw bytes are expensive; {@link readQuarantine} therefore
 * takes it as an explicit argument rather than defaulting it on.
 */

import { ApiError, NetworkError } from "@ledger/client/net/client";

/** The half of `Client` these routes need: a bearer token. */
export interface TokenSource {
  sessionToken: string | null;
}

export interface IOOptions {
  server?: string;
  fetch?: typeof fetch;
}

async function call(
  path: string,
  token: string,
  init: RequestInit,
  opts: IOOptions,
): Promise<{ status: number; text: string }> {
  const doFetch = opts.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const url = `${opts.server ?? ""}${path}`;
  let res: Response;
  try {
    res = await doFetch(url, {
      ...init,
      headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` },
    });
  } catch (err) {
    throw new NetworkError(`${init.method ?? "GET"} ${path}: ${err instanceof Error ? err.message : String(err)}`, err);
  }
  const text = await res.text();
  if (!res.ok) {
    let code = "";
    let detail = "";
    try {
      const e = JSON.parse(text) as { error?: string; detail?: string };
      code = e.error ?? "";
      detail = e.detail ?? "";
    } catch {
      detail = text.slice(0, 200);
    }
    throw new ApiError(res.status, code, detail, `${init.method ?? "GET"} ${path}: ${String(res.status)} ${code}`);
  }
  return { status: res.status, text };
}

function requireToken(client: TokenSource): string {
  const token = client.sessionToken;
  if (token === null || token === "") throw new Error("sign in before setting up your account");
  return token;
}

function json<T>(text: string, what: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ApiError(200, "", text.slice(0, 200), `${what}: unreadable response`);
  }
}

// ---------------------------------------------------------------------------
// GET /api/v1/templates — which banks can be read at all
// ---------------------------------------------------------------------------

export interface SupportedBank {
  /** The `bank` field a template carries, e.g. `"dib"`. */
  id: string;
  /** How many published templates name it. Shown nowhere; useful in a report. */
  templates: number;
}

/**
 * The distinct banks the server has published templates for, alphabetically.
 *
 * Distinct, because `templates.go` answers one entry PER TEMPLATE and a bank
 * routinely has several (`dib.card.v1`, `dib.account.v1`). A picker built
 * straight off the array shows Dubai Islamic Bank twice.
 *
 * `?since=` is deliberately not sent: the delta form is for a client keeping a
 * template cache in step, and onboarding wants the whole current set. A `since`
 * cursor here would answer "what changed" and the picker would come back empty
 * for anyone already up to date.
 */
export async function readSupportedBanks(client: TokenSource, opts: IOOptions = {}): Promise<SupportedBank[]> {
  const { text } = await call("/api/v1/templates", requireToken(client), { method: "GET" }, opts);
  const body = json<{ templates?: unknown }>(text, "GET /api/v1/templates");
  const counts = new Map<string, number>();
  if (Array.isArray(body.templates)) {
    for (const raw of body.templates) {
      if (typeof raw !== "object" || raw === null) continue;
      const bank = (raw as { bank?: unknown }).bank;
      if (typeof bank !== "string" || bank === "") continue;
      counts.set(bank, (counts.get(bank) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([id, templates]) => ({ id, templates }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

// ---------------------------------------------------------------------------
// POST /api/v1/waitlist — the bank-demand counter
// ---------------------------------------------------------------------------

/**
 * Records demand for a bank. `204` on success; the server's own refusal text
 * comes back as an {@link ApiError} with `code === "invalid_bank"` and a
 * `detail` that names the specific problem.
 *
 * The caller passes the ALREADY-FOLDED name (`normalizeBankName(...).bank`).
 * The server folds again and folding an already-folded name is a no-op, so what
 * the client validated is byte-for-byte what is stored.
 */
export async function joinWaitlist(client: TokenSource, bank: string, opts: IOOptions = {}): Promise<void> {
  await call(
    "/api/v1/waitlist",
    requireToken(client),
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ bank }) },
    opts,
  );
}

// ---------------------------------------------------------------------------
// GET /api/v1/quarantine — the held lane
// ---------------------------------------------------------------------------

/**
 * One held message, as `QuarantineItem` in `quarantine.go` sends it.
 *
 * Note what is NOT here, and note that it is absent on the wire too: no subject,
 * no display name, no part of the body. §3.2:55 is specific — the trust decision
 * must never be made from attacker-rendered content. The `blob` is the one
 * exception and it arrives only when asked for.
 */
export interface QuarantineItem {
  id: string;
  ingestId: string;
  receivedAt: string;
  expiresAt: string;
  warnedAt: string | null;
  deleteAfter: string | null;
  outerDomain: string;
  innerDomain: string;
  attested: boolean;
  attestedBy: string;
  dkim: string;
  arc: string;
  sizeBucket: number;
  /** Base64, present only when the page was fetched with `include_blob=1`. */
  blob?: string;
}

export interface QuarantinePage {
  items: QuarantineItem[];
  /** `action_needed`: every held message, per §3.2:56. */
  actionNeeded: number;
  expiringSoon: number;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function nullableStr(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

function decodeItem(raw: unknown): QuarantineItem | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const id = str(r["id"]);
  if (id === "") return null;
  const blob = r["blob"];
  return {
    id,
    ingestId: str(r["ingest_id"]),
    receivedAt: str(r["received_at"]),
    expiresAt: str(r["expires_at"]),
    warnedAt: nullableStr(r["warned_at"]),
    deleteAfter: nullableStr(r["delete_after"]),
    outerDomain: str(r["outer_domain"]),
    innerDomain: str(r["inner_domain"]),
    // Defaulted to FALSE rather than to truthiness: `attested` is the whole
    // difference between "verified" and "unauthenticated", and a field this
    // build failed to read must never read as verified.
    attested: r["attested"] === true,
    attestedBy: str(r["attested_by"]),
    dkim: str(r["dkim"]),
    arc: str(r["arc"]),
    sizeBucket: typeof r["size_bucket"] === "number" ? r["size_bucket"] : 0,
    ...(typeof blob === "string" && blob !== "" ? { blob } : {}),
  };
}

export async function readQuarantine(
  client: TokenSource,
  args: { includeBlob?: boolean } = {},
  opts: IOOptions = {},
): Promise<QuarantinePage> {
  const query = args.includeBlob === true ? "?include_blob=1" : "";
  const { text } = await call(`/api/v1/quarantine${query}`, requireToken(client), { method: "GET" }, opts);
  const body = json<{ items?: unknown; action_needed?: unknown; expiring_soon?: unknown }>(
    text,
    "GET /api/v1/quarantine",
  );
  const items: QuarantineItem[] = [];
  if (Array.isArray(body.items)) {
    for (const raw of body.items) {
      const item = decodeItem(raw);
      if (item !== null) items.push(item);
    }
  }
  return {
    items,
    actionNeeded: typeof body.action_needed === "number" ? body.action_needed : items.length,
    expiringSoon: typeof body.expiring_soon === "number" ? body.expiring_soon : 0,
  };
}

// ---------------------------------------------------------------------------
// POST /api/v1/quarantine/confirm — trusting one verified origin
// ---------------------------------------------------------------------------

export type TrustScope = "outer" | "inner";

/**
 * The refusals a confirmation can come back with, in words a person can act on.
 *
 * The two conflicts are the ones `handleConfirmSender` makes deliberately
 * distinguishable — each names something already visible in the user's own lane,
 * so neither is an oracle. `rate_limited` is here for a different reason: the
 * route carries a per-user budget (`s.QuarantinePerUser`, spent BEFORE the body
 * is even read, because a confirmation runs the whole parse cascade
 * synchronously), so a `429` is an ordinary outcome of tapping twice. Without an
 * entry it fell through to "Try again." — the one instruction that is actively
 * wrong under a rate limit, since trying again is exactly what the budget is
 * refusing.
 */
export const CONFIRM_CONFLICT_COPY: Record<string, string> = {
  forwarder_domain:
    "That is your mail provider, not your bank. Trusting it would trust everything that passes through your " +
    "mailbox. Confirm the bank's own verified domain instead.",
  origin_unproven:
    "Nothing held here carries a verified signature from that domain, so there is nothing to trust yet. Mail " +
    "that cannot be verified stays held.",
  rate_limited:
    "ledger is filing mail as fast as the server allows. Wait about a minute, then confirm again. Nothing was " +
    "lost and the held mail is still there.",
};

/**
 * What one confirmation actually did, out of `ConfirmSenderResponse.Reingest`.
 *
 * **`remaining` is the field that matters and the one a caller must not
 * discard.** `handleConfirmSender` feeds the released ids back through the parse
 * cascade in a BOUNDED batch (`defaultMaxReingestPerConfirm`, 500 — the same cap
 * `ingest.Reprocess` refuses to exceed), and reports what it did not attempt.
 * Confirming again continues, because `Confirm` is idempotent and a promoted
 * message is no longer held. A UI that dropped this reports "done" over a
 * partial ingest, and the user's remaining bank mail sits in the lane until it
 * EXPIRES — announced, per §2, but gone.
 */
export interface ReingestReport {
  examined: number;
  appended: number;
  superseded: number;
  unchanged: number;
  failed: number;
  /** Released ids this call did NOT attempt. Confirming again continues. */
  remaining: number;
  /** The re-ingest hit an infrastructure error; the counts describe what did happen. */
  incomplete: boolean;
}

export interface ConfirmResult {
  domain: string;
  scope: string;
  /** Hex sha256 ids the allowlist row made eligible. */
  ingestIds: string[];
  /**
   * Absent when the deployment has no reprocessor wired — which is never true of
   * a Phase 1 server, and is deliberately distinct from an all-zero report
   * ("there was nothing held to re-ingest"). Collapsing the two would make a
   * confirmation of an origin with no held mail indistinguishable from one on a
   * server where the promotion path is missing.
   */
  reingest: ReingestReport | null;
}

function num(v: unknown): number {
  return typeof v === "number" ? v : 0;
}

export async function confirmSender(
  client: TokenSource,
  domain: string,
  scope: TrustScope,
  opts: IOOptions = {},
): Promise<ConfirmResult> {
  const { text } = await call(
    "/api/v1/quarantine/confirm",
    requireToken(client),
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ domain, scope }) },
    opts,
  );
  const body = json<{ domain?: unknown; scope?: unknown; ingest_ids?: unknown; reingest?: unknown }>(
    text,
    "POST /api/v1/quarantine/confirm",
  );
  const raw = body.reingest;
  const reingest =
    typeof raw === "object" && raw !== null
      ? ((r: Record<string, unknown>): ReingestReport => ({
          examined: num(r["examined"]),
          appended: num(r["appended"]),
          superseded: num(r["superseded"]),
          unchanged: num(r["unchanged"]),
          failed: num(r["failed"]),
          remaining: num(r["remaining"]),
          incomplete: r["incomplete"] === true,
        }))(raw as Record<string, unknown>)
      : null;
  return {
    // The server's NORMALIZED spelling, not the caller's: the stored row is
    // lower-cased, and continuing a batch must send the string this server
    // would match.
    domain: typeof body.domain === "string" ? body.domain : domain,
    scope: typeof body.scope === "string" ? body.scope : scope,
    ingestIds: Array.isArray(body.ingest_ids) ? body.ingest_ids.filter((v): v is string => typeof v === "string") : [],
    reingest,
  };
}

// ---------------------------------------------------------------------------
// What may be rendered as trusted
// ---------------------------------------------------------------------------

export interface TrustBasis {
  authenticated: boolean;
  label: string;
  domain: string | null;
  source: string;
}

/**
 * How `origin.Resolve` spells a domain nothing attested.
 *
 * `Origin.Outer` carries this prefix unless DKIM passed, an ARC chain sealed the
 * message, or a proved relay handed it over — the envelope's `MAIL FROM` is a
 * string the SENDER types, and prefixing it is precisely what stops an envelope
 * claim being compared against an allowlist (`internal/v2/origin/trust.go`).
 *
 * `diag.go` enforces the invariant, and there is a CHECK constraint behind that.
 * It is restated HERE anyway, because the alternative is a security surface
 * whose safety depends on a rule kept three packages away in another language:
 * a client that renders whatever `outer_domain` holds is one schema change away
 * from putting `unverified:dib-alerts.ae` under the words "Verified signing
 * domain".
 */
export const UNVERIFIED_PREFIX = "unverified:";

/**
 * The verified signing domain, or a prominent unauthenticated state — §3.2:55's
 * exact requirement, and the only thing a "trust this sender" control may render
 * about a held message.
 *
 * Three ways to be unauthenticated, and all three land in the same place rather
 * than in three near-miss states:
 *
 *  1. `attested` is not `true`. Decoded as `=== true`, so a field this build
 *     failed to read can never read as verified.
 *  2. The domain to be shown carries {@link UNVERIFIED_PREFIX} — an
 *     envelope-derived name the sender asserted and nothing checked.
 *  3. `attested` is `true` and yet there is no domain at all. The Go validator
 *     does not exclude this pair, and rendering it produced a blank name under
 *     "Verified signing domain" next to a disabled button: incoherent rather
 *     than exploitable, but a security screen has no business showing a state it
 *     cannot explain.
 */
export function trustBasis(item: QuarantineItem): TrustBasis {
  const unauthenticated: TrustBasis = {
    authenticated: false,
    label: "Unauthenticated",
    domain: null,
    source: "No verified origin",
  };
  if (!item.attested) return unauthenticated;
  const domain = item.innerDomain !== "" ? item.innerDomain : item.outerDomain;
  if (domain === "" || domain.startsWith(UNVERIFIED_PREFIX)) return unauthenticated;
  return { authenticated: true, label: domain, domain, source: item.attestedBy || "Verified signature" };
}

/**
 * The expiry notice, or `null` while there is nothing to count down to.
 *
 * Held mail expires after 30 days and §2 forbids dropping anything without a
 * user-visible notice. Both halves of that notice are on the wire: `warned_at`
 * says the warning has gone out, and `delete_after` is the instant the sweep
 * will actually act — **computed by the store, not here**, because a second copy
 * of that arithmetic in the client is how a UI ends up promising a date the
 * server does not honour. Until the warning has been sent there is no deletion
 * to announce, which is why both fields are required for a notice at all.
 */
export function deletionNotice(item: QuarantineItem, nowMs: number): string | null {
  if (item.warnedAt === null || item.deleteAfter === null) return null;
  const deadline = Date.parse(item.deleteAfter);
  if (!Number.isFinite(deadline)) return "Deletion deadline unavailable";
  const days = Math.max(0, Math.ceil((deadline - nowMs) / 86_400_000));
  return days === 0 ? "Scheduled for deletion today" : `Scheduled for deletion in ${days} day${days === 1 ? "" : "s"}`;
}

/**
 * Which (domain, scope) pair confirming this item would send, or null.
 *
 * It refuses everything {@link trustBasis} calls unauthenticated, and it refuses
 * an `unverified:`-prefixed domain in EITHER scope rather than only in the one
 * that happened to be shown — this is the layer that decides what is sent, so it
 * checks for itself instead of trusting the layer that decides what is drawn.
 */
export function trustRequest(item: QuarantineItem): { domain: string; scope: TrustScope } | null {
  if (!trustBasis(item).authenticated) return null;
  const usable = (d: string): boolean => d !== "" && !d.startsWith(UNVERIFIED_PREFIX);
  if (usable(item.innerDomain)) return { domain: item.innerDomain, scope: "inner" };
  if (usable(item.outerDomain)) return { domain: item.outerDomain, scope: "outer" };
  return null;
}
