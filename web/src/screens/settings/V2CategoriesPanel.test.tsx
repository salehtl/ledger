import { describe, expect, it } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { CategoryDef } from "@ledger/client/replay/state";

import { V2CategoriesPanel } from "./V2CategoriesPanel";
import { deckCategories } from "../../v2/reviewDeck";
import type { Writer } from "../../v2/writer";

function recorder(): { writer: Writer; specs: { type: string; payload: unknown }[] } {
  const specs: { type: string; payload: unknown }[] = [];
  return {
    specs,
    writer: {
      pending: [],
      enqueueMany: (s) => void specs.push(...(s as { type: string; payload: unknown }[])),
      flush: async () => {},
    },
  };
}

const GYM: CategoryDef = { id: "c1", name: "Gym", kind: "spending", bucket: "need", color: null, active: true };

describe("V2CategoriesPanel", () => {
  it("defines a category that is born knowing its kind and bucket", async () => {
    const { writer, specs } = recorder();
    render(<V2CategoriesPanel defs={[]} writer={writer} newID={() => "c-new"} />);

    await userEvent.click(screen.getByRole("button", { name: /add to needs/i }));
    await userEvent.type(screen.getByLabelText(/new category in needs/i), "Gym");
    await userEvent.click(screen.getByRole("button", { name: /add gym/i }));

    expect(specs).toEqual([
      {
        type: "category_defined",
        payload: { id: "c-new", name: "Gym", kind: "spending", bucket: "need", color: null, active: true },
      },
    ]);
    // And that definition is what makes it selectable.
    expect(deckCategories([], [{ ...GYM, id: "c-new" }]).some((c) => c.Name === "Gym" && c.Bucket === "need")).toBe(true);
  });

  it("fires onFlushed only after the upload lands, so the caller can settle", async () => {
    const { writer } = recorder();
    let releaseFlush: () => void = () => undefined;
    writer.flush = () =>
      new Promise((resolve) => {
        releaseFlush = () => resolve(undefined);
      });
    const flushed: number[] = [];
    render(
      <V2CategoriesPanel
        defs={[]}
        writer={writer}
        newID={() => "c-new"}
        onFlushed={() => flushed.push(Date.now())}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: /add to needs/i }));
    await userEvent.type(screen.getByLabelText(/new category in needs/i), "Gym");
    await userEvent.click(screen.getByRole("button", { name: /add gym/i }));

    expect(flushed).toHaveLength(0);
    releaseFlush();
    await waitFor(() => expect(flushed).toHaveLength(1));
  });

  it("retires by re-defining, never by deleting", async () => {
    const { writer, specs } = recorder();
    render(<V2CategoriesPanel defs={[GYM]} writer={writer} />);

    const needs = screen.getByTestId("v2-category-section-need");
    await userEvent.click(within(needs).getByRole("button", { name: /retire/i }));
    expect(specs).toEqual([
      {
        type: "category_defined",
        payload: { id: "c1", name: "Gym", kind: "spending", bucket: "need", color: null, active: false },
      },
    ]);
  });

  it("lists retired categories and says what retiring did NOT do", async () => {
    const { writer, specs } = recorder();
    render(<V2CategoriesPanel defs={[{ ...GYM, active: false }]} writer={writer} />);

    const retired = screen.getByTestId("v2-category-section-retired");
    expect(within(retired).getByText("Gym")).toBeInTheDocument();
    // The claim has to be the true one: retiring stops it being offered and
    // changes nothing already filed.
    expect(screen.getByText(/keeps the name and keeps counting in the same bucket/i)).toBeInTheDocument();
    // And it is no longer offered by the picker.
    expect(deckCategories(["Gym"], [{ ...GYM, active: false }]).some((c) => c.Name === "Gym")).toBe(false);

    await userEvent.click(within(retired).getByRole("button", { name: /bring back/i }));
    expect(specs).toEqual([
      {
        type: "category_defined",
        payload: { id: "c1", name: "Gym", kind: "spending", bucket: "need", color: null, active: true },
      },
    ]);
  });

  it("offers no add control at all with nothing to append to", () => {
    // A control that answered and dropped the answer is worse than its absence.
    render(<V2CategoriesPanel defs={[GYM]} writer={null} />);
    expect(screen.queryByRole("button", { name: /add to needs/i })).toBeNull();
    expect(screen.getByText("Gym")).toBeInTheDocument();
  });
});
