import { compileDefinition, type Definition } from "@ledger/client/tmpl/exec.ts";
import { parseDecimal } from "@ledger/client/wire/op.ts";

export interface PublishedTemplate { id: string; bank: string; version: number; normalizerVersion: number; definition: Definition }
export interface TemplatePage { version: bigint; templates: PublishedTemplate[]; removed: string[] }

export async function fetchTemplates(opts: { server: string; token: string | null; since: bigint; fetch?: (request: Request) => Promise<Response> }): Promise<TemplatePage> {
  if (opts.token === null || opts.token.trim() === "") throw new Error("not signed in");
  const response = await (opts.fetch ?? fetch)(new Request(new URL(`/api/v1/templates?since=${opts.since}`, opts.server), { headers: { authorization: `Bearer ${opts.token}` } }));
  const doc = await response.json() as Record<string, unknown>;
  if (!response.ok) throw new Error(`template fetch failed: ${response.status}`);
  if (typeof doc.version !== "string" || !/^(0|[1-9]\d*)$/.test(doc.version) || !Array.isArray(doc.templates) || !Array.isArray(doc.removed)) throw new Error("invalid template response");
  const templates = doc.templates.map((raw): PublishedTemplate => {
    if (typeof raw !== "object" || raw === null) throw new Error("invalid published template");
    const r = raw as Record<string, unknown>;
    if (r.status !== "published") throw new Error("template response contains a non-published definition");
    const definition = r.definition as Definition;
    const compiled = compileDefinition(definition); // validation at the trust boundary, before storage/execution
    if (r.id !== definition.id || r.bank !== definition.bank || r.version !== definition.version || r.normalizer_version !== definition.normalizer_version) throw new Error("template envelope disagrees with definition");
    void compiled;
    return { id: definition.id, bank: definition.bank, version: definition.version, normalizerVersion: definition.normalizer_version, definition };
  });
  const removed = doc.removed.map((x) => { if (typeof x !== "string") throw new Error("invalid removed template id"); return x; });
  return { version: parseDecimal(doc.version), templates, removed };
}
