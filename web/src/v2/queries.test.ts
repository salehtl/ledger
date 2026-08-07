import { describe, expect, it } from "vitest";
import { QueryClient } from "@tanstack/react-query";

import { V2_QUERY_ROOT, invalidateAfterSync, serializeFilters, v2Keys } from "./queries";
import { EMPTY_FILTERS } from "./sources/transactions";

describe("v2Keys", () => {
  it("prefixes every key with the v2 root, so one invalidation reaches all of them", () => {
    const keys = [
      v2Keys.all,
      v2Keys.budget("2026-08"),
      v2Keys.transactions({ from: "2026-08-01", to: "2026-08-31" }),
      v2Keys.review(),
      v2Keys.quarantine(),
      v2Keys.address(),
    ];
    for (const k of keys) expect(k[0]).toBe(V2_QUERY_ROOT);
  });

  it("distinguishes two scopes of the same resource", () => {
    expect(v2Keys.budget("2026-07")).not.toEqual(v2Keys.budget("2026-08"));
    expect(v2Keys.transactions({ from: "a" })).not.toEqual(v2Keys.transactions({ from: "b" }));
  });

  it("is stable for the same arguments — an unstable key refetches forever", () => {
    expect(v2Keys.transactions({ from: "a", to: "b" })).toEqual(v2Keys.transactions({ from: "a", to: "b" }));
  });
});

describe("invalidateAfterSync", () => {
  it("marks every v2 query stale and leaves anything else alone", async () => {
    const qc = new QueryClient();
    qc.setQueryData(v2Keys.review(), ["a"]);
    qc.setQueryData(v2Keys.budget("2026-08"), { total: 1n });
    qc.setQueryData(["ingest-health"], { status: "ok" });

    for (const key of [v2Keys.review(), v2Keys.budget("2026-08"), ["ingest-health"]]) {
      qc.getQueryCache().find({ queryKey: key })?.setState({ isInvalidated: false } as never);
    }

    await invalidateAfterSync(qc);

    expect(qc.getQueryCache().find({ queryKey: v2Keys.review() })?.state.isInvalidated).toBe(true);
    expect(qc.getQueryCache().find({ queryKey: v2Keys.budget("2026-08") })?.state.isInvalidated).toBe(true);
    expect(qc.getQueryCache().find({ queryKey: ["ingest-health"] })?.state.isInvalidated).toBe(false);
  });

  it("keeps bigint data intact across an invalidation — money is never a number", async () => {
    const qc = new QueryClient();
    qc.setQueryData(v2Keys.budget("2026-08"), { spent: 12_345n });
    await invalidateAfterSync(qc);
    expect(qc.getQueryData(v2Keys.budget("2026-08"))).toEqual({ spent: 12_345n });
  });
});

describe("serializeFilters", () => {
  it("is stable however the user reached the same selection", () => {
    const a = { ...EMPTY_FILTERS, categories: ["dining", null, "groceries"], flags: ["split" as const, "needs_review" as const] };
    const b = { ...EMPTY_FILTERS, categories: [null, "groceries", "dining"], flags: ["needs_review" as const, "split" as const] };
    expect(serializeFilters(a)).toBe(serializeFilters(b));
    expect(v2Keys.transactions({ extra: serializeFilters(a) })).toEqual(
      v2Keys.transactions({ extra: serializeFilters(b) }),
    );
  });

  it("separates a selected null category from a selected literal", () => {
    // "Uncategorized" is a real value, not the absence of one, and a key that
    // collapsed it into a category literally named "null" would serve one
    // list's rows to the other.
    expect(serializeFilters({ ...EMPTY_FILTERS, categories: [null] })).not.toBe(
      serializeFilters({ ...EMPTY_FILTERS, categories: ["null"] }),
    );
  });

  it("ignores a whitespace-only search, which is what filtersActive already ignores", () => {
    expect(serializeFilters({ ...EMPTY_FILTERS, query: "  " })).toBe(serializeFilters(EMPTY_FILTERS));
  });
});
