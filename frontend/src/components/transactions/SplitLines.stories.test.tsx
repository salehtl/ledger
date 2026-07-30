import "@/test/storybook";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { composeStories } from "@storybook/react-vite";
import * as stories from "./SplitLines.stories";

const { TwoWay, CreditWithIncomeLine, ForeignParent, WithoutCategoryLookup } = composeStories(stories);

describe("SplitLines stories", () => {
  it("two-way: names, note, and column amounts", () => {
    render(<TwoWay />);
    expect(screen.getByText("Groceries")).toBeInTheDocument();
    expect(screen.getByText("Dining")).toBeInTheDocument();
    expect(screen.getByText("household")).toBeInTheDocument();
    expect(screen.getByText("75.00")).toBeInTheDocument();
    expect(screen.getByText("45.00")).toBeInTheDocument();
  });

  it("credit: an income line rides beside a spending refund line", () => {
    render(<CreditWithIncomeLine />);
    expect(screen.getByText("Salary")).toBeInTheDocument();
    expect(screen.getByText("5,000.00")).toBeInTheDocument();
    expect(screen.getByText("refunded delivery")).toBeInTheDocument();
  });

  it("foreign parent: amounts carry the parent currency", () => {
    render(<ForeignParent />);
    expect(screen.getByText("USD 7.00")).toBeInTheDocument();
    expect(screen.getByText("USD 3.09")).toBeInTheDocument();
  });

  it("without a lookup the amounts still stand, names fall back", () => {
    render(<WithoutCategoryLookup />);
    expect(screen.getAllByText("—")).toHaveLength(2);
    expect(screen.getByText("75.00")).toBeInTheDocument();
  });
});
