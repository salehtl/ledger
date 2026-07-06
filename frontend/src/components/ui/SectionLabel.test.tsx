import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { SectionLabel } from "./SectionLabel";

it("renders the canonical eyebrow style", () => {
  render(<SectionLabel>Analyze by</SectionLabel>);
  const el = screen.getByText("Analyze by");
  expect(el.tagName).toBe("P");
  expect(el.className).toContain("uppercase");
  expect(el.className).toContain("tracking-[0.08em]");
});

it("can render as a heading or legend without losing the style", () => {
  render(<SectionLabel as="h2">Plan</SectionLabel>);
  expect(screen.getByRole("heading", { name: "Plan" }).className).toContain("uppercase");
});
