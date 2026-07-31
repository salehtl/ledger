import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "../components/Toast";
import { CategoryManager } from "./CategoryManager";
import { MotionProvider } from "../app/MotionProvider";
import { PALETTE_NAMES, PALETTE_DISPLAY_ORDER } from "../lib/paletteColor";

const CATS = [
  { ID: 1, Name: "Groceries", Kind: "spending", Bucket: "need", IsActive: true },
  { ID: 2, Name: "Salary", Kind: "income", Bucket: "", IsActive: true },
  { ID: 3, Name: "Dining", Kind: "spending", Bucket: "want", IsActive: true },
];

type Usage = { transactions: number; rules: number; assignments?: number; targets?: number };

function mockFetch(usage: Record<number, Usage>, overrides?: (url: string, init?: RequestInit) => Response | null) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);

    // Allow caller to intercept specific requests
    if (overrides) {
      const result = overrides(u, init);
      if (result !== null) return result;
    }

    const usageMatch = u.match(/\/api\/categories\/(\d+)\/usage$/);
    if (usageMatch) {
      const id = Number(usageMatch[1]);
      // Mirrors the server: every count is always present in the payload.
      const u = usage[id] ?? { transactions: 0, rules: 0 };
      return new Response(JSON.stringify({ assignments: 0, targets: 0, ...u }));
    }
    if (u === "/api/categories" && (!init || init.method === undefined || init.method === "GET")) {
      return new Response(JSON.stringify(CATS));
    }
    // POST/PUT/DELETE
    return new Response(JSON.stringify({ ok: true }));
  });
}

function wrap() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MotionProvider><QueryClientProvider client={qc}><ToastProvider><CategoryManager onClose={() => {}} /></ToastProvider></QueryClientProvider></MotionProvider>,
  );
}

const USAGE = { 1: { transactions: 3, rules: 1 }, 2: { transactions: 0, rules: 0 }, 3: { transactions: 0, rules: 0 } };

describe("CategoryManager", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", mockFetch(USAGE));
  });

  it("renders one section per bucket plus income and excluded", async () => {
    wrap();
    expect(await screen.findByText("Groceries")).toBeInTheDocument();
    const needs = screen.getByTestId("section-need");
    expect(within(needs).getByText("Needs")).toBeInTheDocument();
    expect(within(needs).getByText("Groceries")).toBeInTheDocument();
    expect(within(screen.getByTestId("section-want")).getByText("Dining")).toBeInTheDocument();
    expect(within(screen.getByTestId("section-income")).getByText("Salary")).toBeInTheDocument();
    // Rows are calm text, not form fields
    expect(screen.queryByLabelText("Rename Groceries")).not.toBeInTheDocument();
  });

  it("overlay has a solid theme background, not a broken CSS-var class (regression)", async () => {
    const { container } = wrap();
    await screen.findByText("Groceries");
    const overlay = container.firstChild as HTMLElement;
    expect(overlay.className).toContain("fixed");
    expect(overlay.className).toContain("bg-bg");
    expect(overlay.className).not.toMatch(/bg-\[--/);
  });

  it("shows compact usage on in-use rows and stays quiet on unused ones", async () => {
    wrap();
    expect(await screen.findByText(/3 txns · 1 rule/i)).toBeInTheDocument();
    expect(screen.queryByText(/unused/i)).not.toBeInTheDocument();
  });

  it("tapping a name edits it in place; Enter saves", async () => {
    const fetchMock = mockFetch(USAGE);
    vi.stubGlobal("fetch", fetchMock);
    wrap();
    fireEvent.click(await screen.findByRole("button", { name: /edit groceries/i }));
    const input = screen.getByLabelText("Rename Groceries");
    fireEvent.change(input, { target: { value: "Food & Groceries" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => {
      const call = fetchMock.mock.calls.find((c) => c[0] === "/api/categories/1" && c[1]?.method === "PUT");
      expect(call).toBeTruthy();
      expect(JSON.parse(String(call![1]!.body))).toMatchObject({ name: "Food & Groceries", bucket: "need" });
    });
  });

  it("Escape cancels an in-place edit without saving", async () => {
    const fetchMock = mockFetch(USAGE);
    vi.stubGlobal("fetch", fetchMock);
    wrap();
    fireEvent.click(await screen.findByRole("button", { name: /edit groceries/i }));
    const input = screen.getByLabelText("Rename Groceries");
    fireEvent.change(input, { target: { value: "Oops" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByLabelText("Rename Groceries")).not.toBeInTheDocument();
    expect(screen.getByText("Groceries")).toBeInTheDocument();
    expect(fetchMock.mock.calls.some((c) => c[1]?.method === "PUT")).toBe(false);
  });

  it("while editing, bucket dots move the category in one tap", async () => {
    const fetchMock = mockFetch(USAGE);
    vi.stubGlobal("fetch", fetchMock);
    wrap();
    fireEvent.click(await screen.findByRole("button", { name: /edit groceries/i }));
    fireEvent.click(screen.getByRole("button", { name: /move to wants/i }));
    await waitFor(() => {
      const call = fetchMock.mock.calls.find((c) => c[0] === "/api/categories/1" && c[1]?.method === "PUT");
      expect(call).toBeTruthy();
      expect(JSON.parse(String(call![1]!.body))).toMatchObject({ bucket: "want" });
    });
  });

  it("delete is always visible: disabled with the reason while in use, live otherwise", async () => {
    const fetchMock = mockFetch(USAGE);
    vi.stubGlobal("fetch", fetchMock);
    wrap();
    const guarded = await screen.findByRole("button", { name: /groceries in use/i });
    expect(guarded).toBeDisabled();
    const live = await screen.findByRole("button", { name: "Delete Salary" });
    expect(live).not.toBeDisabled();
    fireEvent.click(live);
    await waitFor(() => {
      expect(fetchMock.mock.calls.some((c) => c[0] === "/api/categories/2" && c[1]?.method === "DELETE")).toBe(true);
    });
  });

  it("a category held only by a target or an assignment is guarded, and says which", async () => {
    // Both cascade on delete, so the server 409s on them; the button has to
    // agree, or the only way to find out is a failed tap.
    vi.stubGlobal("fetch", mockFetch({
      1: { transactions: 0, rules: 0, assignments: 0, targets: 1 },
      2: { transactions: 0, rules: 0, assignments: 2, targets: 0 },
      3: { transactions: 0, rules: 0, assignments: 0, targets: 0 },
    }));
    wrap();
    expect(await screen.findByRole("button", { name: /groceries in use/i })).toBeDisabled();
    expect(await screen.findByRole("button", { name: /salary in use/i })).toBeDisabled();
    expect(screen.getByText("target")).toBeInTheDocument();
    expect(screen.getByText("2 assigned")).toBeInTheDocument();
    // The genuinely unused one stays live.
    expect(await screen.findByRole("button", { name: "Delete Dining" })).not.toBeDisabled();
  });

  it("names only the reasons it has to — a row with transactions doesn't list its target too", async () => {
    // The meta label shares one row with the category name. Spelling out every
    // reason made "48 txns · 1 rule · 1 assigned · target" and truncated
    // Groceries down to "G", so it stops once the block is already explained.
    vi.stubGlobal("fetch", mockFetch({
      1: { transactions: 48, rules: 1, assignments: 1, targets: 1 },
      2: { transactions: 0, rules: 0, assignments: 1, targets: 1 },
      3: { transactions: 0, rules: 0, assignments: 0, targets: 0 },
    }));
    wrap();
    expect(await screen.findByText("48 txns · 1 rule")).toBeInTheDocument();
    expect(screen.queryByText(/48 txns · 1 rule · /)).not.toBeInTheDocument();
    // With nothing louder to say, the cascade-only reasons still speak.
    expect(screen.getByText("1 assigned · target")).toBeInTheDocument();
    // The genuinely unused one stays live.
    expect(await screen.findByRole("button", { name: "Delete Dining" })).not.toBeDisabled();
  });

  it("delete offers Undo, which recreates the category with its kind and bucket", async () => {
    const fetchMock = mockFetch(USAGE);
    vi.stubGlobal("fetch", fetchMock);
    wrap();
    fireEvent.click(await screen.findByRole("button", { name: "Delete Dining" }));
    const undo = await screen.findByRole("button", { name: "Undo" });
    fireEvent.click(undo);
    await waitFor(() => {
      const call = fetchMock.mock.calls.find((c) => c[0] === "/api/categories" && c[1]?.method === "POST");
      expect(call).toBeTruthy();
      expect(JSON.parse(String(call![1]!.body))).toMatchObject({ name: "Dining", kind: "spending", bucket: "want" });
    });
  });

  it("section-header + adds a new category in place with kind and bucket inferred", async () => {
    const fetchMock = mockFetch(USAGE);
    vi.stubGlobal("fetch", fetchMock);
    wrap();
    await screen.findByText("Groceries");
    fireEvent.click(screen.getByRole("button", { name: /add to wants/i }));
    const input = screen.getByLabelText("New category in Wants");
    fireEvent.change(input, { target: { value: "Hobbies" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => {
      const call = fetchMock.mock.calls.find((c) => c[0] === "/api/categories" && c[1]?.method === "POST");
      expect(call).toBeTruthy();
      expect(JSON.parse(String(call![1]!.body))).toMatchObject({ name: "Hobbies", kind: "spending", bucket: "want" });
    });
  });

  it("adding under Income infers the income kind with no bucket", async () => {
    const fetchMock = mockFetch(USAGE);
    vi.stubGlobal("fetch", fetchMock);
    wrap();
    await screen.findByText("Groceries");
    fireEvent.click(screen.getByRole("button", { name: /add to income/i }));
    const input = screen.getByLabelText("New category in Income");
    fireEvent.change(input, { target: { value: "Dividends" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => {
      const call = fetchMock.mock.calls.find((c) => c[0] === "/api/categories" && c[1]?.method === "POST");
      expect(call).toBeTruthy();
      expect(JSON.parse(String(call![1]!.body))).toMatchObject({ name: "Dividends", kind: "income", bucket: "" });
    });
  });

  it("Escape abandons an inline add without posting", async () => {
    const fetchMock = mockFetch(USAGE);
    vi.stubGlobal("fetch", fetchMock);
    wrap();
    await screen.findByText("Groceries");
    fireEvent.click(screen.getByRole("button", { name: /add to needs/i }));
    const input = screen.getByLabelText("New category in Needs");
    fireEvent.change(input, { target: { value: "Nope" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByLabelText("New category in Needs")).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.some((c) => c[1]?.method === "POST")).toBe(false);
  });

  it("filters categories by name", async () => {
    wrap();
    await screen.findByText("Groceries");
    fireEvent.change(screen.getByRole("searchbox", { name: /search categories/i }), { target: { value: "salary" } });
    expect(screen.getByText("Salary")).toBeInTheDocument();
    expect(screen.queryByText("Groceries")).not.toBeInTheDocument();
  });

  it("each row's dot carries the category's own colour, not its bucket", async () => {
    // Groceries and Dining share the "need"/"want" spending kind but get
    // distinct stored colours here — proving the row reads cat.Color, not
    // bucketColor(cat.Bucket) (which would tie both to their bucket's hue
    // regardless of what's stored).
    vi.stubGlobal("fetch", mockFetch(USAGE, (url) => {
      if (url === "/api/categories") {
        return new Response(JSON.stringify([
          { ...CATS[0], Color: "teal" },
          CATS[1],
          { ...CATS[2], Color: "orchid" },
        ]));
      }
      return null;
    }));
    wrap();
    const groceries = await screen.findByRole("button", { name: /edit groceries/i });
    const dining = screen.getByRole("button", { name: /edit dining/i });
    expect((groceries.querySelector("span[aria-hidden]") as HTMLElement).style.backgroundColor).toBe("var(--color-teal)");
    expect((dining.querySelector("span[aria-hidden]") as HTMLElement).style.backgroundColor).toBe("var(--color-orchid)");
  });

  describe("colour picker", () => {
    const withColors = () => mockFetch(USAGE, (url) => {
      if (url === "/api/categories") {
        return new Response(JSON.stringify([{ ...CATS[0], Color: "teal" }, CATS[1], CATS[2]]));
      }
      return null;
    });

    it("offers every palette name, and only while the row is being edited", async () => {
      vi.stubGlobal("fetch", withColors());
      const { container } = wrap();
      // Collapsed rows are calm text — a wall of swatches on every row would
      // make the list unreadable.
      await screen.findByRole("button", { name: /edit groceries/i });
      expect(container.querySelector("[data-color-picker]")).toBeNull();

      fireEvent.click(screen.getByRole("button", { name: /edit groceries/i }));
      const picker = container.querySelector("[data-color-picker]") as HTMLElement;
      expect(picker).toBeTruthy();
      expect(picker.querySelectorAll("button")).toHaveLength(PALETTE_NAMES.length);
      // Every name reachable: a colour the backfill can assign but the user
      // cannot pick would be a colour they can never get rid of.
      for (const name of PALETTE_NAMES) {
        expect(within(picker).getByRole("button", { name })).toBeInTheDocument();
      }
    });

    it("lays the swatches out in hue order, not the array's append order", async () => {
      // The ordering is the only user-visible reason PALETTE_DISPLAY_ORDER
      // exists. Asserting the *set* (above) passes just as happily on append
      // order, so reverting to `PALETTE_NAMES.map` here would otherwise be
      // invisible to the whole suite.
      vi.stubGlobal("fetch", withColors());
      const { container } = wrap();
      fireEvent.click(await screen.findByRole("button", { name: /edit groceries/i }));
      const picker = container.querySelector("[data-color-picker]") as HTMLElement;
      const rendered = [...picker.querySelectorAll("button")].map((b) => b.getAttribute("aria-label"));
      expect(rendered).toEqual([...PALETTE_DISPLAY_ORDER]);
      expect(rendered).not.toEqual([...PALETTE_NAMES]);
    });

    it("marks the category's current colour as the pressed swatch", async () => {
      vi.stubGlobal("fetch", withColors());
      wrap();
      fireEvent.click(await screen.findByRole("button", { name: /edit groceries/i }));
      expect(screen.getByRole("button", { name: "teal" })).toHaveAttribute("aria-pressed", "true");
      expect(screen.getByRole("button", { name: "rose" })).toHaveAttribute("aria-pressed", "false");
    });

    it("picking a colour PUTs it with the name and bucket, and keeps the picker open", async () => {
      const fetchMock = withColors();
      vi.stubGlobal("fetch", fetchMock);
      const { container } = wrap();
      fireEvent.click(await screen.findByRole("button", { name: /edit groceries/i }));
      fireEvent.click(screen.getByRole("button", { name: "orchid" }));
      await waitFor(() => {
        const call = fetchMock.mock.calls.find((c) => c[0] === "/api/categories/1" && c[1]?.method === "PUT");
        expect(call).toBeTruthy();
        // Name and bucket ride along — the server takes a whole category, so
        // omitting them would blank the row it was meant to recolour.
        expect(JSON.parse(String(call![1]!.body))).toMatchObject({
          name: "Groceries", bucket: "need", kind: "spending", color: "orchid",
        });
      });
      // Choosing a colour means trying two or three; the editor stays put.
      expect(container.querySelector("[data-color-picker]")).toBeTruthy();
      expect(screen.getByRole("button", { name: "orchid" })).toHaveAttribute("aria-pressed", "true");
    });

    it("does not commit a half-typed rename when you tap a swatch", async () => {
      // The path nothing covered. pickColor is silent and leaves the editor
      // open, so if it carried the draft the way `move` does, typing "Foo" and
      // then tapping a colour would rename the category on the server with no
      // toast, no editor close, and nothing on screen saying it happened.
      const fetchMock = withColors();
      vi.stubGlobal("fetch", fetchMock);
      wrap();
      fireEvent.click(await screen.findByRole("button", { name: /edit groceries/i }));
      fireEvent.change(screen.getByLabelText("Rename Groceries"), { target: { value: "Foo" } });
      fireEvent.click(screen.getByRole("button", { name: "orchid" }));
      await waitFor(() => {
        const call = fetchMock.mock.calls.find((c) => c[0] === "/api/categories/1" && c[1]?.method === "PUT");
        expect(call).toBeTruthy();
        expect(JSON.parse(String(call![1]!.body))).toMatchObject({ name: "Groceries", color: "orchid" });
      });

      // ...and Escape still means Escape. cancelEdit only resets local state,
      // so a rename smuggled out by the swatch tap would already be on the
      // server and this row would come back as "Foo".
      fireEvent.keyDown(screen.getByLabelText("Rename Groceries"), { key: "Escape" });
      expect(await screen.findByText("Groceries")).toBeInTheDocument();
      expect(screen.queryByText("Foo")).not.toBeInTheDocument();
      const renames = fetchMock.mock.calls.filter(
        (c) => c[0] === "/api/categories/1" && c[1]?.method === "PUT" && JSON.parse(String(c[1]!.body)).name === "Foo",
      );
      expect(renames).toHaveLength(0);
    });

    it("renaming a coloured category carries its colour through, not a blank", async () => {
      // The PUT is whole-category. A rename that dropped `color` would rely on
      // the server's empty-means-leave-alone branch; sending it keeps the two
      // sides from having to agree about that.
      const fetchMock = withColors();
      vi.stubGlobal("fetch", fetchMock);
      wrap();
      fireEvent.click(await screen.findByRole("button", { name: /edit groceries/i }));
      const input = screen.getByLabelText("Rename Groceries");
      fireEvent.change(input, { target: { value: "Food" } });
      fireEvent.keyDown(input, { key: "Enter" });
      await waitFor(() => {
        const call = fetchMock.mock.calls.find((c) => c[0] === "/api/categories/1" && c[1]?.method === "PUT");
        expect(JSON.parse(String(call![1]!.body))).toMatchObject({ name: "Food", color: "teal" });
      });
    });

    it("rolls the swatch back and says so when the PUT fails", async () => {
      vi.stubGlobal("fetch", mockFetch(USAGE, (url, init) => {
        if (url === "/api/categories") {
          return new Response(JSON.stringify([{ ...CATS[0], Color: "teal" }, CATS[1], CATS[2]]));
        }
        if (url === "/api/categories/1" && init?.method === "PUT") {
          return new Response(JSON.stringify({ error: "nope" }), { status: 500 });
        }
        return null;
      }));
      wrap();
      fireEvent.click(await screen.findByRole("button", { name: /edit groceries/i }));
      fireEvent.click(screen.getByRole("button", { name: "orchid" }));
      await waitFor(() => expect(screen.getByText("Couldn't change colour")).toBeInTheDocument());
      // Back where it was: an optimistic swatch that stuck would tell the user
      // a colour was saved that the server never took.
      expect(screen.getByRole("button", { name: "teal" })).toHaveAttribute("aria-pressed", "true");
      expect(screen.getByRole("button", { name: "orchid" })).toHaveAttribute("aria-pressed", "false");
    });
  });

  it("rename with duplicate name shows friendly toast", async () => {
    const fetchMock = mockFetch(USAGE, (url, init) => {
      if (url === "/api/categories/1" && init?.method === "PUT") {
        return new Response(JSON.stringify({ error: "name exists" }), { status: 409 });
      }
      return null;
    });
    vi.stubGlobal("fetch", fetchMock);
    wrap();
    fireEvent.click(await screen.findByRole("button", { name: /edit groceries/i }));
    const input = screen.getByLabelText("Rename Groceries");
    fireEvent.change(input, { target: { value: "Salary" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => {
      expect(screen.getByText("A category with that name already exists.")).toBeInTheDocument();
    });
  });
});
