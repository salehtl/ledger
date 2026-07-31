import "@/test/storybook";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { composeStories } from "@storybook/react-vite";
import * as stories from "./AccountRow.stories";

const { CheckedIn, CreditCard, NeverCheckedIn, Tracking, ZeroBalance } = composeStories(stories);

describe("AccountRow stories", () => {
  it("checked-in: live balance, bank · last4, anchor freshness with txn window", () => {
    const { container } = render(<CheckedIn />);
    expect(container.querySelector("[data-checkin]")!.getAttribute("data-checkin")).toBe("anchored");
    expect(screen.getByText("7,450.00")).toBeInTheDocument();
    expect(screen.getByText(/Emirates NBD · •••• 3921/)).toBeInTheDocument();
    expect(screen.getByText("checked in 4d ago · 2 txns since")).toBeInTheDocument();
  });

  it("credit card: negative balance prints the accounting-parens red register", () => {
    const { container } = render(<CreditCard />);
    const neg = container.querySelector(".money-neg");
    expect(neg).not.toBeNull();
    expect(neg!.textContent).toBe("(1,230.00)");
  });

  it("never checked in: em dash instead of a fake zero, and says so", () => {
    const { container } = render(<NeverCheckedIn />);
    expect(container.querySelector("[data-checkin]")!.getAttribute("data-checkin")).toBe("none");
    expect(screen.getByText("—")).toBeInTheDocument();
    expect(screen.getByText("no check-in yet")).toBeInTheDocument();
    expect(container.querySelector(".money-zero")).toBeNull();
  });

  it("tracking: freshness reads 'updated', not 'checked in'", () => {
    const { container } = render(<Tracking />);
    expect(container.querySelector("[data-kind]")!.getAttribute("data-kind")).toBe("tracking");
    expect(screen.getByText("updated 28d ago")).toBeInTheDocument();
    expect(screen.queryByText(/checked in/)).toBeNull();
  });

  it("zero balance: explicit 0.00 in the muted zero register", () => {
    const { container } = render(<ZeroBalance />);
    const zero = container.querySelector(".money-zero");
    expect(zero).not.toBeNull();
    expect(zero!.textContent).toBe("0.00");
  });

  it("the whole row is one 44px-class tap target, its press feedback owned by the shared Pressable primitive", () => {
    render(<CheckedIn />);
    const btn = screen.getByRole("button", { name: /ENBD Current/ });
    // Regression guard for the unlayered `.press` cascade bug: the class must
    // never come back. Pressable.test.tsx covers the actual whileTap behavior.
    expect(btn.className).not.toContain("press");
    expect(btn.className).toContain("w-full");
  });

  it("the accessible name carries balance and freshness, not just the account name", () => {
    render(<CheckedIn />);
    const btn = screen.getByRole("button");
    expect(btn).not.toHaveAttribute("aria-label");
    expect(btn).toHaveAccessibleName(expect.stringContaining("ENBD Current"));
    expect(btn).toHaveAccessibleName(expect.stringContaining("7,450.00"));
    expect(btn).toHaveAccessibleName(expect.stringContaining("checked in 4d ago"));
  });
});
