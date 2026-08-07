import "@/test/storybook";
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { composeStories } from "@storybook/react-vite";
import * as stories from "./UpcomingFeed.stories";

const { Feed, Empty, Paid } = composeStories(stories);

describe("UpcomingFeed stories", () => {
  it("shows countdown labels for due and overdue bills", () => {
    render(<Feed />);
    expect(screen.getByText(/3 days overdue/)).toBeInTheDocument();
    expect(screen.getByText(/due today/)).toBeInTheDocument();
    expect(screen.getByText(/due in 2 days/)).toBeInTheDocument();
    expect(screen.getByText(/due in 13 days/)).toBeInTheDocument();
  });

  it("badges missed and price change in labels, not colour", () => {
    render(<Feed />);
    expect(screen.getByText("Missed")).toBeInTheDocument();
    expect(screen.getByText("Price change")).toBeInTheDocument();
  });

  it("explains a price change on its own line", () => {
    render(<Feed />);
    expect(screen.getByText("last charge 389.00 — expected 427.90")).toBeInTheDocument();
  });

  it("never uses the attention pill (red is rationed to needs-review)", () => {
    const { container } = render(<Feed />);
    expect(container.querySelector(".bg-accent")).toBeNull();
  });

  it("opens a bill from its row, exposing the full row as the name", () => {
    const onOpen = vi.fn();
    render(<Feed onOpen={onOpen} />);
    // No aria-label override: the row's visible text (name, due, amount) is
    // the accessible name, so screen readers hear the badges and figures too.
    fireEvent.click(screen.getByRole("button", { name: /DEWA.*Missed.*overdue/ }));
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen.mock.calls[0][0].merchant).toBe("dewa");
  });

  it("shows the empty window state", () => {
    render(<Empty />);
    expect(screen.getByText("Nothing due")).toBeInTheDocument();
  });

  it("recently paid rows link the matched transaction", () => {
    render(<Paid />);
    expect(screen.getByText(/paid Jul 25/)).toBeInTheDocument();
    expect(screen.getAllByText(/matched transaction/).length).toBeGreaterThan(0);
  });
});
