import "@/test/storybook";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { composeStories } from "@storybook/react-vite";
import * as stories from "./SplitSheet.stories";

const { FreshDebit, EditingExistingSplit, CreditWithIncome, ForeignCurrencyParent } = composeStories(stories);

describe("SplitSheet stories", () => {
  it("fresh debit: bucket-grouped spending chips only, save disabled", () => {
    render(<FreshDebit />);
    expect(screen.getByText("Needs")).toBeInTheDocument();
    expect(screen.getByText("Wants")).toBeInTheDocument();
    expect(screen.getByText("Savings")).toBeInTheDocument();
    expect(screen.queryByText("Income")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Transfers" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save split" })).toBeDisabled();
  });

  it("existing split: lines prefilled, adds up exactly, remove offered", () => {
    render(<EditingExistingSplit />);
    expect(screen.getByLabelText("Amount for Groceries")).toHaveValue("75");
    expect(screen.getByLabelText("Note for Groceries")).toHaveValue("household");
    expect(screen.getByLabelText("Amount for Dining")).toHaveValue("45");
    expect(screen.getByText("Adds up exactly")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove Groceries" })).toBeInTheDocument();
  });

  it("credit parent: income joins the picker", () => {
    render(<CreditWithIncome />);
    expect(screen.getByText("Income")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Salary" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Transfers" })).not.toBeInTheDocument();
  });

  it("foreign parent: shares are stated in the parent's currency", () => {
    render(<ForeignCurrencyParent />);
    expect(screen.getAllByText(/USD 10\.09/).length).toBeGreaterThan(0);
  });
});
