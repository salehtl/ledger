import { fireEvent, render, screen, userEvent, waitFor } from "@testing-library/react-native";
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
  render(<SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } }}><ThemeProvider><ReviewScreen deps={{ source, writer, raw: null, dictionary: null, samples: null, newID: () => "new" }} onClose={() => {}} /></ThemeProvider></SafeAreaProvider>);

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

/**
 * The three seams Task 16 and Task 20 add to this screen, each of which was
 * declared, threaded through the props bag and read by nobody:
 *
 *  - the dictionary is CONSULTED for a row with no category (and never for one
 *    that has one);
 *  - a confirmation that writes a rule back offers to share it, through the
 *    consent screen whose exact wording the plan specifies;
 *  - the unparsed lane can report the layout (content-free) or open the
 *    donation sheet, which is where onboarding's donation invitation lands.
 */
function sources(over: { categories?: string[]; page?: ReviewItem[] } = {}) {
  const source: NonNullable<ReviewDeps["source"]> = {
    counts: async () => ({ needs_review: 1, unparsed: 1, duplicate: 0, forks: 0 }),
    page: async (lane) => (over.page !== undefined ? over.page.filter((i) => i.lane === lane) : lane === "needs_review" ? [parsed] : lane === "unparsed" ? [unparsed] : []),
    forks: async () => [],
    money: async () => ({ counted: 1, excluded: 0, totalHomeMinor: 1000n, awaitingRate: 0 }),
    categories: async () => over.categories ?? ["Groceries"],
    rules: async () => [],
    version: async () => 1,
    dismiss: async () => {},
    restore: async () => {},
  };
  const specs: OpSpec[] = [];
  const writer: NonNullable<ReviewDeps["writer"]> = { pending: [], enqueue: () => { throw new Error("unused"); }, enqueueMany: (s) => { specs.push(...s); return []; }, flush: async () => {} };
  return { source, writer, specs };
}

function mount(deps: ReviewDeps) {
  return render(
    <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } }}>
      <ThemeProvider>
        <ReviewScreen deps={deps} onClose={() => {}} />
      </ThemeProvider>
    </SafeAreaProvider>,
  );
}

it("starts an uncategorized card on the dictionary's answer, matched to an existing category's case", async () => {
  const s = sources({ categories: ["Groceries", "Dining"] });
  const asked: string[] = [];
  const dictionary: NonNullable<ReviewDeps["dictionary"]> = {
    submit: async () => {},
    categoryFor: (m) => { asked.push(m); return "groceries"; },
  };
  await mount({ source: s.source, writer: s.writer, raw: null, dictionary, samples: null, newID: () => "new" });
  await waitFor(() => expect(screen.getByText("Confirm")).toBeTruthy());
  await waitFor(() => expect(asked).toEqual(["SHOP"]));
  // "groceries" reconciled to the account's own "Groceries" rather than
  // forking the category list, and it is SELECTED, not merely offered.
  await waitFor(() => expect(screen.getByLabelText("Groceries").props.accessibilityState.selected).toBe(true));
});

it("never asks the dictionary about a row the user has already categorized", async () => {
  const decided: ReviewItem = { ...parsed, txn: { ...txn, category: "Dining" } };
  const s = sources({ categories: ["Groceries", "Dining"], page: [decided] });
  const asked: string[] = [];
  const dictionary: NonNullable<ReviewDeps["dictionary"]> = {
    submit: async () => {},
    categoryFor: (m) => { asked.push(m); return "groceries"; },
  };
  await mount({ source: s.source, writer: s.writer, raw: null, dictionary, samples: null, newID: () => "new" });
  await waitFor(() => expect(screen.getByText("Confirm")).toBeTruthy());
  await waitFor(() => expect(screen.getByLabelText("Dining").props.accessibilityState.selected).toBe(true));
  expect(asked).toEqual([]);
});

it("offers the dictionary opt-in for the rule a confirmation just wrote, and sends nothing until it is agreed to", async () => {
  const s = sources({ categories: ["Groceries"] });
  const submitted: unknown[] = [];
  const dictionary: NonNullable<ReviewDeps["dictionary"]> = {
    submit: async (e) => { submitted.push(e); },
    categoryFor: () => null,
  };
  await mount({ source: s.source, writer: s.writer, raw: null, dictionary, samples: null, newID: () => "rule-1" });
  await waitFor(() => expect(screen.getByText("Confirm")).toBeTruthy());
  await userEvent.press(screen.getByLabelText("Groceries"));
  await userEvent.press(screen.getByText("Confirm"));

  await waitFor(() => expect(screen.getByTestId("dictionary-consent-screen")).toBeTruthy());
  expect(s.specs.some((spec) => spec.type === "rule_added")).toBe(true);
  // Off by default: pressing share without the checkbox sends nothing.
  await userEvent.press(screen.getByText("Share entry"));
  expect(submitted).toEqual([]);
  await userEvent.press(screen.getByText("☐ I choose to share this entry"));
  await userEvent.press(screen.getByText("Share entry"));
  await waitFor(() => expect(submitted).toEqual([{ pattern: "shop", match: "exact", category: "Groceries" }]));
});

it("reports a layout content-free and opens the donation sheet from the unparsed lane", async () => {
  const s = sources();
  const reported: string[] = [];
  const previewed: string[] = [];
  const samples: NonNullable<ReviewDeps["samples"]> = {
    report: async (id) => { reported.push(id); },
    preview: async (id) => { previewed.push(id); return { bytes: new Uint8Array([1]), text: "RAW MESSAGE", ingestId: id }; },
    donate: async () => {},
  };
  await mount({ source: s.source, writer: s.writer, raw: null, dictionary: null, samples, newID: () => "new" });
  await waitFor(() => expect(screen.getByText("Confirm")).toBeTruthy());
  await userEvent.press(screen.getByText("Couldn't read 1"));
  await waitFor(() => expect(screen.getByTestId("unparsed-samples")).toBeTruthy());

  await userEvent.press(screen.getByText("Tell the operator this layout failed"));
  await waitFor(() => expect(reported).toEqual(["a".repeat(64)]));

  await userEvent.press(screen.getByText("Donate this email…"));
  await waitFor(() => expect(screen.getByTestId("donate-sheet")).toBeTruthy());
  await waitFor(() => expect(screen.getByText("RAW MESSAGE")).toBeTruthy());
  expect(previewed).toEqual(["a".repeat(64)]);
});

it("shows no sample affordance at all when the build has no sample lane", async () => {
  const s = sources();
  await mount({ source: s.source, writer: s.writer, raw: null, dictionary: null, samples: null, newID: () => "new" });
  await waitFor(() => expect(screen.getByText("Confirm")).toBeTruthy());
  await userEvent.press(screen.getByText("Couldn't read 1"));
  await waitFor(() => expect(screen.getByText("Type it in")).toBeTruthy());
  expect(screen.queryByTestId("unparsed-samples")).toBeNull();
});
