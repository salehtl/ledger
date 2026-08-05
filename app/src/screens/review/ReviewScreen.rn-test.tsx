import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { ThemeProvider } from "../../app/Theme.tsx";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { StyleSheet } from "react-native";
import type { Txn } from "@ledger/client/replay/state.ts";
import type { ReviewItem } from "../../lib/review.ts";
import type { ReviewDeps } from "./deps.ts";
import type { OpSpec } from "@ledger/client/outbox/outbox.ts";
import { ReviewScreen } from "./ReviewScreen.tsx";

const txn: Txn = {
  id: "t1", ingest_id: "a".repeat(64), amount_minor: 1000n, currency: "AED", direction: "debit" as const,
  posted_at: "2026-08-03T00:00:00.000Z", merchant_raw: "SHOP", last4: "1234", category: null,
  needs_review: true, unparsed: false, tier: "template" as const, parse_error: null, provenance: "ingest" as const,
  amount_home_minor: 1000n, splits: [], superseded_by: null, possible_duplicate_of: null, version: 1,
};
const parsed: ReviewItem = { key: "txn:t1", lane: "needs_review", reason: "unsigned_headers", txn, counterpart: null };
const unparsed: ReviewItem = { key: "txn:u1", lane: "unparsed", reason: "unreadable", counterpart: null, txn: { ...txn, id: "u1", unparsed: true, tier: "none", amount_minor: 0n, currency: "", direction: "", amount_home_minor: null } };
const duplicate: ReviewItem = { key: "dup:t0:t1", lane: "duplicate", reason: "unsigned_headers", txn: { ...txn, possible_duplicate_of: "t0" }, counterpart: { ...txn, id: "t0", merchant_raw: "OTHER" } };

it("renders and navigates every review lane, including the fork position", async () => {
  const source: NonNullable<ReviewDeps["source"]> = {
    counts: async () => ({ needs_review: 1, unparsed: 1, duplicate: 1, forks: 1 }),
    page: async (lane) => lane === "needs_review" ? [parsed] : lane === "unparsed" ? [unparsed] : lane === "duplicate" ? [duplicate] : [],
    forks: async () => [{ key: "fork:w:l", notice: { entity: { kind: "txn", id: "t1" }, winner_op: "winner", loser_op: "loser", at_seq: 42n } }],
    money: async () => ({ counted: 1, excluded: 0, totalHomeMinor: 1000n, awaitingRate: 0 }),
    categories: async () => ["Food"], rules: async () => [], version: async () => 1,
    dismiss: async () => {}, restore: async () => {},
  };
  let duplicateSpecs: readonly OpSpec[] = [];
  const writer: NonNullable<ReviewDeps["writer"]> = { pending: [], enqueue: () => { throw new Error("unused"); }, enqueueMany: (specs) => { duplicateSpecs = specs; return []; }, flush: async () => {} };
  render(<SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } }}><ThemeProvider><ReviewScreen deps={{ source, writer, raw: null, dictionary: null, newID: () => "new" }} onClose={() => {}} /></ThemeProvider></SafeAreaProvider>);

  await waitFor(() => expect(screen.getByText("Confirm")).toBeTruthy());
  expect(StyleSheet.flatten(screen.getByTestId("review-close").props.style).minHeight).toBeGreaterThanOrEqual(44);
  for (const lane of ["needs_review", "unparsed", "duplicate", "forks"]) {
    expect(StyleSheet.flatten(screen.getByTestId(`review-tab-${lane}`).props.style).minHeight).toBeGreaterThanOrEqual(44);
  }
  fireEvent.press(screen.getByText("Couldn't read 1"));
  await waitFor(() => expect(screen.getByText("Type it in")).toBeTruthy());
  fireEvent.press(screen.getByText("Possible duplicates 1"));
  await waitFor(() => expect(screen.getByText("Do these look like the same purchase?")).toBeTruthy());
  fireEvent.press(screen.getByText("They are different purchases"));
  await waitFor(() => expect(duplicateSpecs[0]?.payload).toEqual({ other_txn_id: "t0", disposition: "different" }));
  await waitFor(() => expect(screen.getByTestId("review-undo")).toBeTruthy());
  expect(StyleSheet.flatten(screen.getByTestId("review-undo").props.style).minHeight).toBeGreaterThanOrEqual(44);
  fireEvent.press(screen.getByText("Resolved edits 1"));
  await waitFor(() => expect(screen.getByText("42")).toBeTruthy());
  expect(screen.getByText("winner")).toBeTruthy();
  expect(screen.getByText("loser")).toBeTruthy();
});
