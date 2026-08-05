export type TrustScope = "outer" | "inner";

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
}

export interface QuarantineCursor {
  after?: string;
  afterId?: string;
  removedAfter?: string;
  removedAfterId?: string;
}

export interface ReingestReport {
  examined: number;
  appended: number;
  superseded: number;
  unchanged: number;
  failed: number;
  remaining: number;
  incomplete: boolean;
}

export interface ConfirmResult {
  domain: string;
  scope: TrustScope;
  ingestIds: string[];
  reingest: ReingestReport | null;
}

export type ConfirmConflict = "forwarder_domain" | "origin_unproven";

export const CONFLICT_COPY: Record<ConfirmConflict, string> = {
  forwarder_domain: "This is your forwarder, not your bank. Trust the verified bank behind it instead.",
  origin_unproven: "Nothing we're holding carries a verified signature from that domain, so it cannot be trusted yet.",
};

export function trustBasis(item: QuarantineItem): { authenticated: boolean; label: string; domain: string | null; source: string } {
  if (!item.attested) return { authenticated: false, label: "Unauthenticated", domain: null, source: "No verified origin" };
  const domain = item.innerDomain || item.outerDomain;
  return { authenticated: true, label: domain, domain, source: item.attestedBy || "Verified signature" };
}

export function trustRequest(item: QuarantineItem): { domain: string; scope: TrustScope } | null {
  if (!item.attested) return null;
  if (item.innerDomain !== "") return { domain: item.innerDomain, scope: "inner" };
  if (item.outerDomain !== "") return { domain: item.outerDomain, scope: "outer" };
  return null;
}

export function deletionNotice(item: QuarantineItem, nowMs: number): string | null {
  if (item.warnedAt === null || item.deleteAfter === null) return null;
  const deadline = Date.parse(item.deleteAfter);
  if (!Number.isFinite(deadline)) return "Deletion deadline unavailable";
  const days = Math.max(0, Math.ceil((deadline - nowMs) / 86_400_000));
  return days === 0 ? "Scheduled for deletion today" : `Scheduled for deletion in ${days} day${days === 1 ? "" : "s"}`;
}

export function addReports(a: ReingestReport, b: ReingestReport): ReingestReport {
  return {
    examined: a.examined + b.examined,
    appended: a.appended + b.appended,
    superseded: a.superseded + b.superseded,
    unchanged: a.unchanged + b.unchanged,
    failed: a.failed + b.failed,
    remaining: b.remaining,
    incomplete: b.incomplete,
  };
}

export const EMPTY_REPORT: ReingestReport = {
  examined: 0, appended: 0, superseded: 0, unchanged: 0, failed: 0, remaining: 0, incomplete: false,
};
