import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { Search } from "lucide-react";
import { Input, Select } from "./Field";

it("renders a 16px control (text-base) so iOS Safari doesn't zoom on focus", () => {
  render(<Input aria-label="Name" />);
  const el = screen.getByLabelText("Name");
  expect(el.className).toContain("text-base");
  expect(el.className).not.toContain("text-sm");
});

it("defaults to the surface background and switches to the inset surface on demand", () => {
  render(<Input aria-label="A" />);
  expect(screen.getByLabelText("A").className).toContain("bg-surface");
  render(<Input aria-label="B" inset />);
  expect(screen.getByLabelText("B").className).toContain("bg-surface-2");
});

it("renders a leading icon and pads the text clear of it", () => {
  render(<Input aria-label="Search" icon={Search} />);
  expect(screen.getByLabelText("Search").className).toContain("pl-9");
});

it("pads for text (no icon) instead", () => {
  render(<Input aria-label="Plain" />);
  expect(screen.getByLabelText("Plain").className).toContain("pl-3");
});

it("combines icon padding with the inset surface", () => {
  render(<Input aria-label="Inset Search" icon={Search} inset />);
  const el = screen.getByLabelText("Inset Search");
  expect(el.className).toContain("pl-9");
  expect(el.className).toContain("bg-surface-2");
});

it("spreads native props through (type, inputMode)", () => {
  render(<Input aria-label="Amount" type="number" inputMode="decimal" />);
  const el = screen.getByLabelText("Amount") as HTMLInputElement;
  expect(el.type).toBe("number");
  expect(el.inputMode).toBe("decimal");
});

it("Select keeps the 16px base and spreads props", () => {
  render(
    <Select aria-label="Kind" defaultValue="income">
      <option value="spending">spending</option>
      <option value="income">income</option>
    </Select>,
  );
  const el = screen.getByLabelText("Kind") as HTMLSelectElement;
  expect(el.className).toContain("text-base");
  expect(el.value).toBe("income");
});
