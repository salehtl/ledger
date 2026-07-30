import "@/test/storybook";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { composeStories } from "@storybook/react-vite";
import * as stories from "./MatchedTxnsSheet.stories";

const { Rows, CreditMatch, Empty, Loading, MissingSome } = composeStories(stories);

describe("MatchedTxnsSheet stories", () => {
  it("lists the matched transactions with category, date, and signed amount", () => {
    render(<Rows />);
    expect(screen.getAllByText("NETFLIX.COM AMSTERDAM")).toHaveLength(3);
    expect(screen.getByText("Subscriptions · Jul 7")).toBeInTheDocument();
    expect(screen.getAllByText("−56.00")).toHaveLength(2);
    expect(screen.getByText("−52.00")).toBeInTheDocument();
  });

  it("signs an inbound match with a plus", () => {
    render(<CreditMatch />);
    expect(screen.getByText("+26,500.00")).toBeInTheDocument();
    // No category resolves to the explicit fallback, never a blank meta line.
    expect(screen.getByText(/Uncategorized · Jul 25/)).toBeInTheDocument();
  });

  it("explains when the linked transactions are gone", () => {
    render(<Empty />);
    expect(screen.getByText("No matched transactions")).toBeInTheDocument();
    expect(screen.getByText("The linked transactions are no longer in the register.")).toBeInTheDocument();
  });

  it("shows a spinner while the register index loads", () => {
    render(<Loading />);
    expect(screen.getByRole("status", { name: "Loading matched transactions" })).toBeInTheDocument();
  });

  it("counts matches that fell out of the register", () => {
    render(<MissingSome />);
    expect(screen.getAllByText("NETFLIX.COM AMSTERDAM")).toHaveLength(2);
    expect(screen.getByText("1 more no longer in the register")).toBeInTheDocument();
  });
});
