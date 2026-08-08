/**
 * The filter strip's category dots, and the one thing they must agree with.
 *
 * A dot is a bucket claim. It has to come from the SAME layered mapping the
 * 50/30/20 read uses, or a category the user defined as a need is a need on
 * Home and a colourless "we don't know" here.
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import type { CategoryDef } from "@ledger/client/replay/state";

import { ProjectionFilterBar } from "./ProjectionFilterBar";
import { EMPTY_FILTERS } from "../../v2/sources/transactions";

const GYM: CategoryDef = { id: "c1", name: "Gym", kind: "spending", bucket: "need", color: null, active: true };

function chipDot(name: string): string | undefined {
  const chip = screen.getByRole("button", { name: new RegExp(`^${name}$`, "i") });
  const dot = chip.querySelector("span[aria-hidden]") as HTMLElement | null;
  return dot?.style.backgroundColor;
}

function mount(defs: readonly CategoryDef[]) {
  return render(
    <ProjectionFilterBar
      filters={EMPTY_FILTERS}
      facets={{ categories: ["Gym", "groceries", "Falconry"], currencies: ["AED"] }}
      categoryDefs={defs}
      open
      onChange={() => {}}
    />,
  );
}

describe("ProjectionFilterBar category dots", () => {
  it("colours a user-defined category by the bucket it was defined in", () => {
    mount([GYM]);
    expect(chipDot("Gym")).toBe("var(--color-need)");
  });

  it("with no definitions, the built-in table is still what colours a chip", () => {
    // Backwards compatibility: an account that has defined nothing sees exactly
    // what it saw before definitions existed.
    mount([]);
    expect(chipDot("groceries")).toBe("var(--color-need)");
    // And a name nothing maps carries no dot at all rather than a guessed hue.
    expect(chipDot("Falconry")).toBeUndefined();
  });

  it("keeps colouring a retired category, because its transactions still count", () => {
    // Retiring stops it being OFFERED. The rows already filed under it are
    // still in the ledger and still in their bucket, and this chip filters
    // exactly those rows.
    mount([{ ...GYM, active: false }]);
    expect(chipDot("Gym")).toBe("var(--color-need)");
  });
});
