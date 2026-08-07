import "@/test/storybook";
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { composeStories } from "@storybook/react-vite";
import * as stories from "./Toast.stories";

const { SuccessWithUndo, ErrorTone } = composeStories(stories);

describe("Toast stories", () => {
  it("shows a success toast with an undo action on demand", () => {
    render(<SuccessWithUndo />);
    fireEvent.click(screen.getByRole("button", { name: "Save rule" }));
    expect(screen.getByText("Rule saved — CARREFOUR → Groceries")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Undo" })).toBeInTheDocument();
  });
  it("error tone is one of the sanctioned full-opacity red uses", () => {
    render(<ErrorTone />);
    fireEvent.click(screen.getByRole("button", { name: "Fail to save" }));
    expect(screen.getByText("Couldn't save — try again")).toBeInTheDocument();
  });
});
