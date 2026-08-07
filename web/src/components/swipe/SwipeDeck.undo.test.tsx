import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, within, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Category, Txn } from "../../api/types";
import { DEFAULT_SWIPE_CONFIG, type SwipeDirection } from "../../lib/swipe";
import { SwipeDeck } from "./SwipeDeck";
import { ToastProvider } from "../Toast";
import { MotionProvider } from "../../app/MotionProvider";

function txn(p: Partial<Txn>): Txn {
  return {
    ID: 1, PostedAt: "2026-07-03T10:00:00Z", AmountFils: 5000, AmountAedFils: 5000, Currency: "AED",
    Direction: "debit", MerchantRaw: "Carrefour", Status: "needs_review", Confidence: 1, Source: "email",
    CategoryID: null, CategoryName: "", Bucket: "", Kind: "", BucketSnapshot: "", RefundOfID: null,
    ...p,
  };
}

const CATS: Category[] = [
  { ID: 11, Name: "Dining", Kind: "spending", Bucket: "want", IsActive: true, Color: "" },
  { ID: 12, Name: "Groceries", Kind: "spending", Bucket: "need", IsActive: true, Color: "" },
  { ID: 13, Name: "Transfers", Kind: "excluded", Bucket: "", IsActive: true, Color: "" },
  { ID: 14, Name: "Salary", Kind: "income", Bucket: "", IsActive: true, Color: "" },
];

interface Call { url: string; method: string; body: unknown; }

const last = <T,>(xs: T[]): T | undefined => xs[xs.length - 1];

/** Route-recording fetch mock; every route resolves with its configured JSON. */
function mockFetch(respond: (url: string, method: string) => unknown = () => ({ ok: true })) {
  const calls: Call[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : null });
    const payload = respond(url, method);
    return new Response(JSON.stringify(url.startsWith("/api/projects") && !Array.isArray(payload) ? [] : payload));
  });
  return calls;
}

function renderDeck(transactions: Txn[]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // MotionProvider, because the categorize panel is a Dialog: with no
  // LazyMotion ancestor its exit is inert, and "canceling springs the card
  // back" would be asserting against a sheet that never animated out.
  render(
    <MotionProvider>
      <QueryClientProvider client={qc}>
        <ToastProvider>
          <SwipeDeck transactions={transactions} categories={CATS} />
        </ToastProvider>
      </QueryClientProvider>
    </MotionProvider>,
  );
}

/**
 * Start a sort in `dir` by tapping that bucket's rail.
 *
 * Not a pointer-event swipe any more: the card is dragged by Framer now, and
 * jsdom cannot drive a Framer drag at all (no layout to measure, no frame
 * clock behind the pointer stream) — a fireEvent pointer stream would just
 * quietly do nothing and every assertion below would be testing an untouched
 * deck. The rail and the swipe funnel into the same `handleDirectionCommit`,
 * so the commit path these tests are about is identical; that the *gesture*
 * still reaches it is covered in harness/gestures.mjs, in a real engine.
 */
function commit(dir: SwipeDirection) {
  fireEvent.click(
    screen.getByRole("button", { name: new RegExp(`^${DEFAULT_SWIPE_CONFIG[dir].label} —`, "i") }),
  );
}

/** The card currently showing `merchant`, exiting or not. */
function cardFor(merchant: string): HTMLElement {
  const el = screen.getAllByTestId("swipe-card").find((c) => c.textContent?.includes(merchant));
  if (!el) throw new Error(`no swipe-card showing "${merchant}"`);
  return el as HTMLElement;
}

beforeEach(() => {
  // jsdom lacks pointer capture
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SwipeDeck undo", () => {
  it("transfer swipe shows an undo toast; undo restores the card and reverts status", async () => {
    const calls = mockFetch();
    renderDeck([txn({ ID: 7, MerchantRaw: "Own account top-up" }), txn({ ID: 8, MerchantRaw: "Next card" })]);

    commit("up"); // up = transfer
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Transfers" }));

    expect(await screen.findByText(/excluded as transfers/i)).toBeInTheDocument();
    const statusCall = calls.find((c) => c.url === "/api/transactions/7/status");
    expect(statusCall?.body).toEqual({ status: "transfer" });

    // Next card is up
    expect(screen.getByText("Next card")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /undo/i }));

    // Reverts to needs_review and the original card is back
    expect(await screen.findByText("Own account top-up")).toBeInTheDocument();
    const revert = last(calls.filter((c) => c.url === "/api/transactions/7/status"));
    expect(revert?.body).toEqual({ status: "needs_review" });
  });

  it("picking an income category on a transfer swipe confirms income, not transfer status", async () => {
    const calls = mockFetch();
    renderDeck([txn({ ID: 7, Direction: "credit", MerchantRaw: "ACME payroll" }), txn({ ID: 8, MerchantRaw: "Next card" })]);

    commit("up"); // up = transfer edge
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Salary" }));

    expect(await screen.findByText(/sorted into salary/i)).toBeInTheDocument();
    const cat = calls.find((c) => c.url === "/api/transactions/7/categorize");
    expect(cat?.body).toMatchObject({ category_id: 14 });
    // No transfer status was written
    expect(calls.some((c) => c.url === "/api/transactions/7/status")).toBe(false);

    // Undo just decategorizes — it must not touch status either
    fireEvent.click(screen.getByRole("button", { name: /undo/i }));
    expect(await screen.findByText("ACME payroll")).toBeInTheDocument();
    const decat = last(calls.filter((c) => c.url === "/api/transactions/7/categorize"));
    expect(decat?.body).toMatchObject({ category_id: null });
    expect(calls.some((c) => c.url === "/api/transactions/7/status")).toBe(false);
  });

  it("categorize shows an undo toast; undo decategorizes and deletes the created rule", async () => {
    const calls = mockFetch((url) =>
      url.includes("/categorize") ? { ok: true, rule_id: 42 } : { ok: true },
    );
    renderDeck([txn({ ID: 7, MerchantRaw: "Nando's" })]);

    commit("left"); // left = want

    // Panel opens; pick Dining
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Dining" }));

    expect(await screen.findByText(/sorted into dining/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /undo/i }));

    expect(await screen.findByText("Nando's")).toBeInTheDocument();
    const decat = last(calls.filter((c) => c.url === "/api/transactions/7/categorize"));
    expect(decat?.body).toMatchObject({ category_id: null });
    expect(calls.some((c) => c.url === "/api/rules/42" && c.method === "DELETE")).toBe(true);
  });

  it("assigns the chosen project after categorizing and unassigns on undo", async () => {
    const georgia = {
      id: 21, name: "Georgia trip", budget_fils: null, color: "#8b5cf6",
      starts_on: "2026-07-01", ends_on: "2026-07-20", status: "active", count_in_monthly: true,
      completed_at: "", net_spent_fils: 0, pending_fils: 0, txn_count: 0,
    };
    const calls = mockFetch((url) => {
      if (url.startsWith("/api/projects")) return [georgia];
      if (url.includes("/categorize")) return { ok: true };
      return { ok: true };
    });
    renderDeck([txn({ ID: 7, MerchantRaw: "Wine bar Tbilisi" })]);

    commit("left");
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(await within(dialog).findByRole("button", { name: /georgia trip/i }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Dining" }));

    await screen.findByText(/sorted into dining/i);
    const assign = calls.find((c) => c.url === "/api/transactions/7/project");
    expect(assign?.body).toEqual({ project_id: 21 });

    fireEvent.click(screen.getByRole("button", { name: /undo/i }));
    expect(await screen.findByText("Wine bar Tbilisi")).toBeInTheDocument();
    const unassign = last(calls.filter((c) => c.url === "/api/transactions/7/project"));
    expect(unassign?.body).toEqual({ project_id: null });
  });

  it("failed save shows an error toast and puts the card back", async () => {
    const calls: Call[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      calls.push({ url: String(input), method: init?.method ?? "GET", body: null });
      return new Response(JSON.stringify({ error: "db error" }), { status: 500 });
    });
    renderDeck([txn({ ID: 7, MerchantRaw: "Flaky Cafe" })]);

    commit("up");
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Transfers" }));

    expect(await screen.findByText(/couldn't save/i)).toBeInTheDocument();
    expect(screen.getByText("Flaky Cafe")).toBeInTheDocument();
  });

  it("skip button moves to the next card without touching the server", () => {
    const calls = mockFetch((url) => (url.startsWith("/api/projects") ? [] : { ok: true }));
    renderDeck([txn({ ID: 7, MerchantRaw: "Mystery charge" }), txn({ ID: 8, MerchantRaw: "Next card" })]);

    fireEvent.click(screen.getByRole("button", { name: /skip/i }));

    expect(screen.getByText("Next card")).toBeInTheDocument();
    expect(calls.filter((c) => c.method !== "GET")).toHaveLength(0);
  });

  it("canceling the panel leaves the same card at the front of the deck", async () => {
    mockFetch((url) => (url.startsWith("/api/projects") ? [] : { ok: true }));
    renderDeck([txn({ ID: 7, MerchantRaw: "Hesitant purchase" }), txn({ ID: 8, MerchantRaw: "Next card" })]);

    commit("left");
    await screen.findByRole("dialog");

    fireEvent.click(screen.getByTestId("dialog-scrim"));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    // Nothing was committed, so the deck must not have moved on. (There is no
    // snap-back to assert any more: `dragSnapToOrigin` returns the card to
    // centre when the pointer lifts, which is why `resetToken` is gone.)
    expect(screen.getByText("Hesitant purchase")).toBeInTheDocument();
    expect(screen.queryByText("Next card")).not.toBeInTheDocument();
  });

  it("undo after a newer commit does not clobber the deck", async () => {
    const calls = mockFetch();
    renderDeck([txn({ ID: 7, MerchantRaw: "First" }), txn({ ID: 8, MerchantRaw: "Second" })]);

    commit("up");
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Transfers" }));
    await screen.findByText(/excluded as transfers/i);

    // Commit the second card too, then press the FIRST toast's undo
    commit("up");
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Transfers" }));

    const undoButtons = await screen.findAllByRole("button", { name: /undo/i });
    fireEvent.click(undoButtons[0]);

    expect(await screen.findByText(/too late to undo/i)).toBeInTheDocument();
    // No revert was issued for the first transaction
    const reverts = calls.filter(
      (c) => c.url === "/api/transactions/7/status" && c.body !== null
        && (c.body as { status: string }).status === "needs_review",
    );
    expect(reverts).toHaveLength(0);
  });
  // ---- the overlap, and the two-render ordering that makes it directional ----

  it("puts the next card in place before the committed one has finished leaving", async () => {
    mockFetch();
    renderDeck([txn({ ID: 7, MerchantRaw: "Own account top-up" }), txn({ ID: 8, MerchantRaw: "Next card" })]);

    commit("up");
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Transfers" }));

    // No transitionend was fired and none is waited for: the deck used to
    // advance only in handleExitComplete, which cost 300ms exit + 320ms enter
    // serially. Both cards are on screen at once now.
    expect(screen.getAllByTestId("swipe-card")).toHaveLength(2);
    expect(screen.getByText("Next card")).toBeInTheDocument();
  });

  it("the leaving card still knows which bucket it committed to", async () => {
    mockFetch();
    renderDeck([txn({ ID: 7, MerchantRaw: "Own account top-up" }), txn({ ID: 8, MerchantRaw: "Next card" })]);

    commit("up");
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Transfers" }));

    // AnimatePresence animates a child out as it was LAST RENDERED. If
    // `flyDirection` and `index` were set in one batched setState, the
    // outgoing card's final render would be the one where `flying` was still
    // null — it would fade straight down instead of flying toward its bucket,
    // and the directional exit the deck is built around would be dead code
    // that still looked plausible. The confirming badge is only rendered on a
    // card that knew its direction, so its presence inside the *leaving* card
    // is the observable proof that the snapshot carried it.
    const leaving = cardFor("Own account top-up");
    expect(within(leaving).getByText(DEFAULT_SWIPE_CONFIG.up.label)).toBeInTheDocument();
  });
});
