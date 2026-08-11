/**
 * `settleAuthored` — the missing half of "author an op".
 *
 * Authoring writes the outbox and the flush uploads it, but the projection —
 * the thing every screen reads — only moves when a sync folds. Until this
 * existed, nothing ran that fold: an edit made on one screen reached the
 * others on the next launch, foreground, or pull-to-refresh, and on nothing
 * else. `settleAuthored` is the third step: sync (pull + fold what the server
 * now holds), then mark every projection query stale so mounted screens
 * re-read.
 */
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import { settleAuthored } from "./settle";
import { v2Keys } from "./queries";

function trackingClient(): { qc: QueryClient; invalidated: () => unknown[][] } {
  const qc = new QueryClient();
  const calls: unknown[][] = [];
  const real = qc.invalidateQueries.bind(qc);
  qc.invalidateQueries = ((filters?: { queryKey?: unknown[] }) => {
    calls.push(filters?.queryKey ?? []);
    return real(filters as never);
  }) as typeof qc.invalidateQueries;
  return { qc, invalidated: () => calls };
}

describe("settleAuthored", () => {
  it("runs the sync with the 'authored' trigger, then invalidates the projection root", async () => {
    const order: string[] = [];
    const { qc, invalidated } = trackingClient();
    await settleAuthored(async (trigger) => {
      order.push(`sync:${trigger}`);
    }, qc);
    expect(order).toEqual(["sync:authored"]);
    // The invalidation reaches the v2 projection root, and it happens — the
    // whole point is that screens re-read AFTER the fold moved the projection.
    expect(invalidated()).toEqual([v2Keys.all]);
  });

  it("invalidates even when the sync rejects — an offline device still re-reads its overlay", async () => {
    const { qc, invalidated } = trackingClient();
    await settleAuthored(async () => {
      throw new Error("offline");
    }, qc);
    expect(invalidated()).toEqual([v2Keys.all]);
  });

  it("finishes the sync before invalidating, never the other way round", async () => {
    const order: string[] = [];
    const { qc } = trackingClient();
    const real = qc.invalidateQueries.bind(qc);
    qc.invalidateQueries = (async (f?: never) => {
      order.push("invalidate");
      return real(f);
    }) as typeof qc.invalidateQueries;
    await settleAuthored(async () => {
      // A slow sync: the invalidation must not overtake it, or the re-read
      // happens over the projection the fold is still rewriting.
      await new Promise((r) => setTimeout(r, 10));
      order.push("sync-done");
    }, qc);
    expect(order).toEqual(["sync-done", "invalidate"]);
  });
});
