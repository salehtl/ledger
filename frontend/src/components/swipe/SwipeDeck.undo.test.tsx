import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, within, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Category, Txn } from "../../api/types";
import { SwipeDeck } from "./SwipeDeck";
import { ToastProvider } from "../Toast";

function txn(p: Partial<Txn>): Txn {
  return {
    ID: 1, PostedAt: "2026-07-03T10:00:00Z", AmountFils: 5000, AmountAedFils: 5000, Currency: "AED",
    Direction: "debit", MerchantRaw: "Carrefour", Status: "needs_review", Confidence: 1, Source: "email",
    CategoryID: null, CategoryName: "", Bucket: "", Kind: "", BucketSnapshot: "", RefundOfID: null,
    ...p,
  };
}

const CATS: Category[] = [
  { ID: 11, Name: "Dining", Kind: "spending", Bucket: "want", IsActive: true },
  { ID: 12, Name: "Groceries", Kind: "spending", Bucket: "need", IsActive: true },
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
    return new Response(JSON.stringify(respond(url, method)));
  });
  return calls;
}

function renderDeck(transactions: Txn[]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <SwipeDeck transactions={transactions} categories={CATS} />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

function swipe(card: Element, dx: number, dy: number) {
  fireEvent.pointerDown(card, { pointerId: 1, clientX: 200, clientY: 300 });
  fireEvent.pointerMove(card, { pointerId: 1, clientX: 200 + dx, clientY: 300 + dy });
  fireEvent.pointerUp(card, { pointerId: 1, clientX: 200 + dx, clientY: 300 + dy });
}

function card(): Element {
  return screen.getByTestId("swipe-card");
}

/** Finish the fly-out so the deck advances (jsdom fires no transition events,
 *  and its generic Event lacks propertyName — define it by hand). */
function completeExit(el: Element) {
  const ev = new Event("transitionend", { bubbles: true });
  Object.defineProperty(ev, "propertyName", { value: "opacity" });
  fireEvent(el, ev);
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

    const el = card();
    swipe(el, 0, -120); // up = transfer
    completeExit(el);

    expect(await screen.findByText(/marked as transfer/i)).toBeInTheDocument();
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

  it("categorize shows an undo toast; undo decategorizes and deletes the created rule", async () => {
    const calls = mockFetch((url) =>
      url.includes("/categorize") ? { ok: true, rule_id: 42 } : { ok: true },
    );
    renderDeck([txn({ ID: 7, MerchantRaw: "Nando's" })]);

    const el = card();
    swipe(el, -120, 0); // left = want

    // Panel opens; pick Dining
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Dining" }));
    completeExit(el);

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

    const el = card();
    swipe(el, -120, 0);
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(await within(dialog).findByRole("button", { name: /georgia trip/i }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Dining" }));
    completeExit(el);

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

    const el = card();
    swipe(el, 0, -120);
    completeExit(el);

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

  it("canceling the panel springs the card back to center", async () => {
    mockFetch((url) => (url.startsWith("/api/projects") ? [] : { ok: true }));
    renderDeck([txn({ ID: 7, MerchantRaw: "Hesitant purchase" })]);

    const el = card();
    swipe(el, -120, 0);
    await screen.findByRole("dialog");
    expect((el as HTMLElement).style.transform).toContain("translateX(-120px)");

    fireEvent.click(screen.getByTestId("dialog-scrim"));
    await waitFor(() =>
      expect((el as HTMLElement).style.transform).toContain("translateX(0px)"),
    );
  });

  it("undo after a newer commit does not clobber the deck", async () => {
    const calls = mockFetch();
    renderDeck([txn({ ID: 7, MerchantRaw: "First" }), txn({ ID: 8, MerchantRaw: "Second" })]);

    let el = card();
    swipe(el, 0, -120);
    completeExit(el);
    await screen.findByText(/marked as transfer/i);

    // Commit the second card too, then press the FIRST toast's undo
    el = card();
    swipe(el, 0, -120);
    completeExit(el);

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
});
