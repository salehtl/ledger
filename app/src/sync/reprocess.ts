import type { OpSpec } from "@ledger/client/outbox/outbox.ts";
import { normalize } from "@ledger/client/norm/norm.ts";
import { compileDefinition, type Definition, type Extraction } from "@ledger/client/tmpl/exec.ts";
import type { Txn } from "@ledger/client/replay/state.ts";

export interface ReprocessCandidate { txn: Txn; verifiedDomain: string | null }
export interface VerifiedColdBody { verified: boolean; body: Uint8Array | null }
export interface ReprocessProgress { examined: number; emitted: number; skipped: number; unavailable: number; total: number }
export interface ReprocessDeps {
  candidates(): Promise<readonly ReprocessCandidate[]> | readonly ReprocessCandidate[];
  cold(ingestId: string, cancelled: () => boolean): Promise<VerifiedColdBody>;
  templates: readonly Definition[];
  enqueue(spec: OpSpec): void;
  newId(): string;
  yieldToUI(): Promise<void>;
  cancelled?(): boolean;
  onProgress?(progress: ReprocessProgress): void;
  chunkSize?: number;
}
export interface ReprocessResult extends ReprocessProgress { cancelled: boolean }

function sameOutcome(txn: Txn, x: Extraction, postedAt: string): boolean {
  return !txn.unparsed && txn.amount_minor === x.amount_minor && txn.currency === x.currency && txn.direction === x.direction && txn.posted_at === postedAt && txn.merchant_raw === x.merchant && txn.last4 === x.last4 && txn.tier === "template";
}

const DOMAIN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
export function senderDomainMatches(listed: readonly string[], verified: string): boolean {
  const v = verified.trim().replace(/\.$/, "").replace(/[A-Z]/g, (c) => c.toLowerCase());
  if (!DOMAIN.test(v)) return false;
  return listed.some((raw) => { const l = raw.replace(/[A-Z]/g, (c) => c.toLowerCase()); return l !== "" && (v === l || v.endsWith(`.${l}`)); });
}
function matchingTemplates(definitions: readonly Definition[], domain: string): Definition[] {
  return definitions.filter((d) => senderDomainMatches(d.match.sender_domain, domain)).sort((a, b) => b.version - a.version || a.id.localeCompare(b.id));
}

export async function reprocessCold(deps: ReprocessDeps): Promise<ReprocessResult> {
  const candidates = await deps.candidates();
  const compiled = new Map(deps.templates.map((d) => [d.id + "\u0000" + d.version, compileDefinition(d)]));
  const progress: ReprocessProgress = { examined: 0, emitted: 0, skipped: 0, unavailable: 0, total: candidates.length };
  const publish = () => deps.onProgress?.({ ...progress });
  const chunk = deps.chunkSize ?? 25;
  for (let i = 0; i < candidates.length; i++) {
    if (deps.cancelled?.()) return { ...progress, cancelled: true };
    const candidate = candidates[i]!; const txn = candidate.txn; progress.examined++;
    if (!txn.unparsed || txn.superseded_by !== null || (txn.tier !== "none" && txn.tier !== "heuristic")) { progress.skipped++; publish(); continue; }
    // There is no TS heuristic. Say so by counting it separately as unavailable; never silently reinterpret it as template output.
    if (txn.tier === "heuristic") { progress.unavailable++; publish(); continue; }
    if (candidate.verifiedDomain === null) { progress.unavailable++; publish(); continue; }
    const body = await deps.cold(txn.ingest_id, deps.cancelled ?? (() => false));
    if (deps.cancelled?.()) return { ...progress, cancelled: true };
    if (!body.verified) throw new Error(`cold body for ${txn.ingest_id} failed chain verification`);
    if (body.body === null) { progress.unavailable++; publish(); continue; }
    let normal;
    try { normal = normalize(1, body.body, txn.posted_at); } catch { progress.skipped++; publish(); continue; }
    let extraction: Extraction | null = null;
    for (const definition of matchingTemplates(deps.templates, candidate.verifiedDomain)) {
      if (definition.normalizer_version !== 1) continue;
      const got = compiled.get(definition.id + "\u0000" + definition.version)!.execute(normal.subject, normal.text);
      if (got.matched) { extraction = got; break; }
    }
    if (extraction === null) { progress.skipped++; publish(); continue; }
    const postedAt = extraction.posted_at === "" ? normal.emailDate : extraction.posted_at;
    if (sameOutcome(txn, extraction, postedAt)) { progress.skipped++; publish(); continue; }
    deps.enqueue({ type: "txn_superseded", entity: { kind: "txn", id: deps.newId() }, parentVersion: null, ingestId: txn.ingest_id,
      payload: { amount_minor: extraction.amount_minor.toString(10), currency: extraction.currency,
        direction: extraction.direction, posted_at: postedAt, merchant_raw: extraction.merchant, last4: extraction.last4,
        category: txn.category, needs_review: false, tier: "template", unparsed: false } });
    progress.emitted++; publish();
    if ((i + 1) % chunk === 0) await deps.yieldToUI();
  }
  return { ...progress, cancelled: false };
}

export const HEURISTIC_LIMITATION = "This message was read by the fallback reader and can't be re-checked on your phone.";
export const BACKFILL_SCOPE = "Re-check all available history. Older mail may be downloaded again and removed from the local cache afterwards.";
