import type { ColdSync } from "../sync/cold.ts";
import { normalizeBankName } from "../lib/bank.ts";
import { donationPreview, donationRequest, type DonationPreview } from "../lib/redaction.ts";

export const SUPPORTED_TEMPLATE_IDS = ["dib.card.v1", "dib.account.v1", "enbd.transfer.v1", "enbd.alert.v1"] as const;
export const SUPPORTED_BANKS = [
  { id: "dib", name: "Dubai Islamic Bank", templateIds: SUPPORTED_TEMPLATE_IDS.filter((id) => id.startsWith("dib.")) },
  { id: "enbd", name: "Emirates NBD", templateIds: SUPPORTED_TEMPLATE_IDS.filter((id) => id.startsWith("enbd.")) },
] as const;
/**
 * The bank a waitlist entry records in the onboarding facts.
 *
 * `lib/onboarding.ts` gates `bank_picked` on `facts.bank !== null` and calls
 * this "the sentinel a waitlist entry uses". Without it a user whose bank is
 * unsupported — the exact user the waitlist exists for — cannot leave the bank
 * step at all, because the only other way to set `bank` is to claim a bank they
 * do not have. The value matches the one `admin.NormalizeBank`'s refusal message
 * names ("send a value from the onboarding picker, or \"other\"").
 */
export const WAITLIST_BANK = "other";

export const SAMPLE_DISCLOSURE = "A donated sample is one complete email of yours — amounts, merchants, card digits, headers, everything. The operator can read it for up to 180 days. Only donate after checking the exact message below.";

export type SampleFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
export interface WaitlistSource { join(bank: string): Promise<void>; }

/**
 * A name this client refused before the request. Its `message` is already the
 * sentence to render — {@link normalizeBankName} names what is allowed — so the
 * screen shows it verbatim rather than substituting a generic apology.
 */
export class BankNameError extends Error {
  constructor(reason: string) { super(reason); this.name = "BankNameError"; }
}

export function waitlistSource(server: string, token: () => string | null, request: SampleFetch = fetch): WaitlistSource {
  return { async join(raw: string) {
    // The server's grammar, checked HERE, so a name it cannot store is refused
    // with the rule attached instead of arriving as a 400 the user cannot act
    // on. The check this replaces accepted any <=64-CODE-POINT non-control
    // string — a strictly wider set than the server's <=64-BYTE ASCII shape,
    // and "Mashreq (UAE)" sat in the gap. See lib/bank.ts.
    const name = normalizeBankName(raw);
    if (!name.ok) throw new BankNameError(name.reason);
    const session = token(); if (session === null) throw new Error("sign in before joining the waitlist");
    // The folded form, which is byte-for-byte what the server stores: it folds
    // again, and folding an already-folded name is a no-op.
    const response = await request(new URL("/api/v1/waitlist", server), { method: "POST", headers: { authorization: `Bearer ${session}`, "content-type": "application/json" }, body: JSON.stringify({ bank: name.bank }) });
    if (response.status !== 204) {
      // The server's own refusal text names the specific problem. It was being
      // discarded in favour of the status code.
      let detail = "";
      try { const body = await response.json() as { detail?: unknown }; if (typeof body.detail === "string") detail = body.detail; } catch { /* a body is optional */ }
      throw Object.assign(new Error(detail === "" ? `waitlist request failed: ${response.status}` : detail), { status: response.status });
    }
  } };
}

export class SampleSource {
  constructor(private readonly options: { server: string; token: () => string | null; cold: Pick<ColdSync, "fetchBody">; fetch?: SampleFetch }) {}
  private async post(path: string, body: object): Promise<void> { const token = this.options.token(); if (!token) throw new Error("sign in before reporting a sample"); const response = await (this.options.fetch ?? fetch)(new URL(path, this.options.server), { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) }); if (response.status !== 204) throw Object.assign(new Error(`sample request failed: ${response.status}`), { status: response.status }); }
  /** Default, content-free on the wire: one existing ingest identifier, no body. */
  report(ingestId: string): Promise<void> { return this.post("/api/v1/samples/report", { ingest_id: ingestId }); }
  async preview(ingestId: string): Promise<DonationPreview> { const body = await this.options.cold.fetchBody(ingestId); if (body === null) throw new Error("the verified cold message is unavailable"); return donationPreview(body, ingestId); }
  donate(preview: DonationPreview, consent: string | null): Promise<void> { return this.post("/api/v1/samples/donate", donationRequest(preview, consent)); }
}

// `donationConsent()` used to sit here and had no caller outside its own test.
// `DonateSheet.tsx` and `lib/redaction.ts` both import `DONATION_CONSENT`
// directly, which is the constant this returned, so the accessor was a second
// name for one value and nothing more.
