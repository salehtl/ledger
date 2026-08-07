import { render, screen } from "@testing-library/react";
import { Pill } from "./Pill";

test("attention is the only tone that spends the spot ink", () => {
  render(<Pill tone="attention">Needs review</Pill>);
  expect(screen.getByText("Needs review").className).toContain("bg-accent");
});

test("default and muted print in ink only", () => {
  render(<><Pill>Cleared</Pill><Pill tone="muted">Archived</Pill></>);
  expect(screen.getByText("Cleared").className).not.toContain("accent");
  expect(screen.getByText("Archived").className).toContain("text-muted");
});
