import "@/test/storybook";
import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { composeStories } from "@storybook/react-vite";
import * as stories from "./BalanceField.stories";

const { Default, WithHelper, ParseError, NegativeSign } = composeStories(stories);

describe("BalanceField stories", () => {
  it("default: persistent label, decimal keyboard, sign toggle group", () => {
    render(<Default />);
    const input = screen.getByLabelText("Balance in your bank app");
    expect(input.getAttribute("inputmode")).toBe("decimal");
    expect(input.getAttribute("placeholder")).toBe("0.00");
    const group = screen.getByRole("group", { name: "Balance sign" });
    expect(within(group).getByRole("button", { name: "+" })).toBeInTheDocument();
    expect(within(group).getByRole("button", { name: "−" })).toBeInTheDocument();
  });

  it("helper: mono meta line under the field", () => {
    render(<WithHelper />);
    expect(screen.getByText("expected 7,450.00 · last check-in 4d ago")).toBeInTheDocument();
  });

  it("error: alert next to the field, input preserved, helper yields", () => {
    render(<ParseError />);
    expect(screen.getByRole("alert").textContent).toBe("Enter an amount like 8,250.00.");
    expect((screen.getByLabelText("Balance in your bank app") as HTMLInputElement).value).toBe("8250.555");
    expect(screen.queryByText("expected 7,450.00 · last check-in 4d ago")).toBeNull();
  });

  it("negative sign: the − segment is pressed", () => {
    render(<NegativeSign />);
    const group = screen.getByRole("group", { name: "Balance sign" });
    expect(within(group).getByRole("button", { name: "−" }).getAttribute("aria-pressed")).toBe("true");
    expect(within(group).getByRole("button", { name: "+" }).getAttribute("aria-pressed")).toBe("false");
  });
});
