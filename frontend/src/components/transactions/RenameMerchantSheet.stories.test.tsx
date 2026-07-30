import "@/test/storybook";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { composeStories } from "@storybook/react-vite";
import * as stories from "./RenameMerchantSheet.stories";

const { WithMatchingRule, ExistingName, NoRuleYet, Blocked } = composeStories(stories);

describe("RenameMerchantSheet stories", () => {
  it("matching rule: raw provenance + honest reach line", () => {
    render(<WithMatchingRule />);
    expect(screen.getByText("NETFLIX.COM 866-579-7172 NL")).toBeInTheDocument();
    expect(screen.getByText(/applies to 3 transactions from this merchant/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled(); // nothing typed yet
  });

  it("existing name: prefilled, save stays closed until it changes", () => {
    render(<ExistingName />);
    expect(screen.getByLabelText(/shown as/i)).toHaveValue("Netflix");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("no rule yet: the sheet still offers the rename (write-back path)", () => {
    render(<NoRuleYet />);
    expect(screen.getByLabelText(/shown as/i)).toBeInTheDocument();
    expect(screen.queryByText(/categorize it first/i)).not.toBeInTheDocument();
  });

  it("blocked: calm explanation, no input, save disabled", () => {
    render(<Blocked />);
    expect(screen.getByText(/categorize it first/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/shown as/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });
});
