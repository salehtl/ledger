import { ApiError, NetworkError } from "@ledger/client/net/client.ts";
import {
  EMPTY_REPORT,
  addReports,
  type ConfirmResult,
  type QuarantineCursor,
  type QuarantineItem,
  type ReingestReport,
  type TrustScope,
} from "../../lib/quarantine.ts";

export interface QuarantinePage {
  items: QuarantineItem[];
  actionNeeded: number;
  expiringSoon: number;
  next: QuarantineCursor;
  complete: boolean;
}

export interface QuarantineListOptions {
  /**
   * Ask for the raw message bytes (`?include_blob=1`).
   *
   * Off by default and it must stay that way: the server documents the default
   * listing as "cheap" precisely because a held message can be a megabyte, and
   * the ONE caller that needs bodies is onboarding's verification step, which
   * has to read Gmail's confirmation code out of a message the product refuses
   * to trust (plan Decision 7).
   */
  includeBlob?: boolean;
}

export interface QuarantineSource {
  list(cursor?: QuarantineCursor, options?: QuarantineListOptions): Promise<QuarantinePage>;
  confirm(domain: string, scope: TrustScope, onPage?: (report: ReingestReport) => void): Promise<ConfirmResult>;
}

export interface QuarantineSourceOptions {
  server: string;
  token: () => string | null;
  fetch?: (request: Request) => Promise<Response>;
  sync: () => Promise<unknown>;
  maxConfirmPages?: number;
}

const text = (x: unknown, name: string): string => {
  if (typeof x !== "string") throw new Error(`quarantine ${name} is not text`);
  return x;
};
const integer = (x: unknown, name: string): number => {
  if (typeof x !== "number" || !Number.isInteger(x) || x < 0) throw new Error(`quarantine ${name} is not a count`);
  return x;
};

function item(raw: unknown): QuarantineItem {
  if (typeof raw !== "object" || raw === null) throw new Error("quarantine item is not an object");
  const r = raw as Record<string, unknown>;
  return {
    id: text(r.id, "id"), ingestId: text(r.ingest_id, "ingest_id"), receivedAt: text(r.received_at, "received_at"),
    expiresAt: text(r.expires_at, "expires_at"), warnedAt: r.warned_at == null ? null : text(r.warned_at, "warned_at"),
    deleteAfter: r.delete_after == null ? null : text(r.delete_after, "delete_after"), outerDomain: text(r.outer_domain, "outer_domain"),
    innerDomain: text(r.inner_domain, "inner_domain"), attested: r.attested === true, attestedBy: text(r.attested_by, "attested_by"),
    dkim: text(r.dkim, "dkim"), arc: text(r.arc, "arc"), sizeBucket: integer(r.size_bucket, "size_bucket"),
    ...(typeof r.blob === "string" && r.blob !== "" ? { blob: r.blob } : {}),
  };
}

export function createQuarantineSource(opts: QuarantineSourceOptions): QuarantineSource {
  const doFetch = opts.fetch ?? ((request: Request) => fetch(request));
  const request = async <T,>(method: string, path: string, body?: unknown): Promise<T> => {
    const token = opts.token();
    if (token === null || token.trim() === "") throw new Error("not signed in");
    let response: Response;
    try {
      response = await doFetch(new Request(new URL(path, opts.server), {
        method, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }));
    } catch (cause) {
      throw new NetworkError("quarantine request failed", cause);
    }
    const doc = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) throw new ApiError(response.status, typeof doc.error === "string" ? doc.error : "http_error", typeof doc.detail === "string" ? doc.detail : "", `quarantine request failed: ${response.status}`);
    return doc as T;
  };

  return {
    async list(cursor = {}, options = {}) {
      const q = new URLSearchParams();
      if (options.includeBlob === true) q.set("include_blob", "1");
      if (cursor.after !== undefined) q.set("after", cursor.after);
      if (cursor.afterId !== undefined) q.set("after_id", cursor.afterId);
      if (cursor.removedAfter !== undefined) q.set("removed_after", cursor.removedAfter);
      if (cursor.removedAfterId !== undefined) q.set("removed_after_id", cursor.removedAfterId);
      const raw = await request<Record<string, unknown>>("GET", `/api/v1/quarantine?${q}`);
      const values = Array.isArray(raw.items) ? raw.items.map(item) : [];
      return {
        items: values,
        actionNeeded: integer(raw.action_needed, "action_needed"),
        expiringSoon: integer(raw.expiring_soon, "expiring_soon"),
        next: {
          ...(typeof raw.next === "string" && raw.next !== "" ? { after: raw.next } : {}),
          ...(typeof raw.next_id === "string" && raw.next_id !== "" ? { afterId: raw.next_id } : {}),
          ...(typeof raw.removed_next === "string" && raw.removed_next !== "" ? { removedAfter: raw.removed_next } : {}),
          ...(typeof raw.removed_next_id === "string" && raw.removed_next_id !== "" ? { removedAfterId: raw.removed_next_id } : {}),
        },
        complete: raw.complete === true,
      };
    },
    async confirm(domain, scope, onPage) {
      let total = EMPTY_REPORT;
      let ids: string[] = [];
      let normalized = domain;
      const max = opts.maxConfirmPages ?? 100;
      for (let page = 0; page < max; page++) {
        const raw = await request<Record<string, unknown>>("POST", "/api/v1/quarantine/confirm", { domain, scope });
        normalized = text(raw.domain, "confirm domain");
        ids = ids.concat(Array.isArray(raw.ingest_ids) ? raw.ingest_ids.map((x) => text(x, "confirm ingest id")) : []);
        const r = raw.reingest as Record<string, unknown> | null | undefined;
        if (r == null) {
          await opts.sync();
          return { domain: normalized, scope, ingestIds: ids, reingest: null };
        }
        const report: ReingestReport = {
          examined: integer(r.examined, "examined"), appended: integer(r.appended, "appended"),
          superseded: integer(r.superseded, "superseded"), unchanged: integer(r.unchanged, "unchanged"),
          failed: integer(r.failed, "failed"), remaining: integer(r.remaining, "remaining"), incomplete: r.incomplete === true,
        };
        total = addReports(total, report);
        onPage?.(report);
        if (!report.incomplete && report.remaining === 0) {
          await opts.sync();
          return { domain: normalized, scope, ingestIds: ids, reingest: total };
        }
        if (report.examined === 0) throw new Error(`quarantine confirm did not make progress (${report.remaining} remaining)`);
      }
      throw new Error("quarantine confirm exceeded its page limit");
    },
  };
}
