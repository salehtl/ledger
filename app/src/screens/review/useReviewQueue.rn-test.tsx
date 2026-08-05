import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { Pressable, Text } from "react-native";

import type { OpSpec } from "@ledger/client/outbox/outbox.ts";
import type { Op } from "@ledger/client/wire/op.ts";
import type { ReviewItem } from "../../lib/review.ts";
import type { ReviewDeps, ReviewWriter } from "./deps.ts";
import { useReviewQueue } from "./useReviewQueue.ts";

const item: ReviewItem = {
  key: "txn:t1",
  lane: "needs_review",
  reason: "unsigned_headers",
  counterpart: null,
  txn: {
    id: "t1", ingest_id: "a".repeat(64), amount_minor: 1000n, currency: "AED", direction: "debit",
    posted_at: "2026-08-03T00:00:00.000Z", merchant_raw: "SHOP", last4: "1234", category: null,
    needs_review: true, unparsed: false, tier: "template", parse_error: null, provenance: "ingest",
    amount_home_minor: 1000n, splits: [], superseded_by: null, possible_duplicate_of: null, version: 1,
  },
};

function Harness({ deps }: { deps: ReviewDeps }) {
  const queue = useReviewQueue(deps);
  const first = queue.items[0];
  return first === undefined
    ? <Text>empty</Text>
    : <Pressable accessibilityRole="button" onPress={() => void queue.confirm(first, "Food")}><Text>confirm item</Text></Pressable>;
}

it("queues category and learned rule in one durable batch and pending settles across remount", async () => {
  const pending: Op[] = [];
  const calls: OpSpec[][] = [];
  const writer: ReviewWriter = {
    get pending() { return pending; },
    enqueue: () => { throw new Error("sequential fallback is forbidden"); },
    enqueueMany(specs) {
      calls.push([...specs]);
      for (const [index, spec] of specs.entries()) pending.push({
        v: 1, type: spec.type as Op["type"], op_id: `op-${pending.length}-${index}`,
        authored_at: "2026-08-03T00:00:00.000Z", parent_version: spec.parentVersion ?? null,
        payload: spec.payload, ...(spec.entity === undefined ? {} : { entity: spec.entity }),
      });
      return pending.slice(-specs.length);
    },
    flush: async () => {},
  };
  const source: ReviewDeps["source"] = {
    counts: async () => ({ needs_review: 1, unparsed: 0, duplicate: 0, forks: 0 }),
    page: async () => [item], forks: async () => [],
    money: async () => ({ counted: 1, excluded: 0, totalHomeMinor: 1000n, awaitingRate: 0 }),
    categories: async () => ["Food"], rules: async () => [], version: async () => 1,
    dismiss: async () => {}, restore: async () => {},
  };
  const deps: ReviewDeps = { source, writer, raw: null, dictionary: null, samples: null, newID: () => "rule-1" };

  const first = await render(<Harness deps={deps} />);
  await waitFor(() => expect(screen.getByText("confirm item")).toBeTruthy());
  fireEvent.press(screen.getByText("confirm item"));
  await waitFor(() => expect(calls).toHaveLength(1));
  expect(calls[0]?.map((spec) => spec.type)).toEqual(["txn_categorized", "rule_added"]);
  await first.unmount();

  await render(<Harness deps={deps} />);
  await waitFor(() => expect(screen.getByText("empty")).toBeTruthy());
});
