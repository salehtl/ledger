import "@/test/storybook";
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { composeStories } from "@storybook/react-vite";
import * as stories from "./ScheduleList.stories";

const { Active, WithPaused } = composeStories(stories);

describe("ScheduleList stories", () => {
  it("shows name, cadence, next due, and source on each row", () => {
    render(<Active />);
    expect(screen.getByText("Netflix")).toBeInTheDocument();
    expect(screen.getByText(/every month · next Aug 7 · detected/)).toBeInTheDocument();
    expect(screen.getByText(/every month · next Aug 5 · manual/)).toBeInTheDocument();
  });

  it("marks paused rows and drops their next-due date", () => {
    render(<WithPaused />);
    expect(screen.getByText("Paused")).toBeInTheDocument();
    expect(screen.getByText("every month · manual")).toBeInTheDocument();
    expect(screen.queryByText(/manual · next/)).toBeNull();
  });

  it("opens a schedule from its row, exposing the full row as the name", () => {
    const onOpen = vi.fn();
    render(<Active onOpen={onOpen} />);
    // No aria-label override: the visible content (name + amount) is the
    // accessible name, so screen readers hear the whole row.
    fireEvent.click(screen.getByRole("button", { name: /Gym membership.*250\.00/ }));
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen.mock.calls[0][0].merchant).toBe("gym co");
  });

  it("never spends the spot ink on inventory rows", () => {
    const { container } = render(<WithPaused />);
    expect(container.querySelector(".bg-accent")).toBeNull();
  });
});
