import "@/test/storybook";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { composeStories } from "@storybook/react-vite";
import * as stories from "./Field.stories";

const { TextInput, SearchInput, SearchInputClearable, InsetInput, CategorySelect } = composeStories(stories);

describe("Field stories", () => {
  it("input is 16px text on a 44px control (iOS zoom guard)", () => {
    render(<TextInput />);
    const input = screen.getByPlaceholderText("Merchant contains…");
    expect(input.className).toContain("text-base");
  });
  it("icon variant pads for the leading glyph", () => {
    render(<SearchInput />);
    expect(screen.getByPlaceholderText("Search merchants…").className).toContain("pl-9");
  });
  it("clearable variant shows the Clear button while it has text", () => {
    render(<SearchInputClearable />);
    expect(screen.getByRole("button", { name: "Clear" })).toBeInTheDocument();
  });
  it("inset variant swaps to the dialog surface", () => {
    render(<InsetInput />);
    expect(screen.getByPlaceholderText("0.00").className).toContain("bg-surface-2");
  });
  it("select renders real options", () => {
    render(<CategorySelect />);
    expect(screen.getByRole("combobox")).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Groceries" })).toBeInTheDocument();
  });
});
