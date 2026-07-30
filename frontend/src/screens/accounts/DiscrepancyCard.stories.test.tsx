import "@/test/storybook";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { composeStories } from "@storybook/react-vite";
import * as stories from "./DiscrepancyCard.stories";

const { ShortWithReceipts, MoreThanExpected, CashOnly, AdjustPending } = composeStories(stories);

describe("DiscrepancyCard stories", () => {
  it("short: verdict, expected·stated meta, and the delta in the red register", () => {
    const { container } = render(<ShortWithReceipts />);
    expect(screen.getByText("Bank shows 180.00 less")).toBeInTheDocument();
    expect(screen.getByText(/expected 7,450\.00 · stated 7,270\.00 · 4 txns since Jul 25/)).toBeInTheDocument();
    expect(container.querySelector(".money-neg")!.textContent).toBe("(180.00)");
  });

  it("causes render in concreteness order: unparsed emails → fx → cash", () => {
    const { container } = render(<ShortWithReceipts />);
    const kinds = [...container.querySelectorAll("[data-cause]")].map((el) => el.getAttribute("data-cause"));
    expect(kinds).toEqual(["unparsed", "unparsed", "fx", "cash"]);
    expect(screen.getByText("Debit card purchase alert")).toBeInTheDocument();
    expect(screen.getByText(/no amount found/)).toBeInTheDocument();
    expect(screen.getByText(/1 foreign transaction await/)).toBeInTheDocument();
    expect(screen.getByText(/180\.00 may have left as cash/)).toBeInTheDocument();
  });

  it("one tap writes the delta off, verbatim in the label", () => {
    render(<ShortWithReceipts />);
    expect(screen.getByRole("button", { name: "Write 180.00 adjustment" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Keep for now" })).toBeInTheDocument();
  });

  it("surplus: cause copy flips to deposit/refund; no unparsed rows", () => {
    const { container } = render(<MoreThanExpected />);
    expect(screen.getByText("Bank shows 42.00 more")).toBeInTheDocument();
    expect(container.querySelectorAll('[data-cause="unparsed"]').length).toBe(0);
    expect(screen.getByText(/42\.00 may be a deposit or refund/)).toBeInTheDocument();
  });

  it("cash-only mismatch still explains itself — the causes list never renders blank", () => {
    const { container } = render(<CashOnly />);
    expect(container.querySelectorAll("[data-cause]").length).toBe(1);
    expect(screen.getByText("Cash or ATM movement")).toBeInTheDocument();
  });

  it("adjust pending disables the action and says so", () => {
    render(<AdjustPending />);
    const btn = screen.getByRole("button", { name: "Writing…" });
    expect(btn).toBeDisabled();
  });
});
